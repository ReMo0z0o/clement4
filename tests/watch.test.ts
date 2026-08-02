/**
 * Les trois ajouts de cette manche de travail, vérifiés dans la simulation
 * réelle et non dans la configuration : l'œil de guet qui voit à travers les
 * murs, le Cœur disputé qui suspend le chrono, et la carte de prédiction du
 * client qui ne doit plus prendre l'inexploré pour de la pierre.
 *
 * Chacun de ces trois points est né d'un défaut constaté en jouant. Les tests
 * sont écrits pour échouer si le défaut revient, pas pour décrire le code.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CFG,
  IDLE,
  SnapshotFilter,
  auditSnapshot,
  dist,
  filterEvents,
  makeWorld,
  place,
  run,
  seconds,
  snapshotOf,
} from './helpers';
import { ClientView } from '../src/net/clientView';
import { getPlan } from '../src/game/plans/index';
import { T, emptyInput } from '../src/game/types';
import { idx } from '../src/game/grid';

/* ==================================================================== */
/* L'œil de guet                                                        */
/* ==================================================================== */

describe('yeux de guet', () => {
  /** Un monde où le guet tient l'Envahisseur et le Châtelain est à l'opposé. */
  function watched() {
    const world = makeWorld({ sensors: [{ x: 11, y: 4 }] });
    place(world.castellan, { x: 1.5, y: 22.5 });
    place(world.invader, { x: 11.5, y: 4.5 });
    return world;
  }

  test('il montre l’Envahisseur sans ligne de vue, et seulement dans son cercle', () => {
    const world = watched();
    run(world, 1);
    assert.ok(
      !world.castle.losClear(world.castellan.pos, world.invader.pos) ||
        dist(world.castellan.pos, world.invader.pos) > CFG.vision.castellanRange,
      'le test ne prouve rien si le Châtelain le voyait déjà de ses yeux',
    );
    assert.equal(world.castellanSees(), 'sensor');

    // Deux pas hors du cercle : la vision s'arrête net.
    place(world.invader, { x: 11.5, y: 4.5 + CFG.sensors.radius + 1 });
    run(world, 1);
    assert.equal(world.castellanSees(), null, 'le guet voit au-delà de son propre cercle');
  });

  test('la réserve de veille s’épuise, et le guet s’éteint pour de bon', () => {
    const world = watched();
    run(world, seconds(CFG.sensors.watchTime + 2));
    assert.equal(world.sensors[0].watchLeft, 0);
    assert.equal(
      world.castellanSees(),
      null,
      'un guet à réserve vide continue de montrer l’Envahisseur',
    );
  });

  test('deux cercles superposés ne vident pas deux réserves pour la même vue', () => {
    const world = makeWorld({ sensors: [{ x: 11, y: 4 }, { x: 12, y: 4 }] });
    place(world.castellan, { x: 1.5, y: 22.5 });
    place(world.invader, { x: 11.9, y: 4.5 });
    const before = world.sensors.map((g) => g.watchLeft);
    run(world, seconds(2));
    const drained = world.sensors.filter((g, i) => g.watchLeft < before[i]).length;
    assert.equal(drained, 1, 'la même information a été facturée deux fois');
  });

  test('l’Envahisseur apprend le guet qui le tient — et lui seul', () => {
    const world = makeWorld({ sensors: [{ x: 11, y: 4 }, { x: 3, y: 20 }] });
    place(world.castellan, { x: 1.5, y: 22.5 });
    place(world.invader, { x: 11.5, y: 4.5 });
    const filter = new SnapshotFilter('invader', world, {});
    run(world, 1);

    const snap = snapshotOf(filter, world);
    assert.deepEqual(auditSnapshot(snap, 'invader', world), []);
    assert.deepEqual(snap.spotted, { x: 11.5, y: 4.5 }, 'il doit voir l’œil qui le tient');
    assert.equal(snap.sensors, undefined, 'la liste complète des guets ne lui appartient pas');

    // Hors de tout cercle, il ne sait plus rien.
    place(world.invader, { x: 2.5, y: 2.5 });
    run(world, 1);
    assert.equal(snapshotOf(filter, world).spotted, null);
  });

  test('le Châtelain reçoit la réserve de chaque œil, l’Envahisseur jamais', () => {
    const world = watched();
    const cas = new SnapshotFilter('castellan', world, {});
    const inv = new SnapshotFilter('invader', world, {});
    run(world, seconds(1));

    const forCastellan = snapshotOf(cas, world);
    assert.equal(forCastellan.sensors?.length, 1);
    assert.ok(forCastellan.sensors![0].watching);
    assert.ok(forCastellan.sensors![0].watchLeft < CFG.sensors.watchTime);
    assert.deepEqual(auditSnapshot(forCastellan, 'castellan', world), []);

    assert.deepEqual(auditSnapshot(snapshotOf(inv, world), 'invader', world), []);
  });

  test('l’extinction d’un œil ne s’entend que chez son propriétaire', () => {
    const world = watched();
    run(world, seconds(CFG.sensors.watchTime + 1));
    const events = world.drainEvents().filter((e) => e.k === 'sensor');
    assert.ok(events.length > 0, 'un guet qui s’éteint doit le signaler');
    assert.equal(filterEvents(events, 'invader', world).length, 0);
    assert.equal(filterEvents(events, 'castellan', world).length, events.length);
  });
});

/* ==================================================================== */
/* Le Cœur disputé                                                      */
/* ==================================================================== */

