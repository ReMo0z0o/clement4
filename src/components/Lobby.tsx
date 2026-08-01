'use client';

/**
 * L'écran d'accueil — la première chose que voit un joueur.
 *
 * Il porte l'identité du jeu (§15) et ne demande que trois choses : créer ou
 * rejoindre, choisir un château, se déclarer prêt. Rien d'autre n'y entre.
 * Ce composant est purement présentatif : il reçoit son état et appelle les
 * fonctions qu'on lui donne.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PlanId } from '@/game/types';
import { codeProblem, normalizeCode, transportBlurb, type TransportKind } from '@/net/transport';

export interface LobbyProps {
  onCreate: () => void;
  onJoin: (code: string) => void;
  status: 'idle' | 'connecting' | 'waiting' | 'error';
  /** Notre code de session, une fois la partie ouverte. */
  code: string | null;
  /** Avons-nous créé cette partie, ou l'avons-nous rejointe ? */
  isHost: boolean;
  /** Personne n'a répondu après le délai d'attente. */
  waitingTooLong: boolean;
  /** Repart de zéro : indispensable après un code mal tapé. */
  onCancel: () => void;
  /** Mode local : ouvre la seconde fenêtre, déjà branchée sur le code. */
  onOpenSecondWindow: () => void;
  error: string | null;
  transportKind: TransportKind;
  plans: { id: PlanId; name: string; blurb: string }[];
  selectedPlan: PlanId | null;
  onSelectPlan: (id: PlanId) => void;
  ready: boolean;
  peerReady: boolean;
  peerConnected: boolean;
  onReady: (r: boolean) => void;
}

/**
 * Ce qu'on dit quand personne ne répond.
 *
 * Un message d'erreur explique quoi faire, il ne s'excuse pas (§15) — et
 * surtout il nomme la vraie cause : en mode local, l'immense majorité des
 * échecs vient de deux personnes qui essaient de se rejoindre depuis deux
 * appareils, ce que ce mode ne peut pas faire.
 */
function waitingAdvice(isHost: boolean, kind: TransportKind): string {
  if (kind === 'local') {
    return isHost
      ? 'Personne n’a rejoint. En partie locale, votre adversaire doit ouvrir une seconde ' +
          'fenêtre de ce navigateur, sur cet ordinateur : un autre appareil ne peut pas voir ' +
          'cette partie. Le bouton « Ouvrir la seconde fenêtre » le fait pour vous.'
      : 'Aucune partie ne porte ce code dans ce navigateur. Vérifiez les six caractères, et ' +
          'assurez-vous que la partie a bien été créée depuis ce même navigateur.';
  }
  return isHost
    ? 'Personne n’a encore rejoint. Le code reste valable : redonnez-le à votre adversaire.'
    : 'Aucune partie ne répond à ce code. Vérifiez les six caractères, ou demandez à votre ' +
        'adversaire d’en créer une nouvelle.';
}

