'use client';

/**
 * Panneau de réglage, ouvert avec la touche ² (ou ~).
 *
 * « Le plaisir se règle par itération, pas par intuition » (§17). Ce panneau
 * modifie `CFG` en direct, sans rechargement : on change une vitesse, on joue
 * trois secondes, on sait si c'était mieux.
 *
 * Les valeurs exposées ne sont pas choisies au hasard : ce sont exactement
 * celles dont dépendent les cinq tensions de la section 2.
 */

import { useState } from 'react';
import { CFG } from '@/game/config';
import type { EngineState } from '@/net/engine';

interface Knob {
  label: string;
  hint: string;
  get: () => number;
  set: (v: number) => void;
  min: number;
  max: number;
  step: number;
}

const GROUPS: { title: string; why: string; knobs: Knob[] }[] = [
  {
    title: 'Allures',
    why: 'Si l’Envahisseur ne change pas d’allure dix fois par manche, elles ne sont pas assez différenciées.',
    knobs: [
      k('Vitesse de base', 'tuiles/s en allure normale', () => CFG.invader.baseSpeed, (v) => (CFG.invader.baseSpeed = v), 1.5, 6, 0.1),
      k('Prudente ×', 'part de la vitesse normale', () => CFG.invader.gait.careful.speedMul, (v) => (CFG.invader.gait.careful.speedMul = v), 0.2, 0.9, 0.05),
      k('Course ×', '', () => CFG.invader.gait.run.speedMul, (v) => (CFG.invader.gait.run.speedMul = v), 1.1, 2.2, 0.05),
      k('Rayon prudent', 'tuiles de révélation des indices', () => CFG.invader.gait.careful.senseRadius, (v) => (CFG.invader.gait.careful.senseRadius = v), 1, 6, 0.25),
      k('Rayon normal', '', () => CFG.invader.gait.normal.senseRadius, (v) => (CFG.invader.gait.normal.senseRadius = v), 0, 3, 0.25),
    ],
  },
  {
    title: 'Scrutation et Influence',
    why: 'Si le Châtelain reste planté dans un seul mode, le coût est mal réglé.',
    knobs: [
      k('Coût Scrutation', 'Influence / s', () => CFG.castellan.scryDrain, (v) => (CFG.castellan.scryDrain = v), 1, 15, 0.5),
      k('Régénération', 'Influence / s hors du Cœur', () => CFG.castellan.influenceRegen, (v) => (CFG.castellan.influenceRegen = v), 0, 8, 0.5),
      k('Régénération au Cœur', '', () => CFG.castellan.influenceRegenHeart, (v) => (CFG.castellan.influenceRegenHeart = v), 2, 20, 0.5),
      k('Reprise en main', 's sans attaque à la sortie', () => CFG.castellan.scryRecover, (v) => (CFG.castellan.scryRecover = v), 0, 1.5, 0.05),
      k('Vitesse Châtelain', 'tuiles/s', () => CFG.castellan.baseSpeed, (v) => (CFG.castellan.baseSpeed = v), 1.5, 6, 0.1),
    ],
  },
  {
    title: 'Le Cœur',
    why: 'Les deux boucles convergent ici. C’est le réglage le plus structurant du jeu.',
    knobs: [
      k('Durée de capture', 's cumulées', () => CFG.heart.captureTime, (v) => (CFG.heart.captureTime = v), 5, 60, 1),
      k('Rayon de la salle', 'tuiles', () => CFG.heart.roomRadius, (v) => (CFG.heart.roomRadius = v), 1, 6, 0.2),
      k('Seuil de brèche', 'fraction', () => CFG.heart.breachAt, (v) => (CFG.heart.breachAt = v), 0.2, 0.9, 0.05),
      k('Alarme à', 's restantes', () => CFG.alarm.timeLeftTrigger, (v) => (CFG.alarm.timeLeftTrigger = v), 30, 150, 5),
    ],
  },
  {
    title: 'Combat',
    why: 'Le Châtelain doit perdre un duel loyal. Si ce n’est pas le cas, il n’a plus besoin de préparer.',
    knobs: [
      k('Épée', 'dégâts', () => CFG.combat.sword.damage, (v) => (CFG.combat.sword.damage = v), 5, 55, 1),
      k('Lame du Châtelain', 'dégâts', () => CFG.combat.castellanBlade.damage, (v) => (CFG.combat.castellanBlade.damage = v), 5, 55, 1),
      k('Récupération épée', 's', () => CFG.combat.sword.recovery, (v) => (CFG.combat.sword.recovery = v), 0.2, 1.5, 0.05),
      k('Récupération lame', 's', () => CFG.combat.castellanBlade.recovery, (v) => (CFG.combat.castellanBlade.recovery = v), 0.2, 1.5, 0.05),
      k('Recharge esquive', 's', () => CFG.combat.dodge.cooldown, (v) => (CFG.combat.dodge.cooldown = v), 0.5, 8, 0.25),
      k('Arbalète : recharge', 's', () => CFG.combat.crossbow.reload, (v) => (CFG.combat.crossbow.reload = v), 0.5, 6, 0.1),
    ],
  },
  {
    title: 'Chrono',
    why: 'Une manche décidée à mi-parcours doit se raccourcir, pas s’étirer.',
    knobs: [
      k('Durée de manche', 's', () => CFG.match.roundDuration, (v) => (CFG.match.roundDuration = v), 60, 360, 10),
      k('Brasero', 's gagnées', () => CFG.brazier.timeBonus, (v) => (CFG.brazier.timeBonus = v), 5, 60, 5),
      k('Préparation', 's', () => CFG.match.prepBuild, (v) => (CFG.match.prepBuild = v), 20, 150, 5),
    ],
  },
];

