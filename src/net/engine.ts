/**
 * Moteur de match : machine à états, autorité côté hôte, prédiction côté invité.
 *
 * Le créateur de la session est l'hôte et le reste tout le match, quel que soit
 * son rôle dans la manche en cours (§13). Il fait tourner la simulation à
 * 30 ticks/s ; l'invité n'exécute aucune logique de vérité.
 *
 * La boucle vit hors de React (§18) : elle appelle `onState` à basse fréquence
 * pour le HUD, et le rendu lit directement `view` à chaque frame.
 */

import { CFG, MAX_CATCHUP_TICKS, TICK_DT } from '@/game/config';
import type { IntelKind, ToolKind } from '@/game/config';
import { getPlan } from '@/game/plans';
import {
  applyResult,
  defenderOf,
  invaderOf,
  isRedress,
  newMatch,
  nextRound,
  prepDuration,
  recordBurned,
  roleOf,
  roundDuration,
  slot,
  TIEBREAK_ROUND,
  type MatchState,
  type Side,
} from '@/game/match';
import {
  buildCost,
  canPlaceDevice,
  canPlaceSensor,
  canPlaceTrap,
  emptyBuild,
  emptyLoadout,
  loadoutCost,
  prepareRedress,
  resolveIntel,
  sanitizeBuild,
  sanitizeLoadout,
} from '@/game/prep';
import { World } from '@/game/sim';
import { SnapshotFilter, filterEvents } from '@/game/snapshot';
import type {
  BuildOrder,
  DeviceKind,
  GameEvent,
  InputFrame,
  IntelResult,
  Loadout,
  NetMessage,
  Phase,
  PlanId,
  Role,
  RoundResult,
  Snapshot,
  TellKind,
  TrapKind,
} from '@/game/types';
import { emptyInput } from '@/game/types';
import { ClientView } from './clientView';
import type { PeerStatus, Transport } from './transport';

export interface EngineState {
  phase: Phase;
  round: number;
  side: Side;
  role: Role;
  timeLeft: number;
  score: { host: number; guest: number };
  peer: PeerStatus;
  code: string;
  transport: 'local' | 'supabase';
  /** Le pair est parti : la partie est en pause, pas perdue. */
  paused: boolean;
  pauseSecondsLeft: number;

  planId: PlanId | null;
  planLocked: boolean;
  build: BuildOrder;
  loadout: Loadout;
  budgetTotal: number;
  budgetSpent: number;
  ready: boolean;
  peerReady: boolean;
  /** Manches 3 et 4 : pièges repérés par l'adversaire, déplaçables gratuitement. */
  burned: number[];
  heat: { x: number; y: number; t: number }[];

  intel: IntelResult | null;
  result: RoundResult | null;
  matchWinner: Side | null;
  /** Rejeu de piège en cours (§11). */
  replay: { trap: TrapKind; x: number; y: number; until: number } | null;
  notice: string | null;
}

export type EngineListener = (s: EngineState) => void;
export type EventListener = (events: GameEvent[]) => void;

export class Engine {
  readonly transport: Transport;
  readonly isHost: boolean;
  readonly side: Side;

  view: ClientView | null = null;
  private world: World | null = null;
  private match: MatchState = newMatch();

  private filterSelf: SnapshotFilter | null = null;
  private filterPeer: SnapshotFilter | null = null;

  private state: EngineState;
  private listeners = new Set<EngineListener>();
  private eventListeners = new Set<EventListener>();

  private raf = 0;
  private lastFrame = 0;
  private acc = 0;
  private tick = 0;
  private snapAcc = 0;
  private inputAcc = 0;
  private phaseEndsAt = 0;
  private uiAcc = 0;

