/**
 * Vue client d'une manche.
 *
 * Elle ne contient aucune vérité : elle assemble ce que l'hôte a bien voulu
 * transmettre, y ajoute la prédiction locale du joueur et l'interpolation des
 * entités distantes, et sert de source unique au rendu.
 *
 * Sensation visée (§13) : le déplacement répond à la touche immédiatement, et
 * un adversaire à 80 ms de latence bouge sans saccade ni téléportation.
 */

import { CFG, TICK_DT } from '@/game/config';
import { CastleRuntime, idx } from '@/game/grid';
import type {
  CastlePlan,
  Gait,
  InputFrame,
  Role,
  Snapshot,
  SnapshotOther,
  TileId,
  Vec,
} from '@/game/types';
import { T, lerp, lerpAngle } from '@/game/types';

interface EntityView {
  id: number;
  kind: string;
  from: Vec;
  to: Vec;
  a: number;
  ttl: number;
}

interface TellView {
  id: number;
  tell: string;
  x: number;
  y: number;
  facing: number;
  /** 0 → 1, pour un fondu et non une apparition sèche. */
  alpha: number;
  seen: boolean;
}

export class ClientView {
  readonly role: Role;
  /** Ce qui est *affiché* : tout est mur tant que rien n'a été révélé. */
  readonly castle: CastleRuntime;
  /**
   * Ce qui sert à *prédire le déplacement* : tout est sol tant que rien n'a été
   * révélé. Les deux cartes reçoivent exactement les mêmes révélations et ne
   * diffèrent que par leur valeur par défaut.
   *
   * Cette séparation corrige l'accrochage le plus pénible du jeu. Prédire avec
   * la carte d'affichage revenait à traiter chaque tuile pas encore reçue comme
   * un mur : l'Envahisseur invité se cognait dans du sol dégagé, puis
   * l'instantané suivant le remettait deux pas plus loin. Le joueur avançait
   * par à-coups de 50 ms au lieu de marcher.
   *
   * Le défaut inverse est presque toujours juste : l'hôte transmet aussi les
   * murs qui bordent ce qu'on vient de voir, donc un mur qu'on peut heurter est
   * déjà connu. Et dans le cas rare où la prédiction se trompe, l'hôte tranche
   * — il est le seul à faire autorité.
   */
  private readonly predictCastle: CastleRuntime;
  known = new Set<number>();

  snap: Snapshot | null = null;
  private prevSnap: Snapshot | null = null;
  private snapAt = 0;
  private prevSnapAt = 0;

  /** Position prédite localement : c'est elle qui répond à la touche. */
  pos: Vec;
  /** Position affichée : la prédite, lissée pour éviter les à-coups. */
  render: Vec;
  aim = 0;
  gait: Gait = 'normal';

  other: SnapshotOther | null = null;
  private otherRender: Vec | null = null;
  private otherAim = 0;

  entities: EntityView[] = [];
  tells = new Map<number, TellView>();

  /** Entrées envoyées mais pas encore confirmées par l'hôte. */
  private pending: InputFrame[] = [];
  private lastSeq = 0;

  constructor(plan: CastlePlan, role: Role, spawn: Vec) {
    this.role = role;
    const blank: CastlePlan = { ...plan, tiles: new Array(plan.tiles.length).fill(T.WALL) };
    this.castle = new CastleRuntime(blank);
    const open: CastlePlan = { ...plan, tiles: new Array(plan.tiles.length).fill(T.FLOOR) };
    this.predictCastle = new CastleRuntime(open);
    this.pos = { ...spawn };
    this.render = { ...spawn };
  }

  /* ================================================================== */
  /* Réception                                                          */
  /* ================================================================== */

