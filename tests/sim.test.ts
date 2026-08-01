/**
 * Invariants de la manche.
 *
 * Chaque test ici correspond à une promesse faite au joueur : la progression
 * ne recule pas, personne ne meurt d'un coup, un faux indice reste inoffensif,
 * un piège se déclenche une fois, l'alarme sonne une fois, la manche se
 * termine. Ce sont des propriétés, pas des redites de l'implémentation.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CFG, TICK_DT } from '../src/game/config';
import type { TrapKind } from '../src/game/config';
import type { GameEvent } from '../src/game/types';
import { dist } from '../src/game/types';
import {
  IDLE,
  input,
  legalTrapTiles,
  makeWorld,
  place,
  plan,
  rng,
  run,
  seconds,
  walkInvaderTo,
} from './helpers';

const COMPACT = plan('compact');
/** Une tuile de sol bordée d'un mur : légale pour tous les pièges, flèches comprises. */
const TRAP_TILE = { x: 8, y: 8 };
/** Coin nord-ouest : le point d'apparition de l'Envahisseur. */
const FAR_CORNER = { x: 2.5, y: 2.5 };
/** Coin sud-est, loin du premier candidat Cœur comme de l'entrée. */
const AWAY = { x: 21.5, y: 21.5 };

/* ==================================================================== */
/* Le Cœur                                                              */
/* ==================================================================== */

describe('capture du Cœur', () => {
  test('la progression ne recule jamais, même contestée', () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.castellan, FAR_CORNER);
    place(world.invader, world.heart);

    const series: number[] = [];
    const watch = () => series.push(world.captureProgress);

    // 1. L'Envahisseur seul dans la salle : ça monte.
    run(world, seconds(11), IDLE, IDLE, watch);
    const afterAlone = world.captureProgress;
    assert.ok(afterAlone >= CFG.heart.breachAt, `progression ${afterAlone} après 11 s`);
    assert.equal(world.breached, true, 'le seuil de 50 % doit avoir ouvert la brèche');

    // 2. Le Châtelain revient contester : ça se suspend, ça ne retombe pas.
    place(world.castellan, world.heart);
    run(world, seconds(4), IDLE, IDLE, watch);
    assert.equal(world.contested, true, 'les deux sont dans la salle');
    assert.equal(
      world.captureProgress,
      afterAlone,
      'contester doit suspendre la capture, pas la remettre à zéro (§6)',
    );

    // 3. Il ressort : ça repart d'où c'était.
    place(world.castellan, FAR_CORNER);
    run(world, seconds(12), IDLE, IDLE, watch);

    for (let i = 1; i < series.length; i++) {
      assert.ok(
        series[i] >= series[i - 1],
        `la progression est retombée de ${series[i - 1]} à ${series[i]} au pas ${i}`,
      );
    }
    assert.ok(world.captureProgress >= 1, 'la capture doit finir par aboutir');
    assert.deepEqual(world.over, { winner: 'invader', outcome: 'capture' });
  });

  test('fuzz : 4 000 pas d’entrées aléatoires, la progression reste monotone', () => {
    const world = makeWorld({ heartIndex: 1 });
    const r = rng(0x1c3);
    let previous = 0;

    const control = () =>
      input({
        move: { x: r() * 2 - 1, y: r() * 2 - 1 },
        aim: r() * Math.PI * 2,
        gait: r() < 0.3 ? 'careful' : 'normal',
        primary: r() < 0.05,
      });

    run(world, 4000, control, control, (w) => {
      assert.ok(w.captureProgress >= previous, `progression ${w.captureProgress} après ${previous}`);
      assert.ok(w.captureProgress >= 0 && w.captureProgress <= 1);
      previous = w.captureProgress;
    });
  });

  test('la brèche ouvre les portes verrouillées autour du Cœur', () => {
    const world = makeWorld({ heartIndex: 0, lockedDoors: [0, 1, 2, 3] });
    place(world.castellan, FAR_CORNER);
    place(world.invader, world.heart);
    const before = world.castle.blockers.size;
    assert.ok(before > 0, 'le test doit poser des verrous');

    run(world, seconds(11));
    assert.equal(world.breached, true);
    for (const [i] of world.castle.blockers) {
      const x = (i % COMPACT.w) + 0.5;
      const y = Math.floor(i / COMPACT.w) + 0.5;
      assert.ok(
        dist({ x, y }, world.heart) > CFG.heart.breachRadius,
        `un verrou survit à ${dist({ x, y }, world.heart).toFixed(1)} tuiles du Cœur`,
      );
    }
  });
});