  private localInput: InputFrame = emptyInput();
  private remoteInput: InputFrame = emptyInput();
  private lastAckSeq = 0;
  private seq = 0;
  private peerBuild: BuildOrder | null = null;
  private peerLoadout: Loadout | null = null;
  private peerReadyFlag = false;
  /**
   * Plafond de construction de chaque camp pour la manche en cours. Il dépasse
   * le budget de base aux manches de réaménagement, et la revalidation d'hôte
   * doit utiliser exactement le même chiffre que l'interface — sinon le
   * défenseur voit ses derniers pièges disparaître au lancement.
   */
  private roundBudget: Record<Side, number> = { host: CFG.budget.castellan, guest: CFG.budget.castellan };
  private disconnectedAt = 0;
  private unsubscribe: (() => void)[] = [];

  constructor(transport: Transport, onState?: EngineListener) {
    this.transport = transport;
    this.isHost = transport.isHost;
    this.side = transport.isHost ? 'host' : 'guest';
    this.state = {
      phase: 'lobby',
      round: 0,
      side: this.side,
      role: 'invader',
      timeLeft: 0,
      score: { host: 0, guest: 0 },
      peer: { connected: false, latency: null },
      code: transport.code,
      transport: transport.kind,
      paused: false,
      pauseSecondsLeft: 0,
      planId: null,
      planLocked: false,
      build: emptyBuild('compact'),
      loadout: emptyLoadout(),
      budgetTotal: CFG.budget.castellan,
      budgetSpent: 0,
      ready: false,
      peerReady: false,
      burned: [],
      heat: [],
      intel: null,
      result: null,
      matchWinner: null,
      replay: null,
      notice: null,
    };
    if (onState) this.listeners.add(onState);

    this.unsubscribe.push(transport.onMessage((m) => this.onMessage(m)));
    this.unsubscribe.push(
      transport.onPeer((p) => {
        const wasConnected = this.state.peer.connected;
        this.state.peer = p;
        if (!p.connected && wasConnected) this.disconnectedAt = performance.now();
        if (p.connected) this.disconnectedAt = 0;
        this.emit();
      }),
    );
  }

  /* ================================================================== */
  /* Abonnements                                                        */
  /* ================================================================== */

  subscribe(cb: EngineListener): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  onEvents(cb: EventListener): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private emit(): void {
    const snapshot = { ...this.state };
    for (const cb of this.listeners) cb(snapshot);
  }

  private fire(events: GameEvent[]): void {
    if (!events.length) return;
    for (const e of events) {
      if (e.k === 'replay') {
        this.state.replay = {
          trap: e.trap,
          x: e.x,
          y: e.y,
          until: performance.now() / 1000 + CFG.feel.replayDuration,
        };
      }
    }
    for (const cb of this.eventListeners) cb(events);
  }

  getState(): EngineState {
    return this.state;
  }

  /* ================================================================== */
  /* Boucle                                                             */
  /* ================================================================== */

  start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      // Onglet en arrière-plan : rAF s'arrête, on ne rattrape pas l'infini (§18).
      const dtMs = Math.min(250, now - this.lastFrame);
      this.lastFrame = now;
      this.update(dtMs / 1000, now);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /**
   * Arrête la boucle et ferme le transport.
   *
   * Le moteur possède son transport à partir de sa construction : c'est la
   * seule façon d'éviter qu'un nettoyage extérieur ferme une connexion qui
   * vient d'être ouverte.
   */
  stop(): void {
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    this.listeners.clear();
    this.eventListeners.clear();
    this.transport.close();
  }

  private update(dt: number, nowMs: number): void {
    /* --- Pause sur déconnexion (§13) --- */
    const wantPause = !this.state.peer.connected && this.state.phase !== 'lobby';
    if (wantPause !== this.state.paused) {
      this.state.paused = wantPause;
      this.emit();
    }
    if (this.state.paused) {
      const elapsed = (nowMs - this.disconnectedAt) / 1000;
      this.state.pauseSecondsLeft = Math.max(0, CFG.net.disconnectGrace - elapsed);
      this.uiAcc += dt;
      if (this.uiAcc > 0.25) {
        this.uiAcc = 0;
        this.emit();
      }
      return;
    }

    if (this.state.replay && nowMs / 1000 > this.state.replay.until) {
      this.state.replay = null;
      this.emit();
    }

    if (this.isHost) this.hostUpdate(dt, nowMs);
    else this.guestUpdate(dt, nowMs);

    this.view?.interpolate(dt * 1000, nowMs);

    // Le HUD se rafraîchit dix fois par seconde, pas soixante.
    this.uiAcc += dt;
    if (this.uiAcc >= 0.1) {
      this.uiAcc = 0;
      if (this.world) this.state.timeLeft = Math.max(0, this.world.timeLeft);
      else if (this.phaseEndsAt) this.state.timeLeft = Math.max(0, (this.phaseEndsAt - nowMs) / 1000);
      this.emit();
    }
  }

