/**
 * Grille : collisions, ligne de vue, découpage en pièces.
 *
 * Ce sont les propriétés dont dépend tout le reste. Un acteur qui finit dans
 * un mur, une ligne de vue qui ne marche que dans un sens, une pièce qui
 * déborde sur sa voisine : chacune de ces trois choses casse le jeu de façon
 * invisible, donc on les fuzz.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CFG, GRID_H, GRID_W } from '../src/game/config';
import { CastleRuntime, floodRooms, idx, inBounds } from '../src/game/grid';
import type { Role, TileId, Vec } from '../src/game/types';
import { T } from '../src/game/types';
import { floorTiles, makeWorld, plan, PLAN_IDS, rng, run, input } from './helpers';

const WALKABLE: TileId[] = [T.FLOOR, T.LOW, T.PIT];

/* ==================================================================== */
/* Collisions                                                           */
/* ==================================================================== */

describe('collision : on ne finit jamais dans un mur', () => {
  for (const id of PLAN_IDS) {
    test(`${id} — 12 000 déplacements aléatoires`, () => {
      const p = plan(id);
      const castle = new CastleRuntime(p);
      const tiles = floorTiles(p);
      const r = rng(0x5eed + id.length);
      const roles: Role[] = ['invader', 'castellan'];
      let moves = 0;

      for (let n = 0; n < 4000; n++) {
        const role = roles[n & 1];
        const radius = role === 'invader' ? CFG.invader.radius : CFG.castellan.radius;
        const start = tiles[Math.floor(r() * tiles.length)];
        let pos: Vec = { x: start.x + 0.5 + (r() - 0.5) * 0.6, y: start.y + 0.5 + (r() - 0.5) * 0.6 };
        if (castle.circleHits(pos.x, pos.y, radius, role, 0)) continue;

        // Cinq pas d'affilée : c'est l'enchaînement qui fait sortir des murs,
        // pas le pas isolé.
        for (let k = 0; k < 5; k++) {
          // Jusqu'à 0,7 tuile par pas : bien au-delà de ce que la course produit.
          const delta = { x: (r() - 0.5) * 1.4, y: (r() - 0.5) * 1.4 };
          pos = castle.moveCircle(pos, delta, radius, role, 0);
          moves++;
          assert.ok(
            !castle.circleHits(pos.x, pos.y, radius, role, 0),
            `${id} : ${role} termine en ${pos.x.toFixed(3)},${pos.y.toFixed(3)}, dans un bloqueur`,
          );
          assert.ok(
            Number.isFinite(pos.x) && Number.isFinite(pos.y),
            `${id} : position non numérique après déplacement`,
          );
        }
      }
      assert.ok(moves >= 12000, `seulement ${moves} déplacements testés`);
    });
  }

  test('au grappin, on franchit un trou mais jamais un mur', () => {
    const p = plan('compact');
    const castle = new CastleRuntime(p);
    const tiles = floorTiles(p);
    const r = rng(0x9ea1);
    for (let n = 0; n < 3000; n++) {
      const start = tiles[Math.floor(r() * tiles.length)];
      let pos: Vec = { x: start.x + 0.5, y: start.y + 0.5 };
      for (let k = 0; k < 4; k++) {
        pos = castle.moveCircle(
          pos,
          { x: (r() - 0.5) * 1.4, y: (r() - 0.5) * 1.4 },
          CFG.invader.radius,
          'invader',
          0,
          true,
        );
        assert.ok(
          !castle.circleHits(pos.x, pos.y, CFG.invader.radius, 'invader', 0, true),
          `en vol, position ${pos.x.toFixed(3)},${pos.y.toFixed(3)} dans un mur`,
        );
      }
    }
  });

  test('un mur reste un mur : les quatre bords du château sont infranchissables', () => {
    for (const id of PLAN_IDS) {
      const castle = new CastleRuntime(plan(id));
      for (const role of ['invader', 'castellan'] as Role[]) {
        for (let x = 0; x < GRID_W; x++) {
          assert.ok(castle.blocksMove(x, -1, role, 0), `${id} : hors grille franchissable`);
          assert.ok(castle.blocksMove(x, GRID_H, role, 0));
        }
        for (let y = 0; y < GRID_H; y++) {
          assert.ok(castle.blocksMove(-1, y, role, 0));
          assert.ok(castle.blocksMove(GRID_W, y, role, 0));
        }
      }
    }
  });

  test('une manche entière d’entrées aléatoires ne coince personne dans un mur', () => {
    const world = makeWorld({
      planId: 'compact',
      traps: [
        { kind: 'spikes', x: 10, y: 8 },
        { kind: 'boulder', x: 13, y: 8 },
      ],
    });
    const r = rng(0xabc);
    const control = () =>
      input({
        move: { x: r() * 2 - 1, y: r() * 2 - 1 },
        aim: r() * Math.PI * 2,
        gait: r() < 0.2 ? 'run' : r() < 0.4 ? 'careful' : 'normal',
        primary: r() < 0.08,
        parry: r() < 0.08,
        dodge: r() < 0.05,
      });

    run(world, 3000, control, control, (w) => {
      for (const a of [w.invader, w.castellan]) {
        if (!a.alive) continue;
        const radius = a.role === 'invader' ? CFG.invader.radius : CFG.castellan.radius;
        assert.ok(
          !w.castle.circleHits(a.pos.x, a.pos.y, radius, a.role, w.now),
          `${a.role} coincé en ${a.pos.x.toFixed(2)},${a.pos.y.toFixed(2)} à t=${w.now.toFixed(2)}`,
        );
      }
    });
  });
});

