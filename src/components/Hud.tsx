'use client';

/**
 * HUD pendant l'invasion.
 *
 * §15 est explicite : PV, allure, outils et recharges, temps restant, Influence
 * pour le Châtelain. **Rien d'autre.** Chaque élément ajouté ici doit gagner sa
 * place contre cette liste.
 *
 * Il se rafraîchit à ~10 Hz, pas à 60 : la boucle de jeu vit hors de React.
 */

import { CFG } from '@/game/config';
import type { EngineState } from '@/net/engine';
import type { Snapshot } from '@/game/types';

function clock(s: number): string {
  const m = Math.floor(Math.max(0, s) / 60);
  const r = Math.floor(Math.max(0, s) % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

const GAIT_LABEL: Record<string, string> = {
  careful: 'Prudent',
  normal: 'Normal',
  run: 'Course',
};

export function Hud({ state, snap }: { state: EngineState; snap: Snapshot | null }) {
  if (!snap) return null;
  const invader = state.role === 'invader';
  const hp = Math.round(snap.self.hp);
  const lowHp = hp < CFG.feel.lowHpVignette;
  const urgent = snap.timeLeft <= CFG.audio.finalRush;

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Chrono — au centre haut, sous la jauge de capture. */}
      <div className="absolute left-1/2 top-3 -translate-x-1/2 text-center">
        <div
          className={`font-code text-3xl leading-none tabular-nums ${
            urgent ? 'text-danger' : 'text-parchment'
          } ${urgent ? 'ember-pulse' : ''}`}
        >
          {clock(snap.timeLeft)}
        </div>
        <div className="mt-1 text-[11px] uppercase tracking-widest opacity-55">
          Manche {state.round} · {state.score.host} – {state.score.guest}
        </div>
      </div>

      {/* Le réveil du château. */}
      {snap.alarm && (
        <div className="absolute left-1/2 top-20 -translate-x-1/2 rounded-sm border border-danger/60 bg-danger/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-danger">
          Le château est réveillé
        </div>
      )}

      {/* Vie et ressource — en bas à gauche, là où l'œil retombe. */}
      <div className="absolute bottom-5 left-5 w-64">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-widest opacity-60">Vie</span>
          <span
            className={`font-code text-xl leading-none tabular-nums ${lowHp ? 'text-danger' : ''}`}
          >
            {hp}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-sm bg-black/55">
          <div
            className={`h-full transition-[width] duration-200 ${lowHp ? 'bg-danger' : 'bg-[var(--role-accent)]'}`}
            style={{ width: `${hp}%` }}
          />
        </div>
        {snap.self.shieldHp > 0 && (
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-black/40">
            <div
              className="h-full bg-parchment/80"
              style={{ width: `${(snap.self.shieldHp / CFG.toolParams.buckler.absorb) * 100}%` }}
            />
          </div>
        )}

        {!invader && (
          <>
            <div className="mt-3 mb-1 flex items-baseline justify-between">
              <span className="text-[11px] uppercase tracking-widest opacity-60">Influence</span>
              <span className="font-code text-xl leading-none tabular-nums">
                {Math.round(snap.self.influence)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-sm bg-black/55">
              <div
                className="h-full bg-keep-ember"
                style={{ width: `${snap.self.influence}%` }}
              />
            </div>
            {snap.self.scrying && (
              <div className="mt-1.5 text-[11px] tracking-wide text-keep-ember ember-pulse">
                Scrutation — votre corps est immobile
              </div>
            )}
          </>
        )}
      </div>

      {/* Allure — le retour le plus important pour l'Envahisseur. */}
      {invader && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 text-center">
          <div className="flex items-end gap-1.5">
            {(['careful', 'normal', 'run'] as const).map((g) => {
              const active = snap.self.gait === g;
              return (
                <div
                  key={g}
                  className={`rounded-sm px-2.5 py-1 text-[11px] uppercase tracking-widest transition-colors ${
                    active
                      ? 'bg-[var(--role-accent)] font-semibold text-siege-bg'
                      : 'bg-black/45 opacity-45'
                  }`}
                >
                  {GAIT_LABEL[g]}
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 text-[10px] uppercase tracking-widest opacity-40">
            Maj prudent · Espace course
          </div>
        </div>
      )}

      {/* L'arbalète : la seule recharge que les deux camps surveillent. */}
      <div className="absolute bottom-[104px] right-5 text-right text-[11px] uppercase tracking-widest">
        {snap.self.crossbowCooldown > 0.05 ? (
          <span className="opacity-40">
            Arbalète · {snap.self.crossbowCooldown.toFixed(1)} s
          </span>
        ) : (
          <span className="text-[var(--role-accent)]">Arbalète prête — clic droit</span>
        )}
      </div>

      {/* Outils et recharges. */}
      {invader && state.loadout.tools.length > 0 && (
        <div className="absolute bottom-5 right-5 flex gap-2">
          {state.loadout.tools.map((t, i) => {
            const uses = snap.self.toolUses[i] ?? 0;
            const cd = snap.self.toolCooldowns[i] ?? 0;
            const spent = uses === 0;
            return (
              <div
                key={t}
                className={`relative w-[92px] overflow-hidden rounded-sm border px-2 py-1.5 text-[11px] ${
                  spent
                    ? 'border-white/10 bg-black/40 opacity-35'
                    : 'border-[var(--role-accent)]/45 bg-black/55'
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-code opacity-60">{i + 1}</span>
                  {uses >= 0 && <span className="font-code tabular-nums">{uses}</span>}
                </div>
                <div className="mt-0.5 truncate">{CFG.tools[t].label}</div>
                {cd > 0.05 && (
                  <div
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--role-accent)]"
                    style={{ width: `${100 - (cd / CFG.combat.crossbow.reload) * 100}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Esquive : la seule recharge que l'Envahisseur consulte en duel. */}
      {invader && (
        <div className="absolute bottom-[104px] left-5 text-[11px] uppercase tracking-widest">
          {snap.self.dodgeReadyAt > snap.now ? (
            <span className="opacity-35">
              Esquive · {(snap.self.dodgeReadyAt - snap.now).toFixed(1)} s
            </span>
          ) : (
            <span className="text-[var(--role-accent)]">Esquive prête — F</span>
          )}
        </div>
      )}

      {/* Mécanismes du Châtelain : lisibles seulement en Scrutation. */}
      {!invader && snap.devices && snap.devices.length > 0 && (
        <div className="absolute bottom-5 right-5 w-56 space-y-1">
          <div className="mb-1 text-[10px] uppercase tracking-widest opacity-45">
            Mécanismes {snap.self.scrying ? '— cliquez pour déclencher' : '— Scrutation requise'}
          </div>
          {snap.devices.map((d) => {
            const cost = CFG.devices[d.kind].influence;
            const usable = snap.self.scrying && d.ready;
            return (
              <div
                key={d.id}
                className={`flex items-center justify-between rounded-sm border px-2 py-1 text-[11px] ${
                  usable
                    ? 'border-keep-ember/50 bg-black/55'
                    : 'border-white/10 bg-black/35 opacity-40'
                }`}
              >
                <span>{CFG.devices[d.kind].label}</span>
                <span className="font-code tabular-nums opacity-70">{cost}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Le guet a sonné : le Châtelain sait où l'ennemi est passé. */}
      {!invader && snap.ping && (
        <div className="slide-up absolute left-1/2 top-24 -translate-x-1/2 rounded-sm border border-danger/60 bg-black/75 px-3 py-1.5 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-danger">
            Un guet a sonné
          </div>
          <div className="mt-0.5 text-[11px] opacity-70">
            Passage repéré {snap.ping.age < 1.5 ? 'à l’instant' : `il y a ${Math.round(snap.ping.age)} s`} —
            le point rouge sur votre plan
          </div>
        </div>
      )}

      {/* Rejeu du piège : la récompense du Châtelain, où qu'il soit (§11). */}
      {state.replay && (
        <div className="slide-up absolute right-5 top-5 w-56 rounded-sm border border-keep-ember/50 bg-black/70 px-3 py-2">
          <div className="text-[10px] uppercase tracking-widest text-keep-ember">
            Piège déclenché
          </div>
          <div className="mt-0.5 text-sm">{CFG.traps[state.replay.trap].label}</div>
          <div className="mt-0.5 font-code text-[11px] opacity-55">
            {Math.floor(state.replay.x)}, {Math.floor(state.replay.y)}
          </div>
        </div>
      )}

      {/* Le Cœur, quand on ne l'a pas encore trouvé : la distance seule. */}
      {invader && !snap.heart && (
        <div className="absolute right-5 top-5 text-right text-[11px] uppercase tracking-widest opacity-50">
          {snap.heartDist >= CFG.heart.heartbeatRadius
            ? 'Vous n’entendez pas le Cœur'
            : `Le Cœur bat à ${Math.round(snap.heartDist)} pas`}
        </div>
      )}
    </div>
  );
}