/* ==================================================================== */
/* Silhouettes de plan — dessinées, jamais photographiées               */
/* ==================================================================== */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Une forme suffit à dire « serré », « tordu » ou « ouvert ». */
function PlanGlyph({ id }: { id: PlanId }) {
  if (id === 'labyrinth') {
    const d = 'M9 41 L9 27 L19 27 L19 13 L31 13 L31 31 L40 31 L40 9';
    return (
      <svg viewBox="0 0 48 48" className="h-16 w-16 shrink-0" aria-hidden="true">
        <path {...STROKE} d={d} strokeWidth={7} opacity={0.22} />
        <path {...STROKE} d={d} strokeWidth={1.4} />
        <path {...STROKE} strokeWidth={1.4} d="M9 13 L14 13 M24 41 L24 35 M40 41 L40 38" opacity={0.55} />
      </svg>
    );
  }
  if (id === 'open') {
    const columns = [14, 22, 30, 38];
    return (
      <svg viewBox="0 0 48 48" className="h-16 w-16 shrink-0" aria-hidden="true">
        <rect {...STROKE} strokeWidth={1.4} x={6} y={8} width={36} height={14} rx={1.5} />
        <rect {...STROKE} strokeWidth={1.4} x={6} y={26} width={36} height={14} rx={1.5} />
        {columns.map((x) => (
          <circle key={`a${x}`} cx={x} cy={15} r={1.5} fill="currentColor" opacity={0.6} />
        ))}
        {columns.map((x) => (
          <circle key={`b${x}`} cx={x} cy={33} r={1.5} fill="currentColor" opacity={0.6} />
        ))}
      </svg>
    );
  }
  const cells = [0, 1, 2];
  return (
    <svg viewBox="0 0 48 48" className="h-16 w-16 shrink-0" aria-hidden="true">
      {cells.map((j) =>
        cells.map((i) => (
          <rect
            key={`${i}-${j}`}
            {...STROKE}
            strokeWidth={1.4}
            x={7 + i * 12}
            y={7 + j * 12}
            width={10}
            height={10}
            rx={1}
          />
        )),
      )}
    </svg>
  );
}

/* ==================================================================== */

