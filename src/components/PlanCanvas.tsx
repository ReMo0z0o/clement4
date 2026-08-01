'use client';

/**
 * Plan interactif de la préparation.
 *
 * Volontairement schématique, et pas un aperçu du jeu : ici on lit une
 * topologie et on prend des décisions d'urbanisme, on ne cherche pas
 * l'ambiance. Ce qui compte est de voir d'un coup d'œil où passent les
 * itinéraires et où l'on a déjà dépensé.
 */

import { useEffect, useRef, useState } from 'react';
import { CFG, GRID_H, GRID_W } from '@/game/config';
import { getPlan } from '@/game/plans';
import { canPlaceDevice, canPlaceTrap } from '@/game/prep';
import type { BuildOrder, DeviceKind, PlanId, TellKind, TrapKind } from '@/game/types';
import { T } from '@/game/types';
import { drawTell } from '@/render/tells';

export type Brush =
  | { kind: 'trap'; trap: TrapKind; tell: TellKind }
  | { kind: 'device'; device: DeviceKind }
  | { kind: 'heart' }
  | { kind: 'door' }
  | { kind: 'secret' }
  | { kind: 'erase' };

const CELL = 26;

export function PlanCanvas({
  planId,
  build,
  brush,
  burned,
  heat,
  onPlace,
  onErase,
  onHeart,
  onDoor,
  onSecret,
  readOnly = false,
}: {
  planId: PlanId;
  build: BuildOrder;
  brush: Brush;
  burned: number[];
  heat: { x: number; y: number; t: number }[];
  onPlace: (x: number, y: number) => void;
  onErase: (x: number, y: number) => void;
  onHeart: (i: number) => void;
  onDoor: (i: number) => void;
  onSecret: (i: number) => void;
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const plan = getPlan(planId);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = GRID_W * CELL * dpr;
    canvas.height = GRID_H * CELL * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#14100c';
    ctx.fillRect(0, 0, GRID_W * CELL, GRID_H * CELL);

    /* --- La pierre --- */
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = plan.tiles[y * GRID_W + x];
        const px = x * CELL;
        const py = y * CELL;
        if (t === T.WALL) {
          ctx.fillStyle = '#241d16';
          ctx.fillRect(px, py, CELL, CELL);
          ctx.fillStyle = '#3a3128';
          ctx.fillRect(px, py, CELL, CELL - 3);
        } else if (t === T.FRAGILE) {
          ctx.fillStyle = '#2f2519';
          ctx.fillRect(px, py, CELL, CELL);
          ctx.strokeStyle = 'rgba(232,161,60,0.35)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 2.5, py + 2.5, CELL - 5, CELL - 5);
        } else if (t === T.SECRET) {
          ctx.fillStyle = '#241d16';
          ctx.fillRect(px, py, CELL, CELL);
        } else if (t === T.LOW) {
          ctx.fillStyle = '#3a3128';
          ctx.fillRect(px, py, CELL, CELL);
          ctx.fillStyle = '#241d16';
          ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
        } else {
          ctx.fillStyle = (x + y) % 2 === 0 ? '#463b2e' : '#4d4133';
          ctx.fillRect(px, py, CELL, CELL);
          ctx.strokeStyle = 'rgba(0,0,0,0.15)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
        }
      }
    }

    /* --- Carte de chaleur du trajet adverse (manches 3 et 4) --- */
    if (heat.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Deux passes : un halo large, puis le tracé — il doit se lire par-dessus
      // la pierre sans masquer les murs.
      for (const pass of [0, 1]) {
        ctx.beginPath();
        ctx.moveTo(heat[0].x * CELL, heat[0].y * CELL);
        for (const p of heat) ctx.lineTo(p.x * CELL, p.y * CELL);
        ctx.strokeStyle = pass === 0 ? 'rgba(216,56,79,0.18)' : 'rgba(240,120,90,0.75)';
        ctx.lineWidth = pass === 0 ? 13 : 2.4;
        ctx.stroke();
      }
      ctx.restore();
    }

    /* --- Torches, braseros, apparitions --- */
    for (const tp of plan.torches) {
      ctx.fillStyle = 'rgba(255,190,110,0.75)';
      ctx.beginPath();
      ctx.arc(tp.x * CELL, tp.y * CELL, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const b of plan.brazierSpots) {
      ctx.strokeStyle = '#f0c469';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(b.x * CELL, b.y * CELL, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(240,196,105,0.2)';
      ctx.fill();
    }
    marker(ctx, plan.invaderSpawn.x * CELL, plan.invaderSpawn.y * CELL, '#7fd4e8', 'E');
    marker(ctx, plan.castellanSpawn.x * CELL, plan.castellanSpawn.y * CELL, '#e8a13c', 'C');

    /* --- Candidats du Cœur --- */
    plan.heartCandidates.forEach((h, i) => {
      const chosen = i === build.heartIndex;
      ctx.save();
      ctx.strokeStyle = chosen ? '#f0c469' : 'rgba(240,196,105,0.35)';
      ctx.lineWidth = chosen ? 2.4 : 1.4;
      const s = chosen ? 11 : 8;
      ctx.beginPath();
      ctx.moveTo(h.x * CELL, h.y * CELL - s);
      ctx.lineTo(h.x * CELL + s, h.y * CELL);
      ctx.lineTo(h.x * CELL, h.y * CELL + s);
      ctx.lineTo(h.x * CELL - s, h.y * CELL);
      ctx.closePath();
      if (chosen) {
        ctx.fillStyle = 'rgba(240,196,105,0.45)';
        ctx.fill();
      }
      ctx.stroke();
      ctx.restore();
    });

    /* --- Portes verrouillables et passages secrets --- */
    plan.doors.forEach((d, i) => {
      const locked = build.lockedDoors.includes(i);
      ctx.strokeStyle = locked ? '#e8a13c' : 'rgba(232,161,60,0.28)';
      ctx.lineWidth = locked ? 2.4 : 1.2;
      ctx.strokeRect(d.x * CELL - CELL / 2 + 2, d.y * CELL - CELL / 2 + 2, CELL - 4, CELL - 4);
      if (locked) {
        ctx.fillStyle = 'rgba(232,161,60,0.22)';
        ctx.fillRect(d.x * CELL - CELL / 2 + 2, d.y * CELL - CELL / 2 + 2, CELL - 4, CELL - 4);
      }
    });
    plan.secretSpots.forEach((s, i) => {
      const open = build.secretDoors.includes(i);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = open ? '#9fd8e8' : 'rgba(159,216,232,0.3)';
      ctx.lineWidth = open ? 2.2 : 1.2;
      ctx.strokeRect(s.x * CELL - CELL / 2 + 3, s.y * CELL - CELL / 2 + 3, CELL - 6, CELL - 6);
      ctx.restore();
    });

    /* --- Ce qui est posé --- */
    for (const t of build.traps) {
      const px = t.x * CELL;
      const py = t.y * CELL;
      const isBurned = burned.includes(t.id);
      ctx.save();
      ctx.globalAlpha = 1;
      // L'anneau dit le type ; le trait pointillé dit « grillé ».
      ctx.fillStyle = t.kind === 'decoy' ? 'rgba(180,180,190,0.16)' : 'rgba(224,80,60,0.2)';
      ctx.beginPath();
      ctx.arc(px, py, CELL * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = t.kind === 'decoy' ? 'rgba(200,200,210,0.65)' : '#e0503c';
      ctx.lineWidth = 1.6;
      if (t.kind === 'decoy') ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(px, py, CELL * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (isBurned) {
        ctx.strokeStyle = '#f0c469';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(px, py, CELL * 0.58, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
      drawTell(ctx, t.tell, px, py, t.facing, 0.9, '#e8ddc8');
    }
    for (const d of build.devices) {
      const px = d.x * CELL;
      const py = d.y * CELL;
      ctx.save();
      ctx.fillStyle = 'rgba(232,161,60,0.18)';
      ctx.strokeStyle = '#e8a13c';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.rect(px - CELL * 0.36, py - CELL * 0.36, CELL * 0.72, CELL * 0.72);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e8ddc8';
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(CFG.devices[d.kind].label.slice(0, 2).toUpperCase(), px, py);
      ctx.restore();
    }

    /* --- Survol --- */
    if (hover && !readOnly) {
      const px = hover.x * CELL;
      const py = hover.y * CELL;
      ctx.save();
      ctx.strokeStyle = problem ? '#e0503c' : '#7fd4e8';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, CELL - 2, CELL - 2);
      ctx.fillStyle = problem ? 'rgba(224,80,60,0.16)' : 'rgba(127,212,232,0.14)';
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      ctx.restore();
    }
  }, [planId, build, brush, burned, heat, hover, problem, readOnly]);

  const cellFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = (e.clientX - rect.left) / rect.width;
    const sy = (e.clientY - rect.top) / rect.height;
    return { x: Math.floor(sx * GRID_W), y: Math.floor(sy * GRID_H) };
  };

  const evaluate = (x: number, y: number): string | null => {
    const plan = getPlan(planId);
    if (brush.kind === 'trap') return canPlaceTrap(plan, brush.trap, x, y, build.traps, build.devices);
    if (brush.kind === 'device')
      return canPlaceDevice(plan, brush.device, x, y, build.traps, build.devices);
    return null;
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly) return;
    const c = cellFromEvent(e);
    if (hover?.x === c.x && hover?.y === c.y) return;
    setHover(c);
    setProblem(evaluate(c.x, c.y));
  };

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly) return;
    const { x, y } = cellFromEvent(e);
    const plan = getPlan(planId);

    if (e.button === 2 || brush.kind === 'erase') {
      onErase(x, y);
      return;
    }
    if (brush.kind === 'heart') {
      const i = plan.heartCandidates.findIndex(
        (h) => Math.floor(h.x) === x && Math.floor(h.y) === y,
      );
      if (i >= 0) onHeart(i);
      return;
    }
    if (brush.kind === 'door') {
      const i = plan.doors.findIndex((d) => Math.floor(d.x) === x && Math.floor(d.y) === y);
      if (i >= 0) onDoor(i);
      return;
    }
    if (brush.kind === 'secret') {
      const i = plan.secretSpots.findIndex((s) => Math.floor(s.x) === x && Math.floor(s.y) === y);
      if (i >= 0) onSecret(i);
      return;
    }
    onPlace(x, y);
  };

  return (
    <div className="relative">
      <canvas
        ref={ref}
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
        onPointerDown={handleDown}
        onContextMenu={(e) => e.preventDefault()}
        className="w-full max-w-[640px] rounded-sm border border-[var(--role-accent)]/25"
        style={{ aspectRatio: '1 / 1', touchAction: 'none' }}
      />
      {problem && hover && !readOnly && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-sm bg-black/85 px-2 py-1 text-[11px] text-danger">
          {problem}
        </div>
      )}
    </div>
  );
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, letter: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, x, y + 0.5);
  ctx.restore();
}
