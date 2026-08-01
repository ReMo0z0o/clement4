/**
 * Grille du château : compilation des plans, collisions, ligne de vue,
 * lumière et pièces. Logique pure, testable en Node (§18).
 */

import { GRID_H, GRID_W } from './config';
import type { CastlePlan, PlanSource, Role, TileId, Vec } from './types';
import { PLAN_CHARS, T } from './types';

export function idx(x: number, y: number): number {
  return y * GRID_W + x;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

/* ==================================================================== */
/* Compilation d'un plan ASCII                                          */
/* ==================================================================== */

export function compilePlan(src: PlanSource): CastlePlan {
  const tiles: TileId[] = new Array(GRID_W * GRID_H).fill(T.WALL);
  const heartCandidates: Vec[] = [];
  const brazierSpots: Vec[] = [];
  const torches: Vec[] = [];
  const doors: Vec[] = [];
  const secretSpots: Vec[] = [];
  let invaderSpawn: Vec = { x: 1.5, y: 1.5 };
  let castellanSpawn: Vec = { x: GRID_W - 1.5, y: GRID_H - 1.5 };

  for (let y = 0; y < GRID_H; y++) {
    const row = src.rows[y] ?? '';
    for (let x = 0; x < GRID_W; x++) {
      const ch = row[x] ?? '#';
      const tile = PLAN_CHARS[ch];
      tiles[idx(x, y)] = tile === undefined ? T.WALL : tile;
      const c = { x: x + 0.5, y: y + 0.5 };
      switch (ch) {
        case 'S':
          invaderSpawn = c;
          break;
        case 'C':
          castellanSpawn = c;
          break;
        case 'H':
          heartCandidates.push(c);
          break;
        case 'B':
          brazierSpots.push(c);
          break;
        case 't':
          torches.push(c);
          break;
        case '+':
          doors.push(c);
          break;
        case '%':
          secretSpots.push(c);
          break;
      }
    }
  }

  const { rooms, roomCount } = floodRooms(tiles);

  return {
    id: src.id,
    name: src.name,
    blurb: src.blurb,
    w: GRID_W,
    h: GRID_H,
    tiles,
    invaderSpawn,
    castellanSpawn,
    heartCandidates,
    brazierSpots,
    torches,
    doors,
    secretSpots,
    rooms,
    roomCount,
  };
}

/**
 * Découpe le château en pièces : remplissage par diffusion sur le sol, les
 * portes faisant office de frontière. Utilisé par la Sonde et la carte de
 * chaleur.
 */
export function floodRooms(tiles: TileId[]): { rooms: Int16Array; roomCount: number } {
  const rooms = new Int16Array(GRID_W * GRID_H).fill(-1);
  let count = 0;
  const stack: number[] = [];

  const walkable = (t: TileId) => t === T.FLOOR || t === T.LOW || t === T.PIT;

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = idx(x, y);
      if (rooms[i] !== -1 || !walkable(tiles[i])) continue;
      const id = count++;
      stack.length = 0;
      stack.push(i);
      rooms[i] = id;
      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % GRID_W;
        const cy = (cur / GRID_W) | 0;
        for (const [dx, dy] of NEIGHBORS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inBounds(nx, ny)) continue;
          const ni = idx(nx, ny);
          if (rooms[ni] !== -1 || !walkable(tiles[ni])) continue;
          rooms[ni] = id;
          stack.push(ni);
        }
      }
    }
  }

  // Les portes rejoignent la pièce voisine la plus proche, pour que la Sonde
  // lancée dans une embrasure fasse quelque chose d'utile.
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = idx(x, y);
      if (tiles[i] !== T.DOOR && tiles[i] !== T.SECRET) continue;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const r = rooms[idx(nx, ny)];
        if (r >= 0) {
          rooms[i] = r;
          break;
        }
      }
    }
  }

  return { rooms, roomCount: count };
}

const NEIGHBORS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/* ==================================================================== */
/* État mutable du château pendant une manche                           */
/* ==================================================================== */

export interface Blocker {
  /** Index de tuile. */
  i: number;
  /** Temps de manche jusqu'auquel le blocage tient (Infinity = permanent). */
  until: number;
  kind: 'portcullis' | 'lock';
}

