/**
 * Banc d'essai réseau : les VRAIS moteurs hôte et invité, reliés par un réseau
 * simulé — latence, gigue, paquets groupés — et pilotés par une horloge fictive.
 *
 * On y mesure ce que l'invité ressent : l'amplitude des recalages que l'hôte
 * lui impose. Sans force extérieure (personne ne le frappe), un modèle de
 * prédiction juste ne devrait JAMAIS être recalé : chaque recalage est un
 * tremblement, un recul, une téléportation à l'écran.
 *
 * Ce fichier n'importe ni React ni le DOM : il tourne sous Node.
 */

import { CFG, TICK_DT } from '../src/game/config';
import type { NetMessage, Role } from '../src/game/types';
import { Engine } from '../src/net/engine';
import type { PeerStatus, Transport } from '../src/net/transport';

/* ==================================================================== */
/* Horloge fictive : `performance.now()` est détourné vers elle         */
/* ==================================================================== */

export class Clock {
  ms = 1000;
  install(): () => void {
    const real = globalThis.performance.now.bind(globalThis.performance);
    globalThis.performance.now = () => this.ms;
    return () => {
      globalThis.performance.now = real;
    };
  }
}

/* ==================================================================== */
/* Réseau simulé                                                        */
/* ==================================================================== */

export interface NetProfile {
  /** Latence d'aller simple, en ms. */
  latency: number;
  /** Gigue ajoutée, en ms (uniforme sur [0, jitter]). */
  jitter: number;
  /** Rend vrai pour un message à PERDRE : Supabase n'accuse pas réception. */
  drop?: (msg: NetMessage, to: 'host' | 'guest') => boolean;
}

/** Aléa déterministe : un banc d'essai qui échoue doit échouer toujours. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class FakeNet {
  private inflight: { at: number; to: 'host' | 'guest'; msg: NetMessage; order: number }[] = [];
  private order = 0;
  /** Dernier instant de livraison par sens : l'ordre d'envoi est préservé. */
  private lastAt = { host: 0, guest: 0 };
  readonly host: FakeTransport;
  readonly guest: FakeTransport;
  private r: () => number;

  constructor(
    private clock: Clock,
    private profile: NetProfile,
    seed = 7,
  ) {
    this.r = rng(seed);
    this.host = new FakeTransport(true, (m) => this.post('guest', m));
    this.guest = new FakeTransport(false, (m) => this.post('host', m));
  }

  private post(to: 'host' | 'guest', msg: NetMessage): void {
    if (this.profile.drop?.(msg, to)) return;
    // Une copie : sur un vrai réseau, l'objet envoyé n'est jamais partagé.
    const copy = JSON.parse(JSON.stringify(msg)) as NetMessage;
    const at = Math.max(
      this.clock.ms + this.profile.latency + this.r() * this.profile.jitter,
      // Supabase et BroadcastChannel livrent dans l'ordre : la gigue groupe
      // les paquets, elle ne les inverse pas.
      this.lastAt[to],
    );
    this.lastAt[to] = at;
    this.inflight.push({ at, to, msg: copy, order: this.order++ });
  }

  /** Livre tout ce qui est arrivé à l'instant présent. */
  pump(): void {
    const due = this.inflight.filter((p) => p.at <= this.clock.ms).sort((a, b) => a.at - b.at || a.order - b.order);
    this.inflight = this.inflight.filter((p) => p.at > this.clock.ms);
    for (const p of due) (p.to === 'host' ? this.host : this.guest).deliver(p.msg);
  }
}

class FakeTransport implements Transport {
  readonly kind = 'local' as const;
  readonly code = 'TEST42';
  private msgCbs = new Set<(m: NetMessage) => void>();
  private peerCbs = new Set<(s: PeerStatus) => void>();

  constructor(
    readonly isHost: boolean,
    private out: (m: NetMessage) => void,
  ) {}

  send(msg: NetMessage): void {
    this.out(msg);
  }
  onMessage(cb: (m: NetMessage) => void): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }
  onPeer(cb: (s: PeerStatus) => void): () => void {
    this.peerCbs.add(cb);
    return () => this.peerCbs.delete(cb);
  }
  close(): void {}
  deliver(m: NetMessage): void {
    for (const cb of this.msgCbs) cb(m);
  }
  connect(): void {
    for (const cb of this.peerCbs) cb({ connected: true, latency: 60 });
  }
}

/* ==================================================================== */
/* Une manche jouée de bout en bout                                     */
/* ==================================================================== */

type Driver = (t: number) => {
  move: { x: number; y: number };
  aim: number;
  gait?: 'careful' | 'normal' | 'run';
  primary?: boolean;
  dodge?: boolean;
};

export interface NetResult {
  /** Recalages par seconde de jeu, au-delà d'un seuil visible. */
  correctionsPerSec: number;
  /** Plus grand recalage subi, en tuiles. */
  worst: number;
  /** Somme des recalages, en tuiles par seconde de jeu. */
  driftPerSec: number;
  /** Longueur du trajet réellement parcouru par l'invité, côté hôte. */
  travelled: number;
  guestRole: Role;
  /** Esquives réellement exécutées par l'hôte pour l'invité. */
  dodges: number;
}

