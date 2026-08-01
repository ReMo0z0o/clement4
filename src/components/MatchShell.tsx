'use client';

/**
 * Assemblage du match : cycle de session, aiguillage des phases, son.
 *
 * C'est le seul composant qui connaît le `Engine` en entier. Tous les autres
 * reçoivent leur état en propriétés et n'appellent que des méthodes publiques.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { planList } from '@/game/plans';
import type { PlanId } from '@/game/types';
import { Engine, type EngineState } from '@/net/engine';
import {
  codeProblem,
  makeCode,
  normalizeCode,
  openTransport,
  type TransportKind,
} from '@/net/transport';
import type { AudioEngine } from '@/audio/engine';
import { Lobby } from './Lobby';
import { PrepScreen } from './PrepScreen';
import { GameView } from './GameView';
import { Hud } from './Hud';
import { RoundEnd } from './RoundEnd';
import { MatchEnd } from './MatchEnd';
import { DebugPanel } from './DebugPanel';

type Status = 'idle' | 'connecting' | 'waiting' | 'error';

export function MatchShell() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [state, setState] = useState<EngineState | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [transportKind, setTransportKind] = useState<TransportKind>('local');
  const [plan, setPlan] = useState<PlanId | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const audioRef = useRef<AudioEngine | null>(null);

  /* ---- Le son ne peut démarrer que sur un geste du joueur ---- */
  const wakeAudio = useCallback(async () => {
    if (audioRef.current) {
      await audioRef.current.resume();
      return audioRef.current;
    }
    try {
      const mod = await import('@/audio/engine');
      const a = new mod.AudioEngine();
      await a.resume();
      audioRef.current = a;
      return a;
    } catch {
      // Sans audio, le jeu reste jouable : on ne bloque pas une partie pour ça.
      return null;
    }
  }, []);

  const connect = useCallback(
    async (sessionCode: string, asHost: boolean) => {
      setStatus('connecting');
      setError(null);
      void wakeAudio();
      try {
        const transport = await openTransport(sessionCode, asHost);
        setTransportKind(transport.kind);
        const e = new Engine(transport);
        e.subscribe(setState);
        e.start();
        setEngine(e);
        setCode(sessionCode);
        setStatus('waiting');
      } catch (err) {
        setStatus('error');
        setError(
          err instanceof Error && err.message
            ? err.message
            : 'La connexion n’a pas abouti. Vérifiez votre réseau et réessayez.',
        );
      }
    },
    [wakeAudio],
  );

  const onCreate = useCallback(() => void connect(makeCode(), true), [connect]);

  const onJoin = useCallback(
    (raw: string) => {
      const problem = codeProblem(raw);
      if (problem) {
        setError(problem);
        setStatus('error');
        return;
      }
      void connect(normalizeCode(raw), false);
    },
    [connect],
  );

  /* ---- Panneau de réglage (§17) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' || e.code === 'IntlBackslash' || e.key === '²') {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        setDebugOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // On n'enregistre un nettoyage que lorsqu'il y a réellement un moteur à
  // arrêter. Un nettoyage inconditionnel se déclencherait au passage de
  // `null` au moteur fraîchement créé, et fermerait la connexion à l'instant
  // même où elle vient de s'ouvrir.
  useEffect(() => {
    if (!engine) return;
    return () => engine.stop();
  }, [engine]);

  useEffect(() => {
    const audio = audioRef;
    return () => audio.current?.dispose();
  }, []);

  /* ---- Le rôle bascule toute la palette de la page ---- */
  useEffect(() => {
    const role = state?.phase === 'lobby' || !state ? 'castellan' : state.role;
    document.documentElement.dataset.role = role;
  }, [state]);

  const phase = state?.phase ?? 'lobby';

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      {(!engine || phase === 'lobby') && (
        <Lobby
          onCreate={onCreate}
          onJoin={onJoin}
          status={status}
          code={code}
          error={error}
          transportKind={transportKind}
          plans={planList()}
          selectedPlan={plan}
          onSelectPlan={(id) => {
            setPlan(id);
            engine?.setPlan(id);
            void audioRef.current?.ui('click');
          }}
          ready={state?.ready ?? false}
          peerReady={state?.peerReady ?? false}
          peerConnected={state?.peer.connected ?? false}
          onReady={(r) => {
            engine?.setReady(r);
            void audioRef.current?.ui(r ? 'ready' : 'click');
          }}
        />
      )}

      {engine && state && phase === 'prep' && (
        <PrepScreen
          engine={engine}
          state={state}
          onSound={(k) => audioRef.current?.ui(k)}
        />
      )}

      {engine && state && (phase === 'countdown' || phase === 'invasion') && (
        <div className="relative h-full w-full">
          <GameView engine={engine} state={state} audio={audioRef.current} />
          <Hud state={state} snap={engine.snapshot()} />
          {phase === 'countdown' && <Countdown seconds={state.timeLeft} role={state.role} />}
        </div>
      )}

      {engine && state && phase === 'round_end' && state.result && (
        <RoundEnd
          result={state.result}
          role={state.role}
          round={state.round}
          score={state.score}
          side={state.side}
          secondsLeft={Math.ceil(state.timeLeft)}
        />
      )}

      {engine && state && phase === 'match_end' && (
        <MatchEnd
          winner={state.matchWinner}
          side={state.side}
          score={state.score}
          results={[]}
          code={state.code}
          onRematch={() => window.location.reload()}
        />
      )}

      {state?.paused && <PausedOverlay seconds={state.pauseSecondsLeft} />}

      {debugOpen && <DebugPanel onClose={() => setDebugOpen(false)} state={state} />}
    </main>
  );
}

/* ==================================================================== */
/* Incrustations                                                        */
/* ==================================================================== */

function Countdown({ seconds, role }: { seconds: number; role: string }) {
  const n = Math.max(1, Math.ceil(seconds));
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/45">
      <div className="font-display text-8xl leading-none tabular-nums">{n}</div>
      <p className="mt-3 text-sm uppercase tracking-[0.3em] opacity-70">
        {role === 'castellan' ? 'Tenez votre château' : 'Trouvez le Cœur'}
      </p>
    </div>
  );
}

function PausedOverlay({ seconds }: { seconds: number }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 text-center">
      <h2 className="font-display text-3xl">Votre adversaire a quitté la partie</h2>
      <p className="max-w-md text-sm opacity-75">
        La partie reprend toute seule s’il revient. Gardez cet onglet ouvert.
      </p>
      <p className="font-code text-4xl tabular-nums">{Math.ceil(seconds)}</p>
    </div>
  );
}