/* ==================================================================== */
/* Combat                                                               */
/* ==================================================================== */

describe('combat', () => {
  test(`aucun coup ne dépasse ${CFG.combat.maxSingleHit} dégâts`, () => {
    const world = makeWorld({});
    world.damage(world.invader, 1e9, 'test');
    const hits = world.drainEvents().filter((e): e is Extract<GameEvent, { k: 'hit' }> => e.k === 'hit');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].dmg, CFG.combat.maxSingleHit);
    assert.equal(world.invader.hp, CFG.invader.maxHp - CFG.combat.maxSingleHit);
    assert.ok(world.invader.alive, 'personne ne meurt d’un seul coup en partant de la vie pleine');
  });

  test('une valeur infinie est bornée comme le reste', () => {
    const world = makeWorld({});
    world.damage(world.castellan, Infinity, 'test');
    assert.equal(world.castellan.hp, CFG.castellan.maxHp - CFG.combat.maxSingleHit);
  });

  test('fuzz : 6 000 pas de mêlée, aucun coup hors bornes', () => {
    const tiles = legalTrapTiles(COMPACT);
    const world = makeWorld({
      heartIndex: 1,
      tools: ['crossbow'],
      traps: [
        { kind: 'spikes', x: tiles[0].x, y: tiles[0].y },
        { kind: 'boulder', x: tiles[1].x, y: tiles[1].y },
        { kind: 'chest', x: tiles[2].x, y: tiles[2].y },
      ],
      devices: [{ kind: 'chandelier', x: tiles[8].x, y: tiles[8].y }],
    });
    // Les deux corps commencent au contact : on veut du combat, pas une balade.
    place(world.castellan, { x: world.invader.pos.x + 1, y: world.invader.pos.y });

    const r = rng(0x5aa5);
    let hits = 0;

    // Chacun marche sur l'autre, avec du bruit : c'est ce qui produit vraiment
    // des échanges plutôt que deux promeneurs qui s'ignorent.
    const toward = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const m = Math.hypot(dx, dy) || 1;
      return { x: dx / m + (r() - 0.5) * 0.6, y: dy / m + (r() - 0.5) * 0.6 };
    };
    const face = (from: { x: number; y: number }, to: { x: number; y: number }) =>
      Math.atan2(to.y - from.y, to.x - from.x) + (r() - 0.5) * 0.8;

    const invaderControl = (_t: number, w: typeof world) =>
      input({
        move: toward(w.invader.pos, w.castellan.pos),
        aim: face(w.invader.pos, w.castellan.pos),
        primary: r() < 0.3,
        parry: r() < 0.15,
        dodge: r() < 0.08,
        gait: r() < 0.25 ? 'careful' : 'normal',
        tool: r() < 0.1 ? 0 : -1,
      });
    const castellanControl = (_t: number, w: typeof world) =>
      input({
        move: toward(w.castellan.pos, w.invader.pos),
        aim: face(w.castellan.pos, w.invader.pos),
        primary: r() < 0.3,
        scry: r() < 0.05,
        device: r() < 0.05 ? 0 : -1,
      });

    run(world, 6000, invaderControl, castellanControl, (w) => {
      // Les deux restent debout : on veut mesurer les coups, pas la survie.
      if (w.invader.hp < 30) w.invader.hp = CFG.invader.maxHp;
      if (w.castellan.hp < 30) w.castellan.hp = CFG.castellan.maxHp;
      for (const e of w.drainEvents()) {
        if (e.k !== 'hit') continue;
        hits++;
        assert.ok(Number.isFinite(e.dmg), `dégâts non numériques : ${e.dmg}`);
        assert.ok(e.dmg > 0, `coup à ${e.dmg} dégâts émis pour rien`);
        assert.ok(
          e.dmg <= CFG.combat.maxSingleHit,
          `coup à ${e.dmg} dégâts, au-delà du garde-fou de ${CFG.combat.maxSingleHit} (source : ${e.source})`,
        );
      }
      assert.ok(w.invader.hp >= 0 && w.invader.hp <= CFG.invader.maxHp, `PV Envahisseur ${w.invader.hp}`);
      assert.ok(
        w.castellan.hp >= 0 && w.castellan.hp <= CFG.castellan.maxHp,
        `PV Châtelain ${w.castellan.hp}`,
      );
    });

    assert.ok(hits > 20, `le fuzz n’a produit que ${hits} coups : il ne prouve rien`);
  });
});

