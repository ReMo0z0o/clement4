/**
 * Sécurité de l'information (§13).
 *
 * Règle unique : l'hôte n'envoie jamais à un client une donnée que ce client
 * n'a pas le droit de percevoir. Cacher une chose à l'affichage tout en la
 * transmettant, dans un jeu à information cachée, c'est ne rien cacher.
 *
 * Ces tests lisent la charge utile, pas l'écran.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CFG } from '../src/game/config';
import { resolveIntel } from '../src/game/prep';
import type { GameEvent, Snapshot, VisibleTell } from '../src/game/types';
import { dist } from '../src/game/types';
import {
  auditSnapshot,
  filterEvents,
  filtersFor,
  idx,
  IDLE,
  input,
  legalTrapTiles,
  makeLoadout,
  makeWorld,
  place,
  plan,
  rng,
  run,
  seconds,
  snapshotOf,
  SnapshotFilter,
  walkInvaderTo,
} from './helpers';

const COMPACT = plan('compact');

/** Rangée 8 du Donjon : sept tuiles de sol alignées, hors de portée de l'entrée. */
const SPIKES_TILE = { x: 10, y: 8 };
const DECOY_TILE = { x: 13, y: 8 };
/** Point d'observation à 1,5 tuile de chacun des deux : on lit, on ne déclenche pas. */
const BETWEEN = { x: 12, y: 8.5 };

function stripPosition(t: VisibleTell): Record<string, unknown> {
  const { id: _id, x: _x, y: _y, ...rest } = t;
  return rest;
}

/* ==================================================================== */
/* Ce que l'Envahisseur ne doit jamais recevoir                         */
/* ==================================================================== */

