/**
 * Économie de la préparation (§8).
 *
 * L'hôte revalide systématiquement ce que l'invité lui envoie : un budget ne
 * doit jamais pouvoir être dépassé, quelle que soit l'interface qui a produit
 * l'ordre de construction. La fonction `sanitizeBuild` est donc écrite pour
 * *réparer* un ordre invalide plutôt que le refuser — un joueur ne doit jamais
 * se retrouver bloqué à cause d'un désaccord de version.
 */

import { CFG, TELL_KINDS } from './config';
import type { IntelKind, ToolKind } from './config';
import { idx, inBounds } from './grid';
import type {
  BuildOrder,
  CastlePlan,
  DevicePlacement,
  IntelResult,
  Loadout,
  PlanId,
  TrapPlacement,
} from './types';
import { T, dist } from './types';

/**
 * `kind in CFG.traps` remonte la chaîne de prototypes : « valueOf », « toString »
 * ou « __proto__ » passaient pour des types valides. Le coût lu valait alors
 * `undefined`, `spent + undefined > budget` valait `NaN > 100` — c'est-à-dire
 * `false` — et **plus aucun article n'était refusé ensuite**. Un seul faux type
 * suffisait à faire passer 720 points sur un budget de 100.
 */
function isKnown<A extends object>(table: A, key: unknown): key is keyof A {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

export interface Verdict {
  ok: boolean;
  spent: number;
  problems: string[];
}

export function emptyBuild(planId: PlanId): BuildOrder {
  return {
    planId,
    heartIndex: 0,
    traps: [],
    devices: [],
    lockedDoors: [],
    secretDoors: [],
    sensors: [],
    spent: 0,
  };
}

export function emptyLoadout(): Loadout {
  return { tools: [], intel: [], spent: 0 };
}

export function buildCost(b: BuildOrder): number {
  let total = 0;
  for (const t of b.traps) total += CFG.traps[t.kind].cost;
  for (const d of b.devices) total += CFG.devices[d.kind].cost;
  total += b.lockedDoors.length * CFG.fixtures.lockDoor.cost;
  total += b.secretDoors.length * CFG.fixtures.secretDoor.cost;
  return total;
}

export function loadoutCost(l: Loadout): number {
  let total = 0;
  for (const t of l.tools) total += CFG.tools[t].cost;
  for (const i of l.intel) total += CFG.intel[i].cost;
  return total;
}

/* ==================================================================== */
/* Placement                                                            */
/* ==================================================================== */

/** Un emplacement est-il légal pour ce type de piège ? */
export function canPlaceTrap(
  plan: CastlePlan,
  kind: TrapPlacement['kind'],
  x: number,
  y: number,
  existing: TrapPlacement[],
  devices: DevicePlacement[],
): string | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!inBounds(tx, ty)) return 'Hors du château.';
  if (plan.tiles[idx(tx, ty)] !== T.FLOOR) return 'Il faut du sol dégagé.';

  // Rien à moins de deux tuiles du point d'entrée : mourir avant d'avoir joué
  // est le pire ressenti possible (§2.4).
  if (dist({ x: tx + 0.5, y: ty + 0.5 }, plan.invaderSpawn) < 2.5) {
    return "Trop près de l'entrée de l'Envahisseur.";
  }
  for (const t of existing) {
    if (Math.floor(t.x) === tx && Math.floor(t.y) === ty) return 'Il y a déjà quelque chose ici.';
  }
  for (const d of devices) {
    if (Math.floor(d.x) === tx && Math.floor(d.y) === ty) return 'Il y a déjà quelque chose ici.';
  }
  if (kind === 'arrows' && !hasWallNeighbour(plan, tx, ty)) {
    return 'Les flèches ont besoin d’un mur adjacent.';
  }
  return null;
}

export function canPlaceDevice(
  plan: CastlePlan,
  kind: DevicePlacement['kind'],
  x: number,
  y: number,
  traps: TrapPlacement[],
  devices: DevicePlacement[],
): string | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!inBounds(tx, ty)) return 'Hors du château.';
  const tile = plan.tiles[idx(tx, ty)];

  if (kind === 'portcullis' || kind === 'cavein') {
    if (tile !== T.DOOR) return 'À poser sur une porte : c’est un passage qu’on condamne.';
  } else if (tile !== T.FLOOR) {
    return 'Il faut du sol dégagé.';
  }
  for (const t of traps) {
    if (Math.floor(t.x) === tx && Math.floor(t.y) === ty) return 'Il y a déjà quelque chose ici.';
  }
  for (const d of devices) {
    if (Math.floor(d.x) === tx && Math.floor(d.y) === ty) return 'Il y a déjà quelque chose ici.';
  }
  return null;
}