/* ==================================================================== */
/* Pièges                                                               */
/* ==================================================================== */

describe('pièges automatiques', () => {
  const REAL: TrapKind[] = ['spikes', 'arrows', 'collapse', 'boulder', 'chest'];

  for (const kind of REAL) {
    test(`« ${CFG.traps[kind].label} » se déclenche quand on marche dessus`, () => {
      const world = makeWorld({ heartIndex: 0, traps: [{ kind, x: TRAP_TILE.x, y: TRAP_TILE.y }] });
      place(world.castellan, AWAY);
      const trap = world.traps[0];
      const at = { x: trap.x, y: trap.y };

      const arrived = walkInvaderTo(world, at, { stopWithin: 0.2, maxSeconds: 30 });
      assert.ok(arrived || trap.state !== 'armed', 'l’Envahisseur n’a pas atteint le piège');

      assert.equal(trap.state, 'spent', `le piège est resté « ${trap.state} »`);
      assert.equal(
        world.invader.hp,
        CFG.invader.maxHp - CFG.traps[kind].damage,
        'les dégâts du piège ne correspondent pas à sa fiche',
      );
      assert.deepEqual(world.stats.trapsTriggered, [trap.id]);
      assert.ok(
        !world.stats.trapsUntouched.includes(trap.id),
        'un piège déclenché ne peut pas rester « jamais touché »',
      );
    });
  }

  test('un piège dépensé ne se redéclenche pas quand on repasse dessus', () => {
    const world = makeWorld({ heartIndex: 0, traps: [{ kind: 'spikes', x: TRAP_TILE.x, y: TRAP_TILE.y }] });
    place(world.castellan, AWAY);
    const trap = world.traps[0];
    const at = { x: trap.x, y: trap.y };

    walkInvaderTo(world, at, { stopWithin: 0.2, maxSeconds: 30 });
    const hpAfterFirst = world.invader.hp;
    assert.equal(trap.state, 'spent');
    assert.ok(hpAfterFirst < CFG.invader.maxHp);

    // Cinq allers-retours sur la même dalle.
    for (let k = 0; k < 5; k++) {
      walkInvaderTo(world, { x: at.x + 2.5, y: at.y }, { stopWithin: 0.4, maxSeconds: 6 });
      walkInvaderTo(world, at, { stopWithin: 0.2, maxSeconds: 6 });
    }

    assert.equal(world.invader.hp, hpAfterFirst, 'le piège a mordu deux fois');
    assert.deepEqual(world.stats.trapsTriggered, [trap.id]);
    assert.equal(world.alarm, false, 'l’alarme aurait réarmé le piège et faussé le test');
  });

  test('un faux indice ne blesse jamais et ne se déclenche jamais', () => {
    const world = makeWorld({
      heartIndex: 0,
      traps: [{ kind: 'decoy', x: TRAP_TILE.x, y: TRAP_TILE.y, tell: 'seam' }],
    });
    place(world.castellan, AWAY);
    const decoy = world.traps[0];
    const at = { x: decoy.x, y: decoy.y };

    const seen: GameEvent[] = [];
    const collect = (w: typeof world) => seen.push(...w.drainEvents());

    for (let k = 0; k < 6; k++) {
      walkInvaderTo(world, at, { stopWithin: 0.15, maxSeconds: 30, onTick: collect });
      walkInvaderTo(world, { x: at.x + 2.5, y: at.y }, { stopWithin: 0.4, maxSeconds: 8, onTick: collect });
    }

    assert.equal(world.invader.hp, CFG.invader.maxHp, 'un faux indice a fait des dégâts');
    assert.equal(decoy.state, 'armed', `le faux indice est passé à « ${decoy.state} »`);
    assert.deepEqual(world.stats.trapsTriggered, []);
    assert.equal(seen.filter((e) => e.k === 'trap').length, 0, 'un faux indice a émis un événement de piège');
    assert.equal(seen.filter((e) => e.k === 'hit').length, 0);
  });

  test('réarmer un piège coûte de l’Influence et ne se fait pas à crédit', () => {
    const world = makeWorld({ heartIndex: 0, traps: [{ kind: 'spikes', x: TRAP_TILE.x, y: TRAP_TILE.y }] });
    const trap = world.traps[0];
    trap.state = 'spent';

    world.influence = CFG.castellan.rearmCost - 1;
    assert.equal(world.rearmTrap(trap.id), false, 'on ne réarme pas sans Influence');
    assert.equal(trap.state, 'spent');

    world.influence = CFG.castellan.rearmCost;
    assert.equal(world.rearmTrap(trap.id), true);
    assert.equal(trap.state, 'armed');
    assert.equal(world.influence, 0);

    // Un sol effondré ne se rebouche pas.
    const other = makeWorld({ heartIndex: 0, traps: [{ kind: 'collapse', x: TRAP_TILE.x, y: TRAP_TILE.y }] });
    other.traps[0].state = 'spent';
    other.influence = CFG.castellan.influenceMax;
    assert.equal(other.rearmTrap(0), false, 'un effondrement n’est pas réarmable');
    assert.equal(other.influence, CFG.castellan.influenceMax, 'un refus ne doit rien coûter');
  });
});