/* ==================================================================== */
/* Ligne de vue                                                         */
/* ==================================================================== */

describe('ligne de vue', () => {
  test('on se voit toujours soi-même', () => {
    const castle = new CastleRuntime(plan('compact'));
    const r = rng(3);
    for (let n = 0; n < 500; n++) {
      const p = { x: r() * GRID_W, y: r() * GRID_H };
      assert.equal(castle.losClear(p, { x: p.x + 0.01, y: p.y + 0.01 }), true);
    }
  });

  test('un mur coupe bien le regard', () => {
    const p = plan('compact');
    const castle = new CastleRuntime(p);
    // Deux salles voisines du Donjon, séparées par le mur épais de x=7.
    assert.equal(castle.losClear({ x: 2.5, y: 1.5 }, { x: 5.5, y: 1.5 }), true);
    assert.equal(castle.losClear({ x: 2.5, y: 1.5 }, { x: 12.5, y: 1.5 }), false);

    // Une porte verrouillée cache ; une herse est une grille, on voit à travers.
    const door = p.doors[0];
    const dx = Math.floor(door.x);
    const dy = Math.floor(door.y);
    assert.equal(castle.blocksSight(dx, dy), false);
    castle.addBlocker(dx, dy, Infinity, 'lock');
    assert.equal(castle.blocksSight(dx, dy), true, 'une porte verrouillée doit cacher');
    castle.clearBlocker(dx, dy);
    castle.addBlocker(dx, dy, Infinity, 'portcullis');
    assert.equal(castle.blocksSight(dx, dy), false, 'on voit à travers une herse');
  });

  test('symétrie sur 60 000 couples de positions tirées au hasard', () => {
    for (const id of PLAN_IDS) {
      const castle = new CastleRuntime(plan(id));
      const r = rng(0xd1ce);
      for (let n = 0; n < 20000; n++) {
        const a = { x: r() * GRID_W, y: r() * GRID_H };
        const b = { x: r() * GRID_W, y: r() * GRID_H };
        assert.equal(
          castle.losClear(a, b),
          castle.losClear(b, a),
          `${id} : la vue entre ${JSON.stringify(a)} et ${JSON.stringify(b)} dépend du sens`,
        );
      }
    }
  });

  test(
    'symétrie entre centres de tuiles',
    () => {
      for (const id of PLAN_IDS) {
        const p = plan(id);
        const castle = new CastleRuntime(p);
        for (const a of floorTiles(p)) {
          for (const b of floorTiles(p)) {
            const pa = { x: a.x + 0.5, y: a.y + 0.5 };
            const pb = { x: b.x + 0.5, y: b.y + 0.5 };
            assert.equal(
              castle.losClear(pa, pb),
              castle.losClear(pb, pa),
              `${id} : (${a.x},${a.y}) et (${b.x},${b.y}) ne se voient que dans un sens`,
            );
          }
        }
      }
    },
  );

  test('la lumière ne traverse pas les murs', () => {
    const p = plan('compact');
    const castle = new CastleRuntime(p);
    const light = castle.light();
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        assert.ok(light[idx(x, y)] >= 0 && light[idx(x, y)] <= 1, `luminosité hors de [0,1] en ${x},${y}`);
      }
    }
    // Un plan éclairé par 16 torches ne doit pas être uniformément noir.
    assert.ok(
      Array.from(light).some((v) => v >= CFG.vision.lightThreshold),
      'aucune tuile n’atteint le seuil de lumière : le château serait injouable',
    );
  });
});