describe('instantané destiné à l’Envahisseur', () => {
  test('au premier pas, il ne reçoit rien qu’il n’ait mérité', () => {
    const tiles = legalTrapTiles(COMPACT);
    const world = makeWorld({
      heartIndex: 0,
      traps: [
        { kind: 'spikes', x: SPIKES_TILE.x, y: SPIKES_TILE.y },
        { kind: 'decoy', x: DECOY_TILE.x, y: DECOY_TILE.y, tell: 'seam' },
      ],
      devices: [{ kind: 'chandelier', x: tiles[9].x, y: tiles[9].y }],
    });
    const { invader } = filtersFor(world);
    run(world, 1);

    const snap = snapshotOf(invader, world);
    assert.deepEqual(auditSnapshot(snap, 'invader', world), []);

    assert.equal(snap.other, null, 'la position du Châtelain ne doit pas suivre');
    assert.equal(snap.self.influence, 0, "l'Influence est une donnée du Châtelain");
    assert.equal(snap.self.scrying, false);
    assert.equal(snap.devices, undefined, 'les mécanismes adverses ne traversent pas le réseau');
    assert.equal(snap.ownTraps, undefined, 'la liste des pièges non plus');
    assert.equal(snap.heart, null, 'le Cœur n’a pas encore été trouvé');
    assert.deepEqual(snap.braziers, [], 'aucun brasero n’a encore été vu');
    assert.deepEqual(snap.scars, []);
    assert.deepEqual(snap.tells, [], 'les indices de la rangée 8 sont hors de portée');
  });

  test('rien ne fuit sur une traversée complète du château', () => {
    const tiles = legalTrapTiles(COMPACT);
    const world = makeWorld({
      heartIndex: 1,
      traps: [
        { kind: 'spikes', x: tiles[0].x, y: tiles[0].y },
        { kind: 'decoy', x: tiles[1].x, y: tiles[1].y, tell: 'crack' },
        { kind: 'chest', x: tiles[2].x, y: tiles[2].y },
      ],
      devices: [{ kind: 'hound', x: tiles[9].x, y: tiles[9].y }],
    });
    const { invader } = filtersFor(world);
    let tick = 0;
    let checks = 0;

    const audit = () => {
      tick++;
      checks++;
      const snap = snapshotOf(invader, world, tick);
      const problems = auditSnapshot(snap, 'invader', world);
      assert.deepEqual(problems, [], `fuite au pas ${tick} : ${problems.join(' / ')}`);

      if (!world.invaderSees()) {
        assert.equal(snap.other, null, `position du Châtelain transmise hors de vue au pas ${tick}`);
      }
      if (!world.seenHeart && world.captureProgress === 0) {
        assert.equal(snap.heart, null, `Cœur transmis avant d’être trouvé au pas ${tick}`);
      }
      for (const b of snap.braziers) {
        assert.ok(world.seenBraziers.has(b.id), `brasero ${b.id} transmis sans avoir été vu`);
      }
      for (const t of snap.newTiles) {
        assert.ok(world.explored.has(t.i), `tuile ${t.i} transmise sans avoir été explorée`);
      }
      for (const e of snap.tileEdits) {
        assert.ok(world.explored.has(e.i), `modification de la tuile ${e.i} transmise sans exploration`);
      }
      for (const b of snap.blockers) {
        const i = idx(Math.floor(b.x), Math.floor(b.y));
        assert.ok(world.explored.has(i), `obstacle en ${b.x},${b.y} transmis sans exploration`);
      }
      assert.equal(snap.self.influence, 0);
      assert.equal(snap.devices, undefined);
      assert.equal(snap.ownTraps, undefined);
    };

    // Un aller-retour large : entrée, rangée 8, salle du Cœur, brasero du sud.
    walkInvaderTo(world, { x: 8.5, y: 8.5 }, { maxSeconds: 25, onTick: audit });
    walkInvaderTo(world, world.braziers[0].pos, { maxSeconds: 40, onTick: audit });
    walkInvaderTo(world, world.braziers[2].pos, { maxSeconds: 40, onTick: audit });
    walkInvaderTo(world, world.braziers[1].pos, { maxSeconds: 40, onTick: audit, gait: 'careful' });
    walkInvaderTo(world, world.heart, { maxSeconds: 40, onTick: audit });

    assert.ok(checks > 800, `seulement ${checks} instantanés vérifiés`);
    assert.ok(world.seenHeart, 'le trajet doit finir par révéler le Cœur, sinon le test ne prouve rien');
  });

  test('le Cœur n’apparaît qu’au moment où on le voit', () => {
    const world = makeWorld({ heartIndex: 1 });
    const { invader } = filtersFor(world);
    let revealedBeforeSeen = false;

    walkInvaderTo(world, world.heart, {
      maxSeconds: 40,
      stopWithin: 1,
      onTick: (w, i) => {
        const snap = snapshotOf(invader, w, i);
        if (snap.heart !== null && !w.seenHeart && w.captureProgress === 0) revealedBeforeSeen = true;
      },
    });

    assert.equal(revealedBeforeSeen, false, 'le Cœur a été transmis avant d’avoir été trouvé');
    assert.ok(world.seenHeart);
    const snap = snapshotOf(invader, world);
    assert.deepEqual(snap.heart, { x: world.heart.x, y: world.heart.y });
  });

  test('un brasero reste invisible tant qu’on ne l’a pas vu — sauf s’il est acheté', () => {
    const world = makeWorld({ heartIndex: 1, intel: ['brazier'] });
    const intel = resolveIntel(COMPACT, world.build, world.loadout);
    assert.notEqual(intel.brazier, undefined, 'le renseignement doit désigner un brasero');

    const filter = new SnapshotFilter('invader', world, intel);
    run(world, 1);
    const snap = snapshotOf(filter, world);

    assert.deepEqual(auditSnapshot(snap, 'invader', world), []);
    assert.deepEqual(snap.braziers.map((b) => b.id), [intel.brazier]);
    assert.deepEqual(snap.hintedBraziers, [intel.brazier]);

    // Sans le renseignement, le même brasero reste muet.
    const blind = makeWorld({ heartIndex: 1 });
    const blindFilter = new SnapshotFilter('invader', blind, {});
    run(blind, 1);
    assert.deepEqual(snapshotOf(blindFilter, blind).braziers, []);
  });

  test('le tracé des murs se mérite, ou s’achète', () => {
    // Le tracé arrive par le delta `newTiles` du premier instantané, jamais
    // avant. Sans Plan volé, l'Envahisseur ne reçoit que ce qu'il a exploré.
    const world = makeWorld({ heartIndex: 1 });
    const filter = new SnapshotFilter('invader', world, {});
    run(world, 1);
    const plain = snapshotOf(filter, world);
    assert.ok(
      plain.newTiles.length > 0 && plain.newTiles.length < COMPACT.tiles.length,
      `sans Plan volé, seules les tuiles explorées arrivent (reçu ${plain.newTiles.length} sur ${COMPACT.tiles.length})`,
    );
    for (const t of plain.newTiles) {
      assert.ok(world.explored.has(t.i), `la tuile ${t.i} n’a pas été explorée`);
    }

    const thief = makeWorld({ heartIndex: 1, tools: ['stolenmap'] });
    const thiefFilter = new SnapshotFilter('invader', thief, {});
    run(thief, 1);
    const first = snapshotOf(thiefFilter, thief);
    assert.equal(
      first.newTiles.length,
      COMPACT.tiles.length,
      'le Plan volé donne tout le tracé, dès le premier instantané',
    );
    const second = snapshotOf(thiefFilter, thief);
    assert.deepEqual(second.newTiles, [], 'et une seule fois : le delta ne renvoie rien');
    assert.equal(first.heart, null, 'le Plan volé ne révèle pas le Cœur');
    assert.deepEqual(first.braziers, [], 'ni les braseros');
  });

  test('le Châtelain reçoit son propre château', () => {
    // Il « voit son plan en permanence » (§14). Sans cet envoi il jouait sur
    // une grille entièrement composée de murs, sans rien voir de ce qu'il
    // avait lui-même construit.
    const world = makeWorld({ heartIndex: 1 });
    const filter = new SnapshotFilter('castellan', world, {});
    const first = snapshotOf(filter, world);
    assert.equal(
      first.newTiles.length,
      COMPACT.tiles.length,
      'tout le plan arrive au premier instantané',
    );
    for (const t of first.newTiles) {
      assert.equal(t.t, world.castle.tiles[t.i], 'et il correspond au château réel');
    }
    run(world, 1);
    assert.deepEqual(snapshotOf(filter, world).newTiles, [], 'une seule fois');
  });
});