/* ==================================================================== */
/* Alarme                                                               */
/* ==================================================================== */

describe('alarme', () => {
  test('elle sonne une seule fois, au chrono, si personne n’entre dans la salle', () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.invader, { x: 2.5, y: 2.5 });

    let firedAt: number | null = null;
    let timeLeftAtFiring = 0;
    let alarms = 0;
    let previousTimeLeft = world.timeLeft;

    run(world, seconds(120), IDLE, IDLE, (w) => {
      for (const e of w.drainEvents()) if (e.k === 'alarm') alarms++;
      if (w.alarm && firedAt === null) {
        firedAt = w.now;
        timeLeftAtFiring = w.timeLeft;
        assert.ok(
          previousTimeLeft > CFG.alarm.timeLeftTrigger,
          'l’alarme a sonné en retard : le pas précédent était déjà sous le seuil',
        );
      }
      previousTimeLeft = w.timeLeft;
    });

    assert.notEqual(firedAt, null, 'l’alarme n’a jamais sonné');
    assert.ok(
      timeLeftAtFiring <= CFG.alarm.timeLeftTrigger + 1e-9,
      `alarme à ${timeLeftAtFiring} s restantes, seuil ${CFG.alarm.timeLeftTrigger}`,
    );
    assert.ok(
      timeLeftAtFiring > CFG.alarm.timeLeftTrigger - TICK_DT - 1e-9,
      'l’alarme a sonné bien après le seuil',
    );
    assert.equal(alarms, 1, `${alarms} alarmes émises`);
    assert.equal(world.alarm, true, 'l’alarme ne se rétracte pas');
  });

  test('entrer dans la salle du Cœur la déclenche tout de suite', () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.invader, { x: 2.5, y: 2.5 });
    run(world, seconds(2));
    assert.equal(world.alarm, false);
    assert.ok(world.timeLeft > CFG.alarm.timeLeftTrigger, 'le chrono ne doit pas être en cause');

    place(world.invader, world.heart);
    // Le Châtelain est tenu loin de son Cœur : la régénération du pas est donc
    // la régénération de base, et le calcul attendu ne dépend plus du plan.
    place(world.castellan, AWAY);
    world.influence = 10;
    const before = world.influence;
    run(world, 1);

    assert.equal(world.alarm, true);
    const expected =
      Math.min(CFG.castellan.influenceMax, before + CFG.alarm.influenceGift) +
      CFG.castellan.influenceRegen * TICK_DT;
    assert.ok(
      Math.abs(world.influence - expected) < 1e-9,
      `Influence ${world.influence} au lieu de ${expected}`,
    );
  });

  test('le cadeau d’alarme ne fait pas déborder l’Influence', () => {
    const world = makeWorld({ heartIndex: 0 });
    world.influence = CFG.castellan.influenceMax;
    place(world.invader, world.heart);
    run(world, 1);
    assert.equal(world.alarm, true);
    assert.equal(world.influence, CFG.castellan.influenceMax);
  });

  test('déclenchée par la salle, elle ne resonne pas quand le chrono passe le seuil', () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.castellan, AWAY);
    place(world.invader, world.heart);

    let alarms = 0;
    const count = (w: typeof world) => {
      for (const e of w.drainEvents()) if (e.k === 'alarm') alarms++;
    };

    run(world, 1, IDLE, IDLE, count);
    assert.equal(world.alarm, true);
    assert.equal(alarms, 1);
    assert.ok(world.timeLeft > CFG.alarm.timeLeftTrigger, 'le chrono est encore loin du seuil');

    // On repart de l'entrée, et on laisse le chrono franchir le seuil.
    place(world.invader, FAR_CORNER);
    run(world, seconds(120), IDLE, IDLE, count);
    assert.ok(world.timeLeft <= CFG.alarm.timeLeftTrigger, 'le seuil doit avoir été franchi');
    assert.equal(alarms, 1, `${alarms} alarmes : elle ne doit sonner qu’une fois par manche`);
  });

  test('elle réarme les pièges réarmables, et seulement ceux-là', () => {
    const tiles = legalTrapTiles(COMPACT);
    const world = makeWorld({
      heartIndex: 0,
      traps: [
        { kind: 'spikes', x: tiles[0].x, y: tiles[0].y },
        { kind: 'collapse', x: tiles[1].x, y: tiles[1].y },
      ],
    });
    world.traps[0].state = 'spent';
    world.traps[1].state = 'spent';

    place(world.invader, world.heart);
    run(world, 1);

    assert.equal(world.alarm, true);
    assert.equal(world.traps[0].state, 'armed', 'une fosse à pics se réarme');
    assert.equal(world.traps[1].state, 'spent', 'un sol effondré reste un trou');
  });
});

