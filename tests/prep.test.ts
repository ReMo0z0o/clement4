/**
 * Économie de préparation — critère d'acceptation §8 :
 *
 *   « un budget ne doit JAMAIS pouvoir être dépassé, quelle que soit
 *     l'interface qui a produit l'ordre de construction. »
 *
 * On envoie donc à `sanitizeBuild` / `sanitizeLoadout` exactement ce qu'un
 * client trafiqué enverrait, et on vérifie la sortie, jamais l'intention.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CFG, TELL_KINDS, TOOL_KINDS, TRAP_KINDS, DEVICE_KINDS, INTEL_KINDS } from '../src/game/config';
import type { IntelKind, ToolKind } from '../src/game/config';
import { idx } from '../src/game/grid';
import { prepareRedress, resolveIntel } from '../src/game/prep';
import type { BuildOrder, Loadout } from '../src/game/types';
import { T, dist } from '../src/game/types';
import {
  assertBuildLegal,
  assertLoadoutLegal,
  buildCost,
  emptyBuild,
  emptyLoadout,
  floorTiles,
  hostileTrap,
  legalTrapTiles,
  loadoutCost,
  makeLoadout,
  pick,
  plan,
  PLAN_IDS,
  rng,
  sanitizeBuild,
  sanitizeLoadout,
} from './helpers';

const COMPACT = plan('compact');

/* ==================================================================== */
/* Le château                                                           */
/* ==================================================================== */