/* ==================================================================== */
/* Un vrai piège et un faux se ressemblent jusqu'à l'octet              */
/* ==================================================================== */

describe('indices : rien ne distingue un vrai piège d’un faux', () => {
  test('les deux entrées de `tells` ont la même forme et le même contenu', () => {
    const world = makeWorld({
      heartIndex: 0,
      traps: [
        { kind: 'spikes', x: SPIKES_TILE.x, y: SPIKES_TILE.y },
        // Le joueur a choisi pour son faux indice l'apparence de la fosse à pics.
        { kind: 'decoy', x: DECOY_TILE.x, y: DECOY_TILE.y, tell: 'seam' },
      ],
    });
    const { invader } = filtersFor(world);
    place(world.castellan, { x: 21.5, y: 21.5 });
    place(world.invader, BETWEEN);

    // Allure prudente : c'est elle qui fait lire les indices.
    run(world, seconds(0.5), input({ gait: 'careful', aim: Math.PI }));

    const snap = snapshotOf(invader, world);
    assert.deepEqual(auditSnapshot(snap, 'invader', world), []);
    assert.equal(snap.tells.length, 2, `${snap.tells.length} indices perçus au lieu de 2`);

    const spikes = snap.tells.find((t) => t.x === world.traps[0].x)!;
    const decoy = snap.tells.find((t) => t.x === world.traps[1].x)!;
    assert.ok(spikes && decoy, 'les deux indices doivent être là');

    assert.deepEqual(
      Object.keys(spikes).sort(),
      Object.keys(decoy).sort(),
      'les deux indices ne portent pas les mêmes champs',
    );
    assert.deepEqual(Object.keys(spikes).sort(), ['facing', 'id', 'tell', 'x', 'y']);
    assert.deepEqual(
      stripPosition(spikes),
      stripPosition(decoy),
      'une fois l’identifiant et la position retirés, il reste de quoi les distinguer',
    );
    assert.equal(
      JSON.stringify(stripPosition(spikes)),
      JSON.stringify(stripPosition(decoy)),
      'les charges utiles sérialisées diffèrent',
    );

    // Aucun autre champ de l'instantané ne trahit lequel est lequel.
    assert.deepEqual(snap.scars, []);
    assert.equal(snap.ownTraps, undefined);
    assert.equal(snap.devices, undefined);
    assert.equal(world.invader.hp, CFG.invader.maxHp, 'lire un indice ne doit rien déclencher');
  });

  test('deux manches identiques, l’une piégée, l’autre truquée : mêmes octets', () => {
    const make = (real: boolean) =>
      makeWorld({
        heartIndex: 0,
        traps: [
          real
            ? { kind: 'spikes', x: SPIKES_TILE.x, y: SPIKES_TILE.y }
            : { kind: 'decoy', x: SPIKES_TILE.x, y: SPIKES_TILE.y, tell: 'seam' },
        ],
      });

    const trapped = make(true);
    const faked = make(false);
    const trappedFilter = new SnapshotFilter('invader', trapped, {});
    const fakedFilter = new SnapshotFilter('invader', faked, {});

    for (const w of [trapped, faked]) {
      place(w.castellan, { x: 21.5, y: 21.5 });
      place(w.invader, BETWEEN);
    }

    const frame = input({ gait: 'careful', aim: Math.PI });
    for (let i = 1; i <= seconds(3); i++) {
      trapped.step(frame, IDLE);
      faked.step(frame, IDLE);
      assert.equal(
        JSON.stringify(snapshotOf(trappedFilter, trapped, i)),
        JSON.stringify(snapshotOf(fakedFilter, faked, i)),
        `au pas ${i}, la manche piégée et la manche truquée n’envoient pas la même chose`,
      );
    }

    // Le décor a bien été perçu : sans ça, comparer deux listes vides ne prouve rien.
    assert.equal(
      snapshotOf(trappedFilter, trapped).tells.length,
      1,
      'l’indice doit être perçu pendant toute la comparaison',
    );
    assert.ok(trapped.traps[0].discovered, 'l’indice doit avoir été lu au moins une fois');
    assert.ok(faked.traps[0].discovered);
    assert.equal(trapped.traps[0].state, 'armed', 'le vrai piège ne doit pas s’être déclenché');
  });

  test('un faux indice ne laisse jamais de cicatrice', () => {
    const world = makeWorld({
      heartIndex: 0,
      traps: [{ kind: 'decoy', x: SPIKES_TILE.x, y: SPIKES_TILE.y, tell: 'seam' }],
    });
    const { invader, castellan } = filtersFor(world);
    place(world.castellan, { x: 21.5, y: 21.5 });

    walkInvaderTo(world, { x: world.traps[0].x, y: world.traps[0].y }, { stopWithin: 0.15, maxSeconds: 30 });
    assert.deepEqual(snapshotOf(invader, world).scars, []);
    assert.deepEqual(snapshotOf(castellan, world).scars, [], 'même côté Châtelain');
  });
});

