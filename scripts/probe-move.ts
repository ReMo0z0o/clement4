/**
 * Sonde de déplacement : combien de tuiles un joueur parcourt-il RÉELLEMENT
 * en trois secondes, selon ce qu'il tient enfoncé ?
 *
 *   npx tsx scripts/probe-move.ts
 *
 * Ce n'est pas un test : c'est une mesure. Elle sert à répondre à « parfois il
 * est impossible de se déplacer » avec des chiffres plutôt qu'avec une théorie.
 */

import { CFG, TICK_DT } from '../src/game/config';
import { getPlan } from '../src/game/plans/index';
import { World } from '../src/game/sim';
import { emptyBuild, emptyLoadout } from '../src/game/prep';
import { T, emptyInput } from '../src/game/types';
import type { InputFrame, Role } from '../src/game/types';

function world(): World {
  return new World({
    plan: getPlan('open'),
    build: emptyBuild('open'),
    loadout: emptyLoadout(),
    duration: 180,
  });
}

/** La rangée dégagée la plus longue du plan, et son point de départ. */
function clearRow(): { y: number; x0: number; len: number } {
  const p = getPlan('open');
  let best = { y: 0, x0: 0, len: 0 };
  for (let y = 0; y < p.h; y++) {
    let run = 0;
    for (let x = 0; x < p.w; x++) {
      // Trois rangées libres : le cercle du joueur ne frôle rien.
      const free = [y - 1, y, y + 1].every((yy) => p.tiles[yy * p.w + x] === T.FLOOR);
      run = free ? run + 1 : 0;
      if (run > best.len) best = { y, x0: x - run + 1, len: run };
    }
  }
  return best;
}
const ROW = clearRow();

/** Distance parcourue en `secs` secondes, dans un couloir dégagé. */
function travel(role: Role, patch: (f: InputFrame) => void, secs = 1): number {
  const w = world();
  const a = role === 'invader' ? w.invader : w.castellan;
  const other = role === 'invader' ? w.castellan : w.invader;
  // On les éloigne : cette sonde mesure le déplacement, pas le combat.
  a.pos = { x: ROW.x0 + 0.6, y: ROW.y + 0.5 };
  other.pos = { x: 1.5, y: 1.5 };
  const start = { ...a.pos };

  for (let i = 0; i < Math.ceil(secs / TICK_DT); i++) {
    const f = emptyInput(i);
    f.move = { x: 1, y: 0 };
    f.aim = 0;
    patch(f);
    const inv = role === 'invader' ? f : emptyInput(i);
    const cas = role === 'castellan' ? f : emptyInput(i);
    w.step(inv, cas);
  }
  return Math.hypot(a.pos.x - start.x, a.pos.y - start.y);
}

console.log(`Rangée dégagée : y=${ROW.y}, ${ROW.len} tuiles depuis x=${ROW.x0}`);
const ref = CFG.invader.baseSpeed * 1;
console.log(`Distance parcourue en 1 s — marche théorique : ${ref.toFixed(2)} tuiles\n`);

const cas: [string, Role, (f: InputFrame) => void][] = [
  ['Envahisseur — marche simple', 'invader', () => {}],
  ['Envahisseur — allure prudente', 'invader', (f) => (f.gait = 'careful')],
  ['Envahisseur — course', 'invader', (f) => (f.gait = 'run')],
  // Ce que la simulation recevait d'un bouton gardé enfoncé AVANT : un clic à
  // chaque tick. Les contrôles n'envoient plus qu'un clic par pression.
  ['Envahisseur — un clic à chaque tick (ancien bouton tenu)', 'invader', (f) => (f.primary = true)],
  ['Envahisseur — bouton tenu, contrôles corrigés', 'invader', (f) => (f.primary = f.seq === 0)],
  ['Châtelain — marche simple', 'castellan', () => {}],
  ['Châtelain — bouton tenu, contrôles corrigés', 'castellan', (f) => (f.primary = f.seq === 0)],
  ['Châtelain — Espace maintenu (ex-Scrutation)', 'castellan', (f) => (f.scry = true)],
];

for (const [label, role, patch] of cas) {
  const d = travel(role, patch);
  const pct = (d / ref) * 100;
  const bar = '█'.repeat(Math.max(0, Math.round(pct / 4)));
  console.log(`${label.padEnd(56)} ${d.toFixed(2).padStart(6)} tuiles  ${pct.toFixed(0).padStart(3)}%  ${bar}`);
}

/* ---- Position devenue non numérique : le blocage définitif et silencieux ---- */
{
  const w = world();
  w.invader.pos = { x: 12.5, y: 12.5 };
  let nan = false;
  for (let i = 0; i < Math.ceil(10 / TICK_DT); i++) {
    const f = emptyInput(i);
    f.move = { x: 1, y: 0 };
    f.primary = true;
    f.secondary = i % 60 === 0;
    f.dodge = i % 40 === 0;
    w.step(f, emptyInput(i));
    if (!Number.isFinite(w.invader.pos.x) || !Number.isFinite(w.invader.pos.y)) {
      nan = true;
      break;
    }
  }
  console.log(`\nPosition non numérique après 10 s d'entrées agressives : ${nan ? 'OUI — blocage définitif' : 'non'}`);
}