/* ==================================================================== */
/* Influence                                                            */
/* ==================================================================== */

describe('Influence du Châtelain', () => {
  test('elle reste dans [0, max] sur une longue série de Scrutations et d’activations', () => {
    const tiles = legalTrapTiles(COMPACT);
    const doors = COMPACT.doors;
    const world = makeWorld({
      heartIndex: 1,
      traps: [{ kind: 'spikes', x: tiles[0].x, y: tiles[0].y }],
      devices: [
        { kind: 'portcullis', x: Math.floor(doors[0].x), y: Math.floor(doors[0].y) },
        { kind: 'trapdoor', x: tiles[10].x, y: tiles[10].y },
        { kind: 'douse', x: tiles[11].x, y: tiles[11].y },
        { kind: 'chandelier', x: tiles[12].x, y: tiles[12].y },
        { kind: 'hound', x: tiles[13].x, y: tiles[13].y },
      ],
    });
    assert.equal(world.devices.length, 5, 'le décor du test doit poser cinq mécanismes');

    const r = rng(0x1f1);
    let low = Infinity;
    let high = -Infinity;
    let activations = 0;

    const castellanControl = () =>
      input({
        scry: r() < 0.6,
        device: r() < 0.25 ? Math.floor(r() * world.devices.length) : -1,
        rearm: r() < 0.15 ? 0 : -1,
        move: { x: r() * 2 - 1, y: r() * 2 - 1 },
        aim: r() * Math.PI * 2,
      });
    const invaderControl = () =>
      input({ move: { x: r() * 2 - 1, y: r() * 2 - 1 }, aim: r() * Math.PI * 2 });

    run(world, 5000, invaderControl, castellanControl, (w) => {
      assert.ok(Number.isFinite(w.influence), `Influence non numérique : ${w.influence}`);
      assert.ok(
        w.influence >= 0 && w.influence <= CFG.castellan.influenceMax,
        `Influence ${w.influence} hors de [0, ${CFG.castellan.influenceMax}]`,
      );
      low = Math.min(low, w.influence);
      high = Math.max(high, w.influence);
      for (const e of w.drainEvents()) if (e.k === 'device') activations++;
      // Le molosse finirait par tuer l'Envahisseur : on le remet debout pour
      // que la manche dure assez longtemps à observer.
      if (w.invader.hp < 40) w.invader.hp = CFG.invader.maxHp;
    });

    assert.ok(activations >= 3, `seulement ${activations} activations : le test n’exerce rien`);
    assert.ok(high - low > 20, `l’Influence n’a varié que de ${(high - low).toFixed(1)} points`);
  });

  test('la Scrutation demande un minimum d’Influence pour démarrer', () => {
    const world = makeWorld({ heartIndex: 1 });
    world.influence = CFG.castellan.scryMinInfluence - 1;
    run(world, 1, IDLE, input({ scry: true }));
    assert.equal(world.scrying, false, 'on ne scrute pas à sec');

    world.influence = CFG.castellan.scryMinInfluence + 5;
    run(world, 1, IDLE, input({ scry: true }));
    assert.equal(world.scrying, true);
  });

  test('la Scrutation s’interrompt seule quand l’Influence tombe à zéro', () => {
    const world = makeWorld({ heartIndex: 1 });
    place(world.castellan, { x: 2.5, y: 2.5 });
    world.influence = CFG.castellan.scryMinInfluence + 2;
    run(world, seconds(30), IDLE, input({ scry: true }));
    assert.equal(world.scrying, false);
    assert.ok(world.influence >= 0);
  });
});