describe('sanitizeBuild — le budget du Châtelain', () => {
  test('40 pièges pour 100 points : la facture reste sous le budget', () => {
    const tiles = legalTrapTiles(COMPACT);
    assert.ok(tiles.length >= 40, 'le plan de référence doit offrir 40 emplacements légaux');

    const raw = emptyBuild('compact');
    raw.traps = tiles.slice(0, 40).map((t, i) => ({
      id: i,
      kind: 'spikes' as const,
      x: t.x + 0.5,
      y: t.y + 0.5,
      tell: 'seam' as const,
      facing: 0,
    }));

    const { build, verdict } = sanitizeBuild(COMPACT, raw);
    assertBuildLegal(COMPACT, build, '40 fosses à pics');
    // 40 × 15 = 600 demandés, 100 accordés : au plus 6 fosses survivent.
    assert.equal(build.traps.length, Math.floor(CFG.budget.castellan / CFG.traps.spikes.cost));
    assert.ok(verdict.problems.length > 0, 'le joueur doit être prévenu de ce qui a été retiré');
    assert.equal(verdict.ok, false);
  });

  test('un piège par tuile : dix pièges empilés n’en font qu’un', () => {
    const t = legalTrapTiles(COMPACT)[10];
    const raw = emptyBuild('compact');
    raw.traps = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      kind: 'chest' as const,
      x: t.x + 0.5,
      y: t.y + 0.5,
      tell: 'chest' as const,
      facing: 0,
    }));

    const { build } = sanitizeBuild(COMPACT, raw);
    assertBuildLegal(COMPACT, build, 'pièges empilés');
    assert.equal(build.traps.length, 1);
    assert.equal(build.spent, CFG.traps.chest.cost);
  });

  test('un piège dans un mur est retiré', () => {
    const walls: { x: number; y: number }[] = [];
    for (let y = 0; y < COMPACT.h && walls.length < 12; y++) {
      for (let x = 0; x < COMPACT.w && walls.length < 12; x++) {
        if (COMPACT.tiles[idx(x, y)] === T.WALL) walls.push({ x, y });
      }
    }

    const raw = emptyBuild('compact');
    raw.traps = walls.map((w, i) => ({
      id: i,
      kind: 'boulder' as const,
      x: w.x + 0.5,
      y: w.y + 0.5,
      tell: 'dust' as const,
      facing: 0,
    }));

    const { build } = sanitizeBuild(COMPACT, raw);
    assert.equal(build.traps.length, 0);
    assert.equal(build.spent, 0);
    assertBuildLegal(COMPACT, build, 'pièges murés');
  });

  test('rien à moins de 2,5 tuiles de l’entrée de l’Envahisseur', () => {
    const near = floorTiles(COMPACT).filter(
      (t) => dist({ x: t.x + 0.5, y: t.y + 0.5 }, COMPACT.invaderSpawn) < 2.5,
    );
    assert.ok(near.length > 0, 'le plan doit avoir du sol près de l’entrée, sinon le test ne prouve rien');

    const raw = emptyBuild('compact');
    raw.traps = near.map((t, i) => ({
      id: i,
      kind: 'spikes' as const,
      x: t.x + 0.5,
      y: t.y + 0.5,
      tell: 'seam' as const,
      facing: 0,
    }));

    const { build } = sanitizeBuild(COMPACT, raw);
    assert.equal(build.traps.length, 0, 'mourir avant d’avoir joué est interdit (§2.4)');
    assertBuildLegal(COMPACT, build, 'pièges à l’entrée');
  });

  test('coordonnées négatives, NaN ou infinies : rien n’est posé', () => {
    const bad = [
      { x: -1, y: -1 },
      { x: -0.0001, y: 5.5 },
      { x: NaN, y: NaN },
      { x: 5.5, y: NaN },
      { x: Infinity, y: Infinity },
      { x: -Infinity, y: 3.5 },
      { x: 1e9, y: 1e9 },
      { x: COMPACT.w + 0.5, y: 3.5 },
    ];

    const raw = emptyBuild('compact');
    raw.traps = bad.map((b, i) =>
      hostileTrap({ id: i, kind: 'arrows', x: b.x, y: b.y, tell: 'slit', facing: 0 }),
    );

    const { build } = sanitizeBuild(COMPACT, raw);
    assert.equal(build.traps.length, 0);
    assert.equal(build.spent, 0);
    assertBuildLegal(COMPACT, build, 'coordonnées absurdes');
  });

  test('une orientation NaN devient 0 plutôt que de contaminer la partie', () => {
    const t = legalTrapTiles(COMPACT)[5];
    const raw = emptyBuild('compact');
    raw.traps = [
      hostileTrap({ id: 0, kind: 'boulder', x: t.x + 0.5, y: t.y + 0.5, tell: 'dust', facing: NaN }),
    ];
    const { build } = sanitizeBuild(COMPACT, raw);
    assert.equal(build.traps.length, 1);
    assert.equal(build.traps[0].facing, 0);
    assertBuildLegal(COMPACT, build, 'orientation NaN');
  });

  test('types de pièges inconnus : ignorés sans rien coûter', () => {
    const tiles = legalTrapTiles(COMPACT);
    const raw = emptyBuild('compact');
    raw.traps = ['catapulte', 'SPIKES', 'spikes ', '', 'trap', '0'].map((k, i) =>
      hostileTrap({ id: i, kind: k, x: tiles[i].x + 0.5, y: tiles[i].y + 0.5, tell: 'seam', facing: 0 }),
    );

    const { build } = sanitizeBuild(COMPACT, raw);
    assert.equal(build.traps.length, 0);
    assert.equal(build.spent, 0);
    assertBuildLegal(COMPACT, build, 'types inconnus');
  });

  test('un emplacement de Cœur hors liste retombe sur un candidat valide', () => {
    for (const h of [-5, 99, 1.5, NaN, Infinity]) {
      const raw = emptyBuild('compact');
      raw.heartIndex = h;
      const { build } = sanitizeBuild(COMPACT, raw);
      assertBuildLegal(COMPACT, build, `heartIndex ${h}`);
    }
  });

  test('les listes absentes ne font pas tomber la validation', () => {
    const raw = { planId: 'compact' } as unknown as BuildOrder;
    const { build } = sanitizeBuild(COMPACT, raw);
    assertBuildLegal(COMPACT, build, 'ordre vide');
    assert.equal(build.spent, 0);
  });

  test('nettoyer deux fois donne le même château', () => {
    const tiles = legalTrapTiles(COMPACT);
    const raw = emptyBuild('compact');
    raw.traps = tiles.slice(0, 12).map((t, i) => ({
      id: i,
      kind: TRAP_KINDS[i % TRAP_KINDS.length],
      x: t.x + 0.5,
      y: t.y + 0.5,
      tell: TELL_KINDS[i % TELL_KINDS.length],
      facing: 0,
    }));
    raw.lockedDoors = [0, 1, 0];
    raw.secretDoors = [0];

    const once = sanitizeBuild(COMPACT, raw).build;
    const twice = sanitizeBuild(COMPACT, once).build;
    assert.deepEqual(twice, once, 'la validation doit être stable, sinon le budget dérive entre les manches');
    assertBuildLegal(COMPACT, once, 'idempotence');
  });

  test('fuzz : 400 ordres hostiles, aucun ne dépasse le budget', () => {
    const r = rng(0xc0ffee);
    const badKinds = ['catapulte', 'huile', '', 'Spikes', 'décoy'];

    for (const id of PLAN_IDS) {
      const p = plan(id);
      const legal = legalTrapTiles(p);

      for (let n = 0; n < 400; n++) {
        const raw = emptyBuild(p.id);
        raw.heartIndex = Math.floor(r() * 8) - 2;

        const count = Math.floor(r() * 30);
        raw.traps = Array.from({ length: count }, (_, i) => {
          const useLegalTile = r() < 0.7 && legal.length > 0;
          const tile = useLegalTile
            ? legal[Math.floor(r() * legal.length)]
            : { x: Math.floor(r() * 30) - 3, y: Math.floor(r() * 30) - 3 };
          const kind = r() < 0.85 ? pick(TRAP_KINDS, r) : (pick(badKinds, r) as never);
          return hostileTrap({
            id: i,
            kind,
            x: r() < 0.05 ? NaN : tile.x + 0.5,
            y: r() < 0.05 ? Infinity : tile.y + 0.5,
            tell: r() < 0.2 ? 'inconnu' : pick(TELL_KINDS, r),
            facing: r() < 0.1 ? NaN : r() * 7,
          });
        });

        raw.devices = Array.from({ length: Math.floor(r() * 8) }, (_, i) => {
          const onDoor = r() < 0.5 && p.doors.length > 0;
          const spot = onDoor
            ? p.doors[Math.floor(r() * p.doors.length)]
            : { x: (legal[Math.floor(r() * legal.length)]?.x ?? 0) + 0.5, y: (legal[Math.floor(r() * legal.length)]?.y ?? 0) + 0.5 };
          return {
            id: i,
            kind: pick(DEVICE_KINDS, r),
            x: spot.x,
            y: spot.y,
            facing: 0,
          };
        });

        raw.lockedDoors = Array.from({ length: Math.floor(r() * 6) }, () =>
          Math.floor(r() * (p.doors.length + 3)),
        );
        raw.secretDoors = Array.from({ length: Math.floor(r() * 6) }, () =>
          Math.floor(r() * (p.secretSpots.length + 3)),
        );

        const { build } = sanitizeBuild(p, raw);
        assertBuildLegal(p, build, `${id} #${n}`);
      }
    }
  });
});