  /* ================================================================== */
  /* Hôte : autorité                                                    */
  /* ================================================================== */

  private hostUpdate(dt: number, nowMs: number): void {
    switch (this.state.phase) {
      case 'lobby': {
        if (this.state.peer.connected && this.state.ready && this.peerReadyFlag) this.beginRound(1);
        break;
      }
      case 'prep': {
        const done = nowMs >= this.phaseEndsAt || (this.state.ready && this.peerReadyFlag);
        if (done) this.startInvasion();
        break;
      }
      case 'countdown': {
        if (nowMs >= this.phaseEndsAt) {
          this.state.phase = 'invasion';
          this.broadcastPhase();
          this.emit();
        }
        break;
      }
      case 'invasion': {
        const w = this.world;
        if (!w) break;
        this.acc += dt;
        let steps = 0;
        while (this.acc >= TICK_DT && steps < MAX_CATCHUP_TICKS) {
          this.acc -= TICK_DT;
          steps++;
          this.tick++;
          const hostRole = roleOf('host', this.state.round, this.match);
          const invIn = hostRole === 'invader' ? this.localInput : this.remoteInput;
          const casIn = hostRole === 'castellan' ? this.localInput : this.remoteInput;
          w.step(invIn, casIn);
          // Une impulsion ne vaut que pour le tick qui l'a consommée.
          this.clearPulses(this.localInput);
          this.clearPulses(this.remoteInput);
          // L'hôte reconstruit sa propre vue à chaque tick : son déplacement
          // doit répondre immédiatement, pas avec le retard du réseau.
          this.applyOwnSnapshot(w, nowMs);
          if (w.over) break;
        }
        if (steps >= MAX_CATCHUP_TICKS) this.acc = 0;

        this.dispatchEvents(w);
        this.snapAcc += dt;
        if (this.snapAcc >= 1 / CFG.net.snapshotHz) {
          this.snapAcc = 0;
          this.dispatchSnapshots(w, nowMs);
        }
        if (w.over) this.endRound(w);
        break;
      }
      case 'round_end': {
        if (nowMs >= this.phaseEndsAt) {
          const next = nextRound(this.match);
          if (next === null) this.endMatch();
          else this.beginRound(next);
        }
        break;
      }
      default:
        break;
    }
  }

  private dispatchEvents(w: World): void {
    const events = w.drainEvents();
    if (!events.length) return;
    const hostRole = roleOf('host', this.state.round, this.match);
    const peerRole: Role = hostRole === 'invader' ? 'castellan' : 'invader';
    this.fire(filterEvents(events, hostRole, w));
    const forPeer = filterEvents(events, peerRole, w);
    if (forPeer.length) this.transport.send({ type: 'events', tick: this.tick, events: forPeer });
  }

  private snapOpts() {
    return {
      phase: this.state.phase,
      tick: this.tick,
      score: { host: this.match.host.score, guest: this.match.guest.score },
      round: this.state.round,
    };
  }

  private applyOwnSnapshot(w: World, nowMs: number): void {
    if (!this.filterSelf || !this.view) return;
    this.view.applySnapshot(this.filterSelf.build(w, { ...this.snapOpts(), ackSeq: this.seq }), nowMs);
  }

