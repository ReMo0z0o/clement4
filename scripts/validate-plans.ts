/**
 * Validation des plans de château.
 *
 *   node --experimental-strip-types scripts/validate-plans.ts
 *
 * Un plan invalide casse le jeu de façon silencieuse et pénible à diagnostiquer
 * (Cœur inatteignable, brasero muré, joueur coincé). Ce script refuse de passer
 * tant que la topologie n'est pas correcte.
 */

import { GRID_H, GRID_W } from '../src/game/config';
import { PLANS } from '../src/game/plans/index';
import { compilePlan, idx, inBounds } from '../src/game/grid';
import { T } from '../src/game/types';
import type { PlanSource, TileId, Vec } from '../src/game/types';

let failures = 0;

function fail(plan: string, msg: string): void {
  console.error(`  ✗ [${plan}] ${msg}`);
  failures++;
}

function ok(plan: string, msg: string): void {
  console.log(`  ✓ [${plan}] ${msg}`);
}

/** Cases atteignables à pied par l'Envahisseur (portes ouvertes, pas de secret). */
function reachable(tiles: TileId[], from: Vec): Set<number> {
  const seen = new Set<number>();
  const start = idx(Math.floor(from.x), Math.floor(from.y));
  const queue = [start];
  seen.add(start);
  const passable = (t: TileId) => t === T.FLOOR || t === T.DOOR;
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
      if (seen.has(ni)) continue;
      if (!passable(tiles[ni])) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return seen;
}

/** Nombre de chemins distincts : on coupe chaque porte et on vérifie l'accès. */
function chokepointCount(tiles: TileId[], from: Vec, to: Vec): number {
  let cuts = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] !== T.DOOR) continue;
    const copy = tiles.slice();
    copy[i] = T.WALL;
    const seen = reachable(copy, from);
    if (!seen.has(idx(Math.floor(to.x), Math.floor(to.y)))) cuts++;
  }
  return cuts;
}

