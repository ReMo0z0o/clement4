/**
 * Le modèle de déplacement, en UN SEUL exemplaire.
 *
 * L'hôte l'exécute pour faire autorité, l'invité l'exécute pour prédire. Tant
 * que les deux lisaient chacun leur copie, la moindre différence — une inertie
 * d'un côté et pas de l'autre, une esquive simulée ici et ignorée là — se
 * payait en recalages : l'invité se voyait reculer, glisser, se téléporter.
 * Désormais il n'y a qu'une fonction, et l'invité ne peut plus diverger que
 * sur ce qu'il ignore vraiment (un coup reçu, un piège déclenché).
 *
 * Logique pure : aucune dépendance au DOM, testable en Node.
 */

import { CFG } from './config';
import type { CastleRuntime } from './grid';
import type { ActorState, Gait, InputFrame, Role, Vec } from './types';

/** Multiplicateur de vitesse imposé par l'état de l'acteur. */
export function stateSpeedMul(s: ActorState): number {
  switch (s) {
    case 'windup':
      return 0.35;
    case 'recover':
      return 0.55;
    case 'parry':
      return CFG.combat.parry.speedMul;
    case 'stun':
    case 'immobile':
    case 'scrying':
    case 'dead':
      return 0;
    case 'casting':
      return 0.2;
    default:
      return 1;
  }
}

/**
 * La vitesse que l'acteur VEUT atteindre ce tick, en tuiles par seconde.
 *
 * En esquive, l'entrée ne compte plus : la roulade suit sa direction figée à
 * vitesse constante — c'est ce qui la rend lisible et esquivable.
 */
export function targetVelocity(o: {
  role: Role;
  gait: Gait;
  state: ActorState;
  move: Vec;
  dodgeDir: Vec;
}): Vec {
  if (o.state === 'dodge') {
    const k = CFG.combat.dodge.distance / CFG.combat.dodge.duration;
    return { x: o.dodgeDir.x * k, y: o.dodgeDir.y * k };
  }
  let speed = o.role === 'invader' ? CFG.invader.baseSpeed : CFG.castellan.baseSpeed;
  if (o.role === 'invader') speed *= CFG.invader.gait[o.gait].speedMul;
  speed *= stateSpeedMul(o.state);
  const m = Math.hypot(o.move.x, o.move.y);
  const u = m > 1 ? { x: o.move.x / m, y: o.move.y / m } : o.move;
  return { x: u.x * speed, y: u.y * speed };
}

/**
 * Un pas de déplacement : inertie, puis collision.
 *
 * La vitesse rendue est celle qui a RÉELLEMENT été parcourue. Contre un mur,
 * l'élan qui s'y enfonçait disparaît au lieu de persister en fantôme — ce qui
 * faisait croire au jeu qu'on marchait (état « move », bruits de pas) alors
 * qu'on poussait la pierre. La collision ne peut que retirer de la vitesse,
 * jamais en ajouter : un dégagement hors d'un mur n'est pas un élan.
 */
export function stepMove(
  castle: CastleRuntime,
  pos: Vec,
  vel: Vec,
  target: Vec,
  r: number,
  role: Role,
  now: number,
  dt: number,
  flying = false,
): { pos: Vec; vel: Vec } {
  // Petite inertie : assez pour que ça ne soit pas robotique, assez peu pour
  // que le changement d'allure se sente immédiatement.
  const rate = Math.hypot(target.x, target.y) > 0.01 ? CFG.invader.accel : CFG.invader.friction;
  const k = Math.min(1, rate * dt);
  let vx = vel.x + (target.x - vel.x) * k;
  let vy = vel.y + (target.y - vel.y) * k;
  // Sous ce seuil, la vitesse n'est plus que du bruit d'arrondi : l'inertie
  // n'atteint jamais zéro exactement, et ce résidu infime suffisait à fausser
  // tout test d'immobilité en aval.
  if (Math.abs(vx) < 1e-3) vx = 0;
  if (Math.abs(vy) < 1e-3) vy = 0;

  const next = castle.moveCircle(pos, { x: vx * dt, y: vy * dt }, r, role, now, flying);
  const mx = (next.x - pos.x) / dt;
  const my = (next.y - pos.y) / dt;
  if (Math.hypot(mx, my) <= Math.hypot(vx, vy) + 1e-6) {
    vx = mx;
    vy = my;
  }
  return { pos: next, vel: { x: vx, y: vy } };
}

/* ==================================================================== */
/* L'état de mouvement d'un acteur, rejouable des deux côtés            */
/* ==================================================================== */

/**
 * Ce qu'il faut savoir d'un acteur pour prédire SES PROPRES mouvements.
 *
 * Tout ce qui est ici se déduit de ses entrées et du temps. Ce qui n'y est
 * pas — les dégâts reçus, un recul, un piège — dépend de l'adversaire ou du
 * château : l'invité ne peut pas le prévoir, et l'hôte le corrige.
 *
 * Le type `Actor` de la simulation contient ces champs : on lui passe l'acteur
 * lui-même, sans copie.
 */