  private dispatchSnapshots(w: World, nowMs: number): void {
    if (!this.filterPeer) return;
    void nowMs;
    const theirs = this.filterPeer.build(w, { ...this.snapOpts(), ackSeq: this.lastAckSeq });
    this.transport.send({ type: 'snapshot', snap: theirs });
  }

  /** Efface les actions ponctuelles : elles ne durent qu'un tick. */
  private clearPulses(f: InputFrame): void {
    f.tool = -1;
    f.device = -1;
    f.rearm = -1;
    f.dodge = false;
    f.secondary = false;
  }

  /* ================================================================== */
  /* Invité                                                             */
  /* ================================================================== */

  private guestUpdate(dt: number, nowMs: number): void {
    if (this.state.phase !== 'invasion') return;
    this.inputAcc += dt;
    const period = 1 / CFG.net.inputHz;
    while (this.inputAcc >= period) {
      this.inputAcc -= period;
      this.sendInput(nowMs);
    }
  }

  private sendInput(nowMs: number): void {
    const frame: InputFrame = { ...this.localInput, seq: ++this.seq, t: nowMs / 1000 };
    this.transport.send({ type: 'input', frame });
    this.view?.pushInput(frame);
    // Les actions ponctuelles ne valent que pour un tick.
    this.localInput.tool = -1;
    this.localInput.device = -1;
    this.localInput.rearm = -1;
    this.localInput.dodge = false;
    this.localInput.secondary = false;
  }

  /* ================================================================== */
  /* Réception réseau                                                   */
  /* ================================================================== */

  private onMessage(m: NetMessage): void {
    switch (m.type) {
      case 'input':
        if (!this.isHost) return;
        if (m.frame.seq <= this.lastAckSeq) return;
        this.lastAckSeq = m.frame.seq;
        this.remoteInput = m.frame;
        break;

      case 'snapshot':
        if (this.isHost) return;
        this.view?.applySnapshot(m.snap, performance.now());
        this.state.score = m.snap.score;
        this.state.timeLeft = m.snap.timeLeft;
        break;

      case 'events':
        if (this.isHost) return;
        this.fire(m.events);
        break;

      case 'build':
        this.peerBuild = m.build;
        if (this.isHost) {
          const side: Side = 'guest';
          slot(this.match, side).plan = m.build.planId;
          slot(this.match, side).build = m.build;
        }
        break;

      case 'loadout':
        this.peerLoadout = m.loadout;
        break;

      case 'prep':
        this.peerReadyFlag = m.ready;
        this.state.peerReady = m.ready;
        this.emit();
        break;

      case 'phase':
        if (this.isHost) return;
        this.applyPhase(m);
        break;

      default:
        break;
    }
  }

  private applyPhase(m: Extract<NetMessage, { type: 'phase' }>): void {
    this.state.round = m.round;
    this.state.score = m.score;
    this.state.phase = m.phase;
    this.state.timeLeft = m.timeLeft;
    this.phaseEndsAt = performance.now() + m.timeLeft * 1000;

    if (m.phase === 'prep') {
      this.state.role = m.role;
      this.state.ready = false;
      this.state.peerReady = false;
      this.peerReadyFlag = false;
      this.state.intel = null;
      this.state.result = null;
      this.state.burned = m.burned ?? [];
      this.state.heat = m.heat ?? [];
      if (m.planId) {
        this.state.planId = m.planId;
        this.state.planLocked = true;
      }
      this.state.budgetTotal =
        m.role === 'castellan'
          ? (m.budget ?? CFG.budget.castellan)
          : CFG.budget.invader;
      if (m.role === 'invader') {
        this.state.loadout = emptyLoadout();
        this.state.budgetSpent = 0;
      } else if (m.keepBuild && this.state.build) {
        this.state.budgetSpent = buildCost(this.state.build);
      } else {
        this.state.build = emptyBuild(this.state.planId ?? 'compact');
        this.state.budgetSpent = 0;
      }
    }

    if (m.phase === 'countdown' && m.planId) {
      this.state.planId = m.planId;
      this.state.role = m.role;
      this.state.intel = m.intel ?? null;
      this.openView(m.planId, m.role);
    }

    if (m.phase === 'round_end') {
      this.state.result = m.result ?? null;
    }
    if (m.phase === 'match_end') {
      this.state.matchWinner = m.matchWinner ?? null;
      this.state.result = m.result ?? null;
    }
    this.emit();
  }