/* ==================================================================== */
/* Braseros                                                             */
/* ==================================================================== */

describe('braseros', () => {
  test('allumer un brasero ajoute exactement le bonus de temps', () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.castellan, AWAY);
    const brazier = world.braziers[0];

    assert.ok(
      walkInvaderTo(world, brazier.pos, { stopWithin: 0.5, maxSeconds: 40 }),
      'l’Envahisseur n’a pas atteint le brasero',
    );

    let before = world.timeLeft;
    let jump: number | null = null;
    for (let i = 0; i < seconds(6) && jump === null; i++) {
      before = world.timeLeft;
      world.step(input({ interact: true }), IDLE);
      if (brazier.lit) jump = world.timeLeft - before;
    }

    assert.notEqual(jump, null, 'le brasero ne s’est jamais allumé');
    // Le pas retire dt au chrono avant d'ajouter le bonus.
    assert.ok(
      Math.abs((jump as number) - (CFG.brazier.timeBonus - TICK_DT)) < 1e-9,
      `bonus observé ${(jump as number) + TICK_DT} au lieu de ${CFG.brazier.timeBonus}`,
    );
    assert.equal(world.stats.braziersLit, 1);
    assert.equal(brazier.progress, 1);
  });

  test(`on ne peut jamais allumer plus de ${CFG.brazier.maxLit} braseros`, () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.castellan, AWAY);
    assert.ok(world.braziers.length > CFG.brazier.maxLit, 'le plan doit offrir plus de braseros que le plafond');

    for (const b of world.braziers) {
      // On se pose sur chaque brasero à tour de rôle : ce qu'on teste, c'est le
      // plafond, pas le trajet.
      place(world.invader, b.pos);
      run(world, seconds(5), input({ interact: true }));
    }

    const lit = world.braziers.filter((b) => b.lit);
    assert.equal(lit.length, CFG.brazier.maxLit, `${lit.length} braseros allumés`);
    assert.equal(world.stats.braziersLit, CFG.brazier.maxLit);

    const dark = world.braziers.find((b) => !b.lit)!;
    assert.equal(dark.progress, 0, 'le troisième brasero ne doit même pas progresser');

    const expected = CFG.match.roundDuration + CFG.brazier.maxLit * CFG.brazier.timeBonus;
    assert.ok(
      Math.abs(world.timeLeft + world.stats.timeElapsed - expected) < 1e-6,
      `chrono total ${(world.timeLeft + world.stats.timeElapsed).toFixed(3)} au lieu de ${expected}`,
    );
  });

  test('lâcher l’interaction fait retomber la progression', () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.invader, world.braziers[0].pos);
    run(world, seconds(1), input({ interact: true }));
    const partial = world.braziers[0].progress;
    assert.ok(partial > 0 && partial < 1, `progression ${partial}`);

    run(world, seconds(3), IDLE);
    assert.equal(world.braziers[0].progress, 0);
    assert.equal(world.braziers[0].lit, false);
  });
});