/** Un guet se pose sur du sol dégagé, loin de l'entrée de l'Envahisseur. */
export function canPlaceSensor(
  plan: CastlePlan,
  x: number,
  y: number,
  existing: { x: number; y: number }[],
): string | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!inBounds(tx, ty)) return 'Hors du château.';
  if (plan.tiles[idx(tx, ty)] !== T.FLOOR) return 'Il faut du sol dégagé.';
  if (dist({ x: tx + 0.5, y: ty + 0.5 }, plan.invaderSpawn) < 3) {
    return "Trop près de l'entrée de l'Envahisseur.";
  }
  for (const g of existing) {
    if (Math.floor(g.x) === tx && Math.floor(g.y) === ty) return 'Il y a déjà un guet ici.';
  }
  return null;
}

function hasWallNeighbour(plan: CastlePlan, x: number, y: number): boolean {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny)) return true;
    const t = plan.tiles[idx(nx, ny)];
    if (t === T.WALL || t === T.FRAGILE || t === T.SECRET) return true;
  }
  return false;
}

/* ==================================================================== */
/* Validation autoritative                                              */
/* ==================================================================== */

/**
 * Nettoie un ordre de construction reçu du réseau. Tout ce qui dépasse le
 * budget ou occupe un emplacement illégal est retiré, dans l'ordre de pose.
 */
export function sanitizeBuild(
  plan: CastlePlan,
  raw: BuildOrder,
  /**
   * Plafond réel de ce château. Aux manches 3 et 4 il dépasse le budget de
   * base : le défenseur récupère 40 % en plus de ce qu'il a déjà engagé (§3).
   * Sans ce paramètre, la revalidation d'hôte supprimait silencieusement tout
   * ce qui dépassait 100 — le Châtelain construisait, puis regardait ses
   * pièges disparaître au lancement de la manche.
   */
  budgetTotal: number = CFG.budget.castellan,
): { build: BuildOrder; verdict: Verdict } {
  const problems: string[] = [];
  const out = emptyBuild(plan.id);
  out.heartIndex = Number.isInteger(raw.heartIndex)
    ? Math.max(0, Math.min(plan.heartCandidates.length - 1, raw.heartIndex))
    : 0;

  let spent = 0;
  const budget = Math.max(0, budgetTotal);

  for (const t of raw.traps ?? []) {
    if (!isKnown(CFG.traps, t.kind)) continue;
    const cost = CFG.traps[t.kind].cost;
    if (spent + cost > budget) {
      problems.push(`${CFG.traps[t.kind].label} retiré : budget dépassé.`);
      continue;
    }
    const why = canPlaceTrap(plan, t.kind, t.x, t.y, out.traps, out.devices);
    if (why) {
      problems.push(`${CFG.traps[t.kind].label} retiré : ${why.toLowerCase()}`);
      continue;
    }
    const tell = TELL_KINDS.includes(t.tell) ? t.tell : CFG.traps[t.kind].tell;
    out.traps.push({
      id: out.traps.length,
      kind: t.kind,
      x: Math.floor(t.x) + 0.5,
      y: Math.floor(t.y) + 0.5,
      tell: t.kind === 'decoy' ? tell : (CFG.traps[t.kind].tell as typeof tell),
      facing: Number.isFinite(t.facing) ? t.facing : 0,
    });
    spent += cost;
  }

  for (const d of raw.devices ?? []) {
    if (!isKnown(CFG.devices, d.kind)) continue;
    const cost = CFG.devices[d.kind].cost;
    if (spent + cost > budget) {
      problems.push(`${CFG.devices[d.kind].label} retiré : budget dépassé.`);
      continue;
    }
    const why = canPlaceDevice(plan, d.kind, d.x, d.y, out.traps, out.devices);
    if (why) {
      problems.push(`${CFG.devices[d.kind].label} retiré : ${why.toLowerCase()}`);
      continue;
    }
    out.devices.push({
      id: out.devices.length,
      kind: d.kind,
      x: Math.floor(d.x) + 0.5,
      y: Math.floor(d.y) + 0.5,
      facing: Number.isFinite(d.facing) ? d.facing : 0,
    });
    spent += cost;
  }

  for (const di of dedupe(raw.lockedDoors ?? [])) {
    // Un index non entier (NaN, 1.5) était facturé puis ignoré par la
    // simulation : le Châtelain payait trois points pour rien.
    if (!Number.isInteger(di) || di < 0 || di >= plan.doors.length) continue;
    if (spent + CFG.fixtures.lockDoor.cost > budget) continue;
    out.lockedDoors.push(di);
    spent += CFG.fixtures.lockDoor.cost;
  }
  for (const si of dedupe(raw.secretDoors ?? [])) {
    if (!Number.isInteger(si) || si < 0 || si >= plan.secretSpots.length) continue;
    if (spent + CFG.fixtures.secretDoor.cost > budget) continue;
    out.secretDoors.push(si);
    spent += CFG.fixtures.secretDoor.cost;
  }

  // Les guets : gratuits, mais jamais plus que le compte, jamais dans un mur.
  for (const g of raw.sensors ?? []) {
    if ((out.sensors?.length ?? 0) >= CFG.sensors.count) {
      problems.push('Guet retiré : trois au maximum.');
      continue;
    }
    if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) continue;
    const why = canPlaceSensor(plan, g.x, g.y, out.sensors ?? []);
    if (why) {
      problems.push(`Guet retiré : ${why.toLowerCase()}`);
      continue;
    }
    out.sensors!.push({ id: out.sensors!.length, x: Math.floor(g.x) + 0.5, y: Math.floor(g.y) + 0.5 });
  }

  out.spent = spent;
  return { build: out, verdict: { ok: problems.length === 0, spent, problems } };
}

