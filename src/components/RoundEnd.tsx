'use client';

/**
 * Fin de manche — la boucle de plaisir se referme ici (§11).
 *
 * Le Châtelain vient de passer 75 secondes à construire. S'il ne voit pas ce
 * que son château a coûté à l'autre, il ne construira pas une deuxième fois.
 * La statistique reine n'est donc pas les dégâts, ce sont les SECONDES PERDUES
 * par l'Envahisseur : c'est la seule mesure honnête d'un piège qui a fait son
 * travail sans jamais se déclencher.
 *
 * Tout tient sur un écran. Rien à faire défiler sur un portable.
 */

import { useMemo } from 'react';
import type { Role, RoundResult, RoundStats } from '@/game/types';

export interface RoundEndProps {
  result: RoundResult;
  role: Role;
  round: number;
  score: { host: number; guest: number };
  side: 'host' | 'guest';
  secondsLeft: number;
}

/* ==================================================================== */
/* Ce qui s'est passé, dit du point de vue du lecteur                   */
/* ==================================================================== */

function verdict(result: RoundResult, role: Role): { title: string; line: string } {
  const won = result.winner === role;
  switch (result.outcome) {
    case 'capture':
      return won
        ? { title: 'Le Cœur est à vous.', line: 'Vous avez tenu dans la salle jusqu’au bout.' }
        : { title: 'Le Cœur est tombé.', line: 'Il a tenu dans la salle. Regardez par où il est passé.' };
    case 'kill_castellan':
      return won
        ? { title: 'Le Châtelain est mort.', line: 'Vous l’avez trouvé avant son Cœur.' }
        : { title: 'Vous êtes tombé.', line: 'Il vous a trouvé. Le château n’a pas suffi.' };
    case 'kill_invader':
      return won
        ? { title: 'L’Envahisseur est mort.', line: 'Il n’est jamais ressorti de vos murs.' }
        : { title: 'Vous êtes mort dans les murs.', line: 'Le château a eu raison de vous.' };
    default:
      return won
        ? { title: 'Le temps a joué pour vous.', line: 'La manche s’est fermée, le Cœur bat toujours.' }
        : { title: 'Le temps vous a manqué.', line: 'Le Cœur battait encore quand la manche s’est fermée.' };
  }
}

/** Secondes lisibles : une décimale tant que ça compte, entier ensuite. */
function secs(v: number): string {
  const n = Math.max(0, v);
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',');
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ==================================================================== */
/* Le trajet de l'Envahisseur, du froid au chaud                        */
/* ==================================================================== */

function PathMap({ path }: { path: RoundStats['path'] }) {
  const segments = useMemo(() => {
    if (path.length < 2) return [];
    const out: { d: string; p: number }[] = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      out.push({ d: `M${a.x} ${a.y} L${b.x} ${b.y}`, p: i / (path.length - 1) });
    }
    return out;
  }, [path]);

  if (segments.length === 0) {
    return (
      <p className="mt-2 text-sm leading-snug opacity-60">
        Il n’a pas fait trois pas. Rien à tracer.
      </p>
    );
  }

  const first = path[0];
  const last = path[path.length - 1];

  return (
    <svg
      viewBox="-1 -1 26 26"
      className="mt-2 aspect-square w-full max-w-[15rem]"
      role="img"
      aria-label="Trajet de l’Envahisseur, du début en bleu froid à la fin en rouge."
    >
      <rect
        x={0}
        y={0}
        width={24}
        height={24}
        fill="none"
        stroke="var(--role-stone)"
        strokeWidth={0.35}
        rx={0.6}
      />
      {segments.map((s, i) => (
        <path
          key={i}
          d={s.d}
          fill="none"
          strokeWidth={0.42}
          strokeLinecap="round"
          style={{
            stroke: `color-mix(in oklab, var(--color-heart-red) ${Math.round(s.p * 100)}%, var(--color-siege-steel))`,
          }}
        />
      ))}
      <circle cx={first.x} cy={first.y} r={0.55} fill="var(--color-siege-steel)" />
      <circle cx={last.x} cy={last.y} r={0.7} fill="var(--color-heart-red)" />
    </svg>
  );
}

/* ==================================================================== */