  /* ================================================================== */
  /* Transitions de phase (hôte)                                        */
  /* ================================================================== */

  private beginRound(round: number): void {
    this.match.round = round;
    this.state.round = round;
    this.state.phase = 'prep';
    this.state.result = null;
    this.state.intel = null;
    this.state.ready = false;
    this.state.peerReady = false;
    this.peerReadyFlag = false;
    this.peerBuild = null;
    this.peerLoadout = null;
    this.world = null;
    this.view = null;

    const myRole = roleOf(this.side, round, this.match);
    this.state.role = myRole;

    const defender = defenderOf(round, this.match);
    const defSlot = slot(this.match, defender);
    const keepBuild = isRedress(round) || round >= TIEBREAK_ROUND;

    // Réaménagement : 40 % du budget rendu, pièges grillés déplaçables (§3).
    let myBudget = CFG.budget.castellan;
    let burned: number[] = [];
    let heat: { x: number; y: number; t: number }[] = [];
    if (keepBuild && defSlot.build) {
      const r = prepareRedress(defSlot.build, defSlot.burnedTraps);
      myBudget = r.budget;
      burned = r.burned;
      heat = defSlot.lastHeat;
    }

    const duration = prepDuration(round);
    this.phaseEndsAt = performance.now() + duration * 1000;
    this.state.timeLeft = duration;

    this.roundBudget[this.side] = myRole === 'castellan' ? myBudget : CFG.budget.invader;
    if (myRole === 'castellan') {
      this.state.budgetTotal = myBudget;
      this.state.burned = burned;
      this.state.heat = heat;
      if (keepBuild && this.match.host.build) {
        this.state.build = this.match.host.build;
        this.state.budgetSpent = buildCost(this.state.build);
      } else {
        this.state.build = emptyBuild(this.state.planId ?? 'compact');
        this.state.budgetSpent = 0;
      }
      this.state.planLocked = this.match.host.plan !== null;
    } else {
      this.state.budgetTotal = CFG.budget.invader;
      this.state.loadout = emptyLoadout();
      this.state.budgetSpent = 0;
      this.state.burned = [];
      this.state.heat = [];
    }

    const guestRole = roleOf('guest', round, this.match);
    const guestSlot = this.match.guest;
    let guestBudget = CFG.budget.castellan;
    let guestBurned: number[] = [];
    let guestHeat: { x: number; y: number; t: number }[] = [];
    if (guestRole === 'castellan' && keepBuild && guestSlot.build) {
      const r = prepareRedress(guestSlot.build, guestSlot.burnedTraps);
      guestBudget = r.budget;
      guestBurned = r.burned;
      guestHeat = guestSlot.lastHeat;
    }

    this.roundBudget.guest = guestRole === 'castellan' ? guestBudget : CFG.budget.invader;

    this.transport.send({
      type: 'phase',
      phase: 'prep',
      round,
      role: guestRole,
      timeLeft: duration,
      score: { host: this.match.host.score, guest: this.match.guest.score },
      planId: guestRole === 'castellan' ? (guestSlot.plan ?? undefined) : undefined,
      budget: guestBudget,
      burned: guestBurned,
      heat: guestHeat,
      keepBuild: keepBuild && guestRole === 'castellan',
    });
    this.emit();
  }