/* ==================================================================== */
/* Le miroir : ce que le Châtelain reçoit                               */
/* ==================================================================== */

describe('instantané destiné au Châtelain', () => {
  test('il voit son château, jamais les indices ni l’Envahisseur hors de vue', () => {
    const tiles = legalTrapTiles(COMPACT);
    const world = makeWorld({
      heartIndex: 0,
      traps: [
        { kind: 'spikes', x: SPIKES_TILE.x, y: SPIKES_TILE.y },
        { kind: 'decoy', x: DECOY_TILE.x, y: DECOY_TILE.y, tell: 'seam' },
      ],
      devices: [{ kind: 'trapdoor', x: tiles[9].x, y: tiles[9].y }],
    });
    const { castellan } = filtersFor(world);
    place(world.castellan, { x: 21.5, y: 21.5 });
    run(world, 1);

    const snap = snapshotOf(castellan, world);
    assert.deepEqual(auditSnapshot(snap, 'castellan', world), []);

    assert.deepEqual(snap.tells, [], 'le Châtelain n’a pas besoin qu’on lui montre ses propres indices');
    assert.equal(snap.other, null, 'l’Envahisseur est hors de vue');
    assert.equal(snap.self.influence, world.influence);
    assert.equal(snap.ownTraps?.length, 2, 'il connaît ses deux pièges');
    assert.equal(snap.devices?.length, 1);
    assert.deepEqual(snap.heart, { x: world.heart.x, y: world.heart.y });
    assert.equal(snap.hintedBraziers, undefined, 'les renseignements sont une affaire d’Envahisseur');
    assert.equal(snap.hintedHearts, undefined);
  });

  test('il ne reçoit ni les usages d’outils ni l’écu de l’Envahisseur', () => {
    const world = makeWorld({ heartIndex: 0, tools: ['buckler', 'crossbow'] });
    const { invader, castellan } = filtersFor(world);
    place(world.castellan, { x: 21.5, y: 21.5 });

    // L'Envahisseur lève son écu.
    run(world, 1, input({ tool: 0 }));
    run(world, 1);

    const mine = snapshotOf(invader, world);
    const theirs = snapshotOf(castellan, world);

    assert.equal(mine.self.shieldHp, CFG.toolParams.buckler.absorb, 'l’écu doit être visible par son porteur');
    assert.equal(mine.self.toolUses.length, 2);
    assert.equal(theirs.self.shieldHp, 0, 'l’état de l’écu adverse ne doit pas transiter');
    assert.deepEqual(theirs.self.toolUses, [], 'ni les munitions restantes');
    assert.deepEqual(theirs.self.toolCooldowns, []);
    assert.deepEqual(auditSnapshot(theirs, 'castellan', world), []);
  });

  test('rien ne fuit vers le Châtelain sur une longue manche mouvementée', () => {
    const tiles = legalTrapTiles(COMPACT);
    const world = makeWorld({
      heartIndex: 1,
      traps: [
        { kind: 'spikes', x: tiles[0].x, y: tiles[0].y },
        { kind: 'decoy', x: tiles[1].x, y: tiles[1].y, tell: 'dust' },
      ],
      devices: [{ kind: 'trapdoor', x: tiles[10].x, y: tiles[10].y }],
    });
    const { castellan } = filtersFor(world);
    const r = rng(0x51de);

    const control = () =>
      input({
        move: { x: r() * 2 - 1, y: r() * 2 - 1 },
        aim: r() * Math.PI * 2,
        gait: r() < 0.4 ? 'careful' : 'normal',
        scry: r() < 0.15,
        device: r() < 0.05 ? 0 : -1,
      });

    run(world, 2500, control, control, (w, i) => {
      const snap = snapshotOf(castellan, w, i);
      const problems = auditSnapshot(snap, 'castellan', w);
      assert.deepEqual(problems, [], `fuite au pas ${i} : ${problems.join(' / ')}`);
      if (!w.castellanSees()) assert.equal(snap.other, null);
      assert.deepEqual(snap.tells, []);
    });
  });
});