/* ==================================================================== */
/* L'équipement                                                         */
/* ==================================================================== */

describe('sanitizeLoadout — le budget de l’Envahisseur', () => {
  test('un équipement à plus de 200 points est ramené sous les 60', () => {
    const raw: Loadout = {
      tools: [...TOOL_KINDS, ...TOOL_KINDS],
      intel: [...INTEL_KINDS, ...INTEL_KINDS],
      spent: 999,
    };
    const asked = loadoutCost(raw);
    assert.ok(asked > 200, `le test doit demander beaucoup plus que le budget (demandé ${asked})`);

    const { loadout, verdict } = sanitizeLoadout(raw);
    assertLoadoutLegal(loadout, 'panier plein');
    assert.ok(verdict.problems.length > 0);
  });

  test('six outils demandés, trois au maximum accordés', () => {
    const raw: Loadout = {
      tools: ['bombs', 'elixir', 'buckler', 'stolenmap', 'probe', 'grapple'],
      intel: [],
      spent: 0,
    };
    const { loadout } = sanitizeLoadout(raw);
    assertLoadoutLegal(loadout, 'six outils');
    assert.equal(loadout.tools.length, CFG.budget.maxTools);
  });

  test('les doublons ne se paient pas deux fois et n’occupent qu’une place', () => {
    const raw: Loadout = {
      tools: ['crossbow', 'crossbow', 'crossbow', 'crossbow'],
      intel: ['heart', 'heart', 'heart'],
      spent: 0,
    };
    const { loadout } = sanitizeLoadout(raw);
    assertLoadoutLegal(loadout, 'doublons');
    assert.deepEqual(loadout.tools, ['crossbow']);
    assert.deepEqual(loadout.intel, ['heart']);
    assert.equal(loadout.spent, CFG.tools.crossbow.cost + CFG.intel.heart.cost);
  });

  test('outils et renseignements inconnus : ignorés', () => {
    const raw = {
      tools: ['trébuchet', '', 'CROSSBOW', 'crossbow'],
      intel: ['météo', 'heart'],
      spent: 0,
    } as unknown as Loadout;
    const { loadout } = sanitizeLoadout(raw);
    assertLoadoutLegal(loadout, 'inconnus');
    assert.deepEqual(loadout.tools, ['crossbow']);
    assert.deepEqual(loadout.intel, ['heart']);
  });

  test('listes absentes : équipement vide, pas d’exception', () => {
    const { loadout } = sanitizeLoadout({} as unknown as Loadout);
    assertLoadoutLegal(loadout, 'équipement vide');
    assert.equal(loadout.spent, 0);
  });

  test('fuzz : 2000 équipements hostiles restent sous 60 points et 3 outils', () => {
    const r = rng(0x1234);
    const bad = ['trébuchet', '', 'crossbow ', 'Bombs'];

    for (let n = 0; n < 2000; n++) {
      const raw = {
        tools: Array.from({ length: Math.floor(r() * 12) }, () =>
          r() < 0.8 ? pick(TOOL_KINDS, r) : pick(bad, r),
        ),
        intel: Array.from({ length: Math.floor(r() * 8) }, () =>
          r() < 0.8 ? pick(INTEL_KINDS, r) : pick(bad, r),
        ),
        spent: r() * 1000,
      } as unknown as Loadout;

      const { loadout } = sanitizeLoadout(raw);
      assertLoadoutLegal(loadout, `équipement #${n}`);
    }
  });

  test('nettoyer deux fois donne le même équipement', () => {
    const raw: Loadout = { tools: [...TOOL_KINDS], intel: [...INTEL_KINDS], spent: 0 };
    const once = sanitizeLoadout(raw).loadout;
    const twice = sanitizeLoadout(once).loadout;
    assert.deepEqual(twice, once);
  });
});

