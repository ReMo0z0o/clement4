/**
 * Filtrage des instantanés (§13).
 *
 * Règle unique et non négociable : **l'hôte n'envoie jamais à un client une
 * donnée que ce client n'a pas le droit de percevoir.** Cacher une information
 * à l'affichage tout en la transmettant est, dans un jeu à information cachée,
 * la faille la plus évidente qui soit.
 *
 * Tout ce qui est spécifique à un destinataire passe par ce fichier, et rien
 * d'autre ne construit de `Snapshot`.
 */

import { CFG } from './config';
import { idx } from './grid';
import type { World } from './sim';
import type {
  GameEvent,
  IntelResult,
  Phase,
  Role,
  Snapshot,
  SnapshotOther,
  SnapshotSelf,
  TileId,
  VisibleTell,
} from './types';
import { T, dist } from './types';

export class SnapshotFilter {
  /** Tuiles déjà transmises à ce destinataire. */
  private sentTiles = new Set<number>();
  private sentEdits = new Set<number>();
  /**
   * Tuiles auxquelles ce destinataire a droit sans avoir à les explorer.
   *
   * Attention : « avoir droit » n'est pas « avoir reçu ». Confondre les deux
   * revenait à considérer le plan du Châtelain comme déjà transmis, donc à ne
   * jamais le lui envoyer — il jouait sur un château entièrement composé de
   * murs, sans rien voir de ce qu'il avait construit.
   */
  private readonly preknown = new Set<number>();

  constructor(
    private readonly role: Role,
    world: World,
    private readonly intel: IntelResult = {},
  ) {
    const wholeMap =
      // Le Châtelain voit son plan en permanence : c'est son château (§14).
      role === 'castellan' ||
      // Plan volé : le tracé des murs, et rien d'autre.
      world.loadout.tools.includes('stolenmap');
    if (wholeMap) {
      for (let i = 0; i < world.plan.tiles.length; i++) this.preknown.add(i);
    }
  }