  private startInvasion(): void {
    const round = this.state.round;
    const defender = defenderOf(round, this.match);
    const invader = invaderOf(round, this.match);

    // Autorité : tout ce qui vient du réseau est revalidé ici. Un budget ne
    // peut donc jamais être dépassé, quelle que soit l'interface d'en face.
    const rawBuild =
      defender === this.side ? this.state.build : (this.peerBuild ?? slot(this.match, defender).build);
    const rawLoadout = invader === this.side ? this.state.loadout : this.peerLoadout;

    const planId = slot(this.match, defender).plan ?? rawBuild?.planId ?? 'compact';
    const plan = getPlan(planId);
    const { build } = sanitizeBuild(plan, rawBuild ?? emptyBuild(planId), this.roundBudget[defender]);
    const { loadout } = sanitizeLoadout(rawLoadout ?? emptyLoadout());

    slot(this.match, defender).plan = planId;
    slot(this.match, defender).build = build;
    slot(this.match, invader).loadout = loadout;

    const intel = resolveIntel(plan, build, loadout);
    this.world = new World({ plan, build, loadout, duration: roundDuration(round) });

    const myRole = roleOf(this.side, round, this.match);
    const peerRole: Role = myRole === 'invader' ? 'castellan' : 'invader';
    this.filterSelf = new SnapshotFilter(myRole, this.world, myRole === 'invader' ? intel : {});
    this.filterPeer = new SnapshotFilter(peerRole, this.world, peerRole === 'invader' ? intel : {});

    this.state.intel = myRole === 'invader' ? intel : null;
    this.state.role = myRole;
    this.state.planId = planId;
    this.openView(planId, myRole);

    this.tick = 0;
    this.acc = 0;
    this.snapAcc = 0;
    this.lastAckSeq = 0;
    this.seq = 0;
    this.localInput = emptyInput();
    this.remoteInput = emptyInput();

    this.state.phase = 'countdown';
    this.phaseEndsAt = performance.now() + CFG.match.countdown * 1000;
    this.state.timeLeft = CFG.match.countdown;

    this.transport.send({
      type: 'phase',
      phase: 'countdown',
      round,
      role: peerRole,
      timeLeft: CFG.match.countdown,
      score: { host: this.match.host.score, guest: this.match.guest.score },
      planId,
      intel: peerRole === 'invader' ? intel : undefined,
    });
    this.emit();
  }

  private endRound(w: World): void {
    if (!w.over) return;
    const round = this.state.round;
    const defender = defenderOf(round, this.match);

    // Ce que l'Envahisseur a repéré est grillé pour les manches suivantes.
    const discovered = w.traps.filter((t) => t.discovered).map((t) => t.id);
    recordBurned(this.match, defender, discovered);

    const result = applyResult(this.match, round, w.over.winner, w.over.outcome, w.stats, w.timeLeft);
    this.state.result = result;
    this.state.score = { host: this.match.host.score, guest: this.match.guest.score };

    const over = this.match.finished || nextRound(this.match) === null;
    this.state.phase = over ? 'match_end' : 'round_end';
    this.state.matchWinner = over ? this.match.winner : null;
    this.phaseEndsAt = performance.now() + CFG.match.roundEndScreen * 1000;
    this.state.timeLeft = CFG.match.roundEndScreen;

    this.transport.send({
      type: 'phase',
      phase: this.state.phase,
      round,
      role: roleOf('guest', round, this.match),
      timeLeft: CFG.match.roundEndScreen,
      score: this.state.score,
      result,
      matchWinner: this.state.matchWinner ?? undefined,
    });

    this.world = null;
    this.emit();
  }

  private endMatch(): void {
    this.state.phase = 'match_end';
    this.state.matchWinner = this.match.winner;
    this.transport.send({
      type: 'phase',
      phase: 'match_end',
      round: this.state.round,
      role: roleOf('guest', this.state.round, this.match),
      timeLeft: 0,
      score: this.state.score,
      matchWinner: this.match.winner ?? undefined,
    });
    this.emit();
  }

  private broadcastPhase(): void {
    this.transport.send({
      type: 'phase',
      phase: this.state.phase,
      round: this.state.round,
      role: roleOf('guest', this.state.round, this.match),
      timeLeft: this.state.timeLeft,
      score: this.state.score,
    });
  }

