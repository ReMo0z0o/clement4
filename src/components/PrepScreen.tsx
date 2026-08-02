'use client';

/**
 * Phase de préparation.
 *
 * Les deux joueurs y sont occupés **en même temps** : le Châtelain construit,
 * l'Envahisseur s'équipe. Aucun des deux n'attend l'autre (§8) — c'est la règle
 * qui a dicté la structure de cet écran.
 *
 * Aux manches 3 et 4, le Châtelain voit en plus le trajet de son adversaire et
 * ses pièges grillés : c'est là que la manche cesse d'être une répétition pour
 * devenir une réponse.
 */

import { useState } from 'react';
import { CFG } from '@/game/config';
import { roundHeadline } from '@/game/match';
import type { Engine, EngineState } from '@/net/engine';
import { PlanCanvas, type Brush } from './PlanCanvas';

export function PrepScreen({
  engine,
  state,
  onSound,
}: {
  engine: Engine;
  state: EngineState;
  onSound?: (k: 'place' | 'remove' | 'deny' | 'ready') => void;
}) {
  const [brush, setBrush] = useState<Brush>({ kind: 'sensor' });
  const [notice, setNotice] = useState<string | null>(null);

  const castellan = state.role === 'castellan';
  const sensorsPlaced = state.build.sensors?.length ?? 0;
  const seconds = Math.ceil(state.timeLeft);

  const say = (msg: string | null) => {
    setNotice(msg);
    if (msg) onSound?.('deny');
  };

  const place = (x: number, y: number) => {
    if (brush.kind !== 'sensor') return;
    const why = engine.placeSensor(x, y);
    if (why) say(why);
    else {
      say(null);
      onSound?.('place');
    }
  };

  return (
    // En dessous de `lg`, les deux colonnes s'empilent et la page défile
    // normalement. À partir de `lg`, on fige la hauteur et ce sont les colonnes
    // qui défilent chacune de leur côté : le plan reste visible pendant qu'on
    // parcourt la palette.
    <div className="flex min-h-dvh flex-col gap-4 p-4 pb-24 lg:h-dvh lg:flex-row lg:overflow-hidden lg:pb-4">
      {/* ---------------- Colonne de gauche : le plan ou le briefing ------- */}
      <section className="flex min-w-0 flex-1 flex-col items-center gap-3 lg:min-h-0 lg:overflow-y-auto">
        <header className="w-full max-w-[640px]">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-2xl">
              {castellan ? 'Votre château' : 'Votre équipement'}
            </h2>
            <div
              className={`font-code text-3xl tabular-nums ${seconds <= 10 ? 'text-danger ember-pulse' : ''}`}
            >
              {seconds}
            </div>
          </div>
          <p className="mt-0.5 text-sm opacity-65">{roundHeadline(state.round, state.role)}</p>
        </header>

        {castellan && state.planId ? (
          <PlanCanvas
            planId={state.planId}
            build={state.build}
            brush={brush}
            burned={state.burned}
            heat={state.heat}
            onPlace={place}
            onErase={(x, y) => {
              engine.removeAt(x, y);
              onSound?.('remove');
            }}
            onHeart={(i) => engine.setHeart(i)}
            onDoor={(i) => engine.toggleDoor(i)}
            onSecret={(i) => engine.toggleSecret(i)}
          />
        ) : (
          <InvaderBriefing state={state} />
        )}

        {notice && <p className="text-sm text-danger">{notice}</p>}
      </section>

      {/* ---------------- Colonne de droite : les achats ------------------- */}
      <aside className="flex w-full flex-col gap-3 lg:h-full lg:min-h-0 lg:w-[380px]">
        <div className="panel rounded-sm p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-widest opacity-60">
              {castellan ? 'Guets posés' : 'Votre équipement'}
            </span>
            <span className="font-code text-lg tabular-nums">
              {castellan ? `${sensorsPlaced} / ${CFG.sensors.count}` : 'épée + arbalète'}
            </span>
          </div>
          {castellan ? (
            <p className="mt-2 text-[12px] leading-snug opacity-55">
              Un guet vous signale tout passage ennemi à {CFG.sensors.radius} pas, où que vous
              soyez. Placez aussi votre Cœur : c’est lui qu’il vient prendre.
            </p>
          ) : (
            <p className="mt-2 text-[12px] leading-snug opacity-55">
              Rien à choisir : votre épée est au clic gauche, votre arbalète au clic droit. Le
              carreau rebondit trois fois sur les murs — le vôtre aussi.
            </p>
          )}
        </div>

        {/* Sur petit écran la palette se déroule dans le flux ; sur grand écran
            elle défile dans sa colonne, entre le budget et le bouton. */}
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
          {castellan ? (
            <CastellanPalette brush={brush} setBrush={setBrush} placed={sensorsPlaced} />
          ) : (
            <InvaderChecklist />
          )}
        </div>

        {/* Barre d'action collante en bas de l'écran tant qu'on n'est pas en
            deux colonnes. Pendant une préparation de 75 secondes, le chrono et
            le bouton de départ ne doivent jamais demander de faire défiler. */}
        <div className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-[var(--role-accent)]/25 bg-[var(--role-bg)]/95 p-3 backdrop-blur lg:static lg:z-auto lg:block lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
          <span
            className={`font-code text-2xl tabular-nums lg:hidden ${
              seconds <= 10 ? 'text-danger ember-pulse' : ''
            }`}
          >
            {seconds}
          </span>
          <button
            type="button"
            onClick={() => {
              engine.setReady(!state.ready);
              onSound?.('ready');
            }}
            aria-pressed={state.ready}
            className="stone-button flex-1 rounded-sm px-4 py-3 font-display text-lg lg:w-full"
          >
            {state.ready ? 'Prêt — en attente' : 'Je suis prêt'}
          </button>
        </div>
        <p className="hidden text-center text-[12px] opacity-55 lg:block">
          {state.peerReady
            ? 'Votre adversaire est prêt.'
            : 'Votre adversaire prépare encore son tour.'}
        </p>
      </aside>
    </div>
  );
}

