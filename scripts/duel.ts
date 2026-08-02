/**
 * Vérification des armes communes.
 *
 *   npx tsx scripts/duel.ts
 *
 * Les deux camps portent la même épée et la même arbalète ; le carreau
 * rebondit sur les murs jusqu'à trois fois et ne fait pas la différence entre
 * les deux joueurs. Ce script vérifie ces promesses dans la simulation
 * réelle — pas seulement dans la configuration.
 */

import { CFG, TICK_DT } from '../src/game/config';
import { getPlan } from '../src/game/plans';
import { World } from '../src/game/sim';
import { emptyBuild, emptyLoadout } from '../src/game/prep';
import { emptyInput } from '../src/game/types';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

function makeWorld(): World {
  return new World({
    plan: getPlan('compact'),
    build: emptyBuild('compact'),
    loadout: emptyLoadout(),
    duration: 180,
  });
}

console.log('Armes communes\n');

/* ---- 1. La même lame dans les deux mains ---- */
{
  const a = CFG.combat.sword;
  const b = CFG.combat.castellanBlade;
  check(
    a.damage === b.damage && a.windup === b.windup && a.recovery === b.recovery && a.range === b.range,
    'les deux épées sont identiques',
    `${a.damage} dégâts, ${(a.windup + a.recovery).toFixed(2)} s par coup`,
  );
}

/* ---- 2. Le carreau rebondit, trois fois au plus ---- */
{
  const w = makeWorld();
  // L'Envahisseur tire droit sur le mur ouest, à bout portant.
  w.invader.pos = { x: 2.5, y: 2.5 };
  w.castellan.pos = { x: 20.5, y: 20.5 };
  const shoot = emptyInput(0);
  shoot.aim = Math.PI; // plein ouest, vers la bordure
  shoot.secondary = true;
  w.step(shoot, emptyInput(0));

  let ricochets = 0;
  let boltAlive = true;
  for (let i = 0; boltAlive && i < 400; i++) {
    w.step(emptyInput(i), emptyInput(i));
    for (const e of w.drainEvents()) if (e.k === 'ricochet') ricochets++;
    boltAlive = w.entities.some((e) => e.kind === 'bolt');
  }
  check(
    ricochets >= 1 && ricochets <= CFG.combat.crossbow.bounces,
    `le carreau rebondit (${ricochets} fois, plafond ${CFG.combat.crossbow.bounces})`,
  );
  check(!boltAlive, 'puis il finit par mourir — pas de carreau immortel');
}

/* ---- 3. Le Châtelain tire aussi, et son carreau porte ---- */
{
  const w = makeWorld();
  // Face à face dans le couloir dégagé du haut du Donjon (ligne 1).
  w.castellan.pos = { x: 9.5, y: 1.5 };
  w.invader.pos = { x: 13.5, y: 1.5 };
  const shoot = emptyInput(0);
  shoot.aim = 0; // vers l'est, droit sur l'Envahisseur
  shoot.secondary = true;
  const hpBefore = w.invader.hp;
  w.step(emptyInput(0), shoot);
  for (let i = 0; i < 60; i++) w.step(emptyInput(i), emptyInput(i));
  w.drainEvents();
  check(
    w.invader.hp <= hpBefore - CFG.combat.crossbow.damage,
    'le carreau du Châtelain touche',
    `${hpBefore} → ${w.invader.hp} PV`,
  );
}

/* ---- 4. Après un rebond, le carreau ne connaît plus son camp ---- */
{
  const w = makeWorld();
  // Tir à bout portant sur le mur : le carreau revient sur le tireur.
  w.invader.pos = { x: 2.2, y: 2.5 };
  w.castellan.pos = { x: 20.5, y: 20.5 };
  const shoot = emptyInput(0);
  shoot.aim = Math.PI;
  shoot.secondary = true;
  const hpBefore = w.invader.hp;
  w.step(shoot, emptyInput(0));
  for (let i = 0; i < Math.ceil(1.5 / TICK_DT); i++) w.step(emptyInput(i), emptyInput(i));
  w.drainEvents();
  check(
    w.invader.hp < hpBefore,
    'un carreau qui revient blesse son propre tireur',
    `${hpBefore} → ${w.invader.hp} PV`,
  );
}

