/**
 * Outils communs aux tests.
 *
 * Tout ce qui vit ici est pur : aucun import React, aucun accès au DOM. C'est
 * la preuve, exécutée à chaque `npm test`, que la simulation tourne en Node.
 *
 * Les fonctions sont volontairement minces : un test doit se lire comme la
 * règle qu'il vérifie, pas comme une mise en scène.
 */

import assert from 'node:assert/strict';

import { CFG, GRID_H, GRID_W, TICK_DT } from '../src/game/config';
import type { DeviceKind, IntelKind, TellKind, ToolKind, TrapKind } from '../src/game/config';
import { CastleRuntime, idx } from '../src/game/grid';
import { getPlan } from '../src/game/plans/index';
import { buildCost, emptyBuild, emptyLoadout, loadoutCost, sanitizeBuild, sanitizeLoadout } from '../src/game/prep';
import { World } from '../src/game/sim';
import { SnapshotFilter, auditSnapshot, filterEvents } from '../src/game/snapshot';
import type {
  Actor,
  BuildOrder,
  CastlePlan,
  DevicePlacement,
  Gait,
  InputFrame,
  IntelResult,
  Loadout,
  PlanId,
  TrapPlacement,
  Vec,
} from '../src/game/types';
import { T, dist, emptyInput } from '../src/game/types';

export const PLAN_IDS: PlanId[] = ['compact', 'labyrinth', 'open'];

/* ==================================================================== */
/* Hasard reproductible                                                 */
/* ==================================================================== */

/** Générateur déterministe : un test qui échoue doit échouer toujours. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<A>(list: A[], r: () => number): A {
  return list[Math.min(list.length - 1, Math.floor(r() * list.length))];
}

/* ==================================================================== */
/* Construction d'un monde                                              */
/* ==================================================================== */

export interface TrapSpec {
  kind: TrapKind;
  /** Coordonnées de TUILE (entières) : le placement les recentre. */
  x: number;
  y: number;
  tell?: TellKind;
  facing?: number;
}

export interface DeviceSpec {
  kind: DeviceKind;
  x: number;
  y: number;
  facing?: number;
}

export interface WorldSpec {
  planId?: PlanId;
  heartIndex?: number;
  traps?: TrapSpec[];
  devices?: DeviceSpec[];
  /** Yeux de guet, en coordonnées de TUILE comme les pièges. */
  sensors?: { x: number; y: number }[];
  lockedDoors?: number[];
  secretDoors?: number[];
  tools?: ToolKind[];
  intel?: IntelKind[];
  duration?: number;
}

export function plan(id: PlanId = 'compact'): CastlePlan {
  return getPlan(id);
}

/** Ordre de construction passé par la validation autoritative, comme en jeu. */
export function makeBuild(spec: WorldSpec = {}): BuildOrder {
  const p = plan(spec.planId ?? 'compact');
  const raw = emptyBuild(p.id);
  raw.heartIndex = spec.heartIndex ?? 0;
  raw.traps = (spec.traps ?? []).map((t, i) => ({
    id: i,
    kind: t.kind,
    x: t.x + 0.5,
    y: t.y + 0.5,
    tell: t.tell ?? CFG.traps[t.kind].tell,
    facing: t.facing ?? 0,
  }));
  raw.devices = (spec.devices ?? []).map((d, i) => ({
    id: i,
    kind: d.kind,
    x: d.x + 0.5,
    y: d.y + 0.5,
    facing: d.facing ?? 0,
  }));
  raw.lockedDoors = spec.lockedDoors ?? [];
  raw.secretDoors = spec.secretDoors ?? [];
  raw.sensors = (spec.sensors ?? []).map((g, i) => ({ id: i, x: g.x + 0.5, y: g.y + 0.5 }));
  const { build, verdict } = sanitizeBuild(p, raw);
  // Un test qui croit poser un piège et n'en pose aucun ne prouve rien.
  assert.deepEqual(
    verdict.problems,
    [],
    `Le décor du test a été refusé par sanitizeBuild : ${verdict.problems.join(' / ')}`,
  );
  return build;
}

export function makeLoadout(spec: WorldSpec = {}): Loadout {
  const raw: Loadout = { tools: spec.tools ?? [], intel: spec.intel ?? [], spent: 0 };
  const { loadout, verdict } = sanitizeLoadout(raw);
  assert.deepEqual(
    verdict.problems,
    [],
    `L'équipement du test a été refusé : ${verdict.problems.join(' / ')}`,
  );
  return loadout;
}

export function makeWorld(spec: WorldSpec = {}): World {
  return new World({
    plan: plan(spec.planId ?? 'compact'),
    build: makeBuild(spec),
    loadout: makeLoadout(spec),
    duration: spec.duration ?? CFG.match.roundDuration,
  });
}

/* ==================================================================== */
/* Entrées et pas de simulation                                         */
/* ==================================================================== */