export function Lobby(props: LobbyProps) {
  const {
    onCreate,
    onJoin,
    status,
    code,
    isHost,
    waitingTooLong,
    onCancel,
    onOpenSecondWindow,
    error,
    transportKind,
    plans,
    selectedPlan,
    onSelectPlan,
    ready,
    peerReady,
    peerConnected,
    onReady,
  } = props;

  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeFieldId = useId();
  const codeHintId = useId();
  const planRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const problem = codeProblem(typed);
  const busy = status === 'connecting';
  const open = code !== null && status !== 'idle' && status !== 'error';

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(t);
  }, [copied]);

  const copyCode = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Presse-papiers refusé : on recopie par le champ caché, ça marche partout.
      const field = document.createElement('textarea');
      field.value = code;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      document.body.removeChild(field);
    }
    setCopied(true);
  }, [code]);

  const submitJoin = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setTouched(true);
      if (codeProblem(typed)) return;
      onJoin(normalizeCode(typed));
    },
    [onJoin, typed],
  );

  /** Groupe radio au clavier : flèches pour parcourir, un seul arrêt de tabulation. */
  const onPlanKey = useCallback(
    (e: React.KeyboardEvent, i: number) => {
      const n = plans.length;
      if (n === 0) return;
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      if (next < 0) return;
      e.preventDefault();
      onSelectPlan(plans[next].id);
      planRefs.current[next]?.focus();
    },
    [onSelectPlan, plans],
  );

  const canReady = open && peerConnected && selectedPlan !== null;
  const blocker = !open
    ? 'Créez une partie ou rejoignez celle de votre adversaire.'
    : !peerConnected
      ? 'Attendez votre adversaire.'
      : selectedPlan === null
        ? 'Choisissez un château pour continuer.'
        : null;

  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10 sm:px-8">
      <div className="slide-up w-full max-w-5xl">
        {/* ---- Titre ---- */}
        <header className="mb-8 sm:mb-10">
          <h1 className="font-display text-[clamp(2.75rem,10vw,5.75rem)] leading-[0.95] tracking-tight">
            Castle Siege
          </h1>
          <p className="mt-3 max-w-xl text-base leading-relaxed opacity-75 sm:text-lg">
            Un joueur piège son château. L’autre y entre de force.
          </p>
        </header>

        <div className="grid gap-5 md:grid-cols-2">
          {/* ---- Session ---- */}
          <section className="panel rounded-lg p-5 sm:p-6" aria-labelledby={`${codeFieldId}-session`}>
            <h2
              id={`${codeFieldId}-session`}
              className="font-display text-xl"
              style={{ color: 'var(--role-accent)' }}
            >
              La partie
            </h2>

            {open && code ? (
              <div className="mt-4">
                <p className="text-sm opacity-70">
                  {isHost ? 'Dictez ce code à votre adversaire.' : 'Vous rejoignez cette partie.'}
                </p>
                <p
                  className="session-code mt-2 break-all text-[clamp(2.25rem,10vw,4rem)] leading-none"
                  style={{ color: 'var(--role-accent)' }}
                  aria-label={`Code de la partie : ${code.split('').join(' ')}`}
                >
                  {code}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {isHost && (
                    <button
                      type="button"
                      onClick={copyCode}
                      className="stone-button rounded px-4 py-2 text-sm font-medium"
                    >
                      {copied ? 'Code copié' : 'Copier le code'}
                    </button>
                  )}
                  {isHost && transportKind === 'local' && !peerConnected && (
                    <button
                      type="button"
                      onClick={onOpenSecondWindow}
                      className="stone-button rounded px-4 py-2 text-sm font-medium"
                      style={{ borderColor: 'var(--role-accent)' }}
                    >
                      Ouvrir la seconde fenêtre
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onCancel}
                    className="rounded px-2 py-2 text-sm underline underline-offset-4 opacity-60 hover:opacity-100"
                  >
                    Changer de partie
                  </button>
                  <span className="text-sm" aria-live="polite" style={{ color: 'var(--role-accent)' }}>
                    {copied ? 'Il est dans votre presse-papiers.' : ''}
                  </span>
                </div>

                {/* Le mode local est une contrainte forte : on le dit en grand,
                    pas en légende. Deux appareils ne se verront jamais. */}
                {transportKind === 'local' && (
                  <p
                    className="mt-4 rounded px-3 py-2 text-sm leading-relaxed"
                    style={{
                      color: 'var(--color-heart-gold)',
                      background: 'color-mix(in srgb, var(--color-heart-gold) 10%, transparent)',
                    }}
                  >
                    Cette partie ne sort pas de ce navigateur. Votre adversaire doit jouer dans
                    une seconde fenêtre du même navigateur, sur cet ordinateur. Pour jouer à
                    distance, il faut configurer Supabase — voir le README.
                  </p>
                )}

                {waitingTooLong && !peerConnected && (
                  <p
                    role="alert"
                    className="mt-3 rounded px-3 py-2 text-sm leading-relaxed"
                    style={{
                      color: 'var(--color-danger)',
                      background: 'color-mix(in srgb, var(--color-danger) 12%, transparent)',
                    }}
                  >
                    {waitingAdvice(isHost, transportKind)}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-4 space-y-6">
                <div>
                  <button
                    type="button"
                    onClick={onCreate}
                    disabled={busy}
                    className="stone-button w-full rounded px-4 py-3 text-base font-medium"
                  >
                    {busy ? 'Ouverture de la partie…' : 'Créer une partie'}
                  </button>
                  <p className="mt-2 text-sm leading-relaxed opacity-70">{transportBlurb(transportKind)}</p>
                </div>

                <form onSubmit={submitJoin} className="border-t pt-5" style={{ borderColor: 'var(--role-stone)' }}>
                  <label htmlFor={codeFieldId} className="block text-sm font-medium opacity-80">
                    Rejoindre une partie
                  </label>
                  <input
                    id={codeFieldId}
                    value={typed}
                    onChange={(e) => {
                      setTyped(normalizeCode(e.target.value));
                      setTouched(true);
                    }}
                    onBlur={() => setTouched(true)}
                    disabled={busy}
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="ABC234"
                    aria-describedby={codeHintId}
                    aria-invalid={touched && problem !== null}
                    className="session-code mt-2 w-full rounded bg-transparent px-3 py-3 text-center text-3xl uppercase outline-none sm:text-4xl"
                    style={{
                      border: '1px solid color-mix(in srgb, var(--role-accent) 30%, transparent)',
                      color: 'var(--role-accent)',
                    }}
                  />
                  <p id={codeHintId} className="mt-2 min-h-[1.25rem] text-sm leading-snug" aria-live="polite">
                    {touched && problem ? (
                      <span style={{ color: 'var(--color-danger)' }}>{problem}</span>
                    ) : (
                      <span className="opacity-60">Six caractères, sans I, O, zéro ni 1.</span>
                    )}
                  </p>
                  <button
                    type="submit"
                    disabled={busy || problem !== null}
                    className="stone-button mt-2 w-full rounded px-4 py-3 text-base font-medium"
                  >
                    Rejoindre
                  </button>
                </form>
              </div>
            )}

            {error ? (
              <p
                role="alert"
                className="mt-4 rounded px-3 py-2 text-sm leading-relaxed"
                style={{
                  color: 'var(--color-danger)',
                  background: 'color-mix(in srgb, var(--color-danger) 12%, transparent)',
                }}
              >
                {error}
              </p>
            ) : null}
          </section>

          {/* ---- Adversaire et départ ---- */}
          <section className="panel flex flex-col rounded-lg p-5 sm:p-6" aria-label="Votre adversaire">
            <h2 className="font-display text-xl" style={{ color: 'var(--role-accent)' }}>
              En face
            </h2>

            <div className="mt-4 flex items-start gap-3" aria-live="polite">
              <span
                className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${peerConnected ? '' : 'ember-pulse'}`}
                style={{
                  background: peerConnected ? 'var(--role-accent)' : 'var(--color-parchment)',
                  opacity: peerConnected ? 1 : 0.5,
                }}
                aria-hidden="true"
              />
              <p className="text-base leading-relaxed">
                {!open
                  ? 'Personne pour l’instant.'
                  : !peerConnected
                    ? isHost
                      ? 'Vous êtes seul. Donnez le code.'
                      : 'Vous attendez que la partie s’ouvre.'
                    : peerReady
                      ? 'Votre adversaire est prêt.'
                      : 'Votre adversaire est arrivé. Il choisit encore.'}
              </p>
            </div>

            <div className="mt-auto pt-6">
              <button
                type="button"
                onClick={() => onReady(!ready)}
                disabled={!canReady}
                aria-pressed={ready}
                className="stone-button w-full rounded px-4 py-4 text-lg font-medium"
              >
                {ready ? 'Annuler' : 'Je suis prêt'}
              </button>
              <p className="mt-2 min-h-[1.25rem] text-sm leading-snug opacity-70" aria-live="polite">
                {blocker ?? (ready ? 'La manche démarre dès que vous êtes deux à être prêts.' : '')}
              </p>
            </div>
          </section>
        </div>

        {/* ---- Choix du château ---- */}
        <section className="mt-5" aria-labelledby={`${codeFieldId}-plans`}>
          <h2 id={`${codeFieldId}-plans`} className="font-display text-xl">
            Votre château
          </h2>
          <p className="mt-1 text-sm opacity-70">
            Vous le défendrez, puis vous devrez le retourner contre lui.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-3" role="radiogroup" aria-label="Votre château">
            {plans.map((p, i) => {
              const on = selectedPlan === p.id;
              return (
                <button
                  key={p.id}
                  ref={(el) => {
                    planRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on || (selectedPlan === null && i === 0) ? 0 : -1}
                  onClick={() => onSelectPlan(p.id)}
                  onKeyDown={(e) => onPlanKey(e, i)}
                  className="panel flex items-start gap-4 rounded-lg p-4 text-left transition-colors"
                  style={{
                    borderColor: on
                      ? 'var(--role-accent)'
                      : 'color-mix(in srgb, var(--role-accent) 22%, transparent)',
                    background: on
                      ? 'color-mix(in srgb, var(--role-accent) 14%, var(--role-panel))'
                      : undefined,
                  }}
                >
                  <span style={{ color: on ? 'var(--role-accent)' : 'var(--color-parchment)', opacity: on ? 1 : 0.55 }}>
                    <PlanGlyph id={p.id} />
                  </span>
                  <span className="min-w-0">
                    <span className="font-display block text-lg leading-tight">{p.name}</span>
                    <span className="mt-1 block text-sm leading-snug opacity-70">{p.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}

export default Lobby;