/* ==================================================================== */
/* Palette du Châtelain                                                 */
/* ==================================================================== */
/* Palette du Châtelain : trois guets et un Cœur                        */
/* ==================================================================== */

function CastellanPalette({
  brush,
  setBrush,
  placed,
}: {
  brush: Brush;
  setBrush: (b: Brush) => void;
  placed: number;
}) {
  return (
    <div className="space-y-4">
      <Group
        title={`${CFG.sensors.plural} — ${placed} / ${CFG.sensors.count}`}
        hint="Cliquez sur le plan pour poser. Tant qu’il est dans le cercle, vous le voyez en direct — même derrière un mur."
      >
        <PaletteButton
          active={brush.kind === 'sensor'}
          cost={0}
          title={`Poser un ${CFG.sensors.label.toLowerCase()}`}
          sub={`Cercle de ${CFG.sensors.radius} pas · ${CFG.sensors.watchTime} s de veille en réserve, puis il s’éteint`}
          onClick={() => setBrush({ kind: 'sensor' })}
        />
        <PaletteButton
          active={brush.kind === 'erase'}
          cost={0}
          title="Retirer"
          sub="Clic droit fait pareil"
          onClick={() => setBrush({ kind: 'erase' })}
        />
      </Group>

      <Group
        title="Le Cœur"
        hint="C’est lui que l’Envahisseur vient capturer — et votre recharge d’Influence."
      >
        <PaletteButton
          active={brush.kind === 'heart'}
          cost={0}
          title="Placer le Cœur"
          sub="Trois emplacements possibles"
          onClick={() => setBrush({ kind: 'heart' })}
        />
      </Group>
    </div>
  );
}


/* ==================================================================== */
/* Côté Envahisseur : rien à acheter, tout à savoir                     */
/* ==================================================================== */

function InvaderBriefing({ state }: { state: EngineState }) {
  return (
    <div className="panel flex w-full max-w-[640px] flex-1 flex-col justify-center gap-4 rounded-sm p-6">
      <h3 className="font-display text-xl">Ce que vous savez</h3>
      <ul className="space-y-2 text-sm leading-relaxed opacity-80">
        <li>
          Trouvez le Cœur et tenez-vous-y {CFG.heart.captureTime} secondes. Le Châtelain doit y
          revenir pour recharger : vous finirez par vous croiser.
        </li>
        <li>
          Vous portez la même épée et la même arbalète que lui. Le carreau rebondit jusqu’à{' '}
          {CFG.combat.crossbow.bounces} fois sur les murs — un tir raté continue de vivre dans le
          couloir, et il ne fait pas la différence entre vous deux.
        </li>
        <li>
          Le château est équipé de {CFG.sensors.count} {CFG.sensors.plural.toLowerCase()}. Dans leur
          cercle, le Châtelain vous voit en direct — même derrière un mur. Vous le saurez : l’œil
          s’affiche en rouge. Chacun n’a que {CFG.sensors.watchTime} secondes de veille en réserve,
          alors user un cercle exprès avant le vrai passage est une option.
        </li>
        <li>
          Trois braseros donnent {CFG.brazier.timeBonus} secondes chacun, deux au maximum. Ils
          sont loin du Cœur — c’est le prix.
        </li>
      </ul>
      {state.round >= 3 && (
        <p className="border-l-2 border-[var(--role-accent)] pl-3 text-sm text-[var(--role-accent)]">
          Vous connaissez déjà ce château. Il a eu le temps de déplacer ses yeux.
        </p>
      )}
    </div>
  );
}

/** La colonne de droite de l'Envahisseur : ses commandes, pour mémoire. */
function InvaderChecklist() {
  const rows = [
    ['Clic gauche', 'Épée'],
    ['Clic droit', 'Arbalète — rebondit 3 fois'],
    ['Maj (maintenu)', 'Avancer prudemment'],
    ['Espace (maintenu)', 'Courir'],
    ['F', 'Esquive roulée'],
    ['E', 'Allumer un brasero'],
  ] as const;
  return (
    <div className="space-y-1.5">
      <h3 className="text-[11px] uppercase tracking-widest opacity-60">Vos commandes</h3>
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex items-center justify-between rounded-sm bg-black/35 px-2.5 py-1.5 text-[12px]"
        >
          <span className="opacity-80">{v}</span>
          <span className="font-code opacity-55">{k}</span>
        </div>
      ))}
    </div>
  );
}


/* ==================================================================== */
/* Briques d'interface                                                  */
/* ==================================================================== */

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-widest opacity-60">{title}</h3>
      {hint && <p className="mb-2 mt-0.5 text-[12px] leading-snug opacity-45">{hint}</p>}
      <div className="grid grid-cols-2 gap-1.5">{children}</div>
    </section>
  );
}

function PaletteButton({
  active,
  disabled,
  cost,
  title,
  sub,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  cost: number;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="stone-button rounded-sm px-2.5 py-2 text-left"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold leading-tight">{title}</span>
        {cost > 0 && <span className="font-code text-[12px] tabular-nums opacity-70">{cost}</span>}
      </div>
      <div className="mt-0.5 text-[11px] leading-snug opacity-55">{sub}</div>
    </button>
  );
}
