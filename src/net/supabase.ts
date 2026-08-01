/**
 * Transport Supabase Realtime.
 *
 * Broadcast pour les messages, Presence pour savoir si le pair est là. Aucune
 * route serveur n'est impliquée : la contrainte Vercel (§12) est respectée par
 * construction, le client parle directement au service temps réel.
 *
 * La table `sessions` (§13) sert uniquement à la persistance du score et à la
 * reprise après déconnexion. Le jeu fonctionne sans elle : si elle n'existe
 * pas, on dégrade silencieusement au lieu de bloquer une partie.
 */

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { NetMessage } from '@/game/types';
import { BaseTransport } from './transport';

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase non configuré');
  client = createClient(url, key, {
    realtime: { params: { eventsPerSecond: 40 } },
    auth: { persistSession: false },
  });
  return client;
}

export class SupabaseTransport extends BaseTransport {
  readonly kind = 'supabase' as const;
  private channel: RealtimeChannel;

  private constructor(code: string, isHost: boolean, channel: RealtimeChannel) {
    super(code, isHost);
    this.channel = channel;
    this.startHeartbeat();
  }

  static async open(code: string, isHost: boolean): Promise<SupabaseTransport> {
    const sb = supabase();
    const channel = sb.channel(`siege:${code}`, {
      config: { broadcast: { self: false, ack: false }, presence: { key: isHost ? 'host' : 'guest' } },
    });

    const t = await new Promise<SupabaseTransport>((resolve, reject) => {
      let transport: SupabaseTransport | null = null;
      channel.on('broadcast', { event: 'm' }, (payload) => {
        transport?.receive(payload.payload as NetMessage);
      });
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          transport = new SupabaseTransport(code, isHost, channel);
          void channel.track({ role: isHost ? 'host' : 'guest', at: Date.now() });
          resolve(transport);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error('La connexion au serveur de partie a échoué.'));
        }
      });
    });

    return t;
  }

  protected transmit(msg: NetMessage): void {
    void this.channel.send({ type: 'broadcast', event: 'm', payload: msg });
  }

  protected dispose(): void {
    void this.channel.unsubscribe();
  }
}

/* ==================================================================== */
/* Persistance facultative                                              */
/* ==================================================================== */

export interface SessionRow {
  code: string;
  host_id: string;
  guest_id: string | null;
  status: 'lobby' | 'playing' | 'finished';
  round: number;
  score_host: number;
  score_guest: number;
}

/** Écrit l'état du match. Un échec n'interrompt jamais la partie. */
export async function persistSession(row: Partial<SessionRow> & { code: string }): Promise<void> {
  try {
    await supabase().from('sessions').upsert(row, { onConflict: 'code' });
  } catch {
    // La table est facultative : on ne casse pas une partie pour ça.
  }
}

export async function loadSession(code: string): Promise<SessionRow | null> {
  try {
    const { data } = await supabase().from('sessions').select('*').eq('code', code).maybeSingle();
    return (data as SessionRow) ?? null;
  } catch {
    return null;
  }
}