export class CastleRuntime {
  readonly plan: CastlePlan;
  /** Copie mutable : les pièges creusent des trous, l'éboulement condamne. */
  tiles: TileId[];
  /** Tuiles modifiées depuis le plan d'origine, pour les snapshots. */
  edits = new Map<number, TileId>();
  blockers = new Map<number, Blocker>();
  /** Passages secrets réellement percés (index dans `plan.secretSpots`). */
  openSecrets = new Set<number>();
  /** Torches éteintes par une Extinction, jusqu'à un instant donné. */
  dousedUntil = 0;
  dousedCenter: Vec | null = null;
  dousedRadius = 0;

  private lightMap = new Float32Array(GRID_W * GRID_H);
  private lightDirty = true;
  private dynamicSources: { pos: Vec; radius: number; power: number }[] = [];

  constructor(plan: CastlePlan) {
    this.plan = plan;
    this.tiles = plan.tiles.slice();
  }

  tile(x: number, y: number): TileId {
    if (!inBounds(x, y)) return T.WALL;
    return this.tiles[idx(x, y)];
  }

  setTile(x: number, y: number, t: TileId): void {
    if (!inBounds(x, y)) return;
    const i = idx(x, y);
    if (this.tiles[i] === t) return;
    this.tiles[i] = t;
    this.edits.set(i, t);
    this.lightDirty = true;
  }

  isBlocked(x: number, y: number, now: number): Blocker | null {
    const b = this.blockers.get(idx(x, y));
    if (!b) return null;
    if (b.until <= now) {
      this.blockers.delete(idx(x, y));
      return null;
    }
    return b;
  }

  addBlocker(x: number, y: number, until: number, kind: Blocker['kind']): void {
    if (!inBounds(x, y)) return;
    this.blockers.set(idx(x, y), { i: idx(x, y), until, kind });
  }

  clearBlocker(x: number, y: number): void {
    this.blockers.delete(idx(x, y));
  }

  /** Une tuile empêche-t-elle le déplacement ? */
  blocksMove(x: number, y: number, role: Role, now: number, flying = false): boolean {
    if (!inBounds(x, y)) return true;
    const t = this.tiles[idx(x, y)];
    switch (t) {
      case T.WALL:
      case T.RUBBLE:
      case T.FRAGILE:
        return true;
      case T.LOW:
        return !flying;
      case T.PIT:
        return !flying;
      case T.SECRET: {
        // Un passage secret n'est franchissable que par le Châtelain, et
        // seulement s'il l'a payé à la préparation.
        if (role !== 'castellan') return true;
        const si = this.plan.secretSpots.findIndex(
          (s) => Math.floor(s.x) === x && Math.floor(s.y) === y,
        );
        return si < 0 || !this.openSecrets.has(si);
      }
      case T.DOOR: {
        const b = this.isBlocked(x, y, now);
        if (!b) return false;
        // Le Châtelain est chez lui : ses verrous ne le gênent pas.
        if (b.kind === 'lock') return role !== 'castellan';
        // La herse bloque tout le monde, y compris son propriétaire.
        return true;
      }
      default: {
        const b = this.isBlocked(x, y, now);
        if (b && b.kind === 'portcullis') return true;
        return false;
      }
    }
  }

  /** Une tuile arrête-t-elle le regard ? */
  blocksSight(x: number, y: number): boolean {
    if (!inBounds(x, y)) return true;
    const t = this.tiles[idx(x, y)];
    if (t === T.WALL || t === T.RUBBLE || t === T.FRAGILE || t === T.SECRET) return true;
    // Une porte verrouillée reste une porte fermée : elle cache.
    if (t === T.DOOR && this.blockers.has(idx(x, y))) {
      const b = this.blockers.get(idx(x, y))!;
      // Une herse est une grille : on voit à travers.
      return b.kind === 'lock';
    }
    return false;
  }

  /* ---------------- Lumière ---------------- */

  setDynamicSources(sources: { pos: Vec; radius: number; power: number }[]): void {
    this.dynamicSources = sources;
    this.lightDirty = true;
  }

  markLightDirty(): void {
    this.lightDirty = true;
  }

  light(): Float32Array {
    if (this.lightDirty) this.recomputeLight();
    return this.lightMap;
  }

