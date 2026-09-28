/**
 * Balayage des accrochages : sur chaque plan, depuis chaque dalle, dans huit
 * directions, on pousse le joueur et on compte les PINCEMENTS — les ticks où il
 * ne bouge presque pas alors qu'il ne touche qu'un seul angle saillant, donc
 * qu'une issue tangentielle existe forcément.
 *
 *   npx tsx scripts/sweep-stuck.ts
 *
 * Un vrai coin rentrant (deux murs) arrête légitimement le joueur : il n'est
 * pas compté. Un angle saillant seul, jamais : on doit toujours pouvoir le
 * contourner en glissant.
 */

import { CFG, GRID_H, GRID_W, TICK_DT } from '../src/game/config';
import { CastleRuntime, idx } from '../src/game/grid';
import { getPlan } from '../src/game/plans/index';
import { T } from '../src/game/types';
import type { PlanId, Vec } from '../src/game/types';

const PLANS: PlanId[] = ['compact', 'labyrinth', 'open'];
const R = CFG.invader.radius;
const SPEED = CFG.invader.baseSpeed;
const DIRS: Vec[] = Array.from({ length: 8 }, (_, k) => {
  const a = (k / 8) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
});

/** Les tuiles bloquantes au contact du cercle, et si chacune est touchée par un sommet. */
function contacts(c: CastleRuntime, p: Vec): { tiles: number; cornerOnly: boolean } {
  let tiles = 0;
  let faces = 0;
  for (let ty = Math.floor(p.y - R - 0.02); ty <= Math.floor(p.y + R + 0.02); ty++) {
    for (let tx = Math.floor(p.x - R - 0.02); tx <= Math.floor(p.x + R + 0.02); tx++) {
      if (!c.blocksMove(tx, ty, 'invader', 0)) continue;
      const nx = Math.max(tx, Math.min(p.x, tx + 1));
      const ny = Math.max(ty, Math.min(p.y, ty + 1));
      if (Math.hypot(p.x - nx, p.y - ny) > R + 0.02) continue;
      tiles++;
      // Le point de contact est-il sur une face (un seul axe borné) ?
      const clampedX = nx !== p.x;
      const clampedY = ny !== p.y;
      if (!(clampedX && clampedY)) faces++;
    }
  }
  return { tiles, cornerOnly: tiles > 0 && faces === 0 };
}

let totalPinch = 0;
let totalTrials = 0;
const perPlan: string[] = [];

for (const id of PLANS) {
  const c = new CastleRuntime(getPlan(id));
  let pinch = 0;
  let trials = 0;
  const examples: string[] = [];

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (c.tiles[idx(x, y)] !== T.FLOOR) continue;
      for (const [ox, oy] of [
        [0.5, 0.5],
        [0.36, 0.36],
        [0.64, 0.36],
        [0.36, 0.64],
        [0.64, 0.64],
      ]) {
        const start = { x: x + ox, y: y + oy };
        if (c.circleHits(start.x, start.y, R, 'invader', 0)) continue;
        for (const d of DIRS) {
          trials++;
          let p = { ...start };
          for (let t = 0; t < 45; t++) {
            const want = { x: d.x * SPEED * TICK_DT, y: d.y * SPEED * TICK_DT };
            const next = c.moveCircle(p, want, R, 'invader', 0);
            const moved = Math.hypot(next.x - p.x, next.y - p.y);
            const k = contacts(c, next);
            if (moved < Math.hypot(want.x, want.y) * 0.02 && k.cornerOnly) {
              pinch++;
              if (examples.length < 3) {
                examples.push(`(${next.x.toFixed(2)}, ${next.y.toFixed(2)}) cap ${Math.round((Math.atan2(d.y, d.x) * 180) / Math.PI)}°`);
              }
              break;
            }
            p = next;
          }
        }
      }
    }
  }
  totalPinch += pinch;
  totalTrials += trials;
  perPlan.push(`  ${id.padEnd(10)} ${String(pinch).padStart(4)} pincements sur ${trials} essais${examples.length ? '  ex. ' + examples.join(' · ') : ''}`);
}

console.log('Pincements sur angle saillant (le joueur bloqué alors qu’il pourrait glisser)\n');
for (const l of perPlan) console.log(l);
console.log(`\n  total      ${totalPinch} sur ${totalTrials} (${((totalPinch / totalTrials) * 100).toFixed(1)} %)`);
process.exitCode = totalPinch > 0 ? 1 : 0;
