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
import { driveMotion, expireStates, type Motion } from '@/game/movement';
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

/** Trames en attente conservées au plus : cinq secondes à 30 Hz. */
const PENDING_MAX = 150;

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

  /**
   * Le tracé montré par un coup d'œil à la carte, tenu À PART de `known`.
   *
   * C'est ce qui rend le coup d'œil temporaire : ces tuiles s'affichent
   * pendant cinq secondes puis disparaissent, sans laisser de trace dans la
   * mémoire du plan. Les verser dans `known` aurait tout révélé pour de bon au
   * premier usage, et les deux autres charges n'auraient servi à rien.
   */
  private glimpseTiles: TileId[] | null = null;
  glimpseUntil = 0;
  glimpseCharges = CFG.glimpse.charges;

  snap: Snapshot | null = null;
  private prevSnap: Snapshot | null = null;
  private snapAt = 0;
  private prevSnapAt = 0;

  /**
   * Son propre état de mouvement, prédit localement : c'est lui qui répond à
   * la touche. Il est avancé par `movement.ts`, le MÊME code que l'hôte.
   */
  private motion: Motion;
  /** Position prédite (raccourci vers `motion.pos`). */
  pos: Vec;
  /** Position au pas précédent : l'affichage glisse de l'une à l'autre. */
  private prevPos: Vec;
  /**
   * Écart visuel laissé par la dernière correction de l'hôte, résorbé en
   * quelques dizaines de millisecondes. On lisse la CORRECTION, jamais le
   * déplacement lui-même.
   */
  private corr: Vec = { x: 0, y: 0 };
  /** Vrai dès qu'on prédit (l'invité). L'hôte, lui, n'a rien à prédire. */
  private predicting = false;
  /** Position affichée. */
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
    this.motion = {
      role,
      pos: { ...spawn },
      vel: { x: 0, y: 0 },
      aim: 0,
      gait: 'normal',
      state: 'idle',
      stateUntil: 0,
      dodgeDir: { x: 1, y: 0 },
      dodgeReadyAt: 0,
      actionLockUntil: 0,
      attackQueuedUntil: 0,
    };
    this.pos = this.motion.pos;
    this.prevPos = { ...spawn };
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
    if (snap.openSecrets) {
      this.castle.openSecrets = new Set(snap.openSecrets);
      this.predictCastle.openSecrets = new Set(snap.openSecrets);
    }

    const g = snap.glimpse;
    if (g) {
      this.glimpseCharges = g.charges;
      this.glimpseUntil = g.until;
      if (g.tiles) this.glimpseTiles = g.tiles;
      else if (g.until <= snap.now) this.glimpseTiles = null;
    }

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

    if (!this.predicting) {
      // L'hôte : sa vue EST la simulation, reconstruite à chaque tick. Pas de
      // correction à fondre, seulement le pas de ce tick à interpoler.
      this.prevPos = { ...this.motion.pos };
      this.motion = this.seed(snap);
      this.pos = this.motion.pos;
      // Sans cette ligne, `aim` n'était jamais écrit chez l'hôte : son propre
      // personnage restait tourné vers l'est toute la manche.
      this.aim = snap.self.aim;
      this.gait = snap.self.gait;
    } else {
      // L'invité : on repart de l'état que l'hôte confirme, puis on rejoue
      // chaque trame qu'il n'a pas encore jouée, au même instant que lui.
      const before = { ...this.motion.pos };
      const m = this.seed(snap);
      this.pending.forEach((f, k) => this.advance(m, f, snap.now + (k + 1) * TICK_DT));
      this.motion = m;
      this.pos = m.pos;
      const dx = m.pos.x - before.x;
      const dy = m.pos.y - before.y;
      if (Math.hypot(dx, dy) > CFG.net.hardSnapDistance) {
        // Un écart de cette taille n'est pas du retard : on recale net.
        this.prevPos = { ...m.pos };
        this.corr = { x: 0, y: 0 };
      } else {
        // L'affichage ne bouge pas d'un pixel à l'instant de la correction ;
        // l'écart est ensuite résorbé dans `interpolate`.
        this.prevPos.x += dx;
        this.prevPos.y += dy;
        this.corr.x -= dx;
        this.corr.y -= dy;
      }
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
    this.predicting = true;
    this.lastSeq = frame.seq;
    this.pending.push(frame);
    // Cinq secondes sans instantané : la liaison est morte, la pause viendra.
    // On borne pour ne pas rejouer une file sans fin à chaque réception.
    if (this.pending.length > PENDING_MAX) this.pending.shift();
    this.gait = frame.gait;
    this.prevPos = { ...this.motion.pos };
    this.advance(this.motion, frame, (this.snap?.now ?? 0) + this.pending.length * TICK_DT);
    this.pos = this.motion.pos;
    this.aim = this.motion.aim;
  }

  nextSeq(): number {
    return this.lastSeq + 1;
  }

  /**
   * Un tick de SES PROPRES mouvements, par le code de l'hôte.
   *
   * On prédit tout ce qui ne dépend que de soi : la marche et son élan,
   * l'esquive, le départ d'une frappe et le ralentissement qu'elle impose, la
   * fin datée d'un étourdissement. Jamais ce qui dépend de l'adversaire — un
   * coup reçu, un recul : l'hôte le tranche et la correction s'en charge.
   */
  private advance(m: Motion, f: InputFrame, now: number): void {
    expireStates(m, now);
    driveMotion(m, f, this.predictCastle, now, TICK_DT);
  }

  /** L'état de mouvement que l'hôte confirme dans cet instantané. */
  private seed(snap: Snapshot): Motion {
    const s = snap.self;
    return {
      role: this.role,
      pos: { x: s.x, y: s.y },
      vel: { x: s.vx, y: s.vy },
      aim: s.aim,
      gait: s.gait,
      state: s.state,
      stateUntil: s.stateUntil,
      dodgeDir: { x: s.dodgeDir.x, y: s.dodgeDir.y },
      dodgeReadyAt: s.dodgeReadyAt,
      actionLockUntil: s.actionLockUntil,
      attackQueuedUntil: s.attackQueuedUntil,
    };
  }

  /* ================================================================== */
  /* Interpolation d'affichage                                          */
  /* ================================================================== */

  /**
   * Appelé à chaque frame de rendu, pas à chaque tick.
   *
   * `alpha` est la fraction du tick en cours déjà écoulée (0 → 1).
   */
  interpolate(dtMs: number, nowMs: number, alpha = 1): void {
    const dt = dtMs / 1000;

    // Sa propre position.
    //
    // Elle poursuivait `pos` par un filtre exponentiel : en régime établi,
    // l'affichage traînait de v/14 derrière le joueur — 0,24 tuile en marche,
    // 70 ms de retard pur, hôte compris. Et la caméra, et même la visée,
    // suivaient cette position en retard : c'est tout l'écran qui semblait
    // répondre mollement.
    //
    // On interpole désormais entre les deux derniers pas simulés, ce qui
    // plafonne le retard à un tick, et l'on ne lisse plus que la correction.
    const a = Math.min(1, Math.max(0, alpha));
    const decay = Math.exp(-CFG.net.reconcileLerp * dt);
    this.corr.x *= decay;
    this.corr.y *= decay;
    this.render.x = lerp(this.prevPos.x, this.pos.x, a) + this.corr.x;
    this.render.y = lerp(this.prevPos.y, this.pos.y, a) + this.corr.y;

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

  /** Un coup d'œil à la carte est-il ouvert en ce moment ? */
  glimpsing(): boolean {
    return this.glimpseTiles !== null && (this.snap?.now ?? 0) < this.glimpseUntil;
  }

  /**
   * La tuile à DESSINER en `i`. Pendant un coup d'œil, c'est le tracé montré ;
   * le reste du temps, ce qu'on a réellement exploré. Le déplacement, lui, ne
   * lit jamais ceci : il s'appuie toujours sur la carte de prédiction.
   */
  drawnTile(i: number): TileId {
    return this.glimpsing() ? this.glimpseTiles![i] : this.castle.tiles[i];
  }

  tileAt(x: number, y: number): TileId {
    return this.castle.tile(x, y);
  }
}