  applySnapshot(snap: Snapshot, nowMs: number): void {
    this.prevSnap = this.snap;
    this.prevSnapAt = this.snapAt;
    this.snap = snap;
    this.snapAt = nowMs;

    for (const t of snap.newTiles) {
      this.castle.tiles[t.i] = t.t;
      this.predictCastle.tiles[t.i] = t.t;
      this.known.add(t.i);
    }
    for (const t of snap.tileEdits) {
      this.castle.tiles[t.i] = t.t;
      this.predictCastle.tiles[t.i] = t.t;
      this.known.add(t.i);
    }
    if (snap.newTiles.length || snap.tileEdits.length) this.castle.markLightDirty();

    this.castle.blockers.clear();
    this.predictCastle.blockers.clear();
    for (const b of snap.blockers) {
      const x = Math.floor(b.x);
      const y = Math.floor(b.y);
      // La durée transmise est relative au temps de manche de l'hôte ; la liste
      // étant reconstruite à chaque instantané, un obstacle disparu n'y est
      // simplement plus. On le tient donc pour posé jusqu'au prochain envoi.
      this.castle.addBlocker(x, y, Infinity, b.kind);
      this.predictCastle.addBlocker(x, y, Infinity, b.kind);
    }

    // Lumière : torches connues + braseros allumés + Cœur si on l'a trouvé.
    const sources = snap.braziers
      .filter((b) => b.lit)
      .map((b) => ({ pos: { x: b.x, y: b.y }, radius: CFG.brazier.lightRadius, power: 0.95 }));
    if (snap.heart) sources.push({ pos: snap.heart, radius: 5.5, power: 0.8 });
    this.castle.setDynamicSources(sources);

    /* --- Réconciliation de sa propre position --- */
    this.pending = this.pending.filter((f) => f.seq > snap.ackSeq);

    // Chez l'hôte, personne n'empile d'entrée en attente : sa vue est
    // reconstruite directement depuis la simulation. Sans cette ligne, `aim`
    // n'était jamais écrit et son propre personnage restait tourné vers l'est
    // pendant toute la manche, quoi que fasse la souris — on tirait dans une
    // direction et on regardait dans une autre.
    if (!this.pending.length) this.aim = snap.self.aim;
    const authoritative = { x: snap.self.x, y: snap.self.y };
    let replayed = { ...authoritative };
    for (const f of this.pending) {
      replayed = this.applyMove(replayed, f, TICK_DT, snap.self.state);
    }
    const err = Math.hypot(replayed.x - this.pos.x, replayed.y - this.pos.y);
    if (err > CFG.net.hardSnapDistance) {
      // Un écart de cette taille n'est pas du retard : c'est une correction.
      this.pos = replayed;
      this.render = { ...replayed };
    } else {
      this.pos = replayed;
    }

    /* --- L'adversaire --- */
    if (!snap.other) {
      this.other = null;
      this.otherRender = null;
    } else {
      if (!this.other) {
        // Il réapparaît : on ne l'interpole pas depuis une position périmée.
        this.otherRender = { x: snap.other.x, y: snap.other.y };
        this.otherAim = snap.other.aim;
      }
      this.other = snap.other;
    }

    /* --- Indices : fondu, jamais d'apparition sèche --- */
    for (const t of this.tells.values()) t.seen = false;
    for (const t of snap.tells) {
      const existing = this.tells.get(t.id);
      if (existing) {
        existing.seen = true;
        existing.x = t.x;
        existing.y = t.y;
      } else {
        this.tells.set(t.id, { ...t, alpha: 0, seen: true });
      }
    }

    /* --- Entités --- */
    const next: EntityView[] = [];
    for (const e of snap.entities) {
      const old = this.entities.find((x) => x.id === e.id);
      next.push({
        id: e.id,
        kind: e.kind,
        from: old ? old.to : { x: e.x, y: e.y },
        to: { x: e.x, y: e.y },
        a: e.a,
        ttl: e.ttl,
      });
    }
    this.entities = next;
  }

  /* ================================================================== */
  /* Prédiction locale                                                  */
  /* ================================================================== */

  /** Enregistre l'entrée envoyée, pour pouvoir la rejouer à la réconciliation. */
  pushInput(frame: InputFrame): void {
    this.lastSeq = frame.seq;
    this.pending.push(frame);
    if (this.pending.length > 90) this.pending.shift();
    this.gait = frame.gait;
    this.aim = frame.aim;
    this.pos = this.applyMove(this.pos, frame, TICK_DT, this.snap?.self.state ?? 'idle');
  }