/* ==================================================================== */
/* Fin de manche                                                        */
/* ==================================================================== */

describe('fin de manche', () => {
  test('200 secondes d’immobilité suffisent toujours à terminer la manche', () => {
    const world = makeWorld({ heartIndex: 0 });
    const ticks = run(world, seconds(200));

    assert.notEqual(world.over, null, `la manche tourne encore après ${(ticks * TICK_DT).toFixed(0)} s`);
    assert.deepEqual(world.over, { winner: 'castellan', outcome: 'timeout' });
    assert.equal(world.timeLeft, 0, 'le chrono affiché doit être remis à zéro proprement');
    assert.ok(
      ticks <= seconds(CFG.match.roundDuration) + 1,
      `la manche a duré ${ticks} pas pour ${CFG.match.roundDuration} s annoncées`,
    );
  });

  test('la manche décisive se termine aussi', () => {
    const world = makeWorld({ heartIndex: 1, duration: CFG.match.tiebreakDuration });
    run(world, seconds(200));
    assert.notEqual(world.over, null);
  });

  test('une fois terminée, la manche n’avance plus', () => {
    const world = makeWorld({ heartIndex: 0 });
    run(world, seconds(200));
    const frozen = {
      now: world.now,
      hp: world.invader.hp,
      progress: world.captureProgress,
      influence: world.influence,
    };
    run(world, 200, input({ move: { x: 1, y: 0 }, primary: true }), input({ primary: true }));
    assert.equal(world.now, frozen.now);
    assert.equal(world.invader.hp, frozen.hp);
    assert.equal(world.captureProgress, frozen.progress);
    assert.equal(world.influence, frozen.influence);
  });

  test('la mort du Châtelain donne la manche à l’Envahisseur', () => {
    const world = makeWorld({ heartIndex: 1 });
    for (let k = 0; k < 3; k++) {
      world.castellan.invulnUntil = 0;
      world.damage(world.castellan, 1e9, 'test');
    }
    run(world, 60);
    assert.equal(world.castellan.alive, false);
    assert.deepEqual(world.over, { winner: 'invader', outcome: 'kill_castellan' });
  });

  test('la mort de l’Envahisseur donne la manche au Châtelain', () => {
    const world = makeWorld({ heartIndex: 1 });
    for (let k = 0; k < 3; k++) {
      world.invader.invulnUntil = 0;
      world.damage(world.invader, 1e9, 'test');
    }
    run(world, 60);
    assert.equal(world.invader.alive, false);
    assert.deepEqual(world.over, { winner: 'castellan', outcome: 'kill_invader' });
  });
});