function k(
  label: string,
  hint: string,
  get: () => number,
  set: (v: number) => void,
  min: number,
  max: number,
  step: number,
): Knob {
  return { label, hint, get, set, min, max, step };
}

export function DebugPanel({ onClose, state }: { onClose: () => void; state: EngineState | null }) {
  const [, force] = useState(0);
  const redraw = () => force((n) => n + 1);

  return (
    <div className="absolute right-0 top-0 z-30 flex h-full w-[380px] flex-col border-l border-[var(--role-accent)]/30 bg-black/92 text-parchment">
      <header className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <h2 className="font-display text-lg">Réglages</h2>
        <button type="button" onClick={onClose} className="stone-button rounded-sm px-2 py-1 text-xs">
          Fermer (²)
        </button>
      </header>

      {state && (
        <div className="border-b border-white/10 px-3 py-2 font-code text-[11px] leading-relaxed opacity-70">
          <div>
            {state.side} · {state.role} · manche {state.round} · {state.phase}
          </div>
          <div>
            {state.transport} · {state.peer.connected ? 'connecté' : 'déconnecté'}
            {state.peer.latency !== null && ` · ${state.peer.latency} ms`}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {GROUPS.map((g) => (
          <section key={g.title} className="mb-4">
            <h3 className="text-[11px] uppercase tracking-widest text-[var(--role-accent)]">
              {g.title}
            </h3>
            <p className="mb-2 mt-0.5 text-[11px] leading-snug opacity-45">{g.why}</p>
            {g.knobs.map((knob) => (
              <label key={knob.label} className="mb-2 block">
                <span className="flex items-baseline justify-between text-[12px]">
                  <span>
                    {knob.label}
                    {knob.hint && <span className="ml-1 opacity-40">{knob.hint}</span>}
                  </span>
                  <span className="font-code tabular-nums">{knob.get().toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={knob.min}
                  max={knob.max}
                  step={knob.step}
                  value={knob.get()}
                  onChange={(e) => {
                    knob.set(Number(e.target.value));
                    redraw();
                  }}
                  className="mt-1 w-full accent-[var(--role-accent)]"
                />
              </label>
            ))}
          </section>
        ))}
      </div>

      <footer className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug opacity-50">
        Les valeurs s’appliquent immédiatement, y compris à la manche en cours. Elles ne sont pas
        sauvegardées : reportez ce qui vous convient dans <code>src/game/config.ts</code>.
      </footer>
    </div>
  );
}
