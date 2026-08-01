'use client';

/**
 * Surface de jeu.
 *
 * Le canvas et la boucle de rendu vivent ici, mais **hors du cycle de rendu de
 * React** : aucun `setState` par frame, aucune entité dans le DOM (§18). React
 * ne s'occupe que du HUD, rafraîchi à basse fréquence par le moteur.
 */

import { useEffect, useRef } from 'react';
import { TILE } from '@/game/config';
import type { Engine } from '@/net/engine';
import type { EngineState } from '@/net/engine';
import type { GameEvent, Role } from '@/game/types';
import { Renderer } from '@/render/renderer';
import { Controls } from '@/render/controls';
import type { AudioEngine } from '@/audio/engine';

export function GameView({
  engine,
  state,
  audio,
}: {
  engine: Engine;
  state: EngineState;
  audio: AudioEngine | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roleRef = useRef<Role>(state.role);
  roleRef.current = state.role;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new Renderer(canvas);
    const controls = new Controls(canvas);
    let raf = 0;
    let last = performance.now();
    let disposed = false;

    const onResize = () => renderer.resize();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    const offEvents = engine.onEvents((events: GameEvent[]) => {
      const view = engine.view;
      renderer.onEvents(events, view ? view.render : { x: 0, y: 0 });
      if (audio) {
        for (const e of events) {
          try {
            audio.play(e);
          } catch {
            // Un son raté ne casse jamais une frame de jeu.
          }
        }
      }
    });

    const frame = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const view = engine.view;
      if (!view) return;
      const role = roleRef.current;

      /* --- Visée : du personnage vers le curseur, en coordonnées monde --- */
      const p = controls.pointer();
      const world = renderer.camera.toWorld(p);
      const aim = Math.atan2(world.y - view.render.y * TILE, world.x - view.render.x * TILE);

      const f = controls.frame(role, aim, 0, now / 1000);
      engine.setInput({
        move: f.move,
        aim: f.aim,
        gait: f.gait,
        primary: f.primary,
        interact: f.interact,
        scry: f.scry,
      });
      if (f.secondary) engine.pulse({ secondary: true });
      if (f.dodge) engine.pulse({ dodge: true });
      if (f.tool >= 0) engine.pulse({ tool: f.tool });
      if (f.device >= 0) engine.pulse({ device: f.device });
      if (f.rearm >= 0) engine.pulse({ rearm: f.rearm });

      if (audio) {
        audio.setListener(view.render, role);
        const snap = view.snap;
        if (snap) {
          audio.setHeartbeat(snap.heartDist, snap.timeLeft, snap.alarm);
          audio.setAmbience(role, snap.alarm);
        }
      }

      renderer.draw(
        { view, role, phase: state.phase, alarm: Boolean(view.snap?.alarm), countdown: null },
        dt,
      );
    };
    raf = requestAnimationFrame(frame);

    /* --- Le Châtelain déclenche ses mécanismes au clic, en Scrutation --- */
    const onClick = (ev: PointerEvent) => {
      if (roleRef.current !== 'castellan') return;
      const snap = engine.view?.snap;
      if (!snap?.self.scrying || !snap.devices) return;
      const rect = canvas.getBoundingClientRect();
      const world = renderer.camera.toWorld({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      const wx = world.x / TILE;
      const wy = world.y / TILE;
      let best = -1;
      let bestD = 1.6;
      for (const d of snap.devices) {
        if (!d.ready) continue;
        const dd = Math.hypot(d.x - wx, d.y - wy);
        if (dd < bestD) {
          bestD = dd;
          best = d.id;
        }
      }
      if (best >= 0) controls.triggerDevice(best);
      else if (snap.ownTraps) {
        // À défaut d'un mécanisme, on tente de réarmer le piège visé.
        for (const t of snap.ownTraps) {
          if (t.state !== 'spent') continue;
          if (Math.hypot(t.x - wx, t.y - wy) < 1.2) {
            controls.triggerRearm(t.id);
            break;
          }
        }
      }
    };
    canvas.addEventListener('pointerdown', onClick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onClick);
      ro.disconnect();
      offEvents();
      controls.dispose();
    };
    // Le moteur et le canvas ne changent pas d'identité sur la durée d'un match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, audio]);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      aria-label="Château"
      className="h-full w-full outline-none"
    />
  );
}
