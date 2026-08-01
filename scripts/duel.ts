/**
 * Vérification du duel loyal (§9).
 *
 *   npx tsx scripts/duel.ts
 *
 * « Le Châtelain perd un duel loyal, et c'est voulu. » Ce n'est pas une
 * intention, c'est une contrainte vérifiable : deux acteurs face à face, en
 * terrain neutre, sans piège ni mécanisme. Si le Châtelain gagne ici, il n'a
 * plus aucune raison de préparer son château, et tout le jeu s'effondre.
 */

import { CFG } from '../src/game/config';
import { getPlan } from '../src/game/plans';
import { World } from '../src/game/sim';
import { emptyBuild, emptyLoadout } from '../src/game/prep';
import { emptyInput } from '../src/game/types';

function duel(label: string, tune: (w: World) => void = () => {}) {
  const plan = getPlan('compact');
  const w = new World({
    plan,
    build: emptyBuild('compact'),
    loadout: emptyLoadout(),
    duration: 180,
  });
  // Face à face, en terrain neutre, loin de tout ce qui a été préparé.
  w.invader.pos = { x: 11.0, y: 11.0 };
  w.castellan.pos = { x: 12.1, y: 11.0 };
  tune(w);

  for (let i = 0; i < 4000 && !w.over; i++) {
    const a = emptyInput(i);
    const b = emptyInput(i);
    a.aim = Math.atan2(w.castellan.pos.y - w.invader.pos.y, w.castellan.pos.x - w.invader.pos.x);
    b.aim = Math.atan2(w.invader.pos.y - w.castellan.pos.y, w.invader.pos.x - w.castellan.pos.x);
    a.primary = true;
    b.primary = true;
    w.step(a, b);
    w.drainEvents();
  }
  const verdict = w.over?.winner === 'invader' ? '✓' : '✗';
  console.log(
    `${verdict} ${label.padEnd(34)} ${(w.over?.outcome ?? 'aucune issue').padEnd(16)} ` +
      `Env ${w.invader.hp.toFixed(0).padStart(3)} PV · Chât ${w.castellan.hp.toFixed(0).padStart(3)} PV · ${w.now.toFixed(1)} s`,
  );
  return w.over?.winner === 'invader';
}

const swordDps = CFG.combat.sword.damage / (CFG.combat.sword.windup + CFG.combat.sword.recovery);
const bladeDps =
  CFG.combat.castellanBlade.damage /
  (CFG.combat.castellanBlade.windup + CFG.combat.castellanBlade.recovery);

console.log('Duel loyal, terrain neutre\n');
console.log(`   dégâts par seconde — épée ${swordDps.toFixed(1)} · lame du Châtelain ${bladeDps.toFixed(1)}\n`);

const results = [
  duel('épée seule'),
  duel('Envahisseur à 70 PV', (w) => (w.invader.hp = 70)),
  duel('Châtelain surpris en Scrutation', (w) => {
    w.castellan.actionLockUntil = 0.4;
  }),
];

console.log('');
if (results.every(Boolean)) {
  console.log('✓ Le Châtelain perd le duel loyal, comme le cahier l’exige.');
} else {
  console.error('✗ Le Châtelain gagne un duel loyal : il n’a plus besoin de préparer son château.');
  process.exit(1);
}