  private openView(planId: PlanId, role: Role): void {
    const plan = getPlan(planId);
    const spawn = role === 'invader' ? plan.invaderSpawn : plan.castellanSpawn;
    this.view = new ClientView(plan, role, spawn);
  }

  /* ================================================================== */
  /* API pour l'interface                                               */
  /* ================================================================== */

  /** État maintenu : déplacement, visée, allure, touches tenues. */
  setInput(patch: Partial<InputFrame>): void {
    Object.assign(this.localInput, patch);
  }

  /**
   * Action ponctuelle. Elle reste armée jusqu'à ce qu'un tick la consomme, ce
   * qui garantit qu'un clic n'est jamais perdu entre deux frames.
   */
  pulse(patch: Partial<InputFrame>): void {
    Object.assign(this.localInput, patch);
  }

  /**
   * Le château est tiré au sort à la connexion : le lobby ne demande plus de
   * choisir. La méthode reste publique pour le jour où on voudra le rendre.
   */
  setPlan(id: PlanId): void {
    if (this.state.planLocked) return;
    this.state.planId = id;
    this.state.build = { ...this.state.build, planId: id, traps: [], devices: [], lockedDoors: [], secretDoors: [] };
    this.state.budgetSpent = 0;
    if (this.isHost) this.match.host.plan = id;
    this.transport.send({ type: 'build', build: this.state.build });
    this.emit();
  }

  /** Pose un guet (trois au maximum, gratuits). */
  placeSensor(x: number, y: number): string | null {
    const plan = getPlan(this.state.planId ?? 'compact');
    const b = this.state.build;
    b.sensors ??= [];
    if (b.sensors.length >= CFG.sensors.count) return 'Trois guets au maximum.';
    const why = canPlaceSensor(plan, x, y, b.sensors);
    if (why) return why;
    b.sensors.push({ id: b.sensors.length, x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 });
    this.emit();
    return null;
  }

  placeTrap(kind: TrapKind, x: number, y: number, tell?: TellKind): string | null {
    const plan = getPlan(this.state.planId ?? 'compact');
    const b = this.state.build;
    const why = canPlaceTrap(plan, kind, x, y, b.traps, b.devices);
    if (why) return why;
    const cost = this.trapCost(kind, x, y);
    if (this.state.budgetSpent + cost > this.state.budgetTotal) return 'Budget insuffisant.';
    b.traps.push({
      id: this.nextPlacementId(),
      kind,
      x: Math.floor(x) + 0.5,
      y: Math.floor(y) + 0.5,
      tell: kind === 'decoy' ? (tell ?? 'seam') : CFG.traps[kind].tell,
      facing: 0,
    });
    this.state.budgetSpent += cost;
    this.emit();
    return null;
  }

  placeDevice(kind: DeviceKind, x: number, y: number): string | null {
    const plan = getPlan(this.state.planId ?? 'compact');
    const b = this.state.build;
    const why = canPlaceDevice(plan, kind, x, y, b.traps, b.devices);
    if (why) return why;
    const cost = CFG.devices[kind].cost;
    if (this.state.budgetSpent + cost > this.state.budgetTotal) return 'Budget insuffisant.';
    b.devices.push({ id: this.nextPlacementId(), kind, x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5, facing: 0 });
    this.state.budgetSpent += cost;
    this.emit();
    return null;
  }

  /** Un piège grillé se déplace gratuitement au réaménagement (§3). */
  private trapCost(kind: TrapKind, x: number, y: number): number {
    void x;
    void y;
    return CFG.traps[kind].cost;
  }