/* ==================================================================== */
/* Le son se filtre comme le reste                                      */
/* ==================================================================== */

describe('événements audibles', () => {
  test('une allure prudente n’émet aucun pas', () => {
    const world = makeWorld({ heartIndex: 1 });
    place(world.castellan, { x: 21.5, y: 21.5 });
    const heard: GameEvent[] = [];

    walkInvaderTo(world, { x: 8.5, y: 8.5 }, {
      gait: 'careful',
      maxSeconds: 40,
      onTick: (w) => heard.push(...w.drainEvents()),
    });

    assert.equal(
      heard.filter((e) => e.k === 'step' && e.role === 'invader').length,
      0,
      'l’allure prudente doit être parfaitement silencieuse (§4)',
    );
  });

  test('un pas lointain ne parvient pas au Châtelain', () => {
    const world = makeWorld({ heartIndex: 1 });
    place(world.castellan, { x: 21.5, y: 21.5 });
    const near: GameEvent = { k: 'step', role: 'invader', x: 21.5, y: 20.5, loud: false };
    const far: GameEvent = { k: 'step', role: 'invader', x: 2.5, y: 2.5, loud: false };
    const loudFar: GameEvent = { k: 'step', role: 'invader', x: 2.5, y: 2.5, loud: true };

    assert.deepEqual(filterEvents([near], 'castellan', world), [near]);
    assert.deepEqual(filterEvents([far], 'castellan', world), []);
    assert.deepEqual(filterEvents([loudFar], 'castellan', world), [loudFar], 'la course s’entend partout');
    assert.deepEqual(filterEvents([near], 'invader', world), [], 'on n’entend pas ses propres pas');
  });

  test('la vignette de rejeu est pour le Châtelain, la Sonde pour l’Envahisseur', () => {
    const world = makeWorld({ heartIndex: 1 });
    const replay: GameEvent = { k: 'replay', trap: 'spikes', x: 5.5, y: 5.5 };
    const probe: GameEvent = { k: 'probe', x: 5.5, y: 5.5 };
    const scry: GameEvent = { k: 'scry', on: true };

    assert.deepEqual(filterEvents([replay, probe, scry], 'castellan', world), [replay, scry]);
    assert.deepEqual(filterEvents([replay, probe, scry], 'invader', world), [probe]);
  });

  test('un piège déclenché s’entend des deux côtés', () => {
    const world = makeWorld({ heartIndex: 1 });
    const trap: GameEvent = { k: 'trap', trap: 'boulder', x: 5.5, y: 5.5, hit: true };
    const alarm: GameEvent = { k: 'alarm', x: 5.5, y: 5.5 };
    assert.deepEqual(filterEvents([trap, alarm], 'castellan', world), [trap, alarm]);
    assert.deepEqual(filterEvents([trap, alarm], 'invader', world), [trap, alarm]);
  });
});