  build(
    world: World,
    opts: {
      phase: Phase;
      tick: number;
      ackSeq: number;
      score: { host: number; guest: number };
      round: number;
    },
  ): Snapshot {
    const me = this.role === 'invader' ? world.invader : world.castellan;
    const isInvader = this.role === 'invader';

    /* ---- soi ---- */
    const tools = world.toolStates();
    const self: SnapshotSelf = {
      x: me.pos.x,
      y: me.pos.y,
      hp: me.hp,
      aim: me.aim,
      gait: me.gait,
      state: me.state,
      influence: isInvader ? 0 : world.influence,
      scrying: !isInvader && world.scrying,
      dodgeReadyAt: me.dodgeReadyAt,
      actionLockUntil: me.actionLockUntil,
      toolUses: isInvader ? tools.map((t) => (t.uses === Infinity ? -1 : t.uses)) : [],
      toolCooldowns: isInvader ? tools.map((t) => Math.max(0, t.readyAt - world.now)) : [],
      shieldHp: isInvader && world.now < world.shieldUntil ? world.shieldHp : 0,
    };

    /* ---- l'autre : seulement s'il est réellement perçu ---- */
    let other: SnapshotOther | null = null;
    if (isInvader) {
      if (world.invaderSees()) {
        const c = world.castellan;
        other = {
          x: c.pos.x,
          y: c.pos.y,
          aim: c.aim,
          state: c.state,
          gait: c.gait,
          hp: c.hp,
          via: 'sight',
        };
      }
    } else {
      const via = world.castellanSees();
      if (via) {
        const i = world.invader;
        other = { x: i.pos.x, y: i.pos.y, aim: i.aim, state: i.state, gait: i.gait, hp: i.hp, via };
      }
    }

    /* ---- indices ---- */
    let tells: VisibleTell[] = [];
    if (isInvader) {
      // Rien dans cette liste ne distingue un vrai piège d'un faux (§4).
      tells = world.visibleTells().map((t) => ({
        id: t.id,
        tell: t.tell,
        x: t.x,
        y: t.y,
        facing: t.facing,
      }));
    }

    /* ---- cicatrices : pièges déjà déclenchés, visibles par tous ---- */
    const scars = world.traps
      .filter((t) => t.state === 'spent' || t.state === 'disabled')
      .filter((t) => t.kind !== 'decoy')
      .filter((t) => {
        if (!isInvader) return true;
        // Une cicatrice n'est visible que si le piège a réellement fonctionné
        // sous ses yeux, ou s'il en avait repéré l'indice. La brèche à 50 %
        // désactive tout piège proche du Cœur : sans ce filtre, elle lui
        // offrait le type et la position exacte de pièges qu'il n'avait jamais
        // vus — et le même château resservant aux manches 3 et 4, c'était tout
        // le plan de défense qui partait.
        if (t.triggeredAt < 0 && !t.discovered) return false;
        return world.explored.has(idx(Math.floor(t.x), Math.floor(t.y)));
      })
      .map((t) => ({ id: t.id, kind: t.kind, x: t.x, y: t.y }));

    /* ---- entités : le carreau qui vole, le molosse qui charge ---- */
    const entities = world.entities
      .filter((e) => {
        if (!isInvader) return world.scrying || dist(e.pos, world.castellan.pos) <= CFG.vision.castellanRange;
        return (
          dist(e.pos, world.invader.pos) <= CFG.vision.invaderRange &&
          world.castle.losClear(world.invader.pos, e.pos)
        );
      })
      .map((e) => ({ id: e.id, kind: e.kind, x: e.pos.x, y: e.pos.y, a: e.angle ?? 0, ttl: e.ttl }));

    /* ---- braseros : position connue seulement une fois vue ou achetée ---- */
    const braziers = world.braziers
      .filter((b) => {
        if (!isInvader) return true;
        if (world.seenBraziers.has(b.id)) return true;
        return this.intel.brazier === b.id;
      })
      .map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, lit: b.lit, progress: b.progress }));

    /* ---- tuiles, en delta ---- */
    const newTiles: { i: number; t: TileId }[] = [];
    const entitled = this.preknown.size ? this.preknown : world.explored;
    for (const i of entitled) {
      if (this.sentTiles.has(i)) continue;
      this.sentTiles.add(i);
      newTiles.push({ i, t: world.castle.tiles[i] });
    }
    if (this.preknown.size && isInvader) {
      // Le Plan volé ne donne que les murs : le reste continue de s'explorer.
      for (const i of world.explored) {
        if (this.sentTiles.has(i)) continue;
        this.sentTiles.add(i);
        newTiles.push({ i, t: world.castle.tiles[i] });
      }
    }
    const tileEdits: { i: number; t: TileId }[] = [];
    for (const [i, t] of world.castle.edits) {
      // Une modification n'est transmise que si le destinataire connaît la tuile.
      if (isInvader && !this.sentTiles.has(i)) continue;
      const key = i * 16 + t;
      if (this.sentEdits.has(key)) continue;
      this.sentEdits.add(key);
      tileEdits.push({ i, t });
    }

    /* ---- obstacles visibles ---- */
    const blockers: { x: number; y: number; until: number }[] = [];
    for (const [i, b] of world.castle.blockers) {
      if (isInvader && !world.explored.has(i)) continue;
      blockers.push({
        x: (i % world.plan.w) + 0.5,
        y: Math.floor(i / world.plan.w) + 0.5,
        until: b.until === Infinity ? -1 : b.until,
      });
    }

    // Une Extinction déclenchée dans une aile jamais visitée livrait son centre
    // et son rayon — donc l'emplacement du mécanisme. On ne la transmet que si
    // le destinataire est en mesure de constater que les torches sont éteintes.
    let dz = world.dousedInfo();
    if (dz && isInvader) {
      const seen = world.explored.has(idx(Math.floor(dz.x), Math.floor(dz.y)));
      const inside = dist(me.pos, { x: dz.x, y: dz.y }) <= dz.r;
      if (!seen && !inside) dz = null;
    }

    /* ---- le Cœur ---- */
    const heartKnown =
      !isInvader ||
      world.seenHeart ||
      world.captureProgress > 0 ||
      (this.intel.eliminatedHeart?.length ?? 0) > 0;

    const snap: Snapshot = {
      tick: opts.tick,
      ackSeq: opts.ackSeq,
      phase: opts.phase,
      timeLeft: Math.max(0, world.timeLeft),
      now: world.now,
      self,
      other,
      entities,
      tells,
      scars,
      capture: {
        progress: world.captureProgress,
        contested: world.contested,
        breached: world.breached,
      },
      braziers,
      newTiles,
      tileEdits,
      blockers,
      doused: dz ? [dz] : [],
      alarm: world.alarm,
      heart: heartKnown ? { x: world.heart.x, y: world.heart.y } : null,
      heartDist: audibleHeartDist(dist(me.pos, world.heart), isInvader),
      score: opts.score,
      round: opts.round,
    };

    if (!isInvader) {
      // Le Châtelain connaît ses propres mécanismes — et seulement les siens.
      snap.devices = world.devices.map((d) => ({
        id: d.id,
        kind: d.kind,
        x: d.x,
        y: d.y,
        ready: world.influence >= CFG.devices[d.kind].influence && world.now >= d.activeUntil,
        used: d.used,
      }));
      snap.ownTraps = world.traps.map((t) => ({
        id: t.id,
        kind: t.kind,
        x: t.x,
        y: t.y,
        state: t.state,
      }));
    } else {
      snap.hintedBraziers = this.intel.brazier !== undefined ? [this.intel.brazier] : [];
      snap.hintedHearts = this.intel.eliminatedHeart ?? [];
    }

    return snap;
  }
}