/* ==================================================================== */
/* Failles réelles — documentées, désactivées                           */
/* ==================================================================== */

describe('sanitizeBuild / sanitizeLoadout — clés héritées d’Object.prototype', () => {
  // Ces deux tests décrivent le comportement voulu. Ils échouent aujourd'hui.
  //
  // BOGUE (src/game/prep.ts:152, 176, 221, 235) : la garde est écrite
  //   `if (!(t.kind in CFG.traps)) continue;`
  // et `in` remonte la chaîne de prototypes. « toString », « valueOf »,
  // « constructor », « hasOwnProperty » passent donc pour des types valides.
  // `CFG.traps['toString'].cost` vaut alors `undefined`, `spent` devient NaN,
  // et toutes les comparaisons `spent + cost > budget` deviennent fausses :
  // plus rien n'est jamais refusé. Correctif : utiliser
  // `Object.prototype.hasOwnProperty.call(CFG.traps, t.kind)`.

  test(
    'un piège nommé « valueOf » ne doit pas ouvrir le budget en grand',
    () => {
      const tiles = legalTrapTiles(COMPACT).slice(0, 41);
      const raw = emptyBuild('compact');
      raw.traps = [
        hostileTrap({ id: 0, kind: 'valueOf', x: tiles[0].x + 0.5, y: tiles[0].y + 0.5, tell: 'seam', facing: 0 }),
        ...tiles.slice(1).map((t, i) => ({
          id: i + 1,
          kind: 'boulder' as const,
          x: t.x + 0.5,
          y: t.y + 0.5,
          tell: 'dust' as const,
          facing: 0,
        })),
      ];

      const { build } = sanitizeBuild(COMPACT, raw);
      assertBuildLegal(COMPACT, build, 'clé de prototype');
    },
  );

  test(
    'un outil nommé « hasOwnProperty » ne doit pas faire sauter les 60 points',
    () => {
      const raw = {
        tools: ['hasOwnProperty', 'crossbow', 'probe'],
        intel: ['heart', 'brazier', 'budget'],
        spent: 0,
      } as unknown as Loadout;
      const { loadout } = sanitizeLoadout(raw);
      assertLoadoutLegal(loadout, 'clé de prototype');
    },
  );

  test(
    'un index de porte NaN ne doit pas être facturé',
    () => {
      const raw = emptyBuild('compact');
      raw.lockedDoors = [NaN, 1.5, 0];
      const { build } = sanitizeBuild(COMPACT, raw);
      for (const di of build.lockedDoors) {
        assert.ok(
          Number.isInteger(di) && di >= 0 && di < COMPACT.doors.length,
          `index de porte invalide accepté : ${di}`,
        );
      }
    },
  );
});