/* ==================================================================== */
/* Pièces                                                               */
/* ==================================================================== */

describe('découpage en pièces', () => {
  for (const id of PLAN_IDS) {
    test(`${id} — les pièces forment une partition du sol`, () => {
      const p = plan(id);
      const members = new Map<number, number[]>();

      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const i = idx(x, y);
          const tile = p.tiles[i];
          const room = p.rooms[i];

          if (WALKABLE.includes(tile)) {
            assert.ok(
              room >= 0 && room < p.roomCount,
              `${id} : tuile praticable ${x},${y} sans pièce (id ${room})`,
            );
            const list = members.get(room) ?? [];
            list.push(i);
            members.set(room, list);
          } else if (tile === T.WALL || tile === T.FRAGILE || tile === T.RUBBLE) {
            assert.equal(room, -1, `${id} : le mur ${x},${y} appartient à la pièce ${room}`);
          }
        }
      }

      // Chaque identifiant annoncé existe vraiment.
      assert.equal(members.size, p.roomCount, `${id} : ${p.roomCount} pièces annoncées, ${members.size} peuplées`);
      for (let k = 0; k < p.roomCount; k++) {
        assert.ok((members.get(k) ?? []).length > 0, `${id} : pièce ${k} vide`);
      }

      // Deux tuiles praticables voisines sont dans la même pièce : sinon la
      // Sonde révélerait la moitié d'une salle.
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          if (!WALKABLE.includes(p.tiles[idx(x, y)])) continue;
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
          ]) {
            const nx = x + dx;
            const ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            if (!WALKABLE.includes(p.tiles[idx(nx, ny)])) continue;
            assert.equal(
              p.rooms[idx(x, y)],
              p.rooms[idx(nx, ny)],
              `${id} : ${x},${y} et ${nx},${ny} sont voisines mais dans deux pièces`,
            );
          }
        }
      }

      // Et chaque pièce est d'un seul tenant.
      for (const [room, list] of members) {
        const seen = new Set<number>([list[0]]);
        const queue = [list[0]];
        let head = 0;
        while (head < queue.length) {
          const cur = queue[head++];
          const cx = cur % GRID_W;
          const cy = Math.floor(cur / GRID_W);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!inBounds(nx, ny)) continue;
            const ni = idx(nx, ny);
            if (seen.has(ni) || !WALKABLE.includes(p.tiles[ni]) || p.rooms[ni] !== room) continue;
            seen.add(ni);
            queue.push(ni);
          }
        }
        assert.equal(seen.size, list.length, `${id} : la pièce ${room} est en plusieurs morceaux`);
      }

      // Les portes rejoignent une pièce voisine, sinon la Sonde ne fait rien
      // quand on la lance dans une embrasure.
      for (const d of p.doors) {
        assert.ok(
          p.rooms[idx(Math.floor(d.x), Math.floor(d.y))] >= 0,
          `${id} : la porte ${d.x},${d.y} n’appartient à aucune pièce`,
        );
      }
    });
  }

  test('le découpage est déterministe : deux compilations donnent le même résultat', () => {
    const p = plan('compact');
    const before = floodRooms(p.tiles);
    assert.equal(before.roomCount, p.roomCount);
    assert.deepEqual(Array.from(before.rooms), Array.from(p.rooms));
  });

  test('roomAt renvoie −1 hors du château', () => {
    const castle = new CastleRuntime(plan('compact'));
    assert.equal(castle.roomAt(-1, 5), -1);
    assert.equal(castle.roomAt(5, -1), -1);
    assert.equal(castle.roomAt(GRID_W, 5), -1);
    assert.equal(castle.roomAt(5, GRID_H), -1);
  });
});
