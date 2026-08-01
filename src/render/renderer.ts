/**
 * Rendu Canvas 2D.
 *
 * Aucune entité n'existe dans le DOM (§18) : tout est peint ici, hors de React,
 * à chaque frame. React ne rend que le HUD, à basse fréquence.
 *
 * Le pipeline suit la direction artistique : on peint le château à pleine
 * lumière, puis on lui retire la lumière qu'il n'a pas. Le brouillard n'est
 * donc jamais un carré noir — c'est une chute de luminosité, calculée par
 * tuile et étalée en douceur.
 */

import { CFG, GRID_H, GRID_W, TILE, WORLD_H, WORLD_W } from '@/game/config';
import { idx } from '@/game/grid';
import type { ClientView } from '@/net/clientView';
import type { GameEvent, Role, Snapshot, TellKind, Vec } from '@/game/types';
import { T, angleDelta, clamp } from '@/game/types';
import { Camera } from './camera';
import { drawTell, drawTellGlow, withAlpha } from './tells';

// Un pixel de masque pour un quart de tuile : assez fin pour que la chute de
// luminosité soit une pente et pas un escalier, assez grossier pour rester
// gratuit (96×96 pixels recalculés par frame).
const MASK_SCALE = 4;

interface Palette {
  bg: string;
  floor: string;
  floorAlt: string;
  wallTop: string;
  wallFace: string;
  wallEdge: string;
  accent: string;
  accentDim: string;
  tell: string;
  self: string;
  other: string;
  lightTint: [number, number, number];
  memory: number;
  /** Teinte de ce qui n'a jamais été vu : présente, mais sans aucune forme. */
  unseen: string;
}

const KEEP: Palette = {
  bg: '#14100c',
  floor: '#332a20',
  floorAlt: '#3c3227',
  wallTop: '#8d7659',
  wallFace: '#1a140e',
  wallEdge: '#967f63',
  accent: '#e8a13c',
  accentDim: '#a56d24',
  tell: '#e2c187',
  self: '#e8a13c',
  other: '#9fd8e8',
  lightTint: [255, 186, 104],
  // Le Châtelain voit son château en permanence : palette chaude et large.
  memory: 0.55,
  unseen: '#2a2118',
};

const SIEGE: Palette = {
  bg: '#0a0d12',
  floor: '#1e2632',
  floorAlt: '#26303d',
  wallTop: '#64738a',
  wallFace: '#0e131a',
  wallEdge: '#6f7d92',
  accent: '#7fd4e8',
  accentDim: '#4a8a9c',
  tell: '#cfe4ec',
  self: '#7fd4e8',
  other: '#e8a13c',
  lightTint: [255, 170, 96],
  // L'Envahisseur ne garde qu'un souvenir sombre : palette froide et resserrée.
  memory: 0.2,
  unseen: '#1a2029',
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  gravity: number;
}

export interface RenderInput {
  view: ClientView;
  role: Role;
  phase: string;
  alarm: boolean;
  countdown: number | null;
}

export class Renderer {
  readonly camera = new Camera();
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private mask: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  private glow: HTMLCanvasElement;
  private glowCtx: CanvasRenderingContext2D;
  private vis = new Float32Array(GRID_W * GRID_H);
  private particles: Particle[] = [];
  private flash = 0;
  private alarmFlash = 0;
  private dpr = 1;
  private time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D indisponible');
    this.ctx = ctx;

    this.mask = document.createElement('canvas');
    this.mask.width = GRID_W * MASK_SCALE;
    this.mask.height = GRID_H * MASK_SCALE;
    this.maskCtx = this.mask.getContext('2d')!;