  lightAt(x: number, y: number): number {
    const map = this.light();
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!inBounds(tx, ty)) return 0;
    return map[idx(tx, ty)];
  }

  private recomputeLight(): void {
    const map = this.lightMap;
    map.fill(0);
    const torchOn = (p: Vec) => {
      if (!this.dousedCenter || this.dousedUntil <= 0) return true;
      const dx = p.x - this.dousedCenter.x;
      const dy = p.y - this.dousedCenter.y;
      return Math.hypot(dx, dy) > this.dousedRadius;
    };

    for (const t of this.plan.torches) {
      if (!torchOn(t)) continue;
      this.splat(map, t, 4.6, 0.72);
    }
    for (const s of this.dynamicSources) {
      this.splat(map, s.pos, s.radius, s.power);
    }
    for (let i = 0; i < map.length; i++) if (map[i] > 1) map[i] = 1;
    this.lightDirty = false;
  }

  private splat(map: Float32Array, src: Vec, radius: number, power: number): void {
    const x0 = Math.max(0, Math.floor(src.x - radius));
    const x1 = Math.min(GRID_W - 1, Math.ceil(src.x + radius));
    const y0 = Math.max(0, Math.floor(src.y - radius));
    const y1 = Math.min(GRID_H - 1, Math.ceil(src.y + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const d = Math.hypot(cx - src.x, cy - src.y);
        if (d > radius) continue;
        if (d > 1.2 && !this.losClear(src, { x: cx, y: cy })) continue;
        const f = Math.pow(1 - d / radius, 1.35) * power;
        const i = idx(x, y);
        if (f > 0) map[i] = Math.min(1, map[i] + f);
      }
    }
  }

  /* ---------------- Ligne de vue ---------------- */

  /** Tracé DDA : vrai si aucun bloqueur de vue entre `a` et `b`. */
  losClear(a: Vec, b: Vec): boolean {
    let x = Math.floor(a.x);
    let y = Math.floor(a.y);
    const ex = Math.floor(b.x);
    const ey = Math.floor(b.y);
    if (x === ex && y === ey) return true;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const invDx = dx === 0 ? Infinity : Math.abs(1 / dx);
    const invDy = dy === 0 ? Infinity : Math.abs(1 / dy);
    let tMaxX =
      dx === 0 ? Infinity : ((dx > 0 ? x + 1 - a.x : a.x - x) / Math.abs(dx));
    let tMaxY =
      dy === 0 ? Infinity : ((dy > 0 ? y + 1 - a.y : a.y - y) / Math.abs(dy));

    let guard = 0;
    while (guard++ < 256) {
      // Sur une égalité exacte, avancer systématiquement en Y rendait la
      // visibilité asymétrique : A voyait B sans que B voie A. Comme le cas se
      // produit précisément entre centres de tuiles — c'est-à-dire pour chaque
      // source de lumière — on franchit le coin en diagonale, ce qui est le
      // seul traitement symétrique.
      if (Math.abs(tMaxX - tMaxY) < 1e-9) {
        x += stepX;
        y += stepY;
        tMaxX += invDx;
        tMaxY += invDy;
      } else if (tMaxX < tMaxY) {
        x += stepX;
        tMaxX += invDx;
      } else {
        y += stepY;
        tMaxY += invDy;
      }
      if (x === ex && y === ey) return true;
      if (tMaxX > 1 && tMaxY > 1) return true;
      if (this.blocksSight(x, y)) return false;
    }
    return false;
  }

  /* ---------------- Collision cercle / tuiles ---------------- */

  /**
   * Déplace un cercle de rayon `r` de `pos` vers `pos + delta`, en résolvant
   * les axes séparément (glissement le long des murs).
   */
  moveCircle(pos: Vec, delta: Vec, r: number, role: Role, now: number, flying = false): Vec {
    let { x, y } = pos;

    /** Distance libre le long d'un axe, par dichotomie : on colle au mur. */
    const slide = (from: number, amount: number, along: 'x' | 'y'): number => {
      const dir = Math.sign(amount);
      let lo = 0;
      let hi = Math.abs(amount);
      for (let k = 0; k < 5; k++) {
        const mid = (lo + hi) / 2;
        const hit =
          along === 'x'
            ? this.circleHits(from + dir * mid, y, r, role, now, flying)
            : this.circleHits(x, from + dir * mid, r, role, now, flying);
        if (hit) hi = mid;
        else lo = mid;
      }
      return dir * lo;
    };

    if (delta.x !== 0) {
      const nx = x + delta.x;
      if (!this.circleHits(nx, y, r, role, now, flying)) {
        x = nx;
      } else {
        x += slide(x, delta.x, 'x');
        // Dégagement d'angle. Sans ça, un joueur qui longe un mur et déborde
        // d'un dixième de tuile sur la rangée suivante se retrouve collé à un
        // coin, et doit reculer pour repartir : c'est le genre d'accrochage
        // qui ruine la sensation de déplacement.
        if (delta.y === 0) y += this.cornerAssist(x, y, delta.x, 0, r, role, now, flying);
      }
    }

    if (delta.y !== 0) {
      const ny = y + delta.y;
      if (!this.circleHits(x, ny, r, role, now, flying)) {
        y = ny;
      } else {
        y += slide(y, delta.y, 'y');
        if (delta.x === 0) x += this.cornerAssist(x, y, 0, delta.y, r, role, now, flying);
      }
    }

    return { x, y };
  }

  /**
   * Petit décalage perpendiculaire qui permet de contourner un angle au lieu
   * de s'y coincer. N'est tenté que sur un déplacement en ligne droite : en
   * diagonale, un coin bloqué des deux côtés est un vrai coin, et il doit le
   * rester.
   */
  private cornerAssist(
    x: number,
    y: number,
    dx: number,
    dy: number,
    r: number,
    role: Role,
    now: number,
    flying: boolean,
  ): number {
    const reach = 0.24;
    for (const sgn of [1, -1]) {
      const ox = dy !== 0 ? sgn * reach : 0;
      const oy = dx !== 0 ? sgn * reach : 0;
      if (this.circleHits(x + ox, y + oy, r, role, now, flying)) continue;
      if (this.circleHits(x + ox + dx, y + oy + dy, r, role, now, flying)) continue;
      return (dx !== 0 ? oy : ox) * 0.55;
    }
    return 0;
  }

  circleHits(cx: number, cy: number, r: number, role: Role, now: number, flying = false): boolean {
    const x0 = Math.floor(cx - r);
    const x1 = Math.floor(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.floor(cy + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.blocksMove(tx, ty, role, now, flying)) continue;
        // Distance cercle / AABB de la tuile.
        const nx = Math.max(tx, Math.min(cx, tx + 1));
        const ny = Math.max(ty, Math.min(cy, ty + 1));
        const dx = cx - nx;
        const dy = cy - ny;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  /** Cherche la case libre la plus proche : anti-blocage après un éboulement. */
  nearestFree(pos: Vec, r: number, role: Role, now: number): Vec {
    if (!this.circleHits(pos.x, pos.y, r, role, now)) return pos;
    for (let ring = 1; ring <= 6; ring++) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const p = { x: pos.x + Math.cos(ang) * ring * 0.6, y: pos.y + Math.sin(ang) * ring * 0.6 };
        if (!this.circleHits(p.x, p.y, r, role, now)) return p;
      }
    }
    return pos;
  }

  /* ---------------- Champ de distance (molosse) ---------------- */

  /** BFS depuis une cible : renvoie un champ de distances en nombre de pas. */
  bfsField(target: Vec, role: Role, now: number): Int16Array {
    const field = new Int16Array(GRID_W * GRID_H).fill(-1);
    const tx = Math.floor(target.x);
    const ty = Math.floor(target.y);
    if (!inBounds(tx, ty)) return field;
    const queue: number[] = [idx(tx, ty)];
    field[idx(tx, ty)] = 0;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const cx = cur % GRID_W;
      const cy = (cur / GRID_W) | 0;
      const d = field[cur];
      for (const [dx, dy] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (field[ni] !== -1) continue;
        if (this.blocksMove(nx, ny, role, now)) continue;
        field[ni] = d + 1;
        queue.push(ni);
      }
    }
    return field;
  }

  /** Direction descendante du champ BFS, pour une poursuite lisible. */
  descend(field: Int16Array, pos: Vec): Vec {
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    let best = -1;
    let bestDir: Vec = { x: 0, y: 0 };
    const here = inBounds(cx, cy) ? field[idx(cx, cy)] : -1;
    if (here <= 0) return bestDir;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(nx, ny)) continue;
      const v = field[idx(nx, ny)];
      if (v === -1) continue;
      if (best === -1 || v < best) {
        best = v;
        bestDir = { x: dx, y: dy };
      }
    }
    if (best === -1 || best >= here) return { x: 0, y: 0 };
    // Vise le centre de la tuile suivante : évite les accrochages d'angle.
    const tx = cx + bestDir.x + 0.5;
    const ty = cy + bestDir.y + 0.5;
    const vx = tx - pos.x;
    const vy = ty - pos.y;
    const len = Math.hypot(vx, vy) || 1;
    return { x: vx / len, y: vy / len };
  }

  roomAt(x: number, y: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!inBounds(tx, ty)) return -1;
    return this.plan.rooms[idx(tx, ty)];
  }
}