describe('Cœur disputé', () => {
  function standoff() {
    const world = makeWorld({ heartIndex: 0 });
    place(world.invader, world.heart);
    place(world.castellan, { x: world.heart.x + 0.4, y: world.heart.y });
    return world;
  }

  test('le chrono se suspend tant que les deux tiennent la salle', () => {
    const world = standoff();
    const t0 = world.timeLeft;
    run(world, seconds(4), IDLE, IDLE, (w) => {
      // On les maintient dans la salle : ce test porte sur le chrono, pas sur
      // l'issue du duel.
      place(w.invader, w.heart);
      place(w.castellan, { x: w.heart.x + 0.4, y: w.heart.y });
    });
    assert.ok(world.contested);
    assert.equal(world.timeLeft, t0);
  });

  test('personne ne se refait pendant la contestation', () => {
    const world = standoff();
    // Un pas d'abord : l'alarme se déclenche à l'entrée dans la salle et offre
    // son Influence. Ce qu'on mesure ici, c'est la recharge, pas ce cadeau.
    run(world, 1);
    world.castellan.hp = 40;
    const influence0 = world.influence;

    run(world, seconds(3), IDLE, IDLE, (w) => {
      place(w.invader, w.heart);
      place(w.castellan, { x: w.heart.x + 0.4, y: w.heart.y });
    });
    assert.equal(world.castellan.hp, 40, 'le Cœur soigne son défenseur pendant le face-à-face');
    const gained = world.influence - influence0;
    assert.ok(
      gained < CFG.castellan.influenceRegenHeart * 3 * 0.9,
      `le Cœur recharge encore à plein régime pendant le face-à-face (+${gained.toFixed(1)})`,
    );
  });

  test('le temps repart dès que l’un des deux sort', () => {
    const world = standoff();
    run(world, seconds(1), IDLE, IDLE, (w) => {
      place(w.invader, w.heart);
      place(w.castellan, { x: w.heart.x + 0.4, y: w.heart.y });
    });
    const held = world.timeLeft;
    place(world.castellan, { x: 1.5, y: 22.5 });
    run(world, seconds(1));
    assert.equal(world.contested, false);
    assert.ok(world.timeLeft < held, 'le chrono est resté bloqué après la fin de la contestation');
  });

  test('un Châtelain qui campe seul ne gèle pas le chrono', () => {
    const world = makeWorld({ heartIndex: 0 });
    place(world.castellan, world.heart);
    place(world.invader, { x: 1.5, y: 1.5 });
    const t0 = world.timeLeft;
    run(world, seconds(2));
    assert.ok(world.timeLeft < t0, 'camper seul sur le Cœur suspendait le temps');
  });
});

/* ==================================================================== */
/* La carte de prédiction du client                                     */
/* ==================================================================== */

describe('prédiction de déplacement côté client', () => {
  test('l’inexploré ne bloque pas la marche prédite', () => {
    const plan = getPlan('compact');
    const spawn = plan.invaderSpawn;
    const view = new ClientView(plan, 'invader', spawn);

    // Aucun instantané reçu : tout est inconnu. Le joueur pousse vers le sud,
    // là où le plan est effectivement dégagé.
    const open = { x: Math.floor(spawn.x), y: Math.floor(spawn.y) + 1 };
    assert.equal(
      plan.tiles[idx(open.x, open.y)],
      T.FLOOR,
      'le test doit porter sur une tuile réellement libre',
    );

    const before = { ...view.pos };
    for (let i = 1; i <= 10; i++) {
      const f = emptyInput(i);
      f.move = { x: 0, y: 1 };
      view.pushInput(f);
    }
    assert.ok(
      view.pos.y > before.y + 0.3,
      `la prédiction s’est cognée dans du sol inexploré (${before.y} → ${view.pos.y})`,
    );
  });

  test('un mur transmis arrête bien la marche prédite', () => {
    const plan = getPlan('compact');
    const view = new ClientView(plan, 'invader', plan.invaderSpawn);

    // On révèle tout le plan tel qu'il est, comme le ferait l'hôte pour le
    // Châtelain : c'est le seul filtre qui envoie le château entier.
    const world = makeWorld();
    const filter = new SnapshotFilter('castellan', world, {});
    run(world, 1);
    view.applySnapshot(snapshotOf(filter, world), 0);

    // Une dalle qui a un mur juste au nord, quelle que soit la carte.
    let stand: { x: number; y: number } | null = null;
    for (let y = 1; y < 24 && !stand; y++) {
      for (let x = 0; x < 24; x++) {
        if (plan.tiles[idx(x, y)] !== T.FLOOR) continue;
        if (plan.tiles[idx(x, y - 1)] !== T.WALL) continue;
        stand = { x: x + 0.5, y: y + 0.5 };
        break;
      }
    }
    assert.ok(stand, 'aucune dalle adossée à un mur : le plan de test ne convient pas');

    view.pos = { ...stand! };
    for (let i = 1; i <= 20; i++) {
      const f = emptyInput(i);
      f.move = { x: 0, y: -1 };
      view.pushInput(f);
    }
    assert.ok(
      view.pos.y >= stand!.y - 0.5,
      `la prédiction traverse un mur pourtant transmis (${stand!.y} → ${view.pos.y})`,
    );
  });

  test('la visée suit l’instantané quand le client ne prédit rien (cas de l’hôte)', () => {
    const plan = getPlan('compact');
    const view = new ClientView(plan, 'castellan', plan.castellanSpawn);
    const world = makeWorld();
    const filter = new SnapshotFilter('castellan', world, {});
    world.castellan.aim = 2.1;
    run(world, 1);
    world.castellan.aim = 2.1;

    view.applySnapshot(snapshotOf(filter, world), 0);
    assert.equal(view.aim, 2.1, 'l’hôte regardait toujours vers l’est, quoi que fasse sa souris');
  });
});