    this.glow = document.createElement('canvas');
    this.glow.width = GRID_W * MASK_SCALE;
    this.glow.height = GRID_H * MASK_SCALE;
    this.glowCtx = this.glow.getContext('2d')!;

    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(240, Math.floor(rect.height));
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.camera.setViewport(w, h);
  }

  /* ================================================================== */
  /* Retour immédiat sur événement                                      */
  /* ================================================================== */

  onEvents(events: GameEvent[], self: Vec): void {
    for (const e of events) {
      switch (e.k) {
        case 'hit': {
          this.camera.kick(e.dmg * CFG.feel.shakePerDamage);
          this.flash = Math.max(this.flash, CFG.feel.hitFlash);
          this.burst(e.x, e.y, 14, '#e0503c', 90);
          break;
        }
        case 'trap': {
          this.camera.kick(4);
          this.burst(e.x, e.y, 22, '#d8a05a', 130);
          break;
        }
        case 'blast': {
          this.camera.kick(9);
          this.flash = Math.max(this.flash, 0.24);
          this.burst(e.x, e.y, 34, '#f0c469', 190);
          break;
        }
        case 'alarm': {
          this.alarmFlash = CFG.alarm.flash;
          this.camera.kick(6);
          break;
        }
        case 'brazier':
          this.burst(e.x, e.y, 26, '#f0c469', 70);
          break;
        case 'breach':
          this.camera.kick(7);
          this.burst(e.x, e.y, 30, '#d8384f', 110);
          break;
        case 'parry':
          this.burst(e.x, e.y, e.perfect ? 20 : 8, e.perfect ? '#f0c469' : '#cfe4ec', 120);
          this.camera.kick(e.perfect ? 5 : 2);
          break;
        case 'death':
          this.camera.kick(10);
          this.burst(e.x, e.y, 40, '#d8384f', 120);
          break;
        default:
          break;
      }
    }
    void self;
  }

  private burst(x: number, y: number, n: number, color: string, speed: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.35 + Math.random() * 0.65) * speed;
      this.particles.push({
        x: x * TILE,
        y: y * TILE,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0.3 + Math.random() * 0.45,
        max: 0.75,
        size: 0.8 + Math.random() * 1.8,
        color,
        gravity: 120,
      });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  /* ================================================================== */
  /* Dessin                                                             */
  /* ================================================================== */

  draw(input: RenderInput, dt: number): void {
    const { view, role } = input;
    const snap = view.snap;
    const pal = role === 'castellan' ? KEEP : SIEGE;
    const ctx = this.ctx;
    this.time += dt;

    const scrying = Boolean(snap?.self.scrying);
    const self = view.render;

    this.camera.follow(self, view.aim, view.gait, scrying, dt);
    this.updateParticles(dt);
    this.flash = Math.max(0, this.flash - dt * 4);
    this.alarmFlash = Math.max(0, this.alarmFlash - dt);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, this.camera.viewW, this.camera.viewH);

    ctx.save();
    // Monde → écran, en une seule passe : densité de pixels, centrage, zoom.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.camera.viewW / 2, this.camera.viewH / 2);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(-this.camera.x, -this.camera.y);

    this.computeVisibility(view, role, scrying);

    this.drawFloor(view, pal);
    this.drawScars(snap, pal);
    this.drawHeart(snap, pal);
    this.drawBraziers(snap, pal);
    this.drawTells(view, pal);
    this.drawWalls(view, pal);
    this.drawEntities(view, pal);
    this.drawActors(view, pal, role, scrying);
    this.drawParticles();
    this.compositeLight(view, pal, scrying);

    ctx.restore();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.drawCaptureGauge(snap, role);
    this.drawScreenEffects(snap, pal, scrying, input.alarm);
  }

  /* ---------------- Visibilité ---------------- */

  private computeVisibility(view: ClientView, role: Role, scrying: boolean): void {
    const snap = view.snap;
    const self = view.render;
    const range = role === 'invader' ? CFG.vision.invaderRange : CFG.vision.castellanRange;
    const pal = role === 'castellan' ? KEEP : SIEGE;
    const aim = view.aim;

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = idx(x, y);
        const known = role === 'castellan' || view.known.has(i);
        if (!known) {
          this.vis[i] = 0;
          continue;
        }
        if (scrying) {
          // En Scrutation, la vue s'élève : le château entier est lisible.
          this.vis[i] = 1;
          continue;
        }
        const cx = x + 0.5;
        const cy = y + 0.5;
        const d = Math.hypot(cx - self.x, cy - self.y);
        let v = pal.memory;
        if (d <= range && view.castle.losClear(self, { x: cx, y: cy })) {
          const ang = Math.atan2(cy - self.y, cx - self.x);
          const off = angleDelta(ang, aim);
          // Hors du cône, on perçoit encore de tout près : on n'est pas aveugle
          // dans son dos, on y voit juste moins loin.
          const inCone = off <= CFG.vision.coneHalfAngle || d <= CFG.vision.coneFalloffRange;
          if (inCone) {
            const edge = 1 - clamp((d - range * 0.72) / (range * 0.28), 0, 1);
            v = Math.max(v, 0.35 + 0.65 * edge);
          }
        }
        this.vis[i] = v;
      }
    }
    void snap;
  }

  /**
   * Luminosité d'une tuile à l'écran.
   *
   * Attention : ceci ne décide de rien dans le jeu. La règle « en allure
   * normale, un indice ne se lit que dans la lumière » est appliquée par la
   * simulation à partir des vraies sources (torches, braseros), pas d'ici.
   * On peut donc éclaircir l'image pour qu'elle soit lisible sans toucher à
   * l'équilibre — et c'est ce que fait le halo personnel ci-dessous : il est
   * gris et froid, quand la vraie lumière est chaude. Les deux ne se
   * confondent pas à l'œil.
   */
  private brightness(i: number, light: Float32Array, personal: number): number {
    const v = this.vis[i];
    if (v <= 0) return 0;
    const l = Math.min(1, light[i] + personal);
    if (v > 0.5) return clamp(0.5 + 0.5 * l, 0, 1) * v;
    return v * (0.55 + 0.45 * l);
  }

  /* ---------------- Sol et murs ---------------- */

  private drawFloor(view: ClientView, pal: Palette): void {
    const ctx = this.ctx;
    // Une teinte de fond uniforme sous tout le château. Ce qui n'a jamais été
    // exploré n'en laisse passer qu'un souffle : assez pour que l'écran reste
    // un château dans le noir, pas un trou. Elle est parfaitement plate, donc
    // elle ne révèle aucun mur — le tracé se paie (§8, Plan volé).
    ctx.fillStyle = pal.unseen;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    const b = this.camera.tileBounds();
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = idx(x, y);
        if (this.vis[i] <= 0) continue;
        const t = view.castle.tiles[i];
        if (t === T.WALL || t === T.FRAGILE || t === T.SECRET) continue;

        const px = x * TILE;
        const py = y * TILE;
        if (t === T.PIT) {
          // Un trou : du noir franc, un liseré, on ne le confond avec rien.
          ctx.fillStyle = '#05070a';
          ctx.fillRect(px, py, TILE, TILE);
          ctx.strokeStyle = withAlpha(pal.wallEdge, 0.5);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(px + 0.75, py + 0.75, TILE - 1.5, TILE - 1.5);
          continue;
        }
        if (t === T.RUBBLE) {
          ctx.fillStyle = pal.wallFace;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = withAlpha(pal.wallTop, 0.55);
          for (let k = 0; k < 5; k++) {
            const h = hash2(x, y, k);
            ctx.beginPath();
            ctx.arc(px + 4 + h * 24, py + 5 + hash2(x, y, k + 9) * 22, 2 + h * 3, 0, Math.PI * 2);
            ctx.fill();
          }
          continue;
        }

        const alt = (x + y) % 2 === 0;
        ctx.fillStyle = alt ? pal.floor : pal.floorAlt;
        ctx.fillRect(px, py, TILE, TILE);

        // Joints de dalle : discrets, mais ils donnent l'échelle.
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);

        if (t === T.DOOR) {
          const blocked = view.castle.blockers.has(i);
          ctx.fillStyle = blocked ? withAlpha(pal.accent, 0.2) : 'rgba(60,42,26,0.55)';
          ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
          ctx.strokeStyle = blocked ? pal.accent : withAlpha(pal.wallEdge, 0.8);
          ctx.lineWidth = blocked ? 2 : 1.2;
          ctx.strokeRect(px + 2.5, py + 2.5, TILE - 5, TILE - 5);
          if (blocked) {
            // Une herse baissée : on voit à travers, on ne passe pas.
            ctx.strokeStyle = withAlpha(pal.accent, 0.75);
            ctx.lineWidth = 1.4;
            for (let k = 1; k < 4; k++) {
              ctx.beginPath();
              ctx.moveTo(px + (k * TILE) / 4, py + 3);
              ctx.lineTo(px + (k * TILE) / 4, py + TILE - 3);
              ctx.stroke();
            }
          }
        }

        if (t === T.LOW) {
          ctx.fillStyle = pal.wallFace;
          ctx.fillRect(px + 3, py + 3, TILE - 6, TILE - 6);
          ctx.fillStyle = withAlpha(pal.wallTop, 0.75);
          ctx.fillRect(px + 3, py + 3, TILE - 6, 5);
        }
      }
    }
  }

  private drawWalls(view: ClientView, pal: Palette): void {
    const ctx = this.ctx;
    const b = this.camera.tileBounds();
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = idx(x, y);
        if (this.vis[i] <= 0) continue;
        const t = view.castle.tiles[i];
        if (t !== T.WALL && t !== T.FRAGILE && t !== T.SECRET) continue;

        const px = x * TILE;
        const py = y * TILE;
        ctx.fillStyle = pal.wallFace;
        ctx.fillRect(px, py, TILE, TILE);

        // Le dessus du mur n'est peint que là où il borde du vide : c'est ce
        // qui donne l'épaisseur sans coûter une passe d'ombre.
        const below = view.castle.tiles[idx(x, Math.min(GRID_H - 1, y + 1))];
        const openBelow = below !== T.WALL && below !== T.FRAGILE && below !== T.SECRET;
        ctx.fillStyle = pal.wallTop;
        ctx.fillRect(px, py, TILE, openBelow ? TILE * 0.72 : TILE);
        if (openBelow) {
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(px, py + TILE * 0.72, TILE, TILE * 0.28);
        }
        ctx.fillStyle = withAlpha(pal.wallEdge, 0.55);
        ctx.fillRect(px, py, TILE, 2);
        if (openBelow) {
          // L'ombre déborde sur la dalle d'en dessous : le mur se détache.
          const g = ctx.createLinearGradient(0, py + TILE, 0, py + TILE * 1.45);
          g.addColorStop(0, 'rgba(0,0,0,0.5)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fillRect(px, py + TILE, TILE, TILE * 0.45);
        }

        // Appareillage de pierre, stable d'une frame à l'autre.
        ctx.fillStyle = 'rgba(0,0,0,0.13)';
        const rows = 3;
        for (let r = 1; r < rows; r++) {
          ctx.fillRect(px, py + (r * TILE) / rows, TILE, 1);
        }
        const offset = y % 2 === 0 ? 0 : TILE / 2;
        for (let r = 0; r < rows; r++) {
          const jx = (px + offset + (r % 2) * (TILE / 2)) % TILE;
          ctx.fillRect(px + jx, py + (r * TILE) / rows, 1, TILE / rows);
        }

        if (t === T.FRAGILE) {
          // Un mur fragile se lit : les joints sont irréguliers, il vibre.
          ctx.strokeStyle = withAlpha(pal.accent, 0.32);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let k = 0; k < 3; k++) {
            const yy = py + 6 + k * 9;
            ctx.moveTo(px + 3, yy);
            ctx.lineTo(px + TILE - 3, yy + (hash2(x, y, k) - 0.5) * 6);
          }
          ctx.stroke();
        }
      }
    }

    // Torches : la source de lumière doit être visible, pas seulement sentie.
    for (const tp of view.castle.plan.torches) {
      const i = idx(Math.floor(tp.x), Math.floor(tp.y));
      if (this.vis[i] <= 0) continue;
      const doused = view.snap?.doused?.some(
        (d) => Math.hypot(d.x - tp.x, d.y - tp.y) <= d.r,
      );
      const flicker = 0.75 + Math.sin(this.time * 9 + tp.x * 3 + tp.y * 5) * 0.12;
      ctx.fillStyle = doused ? 'rgba(90,80,70,0.6)' : `rgba(255,190,110,${flicker})`;
      ctx.beginPath();
      ctx.arc(tp.x * TILE, tp.y * TILE, doused ? 2 : 3.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------------- Objets ---------------- */

  private drawScars(snap: Snapshot | null, pal: Palette): void {
    if (!snap) return;
    const ctx = this.ctx;
    for (const s of snap.scars) {
      const i = idx(Math.floor(s.x), Math.floor(s.y));
      if (this.vis[i] <= 0) continue;
      const px = s.x * TILE;
      const py = s.y * TILE;
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = withAlpha(pal.accentDim, 0.9);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(px, py, TILE * 0.36, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.arc(px, py, TILE * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawHeart(snap: Snapshot | null, pal: Palette): void {
    if (!snap?.heart) return;
    const ctx = this.ctx;
    const px = snap.heart.x * TILE;
    const py = snap.heart.y * TILE;
    const beat = 0.5 + 0.5 * Math.sin(this.time * (snap.alarm ? 5.2 : 2.6));
    const r = CFG.heart.roomRadius * TILE;

    ctx.save();
    const g = ctx.createRadialGradient(px, py, 2, px, py, r);
    g.addColorStop(0, `rgba(240,196,105,${0.34 + beat * 0.14})`);
    g.addColorStop(0.55, `rgba(216,56,79,${0.15 + beat * 0.06})`);
    g.addColorStop(1, 'rgba(216,56,79,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    // Le cercle de capture : on doit voir où commence la salle.
    ctx.strokeStyle = `rgba(240,196,105,${0.3 + beat * 0.2})`;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const size = TILE * (0.34 + beat * 0.05);
    ctx.fillStyle = '#f0c469';
    ctx.beginPath();
    ctx.moveTo(px, py - size);
    ctx.lineTo(px + size, py);
    ctx.lineTo(px, py + size);
    ctx.lineTo(px - size, py);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.accent, 0.8);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  private drawBraziers(snap: Snapshot | null, pal: Palette): void {
    if (!snap) return;
    const ctx = this.ctx;
    for (const b of snap.braziers) {
      const px = b.x * TILE;
      const py = b.y * TILE;
      const i = idx(Math.floor(b.x), Math.floor(b.y));
      // Un brasero allumé se voit de partout : c'est un signal, pas un décor.
      if (!b.lit && this.vis[i] <= 0) continue;

      ctx.save();
      ctx.strokeStyle = pal.wallEdge;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - 5, py + 7);
      ctx.lineTo(px, py + 1);
      ctx.lineTo(px + 5, py + 7);
      ctx.stroke();
      ctx.fillStyle = b.lit ? '#f0c469' : '#4a4038';
      ctx.beginPath();
      ctx.ellipse(px, py - 1, 7, 4.5, 0, 0, Math.PI * 2);
      ctx.fill();

      if (b.lit) {
        const f = 0.75 + Math.sin(this.time * 11 + b.id * 2) * 0.25;
        const g = ctx.createRadialGradient(px, py - 4, 1, px, py - 4, 22 * f);
        g.addColorStop(0, 'rgba(255,210,130,0.85)');
        g.addColorStop(1, 'rgba(255,150,60,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py - 4, 22 * f, 0, Math.PI * 2);
        ctx.fill();
      } else if (b.progress > 0) {
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(px, py, 12, -Math.PI / 2, -Math.PI / 2 + b.progress * Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawTells(view: ClientView, pal: Palette): void {
    const ctx = this.ctx;
    for (const t of view.tellViews()) {
      const i = idx(Math.floor(t.x), Math.floor(t.y));
      if (this.vis[i] <= 0) continue;
      drawTellGlow(ctx, t.x * TILE, t.y * TILE, t.alpha, pal.tell);
      drawTell(ctx, t.tell as TellKind, t.x * TILE, t.y * TILE, t.facing, t.alpha, pal.tell);
    }

    // Côté Châtelain : ses propres pièges, avec leur état.
    const own = view.snap?.ownTraps;
    if (!own) return;
    for (const t of own) {
      const px = t.x * TILE;
      const py = t.y * TILE;
      ctx.save();
      const spent = t.state !== 'armed';
      ctx.globalAlpha = spent ? 0.32 : 0.85;
      ctx.strokeStyle = spent ? pal.accentDim : pal.accent;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(px, py, TILE * 0.3, 0, Math.PI * 2);
      ctx.stroke();
      if (t.kind === 'decoy') {
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(px, py, TILE * 0.42, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  private drawEntities(view: ClientView, pal: Palette): void {
    const ctx = this.ctx;
    for (const e of view.entityViews()) {
      const px = e.pos.x * TILE;
      const py = e.pos.y * TILE;
      ctx.save();
      switch (e.kind) {
        case 'bolt': {
          ctx.translate(px, py);
          ctx.rotate(e.a);
          ctx.fillStyle = '#e8ddc8';
          ctx.fillRect(-7, -1.1, 14, 2.2);
          ctx.fillStyle = pal.accent;
          ctx.beginPath();
          ctx.moveTo(7, 0);
          ctx.lineTo(3, -2.6);
          ctx.lineTo(3, 2.6);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'bomb': {
          const pulse = 0.6 + 0.4 * Math.sin(this.time * 26);
          ctx.fillStyle = '#1b1b1b';
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(224,80,60,${pulse})`;
          ctx.beginPath();
          ctx.arc(px, py - 5, 2.2, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'hound': {
          ctx.translate(px, py);
          ctx.rotate(e.a);
          ctx.fillStyle = '#2a2018';
          ctx.beginPath();
          ctx.ellipse(0, 0, 11, 6.5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#e0503c';
          ctx.beginPath();
          ctx.arc(7, -2, 1.5, 0, Math.PI * 2);
          ctx.arc(7, 2, 1.5, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'chandelier_fall': {
          ctx.strokeStyle = '#f0c469';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, 14 * (1 - e.ttl / 0.6), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        default:
          break;
      }
      ctx.restore();
    }
  }

  /* ---------------- Acteurs ---------------- */

  private drawActors(view: ClientView, pal: Palette, role: Role, scrying: boolean): void {
    const snap = view.snap;
    const other = view.otherAt();
    if (other) {
      this.drawFigure(
        other.pos,
        other.aim,
        other.data.state,
        role === 'invader' ? 'castellan' : 'invader',
        pal.other,
        pal,
        other.data.via === 'scry' || other.data.via === 'reveal' ? 0.85 : 1,
        other.data.hp,
      );
    }
    this.drawFigure(
      view.render,
      view.aim,
      snap?.self.state ?? 'idle',
      role,
      pal.self,
      pal,
      scrying ? 0.42 : 1,
      snap?.self.hp ?? 100,
      true,
    );
  }

  private drawFigure(
    pos: Vec,
    aim: number,
    state: string,
    who: Role,
    color: string,
    pal: Palette,
    alpha: number,
    hp: number,
    isSelf = false,
  ): void {
    const ctx = this.ctx;
    const px = pos.x * TILE;
    const py = pos.y * TILE;
    const r = (who === 'invader' ? CFG.invader.radius : CFG.castellan.radius) * TILE;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Ombre portée : c'est elle qui pose la figure sur le sol.
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(px, py + r * 0.55, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(px, py);
    ctx.rotate(aim);

    if (state === 'dodge') {
      ctx.globalAlpha = alpha * 0.5;
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = withAlpha(color, 0.12);
        ctx.beginPath();
        ctx.arc(-i * 6, 0, r * (1 - i * 0.14), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
    }

    // Le Châtelain est plus large et plus lourd ; l'Envahisseur plus étroit.
    ctx.fillStyle = who === 'castellan' ? '#3b2d1e' : '#1b2430';
    ctx.beginPath();
    if (who === 'castellan') ctx.ellipse(0, 0, r * 1.16, r * 1.02, 0, 0, Math.PI * 2);
    else ctx.ellipse(0, 0, r * 1.02, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Le regard : un joueur doit savoir où l'autre fait face en un coup d'œil.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r * 1.35, 0);
    ctx.lineTo(r * 0.35, -r * 0.55);
    ctx.lineTo(r * 0.35, r * 0.55);
    ctx.closePath();
    ctx.fill();

    if (state === 'windup') {
      // L'attaque est télégraphiée : c'est ce qui rend la parade jouable.
      ctx.strokeStyle = withAlpha('#ffffff', 0.8);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.1, -Math.PI / 4, Math.PI / 4);
      ctx.stroke();
    }
    if (state === 'recover') {
      ctx.strokeStyle = withAlpha(color, 0.5);
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.3, -Math.PI / 3, Math.PI / 3);
      ctx.stroke();
    }
    if (state === 'parry') {
      ctx.strokeStyle = '#cfe4ec';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.75, -CFG.combat.parry.arc / 2, CFG.combat.parry.arc / 2);
      ctx.stroke();
    }
    if (state === 'immobile' || state === 'stun') {
      ctx.strokeStyle = '#e0503c';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // Le corps laissé en Scrutation : visible, immobile, et manifestement absent.
    if (state === 'scrying') {
      ctx.save();
      ctx.globalAlpha = 0.9;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 3.4);
      ctx.strokeStyle = withAlpha(pal.accent, 0.35 + pulse * 0.3);
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(px, py, r * 2.2 + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Barre de vie de l'adversaire : uniquement quand on le voit vraiment.
    if (!isSelf && hp < 100) {
      ctx.save();
      const w = 26;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(px - w / 2, py - r - 11, w, 3.5);
      ctx.fillStyle = hp > 30 ? color : '#e0503c';
      ctx.fillRect(px - w / 2, py - r - 11, (w * hp) / 100, 3.5);
      ctx.restore();
    }
  }

  private updateParticles(dt: number): void {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.gravity * dt;
      p.vx *= 1 - 2.2 * dt;
      p.vy *= 1 - 1.4 * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------- Lumière ---------------- */

  private compositeLight(view: ClientView, pal: Palette, scrying: boolean): void {
    const light = view.castle.light();
    const m = this.maskCtx;
    const g = this.glowCtx;
    m.clearRect(0, 0, this.mask.width, this.mask.height);
    g.clearRect(0, 0, this.glow.width, this.glow.height);

    const [lr, lg, lb] = pal.lightTint;
    const self = view.render;
    // Halo personnel : on voit toujours ses propres pieds. Sans lui, un couloir
    // sans torche est un écran noir, ce qui n'est pas du brouillard mais une
    // panne d'affichage.
    const glowR = 3.4;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = idx(x, y);
        const d = Math.hypot(x + 0.5 - self.x, y + 0.5 - self.y);
        const personal = scrying ? 0.3 : Math.max(0, 1 - d / glowR) ** 1.4 * 0.55;
        const b = this.brightness(i, light, personal);
        // L'inexploré n'est pas tout à fait noir : il garde un fond de pierre.
        const dark = this.vis[i] <= 0 ? 0.955 : 1 - b;
        if (dark > 0.002) {
          m.fillStyle = `rgba(0,0,0,${dark})`;
          m.fillRect(x * MASK_SCALE, y * MASK_SCALE, MASK_SCALE, MASK_SCALE);
        }
        const warm = light[i] * this.vis[i];
        if (warm > 0.02) {
          g.fillStyle = `rgba(${lr},${lg},${lb},${warm * 0.2})`;
          g.fillRect(x * MASK_SCALE, y * MASK_SCALE, MASK_SCALE, MASK_SCALE);
        }
      }
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Un flou par-dessus l'agrandissement : le brouillard devient une pente
    // continue au lieu d'un escalier de tuiles. Le rayon est en unités monde,
    // donc l'aspect ne change pas avec le zoom.
    ctx.filter = `blur(${TILE * 0.26}px)`;
    // La chaleur d'abord : la pierre prend la couleur du feu.
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.glow, 0, 0, WORLD_W, WORLD_H);
    // Puis la nuit : ce qu'on ne voit pas s'efface, il ne se découpe pas.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = scrying ? 0.72 : 1;
    ctx.drawImage(this.mask, 0, 0, WORLD_W, WORLD_H);
    ctx.filter = 'none';
    ctx.restore();
  }

  /* ---------------- Écran ---------------- */

  /**
   * L'élément signature : la jauge de capture envahit l'écran des DEUX joueurs,
   * en tension symétrique. Montante et dorée pour qui prend le Cœur ; sourde et
   * rouge, venue des bords, pour qui le perd.
   */
  private drawCaptureGauge(snap: Snapshot | null, role: Role): void {
    if (!snap || snap.capture.progress <= 0.001) return;
    const ctx = this.ctx;
    const w = this.camera.viewW;
    const h = this.camera.viewH;
    const p = snap.capture.progress;
    const taking = role === 'invader';
    const contested = snap.capture.contested;

    ctx.save();

    // L'envahissement des bords : il grandit avec la progression.
    const reach = Math.min(w, h) * (0.1 + p * 0.34);
    const edge = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.max(0, Math.min(w, h) / 2 - reach),
      w / 2,
      h / 2,
      Math.hypot(w, h) / 2,
    );
    const col = taking ? '240,196,105' : '216,56,79';
    edge.addColorStop(0, `rgba(${col},0)`);
    edge.addColorStop(1, `rgba(${col},${0.1 + p * 0.4})`);
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, w, h);

    // La barre : le seul endroit du HUD où l'on s'autorise du monumental.
    const bw = Math.min(560, w * 0.62);
    const bh = 10;
    const bx = (w - bw) / 2;
    const by = 26;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    ctx.fillStyle = `rgba(${col},${contested ? 0.5 : 1})`;
    ctx.fillRect(bx, by, bw * p, bh);

    // Le seuil des 50 % : le moment où le château cède.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx + bw * CFG.heart.breachAt, by - 4);
    ctx.lineTo(bx + bw * CFG.heart.breachAt, by + bh + 4);
    ctx.stroke();

    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = contested ? '#e8ddc8' : `rgb(${col})`;
    const label = contested
      ? 'CAPTURE SUSPENDUE'
      : taking
        ? `CAPTURE ${Math.floor(p * 100)} %`
        : `LE CŒUR CÈDE — ${Math.floor(p * 100)} %`;
    ctx.fillText(label, w / 2, by + bh + 18);
    ctx.restore();
  }

  private drawScreenEffects(
    snap: Snapshot | null,
    pal: Palette,
    scrying: boolean,
    alarm: boolean,
  ): void {
    const ctx = this.ctx;
    const w = this.camera.viewW;
    const h = this.camera.viewH;

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(224,80,60,${this.flash * 0.5})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Le réveil du château : un changement d'état franc, que les deux sentent.
    if (this.alarmFlash > 0) {
      const k = this.alarmFlash / CFG.alarm.flash;
      ctx.fillStyle = `rgba(216,56,79,${k * 0.32})`;
      ctx.fillRect(0, 0, w, h);
    } else if (alarm) {
      ctx.fillStyle = 'rgba(216,56,79,0.05)';
      ctx.fillRect(0, 0, w, h);
    }

    // Vignette de blessure : sous 30 PV, on le sait sans lire le chiffre.
    const hp = snap?.self.hp ?? 100;
    if (hp < CFG.feel.lowHpVignette) {
      const k = 1 - hp / CFG.feel.lowHpVignette;
      const pulse = 0.6 + 0.4 * Math.sin(this.time * 4.5);
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, 'rgba(224,80,60,0)');
      g.addColorStop(1, `rgba(224,80,60,${0.18 + k * 0.4 * pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Scrutation : un léger voile rappelle que le corps est resté en arrière.
    if (scrying) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, withAlpha(pal.accent, 0.14));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

function hash2(x: number, y: number, n: number): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + n * 2246822519, 1);
  h = (h ^ (h >>> 13)) >>> 0;
  return (Math.imul(h, 1274126177) >>> 0) / 4294967296;
}
