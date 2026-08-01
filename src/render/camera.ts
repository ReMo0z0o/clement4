/**
 * Caméra.
 *
 * Le zoom n'est pas un effet : c'est l'information « je vois mieux / je vois
 * moins » rendue physique. En allure prudente la vue se resserre, à la course
 * elle s'écarte et l'image file. Le joueur sent son allure avant de la lire.
 */

import { CFG, TILE, WORLD_H, WORLD_W, scryZoom } from '@/game/config';
import type { Gait, Vec } from '@/game/types';
import { clamp, lerp } from '@/game/types';

export class Camera {
  /** Centre visé, en pixels monde. */
  x = 0;
  y = 0;
  zoom = 2;
  private targetZoom = 2;
  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;
  private seed = 1337;

  viewW = 960;
  viewH = 600;

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  /** Secousse courte, proportionnelle aux dégâts encaissés (§15). */
  kick(amount: number): void {
    this.shake = Math.min(CFG.feel.shakeMax, this.shake + amount);
  }

  follow(target: Vec, aim: number, gait: Gait, scrying: boolean, dt: number): void {
    if (scrying) {
      // Scrutation : la vue s'élève, tout le château tient à l'écran.
      this.targetZoom = scryZoom(this.viewW, this.viewH);
      const cx = WORLD_W / 2;
      const cy = WORLD_H / 2;
      const k = Math.min(1, CFG.camera.follow * 0.8 * dt);
      this.x = lerp(this.x, cx, k);
      this.y = lerp(this.y, cy, k);
    } else {
      this.targetZoom = CFG.invader.gait[gait].zoom;
      // Un peu d'avance dans la direction du regard : on voit où l'on va.
      const lead = CFG.camera.lead * TILE;
      const tx = target.x * TILE + Math.cos(aim) * lead;
      const ty = target.y * TILE + Math.sin(aim) * lead;
      const k = Math.min(1, CFG.camera.follow * dt);
      this.x = lerp(this.x, tx, k);
      this.y = lerp(this.y, ty, k);
    }

    this.zoom = lerp(this.zoom, this.targetZoom, Math.min(1, CFG.camera.zoomLerp * dt));
    this.clampToWorld();

    if (this.shake > 0.01) {
      this.shake = Math.max(0, this.shake - CFG.feel.shakeMax * CFG.camera.shakeDecay * dt * 0.12);
      this.shakeX = (this.rand() - 0.5) * this.shake;
      this.shakeY = (this.rand() - 0.5) * this.shake;
    } else {
      this.shake = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /** Le château est fini : la caméra ne montre jamais le vide autour. */
  private clampToWorld(): void {
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    if (halfW * 2 >= WORLD_W) this.x = WORLD_W / 2;
    else this.x = clamp(this.x, halfW, WORLD_W - halfW);
    if (halfH * 2 >= WORLD_H) this.y = WORLD_H / 2;
    else this.y = clamp(this.y, halfH, WORLD_H - halfH);
  }

  /** Applique la transformation monde → écran sur un contexte. */
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(this.viewW / 2 + this.shakeX, this.viewH / 2 + this.shakeY);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  toScreen(worldPx: Vec): Vec {
    return {
      x: (worldPx.x - this.x) * this.zoom + this.viewW / 2 + this.shakeX,
      y: (worldPx.y - this.y) * this.zoom + this.viewH / 2 + this.shakeY,
    };
  }

  toWorld(screen: Vec): Vec {
    return {
      x: (screen.x - this.viewW / 2 - this.shakeX) / this.zoom + this.x,
      y: (screen.y - this.viewH / 2 - this.shakeY) / this.zoom + this.y,
    };
  }

  /** Tuiles visibles, pour ne dessiner que ce qui compte. */
  tileBounds(margin = 2): { x0: number; y0: number; x1: number; y1: number } {
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    return {
      x0: Math.max(0, Math.floor((this.x - halfW) / TILE) - margin),
      y0: Math.max(0, Math.floor((this.y - halfH) / TILE) - margin),
      x1: Math.min(WORLD_W / TILE - 1, Math.ceil((this.x + halfW) / TILE) + margin),
      y1: Math.min(WORLD_H / TILE - 1, Math.ceil((this.y + halfH) / TILE) + margin),
    };
  }

  /** Aléatoire déterministe : une secousse ne doit pas dépendre de Math.random. */
  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}
