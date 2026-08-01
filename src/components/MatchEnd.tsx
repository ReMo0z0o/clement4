'use client';

/**
 * Fin de match.
 *
 * Un seul objectif : qu'ils relancent sans qu'on le leur demande. Le verdict
 * est court, la frise des manches tient en un coup d'œil, et « Rejouer » est
 * le plus gros élément cliquable de l'écran. Le code de session ne change pas :
 * on le rappelle pour que personne n'aille chercher comment se retrouver.
 */

import { useEffect, useMemo, useRef } from 'react';
import { defenderOf, newMatch, TOTAL_ROUNDS, type Side } from '@/game/match';
import type { Role, RoundOutcome, RoundResult } from '@/game/types';

export interface MatchEndProps {
  winner: Side | null;
  side: Side;
  score: { host: number; guest: number };
  results: RoundResult[];
  onRematch: () => void;
  code: string;
}

const OUTCOME_LABEL: Record<RoundOutcome, string> = {
  capture: 'Cœur pris',
  kill_castellan: 'Châtelain tué',
  kill_invader: 'Envahisseur tué',
  timeout: 'Temps écoulé',
};

const other = (s: Side): Side => (s === 'host' ? 'guest' : 'host');

export function MatchEnd(props: MatchEndProps) {
  const { winner, side, score, results, onRematch, code } = props;
  const rematchRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    rematchRef.current?.focus();
  }, []);

  const mine = side === 'host' ? score.host : score.guest;
  const theirs = side === 'host' ? score.guest : score.host;

  /**
   * On retrouve le camp de chaque manche à partir de la règle de match : hôte
   * en 1 et 3, invité en 2 et 4. Pour la manche décisive, le défenseur dépend
   * du meilleur temps de capture — information qu'on n'a pas ici, alors on la
   * déduit du score final moins le décompte des manches précédentes.
   */
  const rows = useMemo(() => {
    const blank = newMatch();
    let host = 0;
    let guest = 0;
    return results.map((r) => {
      let winnerSide: Side;
      let defender: Side;
      if (r.round <= TOTAL_ROUNDS) {
        defender = defenderOf(r.round, blank);
        winnerSide = r.winner === 'castellan' ? defender : other(defender);
      } else {
        winnerSide = score.host > host ? 'host' : 'guest';
        defender = r.winner === 'castellan' ? winnerSide : other(winnerSide);
      }
      if (winnerSide === 'host') host += 1;
      else guest += 1;
      const myRole: Role = defender === side ? 'castellan' : 'invader';
      return { round: r.round, outcome: r.outcome, myRole, mine: winnerSide === side };
    });
  }, [results, score.host, side]);

  const title =
    winner === null
      ? 'Personne ne l’emporte.'
      : winner === side
        ? 'Le siège est à vous.'
        : 'Le siège lui revient.';

  const line =
    winner === null
      ? 'Le match s’arrête à égalité.'
      : winner === side
        ? `Vous gagnez ${mine} à ${theirs}.`
        : `Il gagne ${theirs} à ${mine}. Reprenez-lui le château.`;

  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10 sm:px-8">
      <div className="slide-up w-full max-w-4xl">
        {/* ---- Verdict ---- */}
        <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="min-w-0">
            <h1
              className="font-display text-[clamp(2.25rem,7vw,4rem)] leading-[1.02]"
              style={{ color: winner === side ? 'var(--role-accent)' : 'var(--color-parchment)' }}
            >
              {title}
            </h1>
            <p className="mt-2 text-base opacity-75 sm:text-lg">{line}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-[0.25em] opacity-60">Score final</p>
            <p className="font-display text-[clamp(2.5rem,8vw,4rem)] leading-none">
              <span style={{ color: 'var(--role-accent)' }}>{mine}</span>
              <span className="opacity-40"> — </span>
              <span>{theirs}</span>
            </p>
          </div>
        </header>

        {/* ---- Les manches ---- */}
        <section className="mt-8" aria-label="Déroulé du match">
          <h2 className="text-xs uppercase tracking-[0.2em] opacity-60">Les manches</h2>
          <ol className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {rows.map((r) => (
              <li key={r.round} className="panel overflow-hidden rounded-lg">
                <div
                  className="h-1 w-full"
                  style={{ background: r.mine ? 'var(--role-accent)' : 'var(--role-stone)' }}
                  aria-hidden="true"
                />
                <div className="px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.2em] opacity-60">
                    {r.round > TOTAL_ROUNDS ? 'Décisive' : `Manche ${r.round}`}
                  </p>
                  <p
                    className="font-display mt-1 text-xl leading-tight"
                    style={{ color: r.mine ? 'var(--role-accent)' : 'var(--color-parchment)' }}
                  >
                    {r.mine ? 'Gagnée' : 'Perdue'}
                  </p>
                  <p className="mt-1 text-sm leading-snug opacity-70">
                    {r.myRole === 'castellan' ? 'Vous défendiez' : 'Vous attaquiez'} · {OUTCOME_LABEL[r.outcome]}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- On remet ça ---- */}
        <section className="mt-8">
          <button
            ref={rematchRef}
            type="button"
            onClick={onRematch}
            className="stone-button w-full rounded-lg px-6 py-6 text-2xl font-medium sm:text-3xl"
            style={{ borderColor: 'var(--role-accent)' }}
          >
            Rejouer
          </button>
          <p className="mt-3 text-center text-sm leading-relaxed opacity-70">
            Le code{' '}
            <span className="session-code text-base" style={{ color: 'var(--role-accent)' }}>
              {code}
            </span>{' '}
            fonctionne toujours. Restez là, votre adversaire aussi.
          </p>
        </section>
      </div>
    </main>
  );
}

export default MatchEnd;