  removeAt(x: number, y: number): void {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const b = this.state.build;
    const si = (b.sensors ?? []).findIndex((g) => Math.floor(g.x) === tx && Math.floor(g.y) === ty);
    if (si >= 0) {
      b.sensors!.splice(si, 1);
      this.emit();
      return;
    }
    const ti = b.traps.findIndex((t) => Math.floor(t.x) === tx && Math.floor(t.y) === ty);
    if (ti >= 0) {
      const [removed] = b.traps.splice(ti, 1);
      // Reposer un piège grillé ne coûte rien : c'est tout l'intérêt du
      // réaménagement — on le déplace, on ne le rachète pas.
      const free = this.state.burned.includes(removed.id);
      if (!free) this.state.budgetSpent -= CFG.traps[removed.kind].cost;
      this.emit();
      return;
    }
    const di = b.devices.findIndex((d) => Math.floor(d.x) === tx && Math.floor(d.y) === ty);
    if (di >= 0) {
      const [removed] = b.devices.splice(di, 1);
      this.state.budgetSpent -= CFG.devices[removed.kind].cost;
      this.emit();
    }
  }

  setHeart(i: number): void {
    this.state.build.heartIndex = i;
    this.emit();
  }

  toggleDoor(i: number): void {
    const list = this.state.build.lockedDoors;
    const at = list.indexOf(i);
    if (at >= 0) {
      list.splice(at, 1);
      this.state.budgetSpent -= CFG.fixtures.lockDoor.cost;
    } else {
      if (this.state.budgetSpent + CFG.fixtures.lockDoor.cost > this.state.budgetTotal) return;
      list.push(i);
      this.state.budgetSpent += CFG.fixtures.lockDoor.cost;
    }
    this.emit();
  }

  toggleSecret(i: number): void {
    const list = this.state.build.secretDoors;
    const at = list.indexOf(i);
    if (at >= 0) {
      list.splice(at, 1);
      this.state.budgetSpent -= CFG.fixtures.secretDoor.cost;
    } else {
      if (this.state.budgetSpent + CFG.fixtures.secretDoor.cost > this.state.budgetTotal) return;
      list.push(i);
      this.state.budgetSpent += CFG.fixtures.secretDoor.cost;
    }
    this.emit();
  }

  toggleTool(k: ToolKind): void {
    const l = this.state.loadout;
    const at = l.tools.indexOf(k);
    if (at >= 0) l.tools.splice(at, 1);
    else {
      if (l.tools.length >= CFG.budget.maxTools) return;
      if (loadoutCost({ ...l, tools: [...l.tools, k] }) > CFG.budget.invader) return;
      l.tools.push(k);
    }
    this.state.budgetSpent = loadoutCost(l);
    this.emit();
  }

  toggleIntel(k: IntelKind): void {
    const l = this.state.loadout;
    const at = l.intel.indexOf(k);
    if (at >= 0) l.intel.splice(at, 1);
    else {
      if (loadoutCost({ ...l, intel: [...l.intel, k] }) > CFG.budget.invader) return;
      l.intel.push(k);
    }
    this.state.budgetSpent = loadoutCost(l);
    this.emit();
  }

  setReady(ready: boolean): void {
    this.state.ready = ready;
    if (ready) {
      if (this.state.role === 'castellan' || this.state.phase === 'lobby') {
        this.state.build.spent = buildCost(this.state.build);
        this.transport.send({ type: 'build', build: this.state.build });
        if (this.isHost) {
          this.match.host.plan = this.state.planId;
          this.match.host.build = this.state.build;
        }
      }
      if (this.state.role === 'invader') {
        this.state.loadout.spent = loadoutCost(this.state.loadout);
        this.transport.send({ type: 'loadout', loadout: this.state.loadout });
      }
    }
    this.transport.send({
      type: 'prep',
      ready,
      spent: this.state.budgetSpent,
      placed: this.state.build.traps.length + this.state.build.devices.length,
    });
    this.emit();
  }

  private nextPlacementId(): number {
    const b = this.state.build;
    let max = -1;
    for (const t of b.traps) max = Math.max(max, t.id);
    for (const d of b.devices) max = Math.max(max, d.id);
    return max + 1;
  }

  /** Instantané courant côté client, ou `null` hors invasion. */
  snapshot(): Snapshot | null {
    return this.view?.snap ?? null;
  }
}