export function input(p: Partial<InputFrame> = {}): InputFrame {
  return { ...emptyInput(), ...p };
}

export const IDLE: InputFrame = input();

export type InputSource = InputFrame | ((tick: number, w: World) => InputFrame);

function frameOf(src: InputSource, tick: number, w: World): InputFrame {
  return typeof src === 'function' ? src(tick, w) : src;
}

/**
 * Avance la simulation de `ticks` pas. `onTick` est appelé après chaque pas :
 * c'est là qu'on vérifie les invariants, pas seulement à la fin.
 */
export function run(
  world: World,
  ticks: number,
  inv: InputSource = IDLE,
  cas: InputSource = IDLE,
  onTick?: (w: World, tick: number) => void,
): number {
  let done = 0;
  for (let i = 0; i < ticks; i++) {
    world.step(frameOf(inv, i, world), frameOf(cas, i, world));
    done++;
    onTick?.(world, i);
    if (world.over) break;
  }
  return done;
}

export function seconds(s: number): number {
  return Math.round(s / TICK_DT);
}

/* ==================================================================== */
/* Déplacements                                                         */
/* ==================================================================== */

/** Repositionne un acteur — utilisé pour monter une situation, pas pour tricher. */
export function place(actor: Actor, at: Vec): void {
  actor.pos = { x: at.x, y: at.y };
  actor.vel = { x: 0, y: 0 };
}

/**
 * Fait marcher l'Envahisseur jusqu'à `target` en suivant le champ de distance
 * du château : le trajet respecte donc les murs, les portes et les herses.
 * Renvoie `true` s'il est arrivé.
 */
export function walkInvaderTo(
  world: World,
  target: Vec,
  opts: {
    gait?: Gait;
    stopWithin?: number;
    maxSeconds?: number;
    interact?: boolean;
    onTick?: (w: World, tick: number) => void;
  } = {},
): boolean {
  const gait = opts.gait ?? 'normal';
  const stopWithin = opts.stopWithin ?? 0.35;
  const maxTicks = seconds(opts.maxSeconds ?? 40);
  let field = world.castle.bfsField(target, 'invader', world.now);
  let age = 0;

  for (let i = 0; i < maxTicks; i++) {
    if (world.over) return false;
    if (dist(world.invader.pos, target) <= stopWithin) return true;
    if (++age > 15) {
      field = world.castle.bfsField(target, 'invader', world.now);
      age = 0;
    }
    let dir = world.castle.descend(field, world.invader.pos);
    if (dir.x === 0 && dir.y === 0) {
      const vx = target.x - world.invader.pos.x;
      const vy = target.y - world.invader.pos.y;
      const m = Math.hypot(vx, vy) || 1;
      dir = { x: vx / m, y: vy / m };
    }
    world.step(
      input({ move: dir, aim: Math.atan2(dir.y, dir.x), gait, interact: opts.interact ?? false }),
      IDLE,
    );
    opts.onTick?.(world, i);
  }
  return dist(world.invader.pos, target) <= stopWithin;
}

/* ==================================================================== */
/* Géométrie du plan                                                    */
/* ==================================================================== */

export function floorTiles(p: CastlePlan): Vec[] {
  const out: Vec[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (p.tiles[idx(x, y)] === T.FLOOR) out.push({ x, y });
    }
  }
  return out;
}

/** Centres de tuiles où un piège est légalement posable. */
export function legalTrapTiles(p: CastlePlan): Vec[] {
  return floorTiles(p).filter(
    (t) => dist({ x: t.x + 0.5, y: t.y + 0.5 }, p.invaderSpawn) >= 2.5,
  );
}

export function centre(t: Vec): Vec {
  return { x: t.x + 0.5, y: t.y + 0.5 };
}

export function runtime(id: PlanId = 'compact'): CastleRuntime {
  return new CastleRuntime(plan(id));
}

/* ==================================================================== */
/* Entrées hostiles                                                     */
/* ==================================================================== */

/**
 * Fabrique un objet volontairement invalide sans mentir au compilateur : les
 * tests de robustesse doivent pouvoir envoyer ce qu'un client trafiqué
 * enverrait, y compris des formes que le type interdit.
 */
export function hostileTrap(o: Record<string, unknown>): TrapPlacement {
  return o as unknown as TrapPlacement;
}

export function hostileDevice(o: Record<string, unknown>): DevicePlacement {
  return o as unknown as DevicePlacement;
}

/* ==================================================================== */
/* Vérifications réutilisables                                          */
/* ==================================================================== */