export function sanitizeLoadout(raw: Loadout): { loadout: Loadout; verdict: Verdict } {
  const problems: string[] = [];
  const out = emptyLoadout();
  let spent = 0;
  const budget = CFG.budget.invader;

  for (const k of dedupe(raw.tools ?? [])) {
    if (!isKnown(CFG.tools, k)) continue;
    if (out.tools.length >= CFG.budget.maxTools) {
      problems.push(`${CFG.tools[k as ToolKind].label} retiré : trois outils au maximum.`);
      continue;
    }
    const cost = CFG.tools[k as ToolKind].cost;
    if (spent + cost > budget) {
      problems.push(`${CFG.tools[k as ToolKind].label} retiré : budget dépassé.`);
      continue;
    }
    out.tools.push(k as ToolKind);
    spent += cost;
  }
  for (const k of dedupe(raw.intel ?? [])) {
    if (!isKnown(CFG.intel, k)) continue;
    const cost = CFG.intel[k as IntelKind].cost;
    if (spent + cost > budget) {
      problems.push(`${CFG.intel[k as IntelKind].label} retiré : budget dépassé.`);
      continue;
    }
    out.intel.push(k as IntelKind);
    spent += cost;
  }

  out.spent = spent;
  return { loadout: out, verdict: { ok: problems.length === 0, spent, problems } };
}

function dedupe<A>(list: A[]): A[] {
  return Array.from(new Set(list));
}

/* ==================================================================== */
/* Renseignement (§8)                                                   */
/* ==================================================================== */

/**
 * Résolu par l'hôte au tout début de la manche, jamais par le client :
 * c'est la seule façon de garantir qu'un renseignement non acheté ne
 * transite pas sur le réseau.
 */
export function resolveIntel(plan: CastlePlan, build: BuildOrder, loadout: Loadout): IntelResult {
  const out: IntelResult = {};

  if (loadout.intel.includes('heart')) {
    out.eliminatedHeart = plan.heartCandidates
      .map((_, i) => i)
      .filter((i) => i !== build.heartIndex);
  }

  if (loadout.intel.includes('brazier')) {
    // Le plus proche de l'entrée : un renseignement utile, pas une loterie.
    let best = 0;
    let bestD = Infinity;
    plan.brazierSpots.forEach((b, i) => {
      const d = dist(b, plan.invaderSpawn);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    out.brazier = best;
  }

  if (loadout.intel.includes('budget')) {
    out.budget = {
      traps: build.traps.filter((t) => t.kind !== 'decoy').length,
      devices: build.devices.length,
      decoys: build.traps.filter((t) => t.kind === 'decoy').length,
      fixtures: build.lockedDoors.length + build.secretDoors.length,
    };
  }

  return out;
}

/* ==================================================================== */
/* Réaménagement des manches 3 et 4 (§3)                                */
/* ==================================================================== */

export interface RedressState {
  build: BuildOrder;
  /** Budget disponible pour ce réaménagement. */
  budget: number;
  /** Pièges repérés par l'adversaire : déplaçables gratuitement. */
  burned: number[];
}

/**
 * Rend 40 % du budget et marque les pièges grillés. Ceux-ci peuvent être
 * déplacés sans rien payer — c'est ce qui transforme la manche 3 en
 * conversation plutôt qu'en répétition.
 */
export function prepareRedress(build: BuildOrder, discoveredTrapIds: number[]): RedressState {
  const refund = Math.round(CFG.budget.castellan * CFG.match.redressRefund);
  const spentOnKept = buildCost(build);
  // `budget` est le PLAFOND TOTAL du château, pas le reliquat : c'est ainsi
  // que l'interface le lit (« dépensé / total »). Le défenseur garde ce qu'il
  // a construit et reçoit 40 points en plus pour répondre à ce qu'il a vu.
  const budget = Math.min(CFG.budget.castellan + refund, spentOnKept + refund);
  return { build, budget: Math.max(refund, budget), burned: discoveredTrapIds.slice() };
}
