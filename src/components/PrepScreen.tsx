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
import { CFG, DEVICE_KINDS, INTEL_KINDS, TELL_KINDS, TOOL_KINDS, TRAP_KINDS } from '@/game/config';
import type { IntelKind, ToolKind } from '@/game/config';
import { roundHeadline } from '@/game/match';
import type { Engine, EngineState } from '@/net/engine';
import type { DeviceKind, TellKind, TrapKind } from '@/game/types';
import { PlanCanvas, type Brush } from './PlanCanvas';

const TELL_LABEL: Record<TellKind, string> = {
  seam: 'Dalles jointoyées',
  slit: 'Trous d’archère',
  crack: 'Fissures',
  dust: 'Poussière',
  chest: 'Coffre',
};

export function PrepScreen({
  engine,
  state,
  onSound,
}: {
  engine: Engine;
  state: EngineState;
  onSound?: (k: 'place' | 'remove' | 'deny' | 'ready') => void;
}) {
  const [brush, setBrush] = useState<Brush>({ kind: 'trap', trap: 'spikes', tell: 'seam' });
  const [decoyTell, setDecoyTell] = useState<TellKind>('seam');
  const [notice, setNotice] = useState<string | null>(null);

  const castellan = state.role === 'castellan';
  const left = state.budgetTotal - state.budgetSpent;
  const seconds = Math.ceil(state.timeLeft);

  const say = (msg: string | null) => {
    setNotice(msg);
    if (msg) onSound?.('deny');
  };

  const place = (x: number, y: number) => {
    let why: string | null = null;
    if (brush.kind === 'trap') why = engine.placeTrap(brush.trap, x, y, decoyTell);
    else if (brush.kind === 'device') why = engine.placeDevice(brush.device, x, y);
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
              {castellan ? 'Budget de construction' : 'Budget d’équipement'}
            </span>
            <span className="font-code text-lg tabular-nums">
              {left}
              <span className="opacity-45"> / {state.budgetTotal}</span>
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-sm bg-black/55">
            <div
              className="h-full bg-[var(--role-accent)] transition-[width] duration-150"
              style={{ width: `${(state.budgetSpent / Math.max(1, state.budgetTotal)) * 100}%` }}
            />
          </div>
          {castellan && state.burned.length > 0 && (
            <p className="mt-2 text-[12px] leading-snug text-heart-gold">
              {state.burned.length} piège{state.burned.length > 1 ? 's' : ''} repéré
              {state.burned.length > 1 ? 's' : ''} à la manche précédente. Déplacez-les : ça ne coûte
              rien.
            </p>
          )}
        </div>

        {/* Sur petit écran la palette se déroule dans le flux ; sur grand écran
            elle défile dans sa colonne, entre le budget et le bouton. */}
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
          {castellan ? (
            <CastellanPalette
              brush={brush}
              setBrush={setBrush}
              decoyTell={decoyTell}
              setDecoyTell={setDecoyTell}
              left={left}
            />
          ) : (
            <InvaderShop engine={engine} state={state} onSound={onSound} />
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

function CastellanPalette({
  brush,
  setBrush,
  decoyTell,
  setDecoyTell,
  left,
}: {
  brush: Brush;
  setBrush: (b: Brush) => void;
  decoyTell: TellKind;
  setDecoyTell: (t: TellKind) => void;
  left: number;
}) {
  return (
    <div className="space-y-4">
      <Group title="Pièges automatiques" hint="Chacun laisse un indice visible en allure prudente.">
        {TRAP_KINDS.filter((k) => k !== 'decoy').map((k) => {
          const spec = CFG.traps[k];
          const active = brush.kind === 'trap' && brush.trap === k;
          return (
            <PaletteButton
              key={k}
              active={active}
              disabled={spec.cost > left && !active}
              cost={spec.cost}
              title={spec.label}
              sub={spec.tellLabel}
              onClick={() => setBrush({ kind: 'trap', trap: k as TrapKind, tell: spec.tell })}
            />
          );
        })}
      </Group>

      <Group
        title="Faux indices"
        hint="Identiques aux vrais. Vingt points peuvent coûter quarante secondes à votre adversaire."
      >
        <PaletteButton
          active={brush.kind === 'trap' && brush.trap === 'decoy'}
          disabled={CFG.traps.decoy.cost > left}
          cost={CFG.traps.decoy.cost}
          title="Faux indice"
          sub={`Apparence : ${TELL_LABEL[decoyTell]}`}
          onClick={() => setBrush({ kind: 'trap', trap: 'decoy', tell: decoyTell })}
        />
        <div className="col-span-2 flex flex-wrap gap-1">
          {TELL_KINDS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={decoyTell === t}
              onClick={() => {
                setDecoyTell(t);
                setBrush({ kind: 'trap', trap: 'decoy', tell: t });
              }}
              className="stone-button rounded-sm px-2 py-1 text-[11px]"
            >
              {TELL_LABEL[t]}
            </button>
          ))}
        </div>
      </Group>

      <Group title="Mécanismes" hint="Déclenchés en Scrutation, payés en Influence.">
        {DEVICE_KINDS.map((k) => {
          const spec = CFG.devices[k];
          const active = brush.kind === 'device' && brush.device === k;
          return (
            <PaletteButton
              key={k}
              active={active}
              disabled={spec.cost > left && !active}
              cost={spec.cost}
              title={spec.label}
              sub={`${spec.hint} · ${spec.influence} Influence`}
              onClick={() => setBrush({ kind: 'device', device: k as DeviceKind })}
            />
          );
        })}
      </Group>

      <Group title="Le château" hint="Votre mobilité privée vaut souvent mieux qu’un piège de plus.">
        <PaletteButton
          active={brush.kind === 'heart'}
          cost={0}
          title="Placer le Cœur"
          sub="Trois emplacements possibles"
          onClick={() => setBrush({ kind: 'heart' })}
        />
        <PaletteButton
          active={brush.kind === 'door'}
          cost={CFG.fixtures.lockDoor.cost}
          title="Verrouiller une porte"
          sub="Vous passez, lui non"
          onClick={() => setBrush({ kind: 'door' })}
        />
        <PaletteButton
          active={brush.kind === 'secret'}
          cost={CFG.fixtures.secretDoor.cost}
          title="Passage secret"
          sub="Traverser sans croiser son chemin"
          onClick={() => setBrush({ kind: 'secret' })}
        />
        <PaletteButton
          active={brush.kind === 'erase'}
          cost={0}
          title="Retirer"
          sub="Clic droit fait pareil"
          onClick={() => setBrush({ kind: 'erase' })}
        />
      </Group>
    </div>
  );
}

/* ==================================================================== */
/* Boutique de l'Envahisseur                                            */
/* ==================================================================== */

function InvaderShop({
  engine,
  state,
  onSound,
}: {
  engine: Engine;
  state: EngineState;
  onSound?: (k: 'place' | 'remove' | 'deny' | 'ready') => void;
}) {
  const chosen = state.loadout.tools;
  const full = chosen.length >= CFG.budget.maxTools;
  const left = CFG.budget.invader - state.budgetSpent;

  return (
    <div className="space-y-4">
      <Group
        title={`Outils — ${chosen.length} / ${CFG.budget.maxTools}`}
        hint="L’épée est gratuite et vous l’avez déjà."
      >
        {TOOL_KINDS.map((k) => {
          const spec = CFG.tools[k];
          const active = chosen.includes(k as ToolKind);
          return (
            <PaletteButton
              key={k}
              active={active}
              disabled={!active && (full || spec.cost > left)}
              cost={spec.cost}
              title={spec.label}
              sub={spec.hint}
              onClick={() => {
                engine.toggleTool(k as ToolKind);
                onSound?.(active ? 'remove' : 'place');
              }}
            />
          );
        })}
      </Group>

      <Group
        title="Renseignement"
        hint="Payé sur le même budget : de la puissance en moins, du savoir en plus."
      >
        {INTEL_KINDS.map((k) => {
          const spec = CFG.intel[k];
          const active = state.loadout.intel.includes(k as IntelKind);
          return (
            <PaletteButton
              key={k}
              active={active}
              disabled={!active && spec.cost > left}
              cost={spec.cost}
              title={spec.label}
              sub={spec.hint}
              onClick={() => {
                engine.toggleIntel(k as IntelKind);
                onSound?.(active ? 'remove' : 'place');
              }}
            />
          );
        })}
      </Group>
    </div>
  );
}

function InvaderBriefing({ state }: { state: EngineState }) {
  return (
    <div className="panel flex w-full max-w-[640px] flex-1 flex-col justify-center gap-4 rounded-sm p-6">
      <h3 className="font-display text-xl">Ce que vous savez</h3>
      <ul className="space-y-2 text-sm leading-relaxed opacity-80">
        <li>
          Le château est piégé. Chaque piège laisse un indice, et seule l’allure prudente les
          révèle — mais ralentir coûte du temps, et le temps est votre véritable adversaire.
        </li>
        <li>
          Certains indices sont faux. Ils coûtent presque rien à poser. Vous ne saurez jamais
          lesquels avant de vous engager.
        </li>
        <li>
          Trouvez le Cœur et tenez-vous-y {CFG.heart.captureTime} secondes. Le Châtelain doit y
          revenir pour recharger : vous finirez par vous croiser.
        </li>
        <li>
          Trois braseros donnent {CFG.brazier.timeBonus} secondes chacun, deux au maximum. Ils sont
          loin du Cœur — c’est le prix.
        </li>
      </ul>
      {state.round >= 3 && (
        <p className="border-l-2 border-[var(--role-accent)] pl-3 text-sm text-[var(--role-accent)]">
          Vous connaissez déjà ce château. Il le sait aussi, et il a eu le temps de le changer.
        </p>
      )}
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