export interface Motion {
  role: Role;
  pos: Vec;
  vel: Vec;
  aim: number;
  gait: Gait;
  state: ActorState;
  stateUntil: number;
  dodgeDir: Vec;
  dodgeReadyAt: number;
  actionLockUntil: number;
  /** Un clic arrivé quand on ne pouvait pas frapper : le coup part dès que possible. */
  attackQueuedUntil: number;
}

/**
 * Mémoire d'un clic d'attaque, en secondes.
 *
 * Un clic pendant la récupération d'un coup était purement perdu : le joueur
 * frappait, rien ne partait. On le garde un quart de seconde, et la frappe
 * part au premier instant où elle est permise.
 */
export const ATTACK_BUFFER = 0.25;

function weaponOf(role: Role) {
  return role === 'invader' ? CFG.combat.sword : CFG.combat.castellanBlade;
}

/**
 * Les états temporisés arrivés à échéance.
 *
 * Appelé AVANT les entrées, comme l'a toujours fait la simulation : c'est
 * depuis la position de fin d'armement que la frappe se résout.
 */
export function expireStates(m: Motion, now: number): { swingResolved: boolean; castFinished: boolean } {
  const out = { swingResolved: false, castFinished: false };
  if (m.state === 'dead' || m.stateUntil <= 0 || now < m.stateUntil) return out;
  if (m.state === 'windup') {
    out.swingResolved = true;
    m.state = 'recover';
    m.stateUntil = now + weaponOf(m.role).recovery;
  } else if (m.state === 'casting') {
    out.castFinished = true;
    m.state = 'idle';
    m.stateUntil = 0;
  } else {
    m.state = 'idle';
    m.stateUntil = 0;
  }
  return out;
}

/**
 * Les entrées du tick : esquive, parade, départ de frappe, visée, puis le pas.
 *
 * `held` marque une trame que l'hôte a dû inventer faute d'avoir reçu la
 * vraie à temps. Elle ne déclenche rien et ne déplace personne : l'acteur
 * garde sa place, et sa position reste ainsi une fonction exacte des trames
 * réellement reçues — c'est-à-dire de celles que l'invité a prédites.
 */
export function driveMotion(
  m: Motion,
  input: InputFrame,
  castle: CastleRuntime,
  now: number,
  dt: number,
  opts: { suppressSwing?: boolean; flying?: boolean } = {},
): { dodgeStarted: boolean; swingStarted: boolean; parryStarted: boolean } {
  const out = { dodgeStarted: false, swingStarted: false, parryStarted: false };
  if (m.state === 'dead') return out;
  if (m.role === 'invader') m.gait = input.gait;
  if (input.held) return out;

  const canAct = now >= m.actionLockUntil;
  const busy = () => m.state === 'windup' || m.state === 'recover' || m.state === 'casting';

  /* --- Esquive roulée --- */
  if (
    m.role === 'invader' &&
    input.dodge &&
    canAct &&
    !busy() &&
    m.state !== 'dodge' &&
    now >= m.dodgeReadyAt
  ) {
    const mv = Math.hypot(input.move.x, input.move.y);
    m.dodgeDir =
      mv > 0.1 ? { x: input.move.x / mv, y: input.move.y / mv } : { x: Math.cos(m.aim), y: Math.sin(m.aim) };
    m.state = 'dodge';
    m.stateUntil = now + CFG.combat.dodge.duration;
    m.dodgeReadyAt = now + CFG.combat.dodge.cooldown;
    out.dodgeStarted = true;
  }

  /* --- Parade tenue --- */
  if (m.role === 'invader') {
    const gaitOk = CFG.invader.gait[m.gait].canParry;
    if (input.parry && canAct && !busy() && m.state !== 'dodge' && gaitOk) {
      if (m.state !== 'parry') {
        m.state = 'parry';
        out.parryStarted = true;
      }
      m.stateUntil = 0;
    } else if (m.state === 'parry') {
      m.state = 'idle';
    }
  }

  /* --- Attaque : un clic, un coup — mémorisé s'il tombe trop tôt --- */
  if (input.primary) m.attackQueuedUntil = now + ATTACK_BUFFER;
  if (
    now < m.attackQueuedUntil &&
    canAct &&
    !busy() &&
    m.state !== 'dodge' &&
    m.state !== 'parry' &&
    !opts.suppressSwing
  ) {
    const gaitOk = m.role !== 'invader' || CFG.invader.gait[m.gait].canAttack;
    if (gaitOk) {
      m.state = 'windup';
      m.stateUntil = now + weaponOf(m.role).windup;
      m.aim = input.aim;
      m.attackQueuedUntil = 0;
      out.swingStarted = true;
    }
  }

  if (m.state !== 'windup') m.aim = input.aim;

  /* --- Le pas --- */
  const target = targetVelocity({
    role: m.role,
    gait: m.gait,
    state: m.state,
    move: input.move,
    dodgeDir: m.dodgeDir,
  });
  const r = m.role === 'invader' ? CFG.invader.radius : CFG.castellan.radius;
  const res = stepMove(castle, m.pos, m.vel, target, r, m.role, now, dt, opts.flying ?? false);
  m.pos = res.pos;
  m.vel = res.vel;

  const sp = Math.hypot(m.vel.x, m.vel.y);
  if (m.state === 'idle' && sp > 0.2) m.state = 'move';
  else if (m.state === 'move' && sp <= 0.2) m.state = 'idle';

  return out;
}
