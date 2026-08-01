/**
 * Dessin des indices.
 *
 * **Un vrai piège et un faux indice passent par cette fonction et par aucune
 * autre.** Rien ici ne reçoit l'information « vrai / faux » : elle n'existe pas
 * dans la charge utile réseau, et elle n'existe pas non plus dans le rendu.
 * C'est la seule façon de garantir que la lecture d'un couloir reste une
 * question d'attention et pas de pixel-peeping (§4, §15).
 *
 * La variation d'aspect est dérivée des seules coordonnées de la tuile : deux
 * indices voisins ne sont donc pas pixel-identiques — ce qui aurait l'air
 * mécanique — mais la variation ne corrèle avec rien de jouable.
 */

import { TILE } from '@/game/config';
import type { TellKind } from '@/game/types';

/** Bruit déterministe, stable d'une frame à l'autre. */
function hash(x: number, y: number, n = 0): number {
  let h = Math.imul(Math.floor(x) * 374761393 + Math.floor(y) * 668265263 + n * 2246822519, 1);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
}

/**
 * @param cx,cy centre de la tuile, en pixels monde
 * @param alpha fondu d'entrée / sortie du rayon de perception
 * @param tint  couleur de l'indice, dépendante du rôle
 */
export function drawTell(
  ctx: CanvasRenderingContext2D,
  kind: TellKind,
  cx: number,
  cy: number,
  facing: number,
  alpha: number,
  tint: string,
): void {
  if (alpha <= 0.01) return;
  const r = hash(cx, cy);
  const r2 = hash(cx, cy, 7);
  const r3 = hash(cx, cy, 19);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (kind) {
    /* --- Dalles jointoyées trop nettement (fosse à pics) --- */
    case 'seam': {
      ctx.rotate(r < 0.5 ? 0 : Math.PI / 2);
      const w = TILE * 0.74;
      ctx.strokeStyle = tint;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      ctx.stroke();
      // Le joint est trop propre : les petites amorces trahissent la trappe.
      ctx.globalAlpha = alpha * 0.75;
      ctx.lineWidth = 0.9;
      for (let i = 0; i < 4; i++) {
        const t = -w / 2 + (w * (i + 0.5)) / 4;
        const len = TILE * (0.1 + hash(cx, cy, i) * 0.05);
        ctx.beginPath();
        ctx.moveTo(t, -len);
        ctx.lineTo(t, len);
        ctx.stroke();
      }
      // Une ombre fine sous le joint : la dalle ne repose pas à plat.
      ctx.globalAlpha = alpha * 0.35;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-w / 2, 1.6);
      ctx.lineTo(w / 2, 1.6);
      ctx.stroke();
      break;
    }

    /* --- Trous d'archère dans le mur (flèches murales) --- */
    case 'slit': {
      ctx.rotate(facing || (r < 0.5 ? 0 : Math.PI));
      const off = TILE * 0.34;
      for (let i = -1; i <= 1; i++) {
        const h = TILE * (0.16 + hash(cx, cy, i + 3) * 0.05);
        ctx.globalAlpha = alpha * (0.85 - Math.abs(i) * 0.12);
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillRect(-off - 1, i * TILE * 0.22 - h / 2, 2.4, h);
        ctx.strokeStyle = tint;
        ctx.lineWidth = 0.7;
        ctx.strokeRect(-off - 1, i * TILE * 0.22 - h / 2, 2.4, h);
      }
      break;
    }

    /* --- Fissures rayonnantes (sol effondrable) --- */
    case 'crack': {
      ctx.strokeStyle = tint;
      ctx.globalAlpha = alpha * 0.9;
      const arms = 4 + Math.floor(r * 2);
      for (let i = 0; i < arms; i++) {
        const a = (i / arms) * Math.PI * 2 + r2 * 2;
        ctx.lineWidth = 1.1 - (i % 2) * 0.35;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        let px = 0;
        let py = 0;
        const steps = 3;
        for (let s = 1; s <= steps; s++) {
          const len = (TILE * 0.4 * s) / steps;
          const wobble = (hash(cx, cy, i * 5 + s) - 0.5) * 0.55;
          px = Math.cos(a + wobble) * len;
          py = Math.sin(a + wobble) * len;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    /* --- Poussière au sol, ombre au plafond (rocher tombant) --- */
    case 'dust': {
      // L'ombre : ce qui pend au-dessus ne se voit qu'à ce halo sombre.
      const g = ctx.createRadialGradient(0, 0, 1, 0, 0, TILE * 0.62);
      g.addColorStop(0, `rgba(0,0,0,${0.34 * alpha})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, TILE * 0.62, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = alpha * 0.85;
      ctx.fillStyle = tint;
      for (let i = 0; i < 11; i++) {
        const a = hash(cx, cy, i) * Math.PI * 2;
        const d = TILE * (0.08 + hash(cx, cy, i + 40) * 0.34);
        const s = 0.5 + hash(cx, cy, i + 80) * 0.85;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * d, Math.sin(a) * d, s, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    /* --- Serrure sans usure (coffre piégé) : l'appât se voit de loin --- */
    case 'chest': {
      const w = TILE * 0.52;
      const h = TILE * 0.38;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-w / 2 + 1.5, -h / 2 + 2.5, w, h);
      ctx.fillStyle = `rgba(96,70,42,${0.95 * alpha})`;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = tint;
      ctx.lineWidth = 1;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      // Les ferrures.
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 6);
      ctx.lineTo(w / 2, -h / 6);
      ctx.stroke();
      // La serrure, trop neuve pour un coffre resté là si longtemps.
      ctx.fillStyle = tint;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(0, h * 0.08, 1.9 + r3 * 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }

  ctx.restore();
}

/**
 * Halo discret sous un indice qui vient d'entrer dans le rayon de perception.
 * Il attire l'œil sans désigner : c'est un « il y a quelque chose ici », pas un
 * « c'est un piège ».
 */
export function drawTellGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  alpha: number,
  tint: string,
): void {
  if (alpha <= 0.01) return;
  const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, TILE * 0.8);
  g.addColorStop(0, withAlpha(tint, 0.16 * alpha));
  g.addColorStop(1, withAlpha(tint, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, TILE * 0.8, 0, Math.PI * 2);
  ctx.fill();
}

export function withAlpha(color: string, a: number): string {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }
  return color;
}