const OWN = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Tout ce qu'un ordre de construction accepté doit respecter, sans exception. */
export function assertBuildLegal(p: CastlePlan, build: BuildOrder, label = ''): void {
  const tag = label ? `${label} : ` : '';
  const cost = buildCost(build);

  assert.ok(
    Number.isFinite(cost),
    `${tag}le coût du château vaut ${cost} — un budget doit toujours être un nombre.`,
  );
  assert.ok(
    cost <= CFG.budget.castellan,
    `${tag}le château coûte ${cost} pour un budget de ${CFG.budget.castellan}.`,
  );
  assert.equal(build.spent, cost, `${tag}spent annoncé ${build.spent}, coût réel ${cost}.`);

  assert.ok(
    Number.isInteger(build.heartIndex) &&
      build.heartIndex >= 0 &&
      build.heartIndex < p.heartCandidates.length,
    `${tag}emplacement de Cœur hors de la liste : ${build.heartIndex}.`,
  );

  const occupied = new Set<number>();
  for (const t of build.traps) {
    assert.ok(OWN(CFG.traps, t.kind), `${tag}type de piège inconnu : ${String(t.kind)}.`);
    assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), `${tag}piège aux coordonnées ${t.x},${t.y}.`);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    assert.equal(p.tiles[idx(tx, ty)], T.FLOOR, `${tag}piège hors du sol en ${tx},${ty}.`);
    assert.ok(
      dist({ x: tx + 0.5, y: ty + 0.5 }, p.invaderSpawn) >= 2.5,
      `${tag}piège à moins de 2,5 tuiles de l'entrée en ${tx},${ty}.`,
    );
    assert.ok(!occupied.has(idx(tx, ty)), `${tag}deux mécanismes empilés en ${tx},${ty}.`);
    occupied.add(idx(tx, ty));
    assert.ok(Number.isFinite(t.facing), `${tag}orientation non numérique.`);
  }

  for (const d of build.devices) {
    assert.ok(OWN(CFG.devices, d.kind), `${tag}mécanisme inconnu : ${String(d.kind)}.`);
    const tx = Math.floor(d.x);
    const ty = Math.floor(d.y);
    assert.ok(!occupied.has(idx(tx, ty)), `${tag}deux mécanismes empilés en ${tx},${ty}.`);
    occupied.add(idx(tx, ty));
    const tile = p.tiles[idx(tx, ty)];
    if (d.kind === 'portcullis' || d.kind === 'cavein') {
      assert.equal(tile, T.DOOR, `${tag}${d.kind} hors d'une porte en ${tx},${ty}.`);
    } else {
      assert.equal(tile, T.FLOOR, `${tag}${d.kind} hors du sol en ${tx},${ty}.`);
    }
  }
}

/** Tout ce qu'un équipement accepté doit respecter. */
export function assertLoadoutLegal(loadout: Loadout, label = ''): void {
  const tag = label ? `${label} : ` : '';
  const cost = loadoutCost(loadout);

  assert.ok(Number.isFinite(cost), `${tag}le coût de l'équipement vaut ${cost}.`);
  assert.ok(
    cost <= CFG.budget.invader,
    `${tag}l'équipement coûte ${cost} pour un budget de ${CFG.budget.invader}.`,
  );
  assert.equal(loadout.spent, cost, `${tag}spent annoncé ${loadout.spent}, coût réel ${cost}.`);
  assert.ok(
    loadout.tools.length <= CFG.budget.maxTools,
    `${tag}${loadout.tools.length} outils pour un maximum de ${CFG.budget.maxTools}.`,
  );
  assert.equal(new Set(loadout.tools).size, loadout.tools.length, `${tag}outil en double.`);
  assert.equal(new Set(loadout.intel).size, loadout.intel.length, `${tag}renseignement en double.`);
  for (const t of loadout.tools) assert.ok(OWN(CFG.tools, t), `${tag}outil inconnu : ${String(t)}.`);
  for (const i of loadout.intel) assert.ok(OWN(CFG.intel, i), `${tag}renseignement inconnu : ${String(i)}.`);
}

/* ==================================================================== */
/* Instantanés                                                          */
/* ==================================================================== */

/** Construit un instantané comme le ferait l'hôte, sans passer par le réseau. */
export function snapshotOf(
  filter: SnapshotFilter,
  world: World,
  tick = 1,
): ReturnType<SnapshotFilter['build']> {
  return filter.build(world, {
    phase: 'invasion',
    tick,
    ackSeq: tick,
    score: { host: 0, guest: 0 },
    round: 1,
  });
}

/** Les deux filtres d'une même manche, comme dans `Engine.startInvasion`. */
export function filtersFor(
  world: World,
  intel: IntelResult = {},
): { invader: SnapshotFilter; castellan: SnapshotFilter } {
  return {
    invader: new SnapshotFilter('invader', world, intel),
    castellan: new SnapshotFilter('castellan', world, {}),
  };
}

export { buildCost, loadoutCost, emptyBuild, emptyLoadout, sanitizeBuild, sanitizeLoadout };
export { CFG, TICK_DT, GRID_W, GRID_H, idx, dist, T, World };
export { SnapshotFilter, auditSnapshot, filterEvents };