/* ==================================================================== */
/* Renseignement et réaménagement                                       */
/* ==================================================================== */

describe('renseignement et réaménagement', () => {
  test('sans achat, aucun renseignement ne transite', () => {
    const build = emptyBuild('compact');
    const out = resolveIntel(COMPACT, build, emptyLoadout());
    assert.deepEqual(out, {});
  });

  test('« Emplacement du Cœur » élimine exactement les autres candidats', () => {
    const build = emptyBuild('compact');
    build.heartIndex = 2;
    const out = resolveIntel(COMPACT, build, makeLoadout({ intel: ['heart'] }));
    assert.deepEqual(out.eliminatedHeart, [0, 1]);
    assert.ok(!out.eliminatedHeart!.includes(2), 'le vrai Cœur ne doit jamais être éliminé');
  });

  test('« Répartition adverse » compte les faux indices à part', () => {
    const tiles = legalTrapTiles(COMPACT);
    const raw = emptyBuild('compact');
    raw.traps = [
      { id: 0, kind: 'spikes', x: tiles[0].x + 0.5, y: tiles[0].y + 0.5, tell: 'seam', facing: 0 },
      { id: 1, kind: 'decoy', x: tiles[1].x + 0.5, y: tiles[1].y + 0.5, tell: 'seam', facing: 0 },
      { id: 2, kind: 'decoy', x: tiles[2].x + 0.5, y: tiles[2].y + 0.5, tell: 'crack', facing: 0 },
    ];
    const { build } = sanitizeBuild(COMPACT, raw);
    const out = resolveIntel(COMPACT, build, makeLoadout({ intel: ['budget'] }));
    assert.deepEqual(out.budget, { traps: 1, devices: 0, decoys: 2, fixtures: 0 });
  });

  test('le réaménagement ne rend jamais plus que le budget de départ', () => {
    const r = rng(7);
    const tiles = legalTrapTiles(COMPACT);
    for (let n = 0; n < 200; n++) {
      const raw = emptyBuild('compact');
      raw.traps = Array.from({ length: Math.floor(r() * 10) }, (_, i) => ({
        id: i,
        kind: pick(TRAP_KINDS, r),
        x: tiles[(i * 3 + n) % tiles.length].x + 0.5,
        y: tiles[(i * 3 + n) % tiles.length].y + 0.5,
        tell: 'seam' as const,
        facing: 0,
      }));
      const { build } = sanitizeBuild(COMPACT, raw);
      const redress = prepareRedress(build, []);
      const refund = Math.round(CFG.budget.castellan * CFG.match.redressRefund);
      // Le budget rendu est un PLAFOND TOTAL, pas un reliquat : le défenseur
      // garde ce qu'il a construit et reçoit 40 points de plus pour répondre à
      // ce qu'il a vu (§3). Il doit donc toujours pouvoir dépenser au moins ce
      // qu'il a déjà engagé, sinon l'interface lui montrerait un solde négatif.
      assert.ok(
        redress.budget >= buildCost(build),
        `réaménagement à ${redress.budget} points pour un château qui en coûte déjà ${buildCost(build)}`,
      );
      assert.ok(
        redress.budget <= CFG.budget.castellan + refund,
        `réaménagement à ${redress.budget} points, au-delà du plafond ${CFG.budget.castellan + refund}`,
      );
      assert.deepEqual(redress.build, build, 'le château gardé ne doit pas être modifié');
    }
  });

  test(
    'le budget de réaménagement doit être dépensable pour de vrai',
    {
    },
    () => {
      const tiles = legalTrapTiles(COMPACT);
      // Un château gardé à 60 points : quatre rochers.
      const kept = emptyBuild('compact');
      kept.traps = tiles.slice(0, 4).map((t, i) => ({
        id: i,
        kind: 'boulder' as const,
        x: t.x + 0.5,
        y: t.y + 0.5,
        tell: 'dust' as const,
        facing: 0,
      }));
      const { build } = sanitizeBuild(COMPACT, kept);
      assert.equal(buildCost(build), 4 * CFG.traps.boulder.cost);

      const redress = prepareRedress(build, []);
      // `redress.budget` est le plafond TOTAL du château, pas un reliquat :
      // c'est ainsi que l'interface l'affiche (« dépensé / total »).
      assert.ok(redress.budget > buildCost(build), 'le réaménagement doit ouvrir de la marge');
      const room = redress.budget - buildCost(build);
      const extra = Math.floor(room / CFG.traps.collapse.cost);
      assert.ok(extra > 0, 'la marge doit permettre de poser au moins un piège');
      const asked: BuildOrder = {
        ...build,
        traps: [
          ...build.traps,
          ...tiles.slice(4, 4 + extra).map((t, i) => ({
            id: build.traps.length + i,
            kind: 'collapse' as const,
            x: t.x + 0.5,
            y: t.y + 0.5,
            tell: 'crack' as const,
            facing: 0,
          })),
        ],
      };

      // L'hôte revalide avec le MÊME plafond que celui annoncé au joueur.
      const { build: accepted } = sanitizeBuild(COMPACT, asked, redress.budget);
      assert.equal(
        accepted.traps.length,
        asked.traps.length,
        'tout ce que le budget de réaménagement autorise doit survivre à la validation',
      );
      assert.ok(
        buildCost(accepted) <= redress.budget,
        'et rien ne doit dépasser ce plafond',
      );
    },
  );
});