/* ==================================================================== */
/* Fuites réelles                                                       */
/* ==================================================================== */

describe('fuites d’information constatées', () => {
  test('la distance au Cœur ne permet plus de le trianguler', () => {
    // Ce test documentait une fuite : `heartDist` était transmis sans limite,
    // et trois relevés suffisaient à retrouver le Cœur au millionième de tuile
    // depuis l'autre bout du château. La distance est désormais bornée à la
    // portée du battement (§10) et arrondie à l'intérieur : hors de portée elle
    // est constante, donc la trilatération n'a plus de solution.
    const world = makeWorld({ heartIndex: 2 });
    const filter = new SnapshotFilter('invader', world, {});
    place(world.castellan, { x: 21.5, y: 21.5 });

    const posts = [
      { x: 2.5, y: 2.5 },
      { x: 5.5, y: 2.5 },
      { x: 2.5, y: 5.5 },
    ];
    const samples = posts.map((p) => {
      place(world.invader, p);
      const snap = snapshotOf(filter, world);
      assert.equal(snap.heart, null, 'le Cœur n’a jamais été légitimement révélé');
      assert.ok(
        snap.heartDist <= CFG.heart.heartbeatRadius,
        'la distance transmise ne dépasse jamais la portée du battement',
      );
      return { ...p, d: snap.heartDist };
    });

    // Les trois relevés sont hors de portée : ils valent tous exactement la
    // portée maximale, et ne décrivent donc plus trois cercles distincts.
    const trueDistances = posts.map((p) => dist(p, world.heart));
    assert.ok(
      trueDistances.every((d) => d > CFG.heart.heartbeatRadius),
      'les trois postes d’observation sont bien hors de portée',
    );
    assert.ok(
      samples.every((s) => s.d === CFG.heart.heartbeatRadius),
      `hors de portée, la valeur transmise est constante — relevés ${JSON.stringify(samples.map((s) => s.d))}`,
    );

    // À l'intérieur de la portée, l'arrondi laisse une incertitude réelle.
    place(world.invader, { x: 11.5, y: 11.5 });
    const near = snapshotOf(filter, world);
    const exact = dist({ x: 11.5, y: 11.5 }, world.heart);
    if (exact < CFG.heart.heartbeatRadius) {
      assert.ok(
        Math.abs(near.heartDist - exact) > 1e-9 || exact % 2 === 0,
        'la distance audible est arrondie, pas exacte',
      );
    }
  });

  test(
    'une Extinction lancée dans une aile inexplorée ne doit pas être annoncée',
    () => {
      const world = makeWorld({
        heartIndex: 0,
        devices: [{ kind: 'douse', x: 20, y: 20 }],
      });
      const filter = new SnapshotFilter('invader', world, {});
      place(world.invader, { x: 2.5, y: 2.5 });
      world.activateDevice(world.devices[0]);
      run(world, 1);

      assert.equal(
        world.explored.has(idx(20, 20)),
        false,
        'le test doit porter sur une aile inexplorée',
      );
      const snap = snapshotOf(filter, world);
      assert.deepEqual(snap.doused, [], 'la zone éteinte a été transmise sans exploration');
    },
  );

  test(
    'la brèche ne doit pas révéler les pièges jamais découverts',
    () => {
      const world = makeWorld({ heartIndex: 0, traps: [{ kind: 'spikes', x: 17, y: 3 }] });
      const filter = new SnapshotFilter('invader', world, {});
      place(world.castellan, { x: 2.5, y: 2.5 });
      place(world.invader, world.heart);

      run(world, seconds(11));
      assert.equal(world.breached, true);
      assert.equal(world.traps[0].state, 'disabled');
      assert.equal(world.traps[0].discovered, false, 'le piège n’a jamais été repéré');

      const snap: Snapshot = snapshotOf(filter, world);
      assert.deepEqual(
        snap.scars,
        [],
        'un piège désactivé sans avoir été découvert ne doit pas apparaître',
      );
    },
  );
});

/* ==================================================================== */
/* Le renseignement acheté, et lui seul                                 */
/* ==================================================================== */

describe('renseignement transmis', () => {
  test('sans achat, aucun indice de Cœur ni de brasero', () => {
    const world = makeWorld({ heartIndex: 2 });
    const filter = new SnapshotFilter('invader', world, {});
    run(world, 1);
    const snap = snapshotOf(filter, world);
    assert.deepEqual(snap.hintedHearts, []);
    assert.deepEqual(snap.hintedBraziers, []);
    assert.equal(snap.heart, null);
  });

  test('« Emplacement du Cœur » n’envoie que les candidats éliminés', () => {
    const world = makeWorld({ heartIndex: 2, intel: ['heart'] });
    const intel = resolveIntel(COMPACT, world.build, makeLoadout({ intel: ['heart'] }));
    const filter = new SnapshotFilter('invader', world, intel);
    run(world, 1);
    const snap = snapshotOf(filter, world);

    assert.deepEqual(auditSnapshot(snap, 'invader', world), []);
    assert.deepEqual(snap.hintedHearts, [0, 1]);
    assert.ok(!snap.hintedHearts!.includes(2), 'le vrai Cœur n’est jamais dans la liste des éliminés');
  });
});