/* ---- 5. Le guet voit à travers les murs, tant qu'il lui reste de la veille ---- */
{
  const build = emptyBuild('compact');
  build.sensors = [{ id: 0, x: 11.5, y: 4.5 }];
  const w = new World({ plan: getPlan('compact'), build, loadout: emptyLoadout(), duration: 180 });
  // Le Châtelain au diable vauvert, sans la moindre ligne de vue.
  w.castellan.pos = { x: 1.5, y: 22.5 };
  w.invader.pos = { x: 11.5, y: 4.6 };
  w.step(emptyInput(0), emptyInput(0));
  w.drainEvents();
  check(
    w.castellanSees() === 'sensor',
    'un guet montre l’Envahisseur à travers les murs',
    `canal « ${w.castellanSees()} », sans ligne de vue`,
  );
  check(w.watchedBy === 0, 'et le Châtelain sait lequel de ses yeux le tient');

  // La veille se consomme, et seulement pendant qu'elle sert.
  const before = w.sensors[0].watchLeft;
  for (let i = 0; i < Math.ceil(2 / TICK_DT); i++) w.step(emptyInput(i), emptyInput(i));
  w.drainEvents();
  const spent = before - w.sensors[0].watchLeft;
  check(spent > 1.8 && spent < 2.2, 'la réserve se vide en temps réel', `${spent.toFixed(2)} s en 2 s`);

  // Hors du cercle : plus de veille dépensée, plus de vision, mais une piste.
  w.invader.pos = { x: 11.5, y: 20.5 };
  const held = w.sensors[0].watchLeft;
  for (let i = 0; i < Math.ceil(1 / TICK_DT); i++) w.step(emptyInput(i), emptyInput(i));
  w.drainEvents();
  check(w.sensors[0].watchLeft === held, 'un guet qui ne voit personne ne dépense rien');
  check(w.castellanSees() === null, 'et il ne montre plus rien');
  check(w.ping !== null, 'mais le dernier point vu reste comme piste');
}

/* ---- 6. Le Cœur disputé suspend le chrono, et ne soigne plus personne ---- */
{
  const w = new World({
    plan: getPlan('compact'),
    build: emptyBuild('compact'),
    loadout: emptyLoadout(),
    duration: 180,
  });
  // Les deux dans la salle du Cœur.
  w.invader.pos = { x: w.heart.x, y: w.heart.y };
  w.castellan.pos = { x: w.heart.x + 0.4, y: w.heart.y };
  w.castellan.hp = 50;
  const t0 = w.timeLeft;
  const hp0 = w.castellan.hp;
  const prog0 = w.captureProgress;
  for (let i = 0; i < Math.ceil(3 / TICK_DT); i++) {
    // On replace les deux : un coup d'épée pourrait les séparer.
    w.invader.pos = { x: w.heart.x, y: w.heart.y };
    w.castellan.pos = { x: w.heart.x + 0.4, y: w.heart.y };
    w.step(emptyInput(i), emptyInput(i));
  }
  w.drainEvents();
  check(w.contested, 'la salle est bien signalée comme disputée');
  check(w.timeLeft === t0, 'le chrono ne bouge plus tant que les deux y sont', `${t0} → ${w.timeLeft}`);
  check(w.captureProgress === prog0, 'et la capture ne progresse pas non plus');
  check(
    w.castellan.hp === hp0,
    'le Cœur ne soigne pas le Châtelain pendant qu’on le lui dispute',
    `${hp0} → ${w.castellan.hp} PV`,
  );

  // L'Envahisseur s'en va : le temps repart.
  w.invader.pos = { x: 1.5, y: 1.5 };
  w.step(emptyInput(0), emptyInput(0));
  w.drainEvents();
  check(!w.contested && w.timeLeft < t0, 'et il repart dès que l’un des deux quitte la salle');
}

console.log('');
if (failures) {
  console.error(`${failures} promesse(s) d'armement non tenue(s).`);
  process.exit(1);
}
console.log('✓ Épée commune, arbalète à rebond, yeux de guet, Cœur disputé : tout est tenu.');