export function RoundEnd(props: RoundEndProps) {
  const { result, role, round, score, side, secondsLeft } = props;
  const stats = result.stats;
  const v = verdict(result, role);
  const won = result.winner === role;

  const mine = side === 'host' ? score.host : score.guest;
  const theirs = side === 'host' ? score.guest : score.host;

  /* --- La statistique reine --- */
  const parts = [
    { key: 'careful', label: 'Prudence', value: Math.max(0, stats.lostCareful), color: 'var(--color-siege-steel)' },
    { key: 'traps', label: 'Pièges', value: Math.max(0, stats.lostTraps), color: 'var(--color-danger)' },
    { key: 'detour', label: 'Détours', value: Math.max(0, stats.lostDetour), color: 'var(--color-heart-gold)' },
  ];
  const lost = parts.reduce((a, p) => a + p.value, 0);

  /* --- Dégâts par source --- */
  const damage = useMemo(() => {
    const rows = Object.entries(stats.damageBySource)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((a, r) => a + r[1], 0);
    return { rows: rows.slice(0, 5), total, max: rows.length ? rows[0][1] : 1 };
  }, [stats.damageBySource]);

  const triggered = stats.trapsTriggered.length;
  const avoided = stats.trapsAvoided.length;
  const untouched = stats.trapsUntouched.length;

  return (
    <main className="flex h-dvh w-full flex-col overflow-y-auto px-5 py-5 sm:px-8 lg:overflow-hidden">
      <div className="slide-up mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4">
        {/* ---- Verdict ---- */}
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.25em] opacity-60">Manche {round}</p>
            <h1
              className="font-display text-3xl leading-tight sm:text-4xl"
              style={{ color: won ? 'var(--role-accent)' : 'var(--color-parchment)' }}
            >
              {v.title}
            </h1>
            <p className="mt-1 text-sm opacity-75 sm:text-base">{v.line}</p>
          </div>
          <div className="flex items-center gap-5">
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.2em] opacity-60">Score</p>
              <p className="font-display text-2xl leading-none">
                <span style={{ color: 'var(--role-accent)' }}>{mine}</span>
                <span className="opacity-40"> — </span>
                <span>{theirs}</span>
              </p>
            </div>
            <div className="text-right" aria-live="polite">
              <p className="text-xs uppercase tracking-[0.2em] opacity-60">Manche suivante</p>
              <p className="font-display text-2xl leading-none ember-pulse">
                {Math.max(0, Math.ceil(secondsLeft))} s
              </p>
            </div>
          </div>
        </header>

        {/* ---- LA statistique ---- */}
        <section className="panel rounded-lg px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p
              className="font-display text-[clamp(3.25rem,11vw,6rem)] leading-[0.85]"
              style={{ color: 'var(--role-accent)' }}
            >
              {secs(lost)}
            </p>
            <p className="text-base leading-tight opacity-80 sm:text-lg">
              secondes perdues par l’Envahisseur
            </p>
          </div>

          {lost > 0 ? (
            <>
              <div
                className="mt-3 flex h-4 w-full overflow-hidden rounded"
                style={{ background: 'var(--role-stone)' }}
                role="img"
                aria-label={parts.map((p) => `${p.label} ${secs(p.value)} secondes`).join(', ')}
              >
                {parts.map((p) => (
                  <span
                    key={p.key}
                    style={{
                      flexGrow: p.value,
                      flexBasis: 0,
                      minWidth: p.value > 0 ? 4 : 0,
                      background: p.color,
                    }}
                  />
                ))}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                {parts.map((p) => (
                  <li key={p.key} className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: p.color }}
                      aria-hidden="true"
                    />
                    <span className="opacity-75">{p.label}</span>
                    <span className="font-display">{secs(p.value)} s</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-3 text-sm opacity-70">
              Il a traversé sans ralentir une seule fois. Rendez-lui le passage plus cher.
            </p>
          )}
        </section>

        {/* ---- Le détail ---- */}
        <div className="grid flex-1 gap-4 md:grid-cols-3">
          {/* Pièges */}
          <section className="panel rounded-lg px-5 py-4">
            <h2 className="text-xs uppercase tracking-[0.2em] opacity-60">Vos pièges</h2>
            <dl className="mt-3 space-y-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-sm opacity-80">Déclenchés</dt>
                <dd className="font-display text-2xl leading-none" style={{ color: 'var(--color-danger)' }}>
                  {triggered}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-sm opacity-80">Repérés puis évités</dt>
                <dd className="font-display text-2xl leading-none" style={{ color: 'var(--color-heart-gold)' }}>
                  {avoided}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-sm opacity-80">Jamais approchés</dt>
                <dd className="font-display text-2xl leading-none opacity-60">{untouched}</dd>
              </div>
            </dl>
            <p className="mt-3 text-sm leading-snug opacity-70">
              {untouched > 0
                ? `${untouched} piège${untouched > 1 ? 's' : ''} sur son chemin, jamais. Ces points-là, vous les avez posés ailleurs pour rien.`
                : 'Il a croisé tout ce que vous aviez posé. Aucun point gaspillé.'}
            </p>
          </section>

          {/* Dégâts */}
          <section className="panel rounded-lg px-5 py-4">
            <h2 className="text-xs uppercase tracking-[0.2em] opacity-60">Dégâts, par source</h2>
            {damage.rows.length === 0 ? (
              <p className="mt-3 text-sm leading-snug opacity-70">Personne n’a touché personne.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {damage.rows.map(([src, n]) => (
                  <li key={src}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm opacity-85">{capitalize(src)}</span>
                      <span className="font-display text-base">{Math.round(n)}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full rounded" style={{ background: 'var(--role-stone)' }}>
                      <div
                        className="h-full rounded"
                        style={{
                          width: `${Math.max(4, (n / damage.max) * 100)}%`,
                          background: 'var(--role-accent)',
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {damage.total > 0 ? (
              <p className="mt-3 text-sm opacity-70">Total : {Math.round(damage.total)} points de vie.</p>
            ) : null}
          </section>

          {/* Trajet */}
          <section className="panel rounded-lg px-5 py-4">
            <h2 className="text-xs uppercase tracking-[0.2em] opacity-60">Son trajet</h2>
            <PathMap path={stats.path} />
            <p className="mt-2 text-sm leading-snug opacity-70">
              Le tracé chauffe à mesure qu’il avance. La fin est en rouge.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

export default RoundEnd;