  nextSeq(): number {
    return this.lastSeq + 1;
  }

  /**
   * Déplacement prédit. Volontairement plus simple que la simulation : on
   * prédit ce qui est certain (la marche), jamais ce qui dépend de l'autre
   * joueur (les dégâts, les projections). L'hôte tranche le reste.
   */
  private applyMove(from: Vec, f: InputFrame, dt: number, state: string): Vec {
    if (state === 'stun' || state === 'immobile' || state === 'dead' || state === 'scrying') {
      return from;
    }
    let speed = this.role === 'invader' ? CFG.invader.baseSpeed : CFG.castellan.baseSpeed;
    if (this.role === 'invader') speed *= CFG.invader.gait[f.gait].speedMul;
    if (state === 'parry') speed = 0;
    else if (state === 'windup') speed *= 0.35;
    else if (state === 'recover') speed *= 0.55;
    else if (state === 'casting') speed *= 0.2;

    const m = Math.hypot(f.move.x, f.move.y);
    const mv = m > 1 ? { x: f.move.x / m, y: f.move.y / m } : f.move;
    const delta = { x: mv.x * speed * dt, y: mv.y * speed * dt };
    const r = this.role === 'invader' ? CFG.invader.radius : CFG.castellan.radius;
    return this.predictCastle.moveCircle(from, delta, r, this.role, this.snap?.now ?? 0);
  }

  /* ================================================================== */
  /* Interpolation d'affichage                                          */
  /* ================================================================== */

  /** Appelé à chaque frame de rendu, pas à chaque tick. */
  interpolate(dtMs: number, nowMs: number): void {
    const dt = dtMs / 1000;

    // Sa propre position : lissage court, sinon la correction se voit.
    const k = Math.min(1, CFG.net.reconcileLerp * dt);
    this.render.x = lerp(this.render.x, this.pos.x, k);
    this.render.y = lerp(this.render.y, this.pos.y, k);

    // L'adversaire : rendu avec un retard fixe, ce qui absorbe la gigue.
    if (this.other && this.otherRender) {
      const target = { x: this.other.x, y: this.other.y };
      const delay = CFG.net.interpDelay * 1000;
      const span = Math.max(1, this.snapAt - this.prevSnapAt);
      const t = Math.min(1, Math.max(0, (nowMs - delay - this.prevSnapAt) / span));
      const kk = Math.min(1, 12 * dt * (0.4 + t));
      this.otherRender.x = lerp(this.otherRender.x, target.x, kk);
      this.otherRender.y = lerp(this.otherRender.y, target.y, kk);
      this.otherAim = lerpAngle(this.otherAim, this.other.aim, Math.min(1, 14 * dt));
    }

    for (const e of this.entities) {
      const kk = Math.min(1, 18 * dt);
      e.from.x = lerp(e.from.x, e.to.x, kk);
      e.from.y = lerp(e.from.y, e.to.y, kk);
    }

    const fade = dt / CFG.invader.tellFade;
    for (const [id, t] of this.tells) {
      t.alpha += t.seen ? fade : -fade;
      if (t.alpha <= 0 && !t.seen) {
        this.tells.delete(id);
        continue;
      }
      t.alpha = Math.min(1, Math.max(0, t.alpha));
    }
  }

  otherAt(): { pos: Vec; aim: number; data: SnapshotOther } | null {
    if (!this.other || !this.otherRender) return null;
    return { pos: this.otherRender, aim: this.otherAim, data: this.other };
  }

  entityViews(): { id: number; kind: string; pos: Vec; a: number; ttl: number }[] {
    return this.entities.map((e) => ({ id: e.id, kind: e.kind, pos: e.from, a: e.a, ttl: e.ttl }));
  }

  tellViews(): TellView[] {
    return Array.from(this.tells.values()).filter((t) => t.alpha > 0.01);
  }

  isKnown(x: number, y: number): boolean {
    return this.known.has(idx(x, y));
  }

  tileAt(x: number, y: number): TileId {
    return this.castle.tile(x, y);
  }
}