function validate(src: PlanSource): void {
  const id = src.id;
  const startFailures = failures;

  if (src.rows.length !== GRID_H) {
    fail(id, `${src.rows.length} lignes au lieu de ${GRID_H}`);
    return;
  }
  let widthOk = true;
  src.rows.forEach((r, y) => {
    if (r.length !== GRID_W) {
      fail(id, `ligne ${y} : ${r.length} caractères au lieu de ${GRID_W} — « ${r} »`);
      widthOk = false;
    }
  });
  if (!widthOk) return;

  const allowed = new Set('#.+%,fSCHBt'.split(''));
  src.rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      if (!allowed.has(r[x])) fail(id, `ligne ${y} colonne ${x} : caractère « ${r[x]} » inconnu`);
    }
  });

  // Bordure étanche.
  for (let x = 0; x < GRID_W; x++) {
    if ('.+%,'.includes(src.rows[0][x])) fail(id, `bordure haute percée en x=${x}`);
    if ('.+%,'.includes(src.rows[GRID_H - 1][x])) fail(id, `bordure basse percée en x=${x}`);
  }
  for (let y = 0; y < GRID_H; y++) {
    if ('.+%,'.includes(src.rows[y][0])) fail(id, `bordure gauche percée en y=${y}`);
    if ('.+%,'.includes(src.rows[y][GRID_W - 1])) fail(id, `bordure droite percée en y=${y}`);
  }

  const count = (ch: string) => src.rows.join('').split(ch).length - 1;
  if (count('S') !== 1) fail(id, `${count('S')} point d'apparition Envahisseur (attendu 1)`);
  if (count('C') !== 1) fail(id, `${count('C')} point d'apparition Châtelain (attendu 1)`);
  if (count('H') !== 3) fail(id, `${count('H')} candidats Cœur (attendu 3)`);
  if (count('B') !== 3) fail(id, `${count('B')} braseros (attendu 3)`);
  if (count('%') < 3) fail(id, `${count('%')} passages secrets (attendu ≥ 3)`);
  if (count('f') < 2) fail(id, `${count('f')} murs fragiles (attendu ≥ 2)`);
  if (count('t') < 8) fail(id, `${count('t')} torches (attendu ≥ 8) — le château serait trop sombre`);

  const plan = compilePlan(src);

  // Les torches doivent être des murs bordant du sol, sinon elles n'éclairent rien.
  for (const t of plan.torches) {
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    let touchesFloor = false;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (inBounds(nx, ny) && plan.tiles[idx(nx, ny)] !== T.WALL) touchesFloor = true;
    }
    if (!touchesFloor) fail(id, `torche murée en (${tx},${ty}) : elle n'éclaire rien`);
  }

  // Connectivité : tout ce qui compte doit être atteignable à pied.
  const seen = reachable(plan.tiles, plan.invaderSpawn);
  const check = (label: string, p: Vec) => {
    if (!seen.has(idx(Math.floor(p.x), Math.floor(p.y)))) {
      fail(id, `${label} en (${Math.floor(p.x)},${Math.floor(p.y)}) inatteignable depuis l'apparition`);
    }
  };
  plan.heartCandidates.forEach((h, i) => check(`candidat Cœur #${i}`, h));
  plan.brazierSpots.forEach((b, i) => check(`brasero #${i}`, b));
  check('apparition Châtelain', plan.castellanSpawn);

  // Aucun cul-de-sac fatal : chaque Cœur doit avoir au moins deux itinéraires.
  plan.heartCandidates.forEach((h, i) => {
    const cuts = chokepointCount(plan.tiles, plan.invaderSpawn, h);
    if (cuts > 0) {
      fail(
        id,
        `candidat Cœur #${i} : ${cuts} porte(s) dont la fermeture le coupe entièrement — ` +
          `il faut au moins deux itinéraires distincts`,
      );
    }
  });

  // Les candidats Cœur doivent être écartés : sinon le renseignement est inutile.
  for (let i = 0; i < plan.heartCandidates.length; i++) {
    for (let j = i + 1; j < plan.heartCandidates.length; j++) {
      const a = plan.heartCandidates[i];
      const b = plan.heartCandidates[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 7) fail(id, `candidats Cœur #${i} et #${j} distants de ${d.toFixed(1)} tuiles (min 7)`);
    }
  }

  // Braseros loin du Cœur le plus proche (§7 : « placés loin du Cœur »).
  plan.brazierSpots.forEach((b, i) => {
    const nearest = Math.min(...plan.heartCandidates.map((h) => Math.hypot(h.x - b.x, h.y - b.y)));
    if (nearest < 5) fail(id, `brasero #${i} à ${nearest.toFixed(1)} tuiles d'un candidat Cœur (min 5)`);
  });

  // L'apparition de l'Envahisseur ne doit pas être collée au Châtelain.
  const spawnGap = Math.hypot(
    plan.invaderSpawn.x - plan.castellanSpawn.x,
    plan.invaderSpawn.y - plan.castellanSpawn.y,
  );
  if (spawnGap < 10) fail(id, `apparitions distantes de ${spawnGap.toFixed(1)} tuiles (min 10)`);

  // Densité : chaque plan doit tenir son identité (§14).
  const floors = plan.tiles.filter((t) => t === T.FLOOR || t === T.DOOR).length;
  const ratio = floors / (GRID_W * GRID_H);
  const [lo, hi] = src.density;
  if (ratio < lo)
    fail(id, `${(ratio * 100).toFixed(0)} % de surface jouable, en dessous des ${(lo * 100).toFixed(0)} % visés`);
  if (ratio > hi)
    fail(id, `${(ratio * 100).toFixed(0)} % de surface jouable, au-dessus des ${(hi * 100).toFixed(0)} % visés`);

  // Longueur de vue moyenne : c'est elle qui donne son caractère à un plan.
  const sight = averageSightline(plan.tiles);

  if (failures === startFailures) {
    ok(
      id,
      `${plan.roomCount} pièces · ${(ratio * 100).toFixed(0)} % jouable · ` +
        `vue moyenne ${sight.toFixed(1)} tuiles · ${plan.doors.length} portes · ` +
        `${plan.torches.length} torches`,
    );
  }
}

/** Distance moyenne avant un mur, échantillonnée dans 8 directions. */
function averageSightline(tiles: TileId[]): number {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  let total = 0;
  let n = 0;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (tiles[idx(x, y)] !== T.FLOOR) continue;
      for (const [dx, dy] of dirs) {
        let d = 0;
        let cx = x;
        let cy = y;
        while (d < 24) {
          cx += dx;
          cy += dy;
          if (!inBounds(cx, cy)) break;
          const t = tiles[idx(cx, cy)];
          if (t === T.WALL || t === T.FRAGILE || t === T.SECRET || t === T.RUBBLE) break;
          d++;
        }
        total += d;
        n++;
      }
    }
  }
  return n === 0 ? 0 : total / n;
}

console.log('Validation des plans de château\n');
for (const p of PLANS) {
  const before = failures;
  validate(p);
  if (failures > before) console.log('');
}

if (failures > 0) {
  console.error(`\n${failures} problème(s). Le jeu ne sera pas jouable en l'état.`);
  process.exit(1);
}
console.log('\nTous les plans sont valides.');