/**
 * Distance au Cœur transmise à un client.
 *
 * Le battement sert de boussole (§10) et exige donc une distance. Mais une
 * distance exacte, relevée en trois points, se trilatère : trois mesures
 * suffisaient à retrouver le Cœur au millionième de tuile depuis l'autre bout
 * du château, sans jamais l'avoir vu.
 *
 * On borne donc à la portée audible — au-delà, la valeur est constante et ne
 * dit plus rien — et on arrondit à l'intérieur. Ce qui reste correspond
 * exactement à ce que l'oreille perçoit : « il est proche », pas « il est là ».
 */
function audibleHeartDist(d: number, isInvader: boolean): number {
  if (!isInvader) return d;
  const max = CFG.heart.heartbeatRadius;
  if (d >= max) return max;
  const step = 2;
  return Math.min(max, Math.round(d / step) * step);
}

/** Contrôle de sûreté, exécuté par les tests : rien d'interdit ne doit fuir. */
export function auditSnapshot(snap: Snapshot, role: Role, world: World): string[] {
  const problems: string[] = [];

  if (role === 'invader') {
    if (snap.other && !world.invaderSees()) {
      problems.push("La position du Châtelain est transmise alors qu'il n'est pas perçu.");
    }
    if (snap.devices) problems.push("Les mécanismes du Châtelain sont transmis à l'Envahisseur.");
    if (snap.ownTraps) problems.push("Les pièges du Châtelain sont transmis à l'Envahisseur.");
    if (snap.self.influence !== 0) problems.push("L'Influence du Châtelain est transmise à l'Envahisseur.");
    if (snap.heart && !world.seenHeart && world.captureProgress === 0 && !(snap.hintedHearts?.length)) {
      problems.push("La position du Cœur est transmise avant d'avoir été trouvée.");
    }
    for (const b of snap.braziers) {
      if (!world.seenBraziers.has(b.id) && !snap.hintedBraziers?.includes(b.id)) {
        problems.push(`Le brasero ${b.id} est transmis avant d'avoir été vu.`);
      }
    }
    for (const t of snap.newTiles) {
      if (!world.explored.has(t.i) && !world.loadout.tools.includes('stolenmap')) {
        problems.push(`La tuile ${t.i} est transmise avant d'avoir été explorée.`);
      }
    }
    void 0;
    // Un faux indice doit être indiscernable d'un vrai dans la charge utile.
    for (const tell of snap.tells) {
      const trap = world.traps.find((x) => x.id === tell.id);
      if (!trap) continue;
      const keys = Object.keys(tell).sort().join(',');
      if (keys !== 'facing,id,tell,x,y') {
        problems.push(`L'indice ${tell.id} transporte des champs supplémentaires : ${keys}.`);
      }
    }
  } else {
    if (snap.other && !world.castellanSees()) {
      problems.push("La position de l'Envahisseur est transmise alors qu'il n'est pas perçu.");
    }
    if (snap.tells.length) problems.push('Des indices sont transmis au Châtelain via `tells`.');
  }

  return problems;
}

/**
 * Le son est un canal de jeu, donc il se filtre comme le reste (§10).
 *
 * C'est l'endroit exact où se joue « une alternative gratuite à l'omniscience » :
 * le Châtelain apprend *ce qui* s'est déclenché et *où*, sans entrer en
 * Scrutation — mais il n'entend jamais une allure prudente.
 */
export function filterEvents(events: GameEvent[], role: Role, world: World): GameEvent[] {
  const out: GameEvent[] = [];
  const me = role === 'invader' ? world.invader : world.castellan;

  for (const e of events) {
    switch (e.k) {
      case 'step': {
        if (e.role === role) break; // on n'entend pas ses propres pas
        if (e.role === 'invader') {
          // Allure prudente : aucun bruit émis, l'événement n'existe même pas.
          const radius = e.loud ? Infinity : CFG.invader.gait.normal.noise;
          if (dist({ x: e.x, y: e.y }, me.pos) <= radius) out.push(e);
        } else if (dist({ x: e.x, y: e.y }, me.pos) <= CFG.castellan.footstepRadius) {
          out.push(e);
        }
        break;
      }
      case 'replay':
        // La vignette de rejeu est la récompense du Châtelain (§11).
        if (role === 'castellan') out.push(e);
        break;
      case 'scry':
        if (role === 'castellan') out.push(e);
        break;
      case 'probe':
        if (role === 'invader') out.push(e);
        break;
      case 'trap':
      case 'device':
      case 'blast':
      case 'alarm':
      case 'breach':
      case 'brazier':
      case 'door':
        // Entendus des deux côtés : c'est tout leur intérêt.
        out.push(e);
        break;
      default: {
        // Coups, parades, esquives : audibles à portée de mêlée.
        if (dist({ x: (e as { x: number }).x, y: (e as { y: number }).y }, me.pos) <= 11) out.push(e);
        break;
      }
    }
  }
  return out;
}

/** Les tuiles d'un plan, pour l'initialisation du client Châtelain. */
export function fullTiles(tiles: TileId[]): { i: number; t: TileId }[] {
  const out: { i: number; t: TileId }[] = [];
  for (let i = 0; i < tiles.length; i++) if (tiles[i] !== T.WALL) out.push({ i, t: tiles[i] });
  return out;
}