/**
 * Joue `seconds` secondes d'invasion. L'invité est piloté par `driver`,
 * l'hôte reste immobile loin de lui : aucune force extérieure, donc aucune
 * excuse à un recalage.
 */
export function playRound(profile: NetProfile, driver: Driver, seconds: number, seed = 7): NetResult {
  const clock = new Clock();
  const restore = clock.install();
  try {
    const net = new FakeNet(clock, profile, seed);
    const host = new Engine(net.host);
    const guest = new Engine(net.guest);
    net.host.connect();
    net.guest.connect();

    const frameMs = 1000 / 60;
    const step = (engines: Engine[]) => {
      clock.ms += frameMs;
      net.pump();
      for (const e of engines) (e as unknown as { update(dt: number, now: number): void }).update(frameMs / 1000, clock.ms);
    };

    // Salon → préparation → invasion, par les mêmes appels que l'interface.
    host.setReady(true);
    guest.setReady(true);
    for (let i = 0; i < 30; i++) step([host, guest]);
    host.setReady(true);
    guest.setReady(true);
    for (let i = 0; i < 400 && host.getState().phase !== 'invasion'; i++) step([host, guest]);
    for (let i = 0; i < 60 && guest.getState().phase !== 'invasion'; i++) step([host, guest]);
    if (host.getState().phase !== 'invasion' || guest.getState().phase !== 'invasion') {
      throw new Error(`la manche n'a pas démarré (hôte ${host.getState().phase}, invité ${guest.getState().phase})`);
    }

    const guestRole = guest.getState().role;
    const world = (host as unknown as { world: import('../src/game/sim').World }).world;
    const hostActor = guestRole === 'invader' ? world.castellan : world.invader;
    const guestActor = guestRole === 'invader' ? world.invader : world.castellan;
    // L'hôte se range dans un coin : ni combat, ni ligne de vue.
    hostActor.pos = { x: 1.5, y: 22.5 };

    const view = guest.view!;
    // Mesure valable pour TOUTE version du code : la réconciliation ne fait pas
    // avancer le temps, elle recalcule la position des mêmes trames depuis
    // l'autorité. Avec un modèle juste, la position n'en bouge pas. Tout
    // déplacement qu'elle provoque est un recalage que le joueur subit.
    let corrections = 0;
    let worst = 0;
    let drift = 0;
    const apply = view.applySnapshot.bind(view);
    view.applySnapshot = (snap, now) => {
      const before = { x: view.pos.x, y: view.pos.y };
      apply(snap, now);
      const jump = Math.hypot(view.pos.x - before.x, view.pos.y - before.y);
      if (jump > 0.02) corrections++;
      worst = Math.max(worst, jump);
      drift += jump;
    };
    let path = 0;
    let last = { ...guestActor.pos };
    const ticks = Math.round((seconds * 1000) / frameMs);

    let dodges = 0;
    let wasDodging = false;
    for (let i = 0; i < ticks; i++) {
      const t = (i * frameMs) / 1000;
      const d = driver(t);
      guest.setInput({ move: d.move, aim: d.aim, gait: d.gait ?? 'normal' });
      if (d.dodge) guest.pulse({ dodge: true });
      step([host, guest]);
      // L'hôte ne bouge pas : on le maintient dans son coin.
      hostActor.pos = { x: 1.5, y: 22.5 };
      path += Math.hypot(guestActor.pos.x - last.x, guestActor.pos.y - last.y);
      last = { ...guestActor.pos };
      const dodging = guestActor.state === 'dodge';
      if (dodging && !wasDodging) dodges++;
      wasDodging = dodging;
    }

    return {
      correctionsPerSec: corrections / seconds,
      worst,
      driftPerSec: drift / seconds,
      travelled: path,
      guestRole,
      dodges,
    };
  } finally {
    restore();
  }
}

/* ==================================================================== */
/* Rapport, si on lance le fichier directement                          */
/* ==================================================================== */

const zigzag: Driver = (t) => {
  // Un joueur qui explore : il tourne sans cesse, s'arrête, repart.
  const phase = Math.floor(t / 0.7) % 6;
  const dirs = [
    { x: 1, y: 0 },
    { x: 0.7, y: 0.7 },
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: -0.7, y: 0.7 },
    { x: -1, y: 0 },
  ];
  return { move: dirs[phase], aim: t, dodge: Math.floor(t * 10) % 37 === 0 };
};

if (process.argv[1]?.endsWith('netbench.ts')) {
  const profiles: [string, NetProfile][] = [
    ['même machine', { latency: 2, jitter: 1 }],
    ['fibre, même ville', { latency: 20, jitter: 8 }],
    ['wifi chargé', { latency: 45, jitter: 40 }],
    ['4G médiocre', { latency: 90, jitter: 70 }],
  ];
  console.log('Recalages subis par l’invité, sans que personne ne le touche (20 s de jeu)\n');
  for (const [label, p] of profiles) {
    const r = playRound(p, zigzag, 20);
    console.log(
      `  ${label.padEnd(20)} ${r.correctionsPerSec.toFixed(2).padStart(6)} recalages/s · pire ${r.worst.toFixed(3)} tuile · ` +
        `dérive ${r.driftPerSec.toFixed(3)} tuile/s · trajet ${r.travelled.toFixed(1)} tuiles (${r.guestRole})`,
    );
  }
}

void TICK_DT;
