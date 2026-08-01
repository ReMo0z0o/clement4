/**
 * Couche de transport.
 *
 * Contrainte à ne pas contourner (§12) : Vercel n'héberge pas de serveur
 * WebSocket persistant. Aucune route Next.js n'ouvre de socket ; tout passe
 * par un service temps réel externe, ou par un canal local entre onglets.
 *
 * Deux implémentations derrière la même interface :
 *  - `local`    : BroadcastChannel, deux onglets du même navigateur. Aucune
 *                 configuration, le jeu est jouable dès `npm run dev`.
 *  - `supabase` : Supabase Realtime, deux machines, deux réseaux.
 *
 * Le choix est automatique : Supabase si les variables d'environnement sont
 * présentes, canal local sinon. Un joueur ne devrait jamais avoir à savoir
 * lequel des deux tourne.
 */

import type { NetMessage } from '@/game/types';

export type TransportKind = 'local' | 'supabase';

export interface PeerStatus {
  connected: boolean;
  /** Aller-retour mesuré, en millisecondes. `null` tant qu'inconnu. */
  latency: number | null;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly code: string;
  readonly isHost: boolean;
  send(msg: NetMessage): void;
  onMessage(cb: (msg: NetMessage) => void): () => void;
  onPeer(cb: (status: PeerStatus) => void): () => void;
  close(): void;
}

/* ==================================================================== */
/* Code de session                                                      */
/* ==================================================================== */

/** Ni I, ni O, ni 0, ni 1 : ces caractères sont ambigus à dicter (§13). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Insensible à la casse, espaces et séparateurs ignorés (§13). */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-_.]/g, '').slice(0, 6);
}

/**
 * Message d'erreur qui dit quoi faire, et ne s'excuse pas (§15).
 *
 * I, O, 0 et 1 sont volontairement absents de l'alphabet : ils sont ambigus à
 * dicter. On ne devine donc pas ce que le joueur voulait taper — on lui dit
 * précisément ce qui cloche, ce qui l'oriente vers la bonne lecture du code.
 */
export function codeProblem(raw: string): string | null {
  const c = normalizeCode(raw);
  if (c.length === 0) return 'Entrez le code à six caractères de votre adversaire.';
  const ambiguous: Record<string, string> = {
    I: 'un I — les codes n’en contiennent jamais, essayez un J ou un L',
    O: 'un O — les codes n’en contiennent jamais, essayez un Q ou un D',
    '0': 'un zéro — les codes n’en contiennent jamais, essayez un Q ou un D',
    '1': 'un 1 — les codes n’en contiennent jamais, essayez un 7 ou un J',
  };
  for (const ch of c) {
    if (ambiguous[ch]) return `Ce code contient ${ambiguous[ch]}.`;
    if (!CODE_ALPHABET.includes(ch)) return `Le caractère « ${ch} » n'apparaît pas dans un code de partie.`;
  }
  if (c.length < 6) return `Il manque ${6 - c.length} caractère${6 - c.length > 1 ? 's' : ''}.`;
  return null;
}

export function playerId(): string {
  const KEY = 'castle-siege:player-id';
  if (typeof localStorage === 'undefined') return cryptoId();
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  const fresh = cryptoId();
  localStorage.setItem(KEY, fresh);
  return fresh;
}

function cryptoId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `p-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/* ==================================================================== */
/* Socle commun : battement de cœur, latence, présence                  */
/* ==================================================================== */

export abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;
  protected messageCbs = new Set<(m: NetMessage) => void>();
  protected peerCbs = new Set<(s: PeerStatus) => void>();
  protected lastHeard = 0;
  protected status: PeerStatus = { connected: false, latency: null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    readonly code: string,
    readonly isHost: boolean,
  ) {}

  protected startHeartbeat(): void {
    this.timer = setInterval(() => {
      if (this.closed) return;
      this.transmit({ type: 'ping', t: Date.now() });
      // Quatre secondes de silence : on considère le pair parti.
      const alive = Date.now() - this.lastHeard < 4000;
      if (alive !== this.status.connected) {
        this.status = { ...this.status, connected: alive };
        this.emitPeer();
      }
    }, 1000);
  }

  protected receive(msg: NetMessage): void {
    this.lastHeard = Date.now();
    if (!this.status.connected) {
      this.status = { ...this.status, connected: true };
      this.emitPeer();
    }
    if (msg.type === 'ping') {
      this.transmit({ type: 'pong', t: msg.t });
      return;
    }
    if (msg.type === 'pong') {
      this.status = { ...this.status, latency: Date.now() - msg.t };
      this.emitPeer();
      return;
    }
    for (const cb of this.messageCbs) cb(msg);
  }

  private emitPeer(): void {
    for (const cb of this.peerCbs) cb(this.status);
  }

  send(msg: NetMessage): void {
    if (this.closed) return;
    this.transmit(msg);
  }

  protected abstract transmit(msg: NetMessage): void;

  onMessage(cb: (m: NetMessage) => void): () => void {
    this.messageCbs.add(cb);
    return () => this.messageCbs.delete(cb);
  }

  onPeer(cb: (s: PeerStatus) => void): () => void {
    this.peerCbs.add(cb);
    cb(this.status);
    return () => this.peerCbs.delete(cb);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.messageCbs.clear();
    this.peerCbs.clear();
    this.dispose();
  }

  protected abstract dispose(): void;
}

/* ==================================================================== */
/* Transport local : deux onglets, aucune configuration                 */
/* ==================================================================== */

export class LocalTransport extends BaseTransport {
  readonly kind = 'local' as const;
  private channel: BroadcastChannel;

  constructor(code: string, isHost: boolean) {
    super(code, isHost);
    this.channel = new BroadcastChannel(`castle-siege:${code}`);
    this.channel.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { from: 'host' | 'guest'; msg: NetMessage };
      if (!data || typeof data !== 'object') return;
      // On ignore ce qu'on a envoyé soi-même : un onglet n'est pas son pair.
      if (data.from === (isHost ? 'host' : 'guest')) return;
      this.receive(data.msg);
    };
    this.startHeartbeat();
  }

  protected transmit(msg: NetMessage): void {
    this.channel.postMessage({ from: this.isHost ? 'host' : 'guest', msg });
  }

  protected dispose(): void {
    this.channel.close();
  }
}

/* ==================================================================== */
/* Fabrique                                                             */
/* ==================================================================== */

export function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

export async function openTransport(code: string, isHost: boolean): Promise<Transport> {
  if (supabaseConfigured()) {
    const { SupabaseTransport } = await import('./supabase');
    return SupabaseTransport.open(code, isHost);
  }
  return new LocalTransport(code, isHost);
}

/**
 * Ce qu'on affiche au joueur pour qu'il sache avec qui il peut jouer.
 *
 * En mode local, on dit « fenêtre » et pas « onglet », et ce n'est pas un
 * détail : un onglet caché voit son `requestAnimationFrame` bridé par le
 * navigateur, et la partie s'arrête de tourner pour celui qui l'héberge. Deux
 * fenêtres côte à côte restent toutes les deux visibles.
 */
export function transportBlurb(kind: TransportKind): string {
  return kind === 'supabase'
    ? 'Partie en ligne : votre adversaire peut être n’importe où.'
    : 'Partie locale : ouvrez une seconde fenêtre côte à côte, sur ce navigateur.';
}