/* ==================================================================== */
/* Pureté                                                               */
/* ==================================================================== */

describe('la simulation tourne sans navigateur', () => {
  test('le test lui-même s’exécute sans DOM', () => {
    assert.equal(typeof (globalThis as Record<string, unknown>).document, 'undefined');
    assert.equal(typeof (globalThis as Record<string, unknown>).window, 'undefined');
    // Et une manche complète tourne quand même.
    const world = makeWorld({ heartIndex: 0 });
    run(world, seconds(200));
    assert.notEqual(world.over, null);
  });

  test('aucun fichier de src/game n’appelle React, le DOM ou une horloge', () => {
    const dir = fileURLToPath(new URL('../src/game', import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(dir);
    assert.ok(files.length >= 8, `seulement ${files.length} fichiers analysés`);

    const forbidden: [RegExp, string][] = [
      [/from ['"]react/, 'un import React'],
      [/from ['"]next/, 'un import Next'],
      [/\bdocument\./, 'un accès au DOM'],
      [/\bwindow\./, 'un accès à window'],
      [/\bnavigator\./, 'un accès à navigator'],
      [/localStorage|sessionStorage/, 'un accès au stockage du navigateur'],
      [/requestAnimationFrame/, 'une boucle d’animation'],
      [/performance\.now/, 'une horloge du navigateur'],
      [/Math\.random/, 'une source d’aléa'],
      [/Date\.now|new Date\(/, 'une horloge système'],
    ];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const [pattern, why] of forbidden) {
        assert.ok(
          !pattern.test(src),
          `${file.slice(file.indexOf('src/'))} contient ${why} : la manche ne serait plus rejouable`,
        );
      }
    }
  });

  test('deux manches identiques donnent le même résultat au bit près', () => {
    const tiles = legalTrapTiles(COMPACT);
    const spec = {
      heartIndex: 1,
      tools: ['crossbow', 'bombs'] as const,
      traps: [
        { kind: 'spikes' as const, x: tiles[0].x, y: tiles[0].y },
        { kind: 'boulder' as const, x: tiles[1].x, y: tiles[1].y },
      ],
      devices: [{ kind: 'hound' as const, x: tiles[10].x, y: tiles[10].y }],
    };

    const record = () => {
      const world = makeWorld({ ...spec, tools: [...spec.tools] });
      const r = rng(0x2b2b);
      const frames = Array.from({ length: 1500 }, () => ({
        inv: input({
          move: { x: r() * 2 - 1, y: r() * 2 - 1 },
          aim: r() * Math.PI * 2,
          primary: r() < 0.2,
          gait: r() < 0.3 ? 'run' : 'normal',
          tool: r() < 0.1 ? 0 : -1,
        }),
        cas: input({
          move: { x: r() * 2 - 1, y: r() * 2 - 1 },
          aim: r() * Math.PI * 2,
          scry: r() < 0.2,
          device: r() < 0.05 ? 0 : -1,
        }),
      }));
      const trace: string[] = [];
      for (const f of frames) {
        world.step(f.inv, f.cas);
        trace.push(
          `${world.invader.pos.x},${world.invader.pos.y},${world.invader.hp},` +
            `${world.castellan.pos.x},${world.castellan.pos.y},${world.castellan.hp},` +
            `${world.influence},${world.captureProgress},${world.entities.length}`,
        );
      }
      return trace;
    };

    const a = record();
    const b = record();
    assert.deepEqual(b, a, 'la simulation n’est pas déterministe : la rediffusion serait impossible');
    assert.ok(new Set(a).size > 100, 'la trace doit vraiment bouger');
  });
});