/* ==================================================================== */
/* Cohérence des tables de configuration                                */
/* ==================================================================== */

describe('tables de configuration', () => {
  test('chaque piège a un coût positif et une apparence connue', () => {
    for (const k of TRAP_KINDS) {
      const spec = CFG.traps[k];
      assert.ok(spec.cost > 0, `${k} : coût nul`);
      assert.ok(TELL_KINDS.includes(spec.tell), `${k} : apparence « ${spec.tell} » hors liste`);
      assert.ok(spec.damage >= 0, `${k} : dégâts négatifs`);
      assert.ok(
        spec.damage <= CFG.combat.maxSingleHit,
        `${k} : ${spec.damage} dégâts, au-delà du garde-fou de ${CFG.combat.maxSingleHit}`,
      );
    }
  });

  test('un faux indice ne coûte presque rien et ne blesse pas', () => {
    assert.equal(CFG.traps.decoy.damage, 0);
    assert.ok(CFG.traps.decoy.cost < CFG.traps.collapse.cost);
  });

  test('le budget permet au moins un outil et un renseignement', () => {
    const cheapestTool = Math.min(...TOOL_KINDS.map((k: ToolKind) => CFG.tools[k].cost));
    const cheapestIntel = Math.min(...INTEL_KINDS.map((k: IntelKind) => CFG.intel[k].cost));
    assert.ok(cheapestTool + cheapestIntel <= CFG.budget.invader);
  });
});
