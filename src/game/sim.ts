/**
 * Simulation autoritative d'une manche.
 *
 * Logique pure : ni React, ni DOM, ni aléatoire. Elle tourne à pas fixe
 * (TICK_DT) côté hôte, et sert aussi de prédiction locale côté invité pour le
 * seul acteur que celui-ci contrôle.
 *
 * L'ordre du `step` n'est pas arbitraire — il est choisi pour que les moments
 * décrits en §2.3 se produisent :
 *   1. le temps avance et l'alarme peut basculer ;
 *   2. les acteurs bougent et frappent ;
 *   3. les entités volent (un carreau parti reste parti, même si son tireur
 *      meurt dans le même tick) ;
 *   4. les pièges se déclenchent sur la position finale — on ne traverse
 *      jamais une dalle piégée sans la déclencher ;
 *   5. la capture et l'Influence se règlent en dernier, quand tout est stable.
 */

import { CFG, TICK_DT } from './config';
import type { DeviceKind, ToolKind, TrapKind } from './config';
import { CastleRuntime, idx } from './grid';
import type {
  Actor,
  ActorState,
  Brazier,
  BuildOrder,
  CastlePlan,
  DeviceRuntime,
  Entity,
  GameEvent,
  Gait,
  InputFrame,
  Loadout,
  Role,
  RoundOutcome,
  RoundStats,
  TrapRuntime,
  Vec,
} from './types';
import { T, angleDelta, clamp, dist, emptyStats } from './types';

export interface WorldInit {
  plan: CastlePlan;
  build: BuildOrder;
  loadout: Loadout;
  duration: number;
}

interface ToolState {
  kind: ToolKind;
  uses: number;
  readyAt: number;
}

export class World {
  readonly castle: CastleRuntime;
  readonly plan: CastlePlan;
  readonly build: BuildOrder;
  readonly loadout: Loadout;

  invader: Actor;
  castellan: Actor;

  traps: TrapRuntime[] = [];
  devices: DeviceRuntime[] = [];
  entities: Entity[] = [];
  braziers: Brazier[] = [];
  heart: Vec;

  influence: number;
  captureProgress = 0;
  breached = false;
  contested = false;
  alarm = false;
  scrying = false;
  /** Fin de la période où le Châtelain voit son adversaire sans Scrutation. */
  revealUntil = 0;
  /** Pièce sondée et instant de fin de la révélation. */
  probedRoom = -1;
  probedUntil = 0;
  shieldHp = 0;
  shieldUntil = 0;

  /**
   * Mémoire de perception de l'Envahisseur. L'hôte la tient lui-même : c'est
   * la seule façon de ne jamais envoyer au client une position qu'il n'a pas
   * encore méritée (§13).
   */
  seenBraziers = new Set<number>();
  seenHeart = false;
  /** Tuiles déjà traversées : mémoire du plan pour le brouillard. */
  explored = new Set<number>();

  /** Les guets du Châtelain : détecteurs de passage posés à la préparation. */
  sensors: { id: number; x: number; y: number; readyAt: number }[] = [];
  /** Dernier passage détecté par un guet — l'indicateur du Châtelain. */
  ping: { x: number; y: number; at: number } | null = null;

  now = 0;
  timeLeft: number;
  duration: number;

  events: GameEvent[] = [];
  stats: RoundStats = emptyStats();
  over: { winner: Role; outcome: RoundOutcome } | null = null;

  private tools: ToolState[] = [];
  private nextEntityId = 1;
  private lastVisit = new Map<number, number>();
  private visited = new Set<number>();
  private houndField: Int16Array | null = null;
  private houndFieldAt = -1;
  private pathSampleAt = 0;
  private lastGait: Gait = 'normal';
  private lightDirtyAt = -1;

  constructor(init: WorldInit) {
    this.plan = init.plan;
    this.build = init.build;
    this.loadout = init.loadout;
    this.castle = new CastleRuntime(init.plan);
    this.duration = init.duration;
    this.timeLeft = init.duration;
    this.influence = CFG.castellan.influenceStart;

    this.heart =
      init.plan.heartCandidates[
        clamp(init.build.heartIndex, 0, init.plan.heartCandidates.length - 1)
      ] ?? init.plan.heartCandidates[0];

    this.invader = makeActor('invader', init.plan.invaderSpawn, CFG.invader.maxHp);
    // Le Châtelain démarre à la place prévue par le plan, pas sur son Cœur :
    // sinon trouver le Cœur revient à trouver le Châtelain, et le choix de
    // l'emplacement du Cœur ne coûte plus rien.
    this.castellan = makeActor('castellan', init.plan.castellanSpawn, CFG.castellan.maxHp);
    this.castellan.pos = this.castle.nearestFree(this.castellan.pos, CFG.castellan.radius, 'castellan', 0);

    for (const t of init.build.traps) {
      this.traps.push({ ...t, state: 'armed', discovered: false, approached: false, triggeredAt: -1 });
    }
    for (const d of init.build.devices) {
      this.devices.push({ ...d, used: false, activeUntil: 0, discovered: false });
    }
    for (let i = 0; i < init.plan.brazierSpots.length; i++) {
      this.braziers.push({ id: i, pos: init.plan.brazierSpots[i], lit: false, progress: 0 });
    }

    for (const g of init.build.sensors ?? []) {
      this.sensors.push({ id: g.id, x: g.x, y: g.y, readyAt: 0 });
    }
    for (const di of init.build.lockedDoors) {
      const d = init.plan.doors[di];
      if (d) this.castle.addBlocker(Math.floor(d.x), Math.floor(d.y), Infinity, 'lock');
    }
    for (const si of init.build.secretDoors) this.castle.openSecrets.add(si);

    this.tools = init.loadout.tools.map((k) => ({
      kind: k,
      uses: CFG.tools[k].uses === Infinity ? Infinity : (CFG.tools[k].uses as number),
      readyAt: 0,
    }));

    this.refreshLight();
    this.stats.trapsUntouched = this.traps.filter((t) => t.kind !== 'decoy').map((t) => t.id);
  }

  /* ================================================================== */
  /* Boucle principale                                                  */
  /* ================================================================== */

  step(invIn: InputFrame, casIn: InputFrame, dt = TICK_DT): void {
    if (this.over) return;

    this.now += dt;
    this.timeLeft -= dt;
    this.stats.timeElapsed += dt;

    this.updateAlarm();
    this.updateScry(casIn, dt);
    this.updateActor(this.invader, invIn, dt);
    this.updateActor(this.castellan, casIn, dt);
    this.fireCrossbow(this.invader, invIn);
    this.fireCrossbow(this.castellan, casIn);
    this.updateSensors();
    this.updateTools(invIn, dt);
    this.updateDevices(casIn);
    this.updateEntities(dt);
    this.updateTraps(dt);
    this.updateBraziers(invIn, dt);
    this.updateCapture(dt);
    this.updateInfluence(dt);
    this.updatePerception();
    this.updateStats(invIn, dt);
    this.checkEnd();
  }

  /**
   * Ce que l'Envahisseur a durablement découvert. Une fois vue, une chose
   * reste connue : c'est la mémoire du plan, et c'est ce qui rend la manche 3
   * différente de la manche 1.
   */
  private updatePerception(): void {
    const a = this.invader;
    if (!a.alive) return;

    for (const b of this.braziers) {
      if (this.seenBraziers.has(b.id)) continue;
      if (b.lit) {
        // Un brasero allumé est un signal visible par les deux joueurs (§7).
        this.seenBraziers.add(b.id);
        continue;
      }
      if (dist(a.pos, b.pos) <= CFG.vision.invaderRange && this.castle.losClear(a.pos, b.pos)) {
        this.seenBraziers.add(b.id);
      }
    }

    if (!this.seenHeart) {
      const d = dist(a.pos, this.heart);
      if (d <= CFG.vision.invaderRange && this.castle.losClear(a.pos, this.heart)) this.seenHeart = true;
    }

    const cx = Math.floor(a.pos.x);
    const cy = Math.floor(a.pos.y);
    const r = Math.ceil(CFG.vision.invaderRange);
    const fresh: number[] = [];
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= this.plan.w || y >= this.plan.h) continue;
        const p = { x: x + 0.5, y: y + 0.5 };
        if (dist(a.pos, p) > CFG.vision.invaderRange) continue;
        const i = idx(x, y);
        if (this.explored.has(i)) continue;
        if (this.castle.losClear(a.pos, p)) {
          this.explored.add(i);
          fresh.push(i);
        }
      }
    }
    // On voit aussi les murs qui bordent ce qu'on vient de découvrir : sinon
    // les pièces explorées flottent sans contour.
    for (const i of fresh) {
      const x = i % this.plan.w;
      const y = Math.floor(i / this.plan.w);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= this.plan.w || ny >= this.plan.h) continue;
          this.explored.add(idx(nx, ny));
        }
      }
    }
  }

  /* ================================================================== */
  /* Alarme (§6)                                                        */
  /* ================================================================== */

  private updateAlarm(): void {
    if (this.alarm) return;
    const inHeartRoom = dist(this.invader.pos, this.heart) <= CFG.heart.roomRadius;
    if (!inHeartRoom && this.timeLeft > CFG.alarm.timeLeftTrigger) return;

    this.alarm = true;
    this.influence = Math.min(CFG.castellan.influenceMax, this.influence + CFG.alarm.influenceGift);
    this.revealUntil = this.now + CFG.alarm.revealDuration;
    // « Tous les pièges automatiques encore intacts se réarment. »
    for (const t of this.traps) {
      if (t.state === 'spent' && CFG.traps[t.kind].rearmable) t.state = 'armed';
    }
    this.events.push({ k: 'alarm', x: this.invader.pos.x, y: this.invader.pos.y });
  }

  /* ================================================================== */
  /* Scrutation (§5)                                                    */
  /* ================================================================== */

  private updateScry(input: InputFrame, dt: number): void {
    const want = input.scry && this.castellan.alive && this.influence > 0;
    if (want && !this.scrying) {
      if (this.influence < CFG.castellan.scryMinInfluence) return;
      this.scrying = true;
      this.stats.scryCount++;
      this.events.push({ k: 'scry', on: true });
    } else if (!want && this.scrying) {
      this.scrying = false;
      // La reprise en main : c'est la fenêtre où on se fait punir.
      this.castellan.actionLockUntil = Math.max(
        this.castellan.actionLockUntil,
        this.now + CFG.castellan.scryRecover,
      );
      this.events.push({ k: 'scry', on: false });
    }

    if (this.scrying) {
      this.influence -= CFG.castellan.scryDrain * dt;
      this.stats.scryTime += dt;
      if (this.influence <= 0) {
        this.influence = 0;
        this.scrying = false;
        this.castellan.actionLockUntil = this.now + CFG.castellan.scryRecover;
        this.events.push({ k: 'scry', on: false });
      }
    }
  }

  /* ================================================================== */
  /* Acteurs                                                            */
  /* ================================================================== */

  private updateActor(a: Actor, input: InputFrame, dt: number): void {
    if (!a.alive) return;

    // Fin d'état temporisé.
    if (a.stateUntil > 0 && this.now >= a.stateUntil) {
      if (a.state === 'windup') {
        this.resolveSwing(a);
        a.state = 'recover';
        a.stateUntil = this.now + this.weapon(a).recovery;
      } else if (a.state === 'casting') {
        this.finishCast(a);
        a.state = 'idle';
        a.stateUntil = 0;
      } else {
        a.state = 'idle';
        a.stateUntil = 0;
      }
    }

    const isCastellan = a.role === 'castellan';
    if (isCastellan && this.scrying) {
      // Le corps reste immobile et sans défense, exactement là où il est.
      a.state = 'scrying';
      a.vel = { x: 0, y: 0 };
      a.aim = input.aim;
      return;
    }
    if (isCastellan && a.state === 'scrying') a.state = 'idle';

    if (a.role === 'invader') {
      if (input.gait !== a.gait) this.stats.gaitSwitches++;
      a.gait = input.gait;
    }

    const canAct = this.now >= a.actionLockUntil && a.state !== 'dead';
    const busy = a.state === 'windup' || a.state === 'recover' || a.state === 'casting';

    /* --- Esquive roulée --- */
    if (
      a.role === 'invader' &&
      input.dodge &&
      canAct &&
      !busy &&
      a.state !== 'dodge' &&
      this.now >= a.dodgeReadyAt
    ) {
      const dir =
        Math.hypot(input.move.x, input.move.y) > 0.1
          ? norm(input.move)
          : { x: Math.cos(a.aim), y: Math.sin(a.aim) };
      a.state = 'dodge';
      a.dodgeDir = dir;
      a.stateUntil = this.now + CFG.combat.dodge.duration;
      a.invulnUntil = this.now + CFG.combat.dodge.invuln;
      a.dodgeReadyAt = this.now + CFG.combat.dodge.cooldown;
      this.events.push({ k: 'dodge', x: a.pos.x, y: a.pos.y });
    }

    /* --- Parade tenue --- */
    if (a.role === 'invader') {
      const gaitOk = CFG.invader.gait[a.gait].canParry;
      if (input.parry && canAct && !busy && a.state !== 'dodge' && gaitOk) {
        if (a.state !== 'parry') {
          a.state = 'parry';
          a.swungAt = this.now; // sert de repère pour la parade parfaite
        }
        a.stateUntil = 0;
      } else if (a.state === 'parry') {
        a.state = 'idle';
      }
    }

    /* --- Attaque --- */
    if (input.primary && canAct && !busy && a.state !== 'dodge' && a.state !== 'parry') {
      const gaitOk = a.role !== 'invader' || CFG.invader.gait[a.gait].canAttack;
      const hasCrossbow = a.role === 'invader' && this.toolIndex('crossbow') >= 0;
      if (gaitOk) {
        if (hasCrossbow && input.tool === this.toolIndex('crossbow')) {
          // géré dans updateTools
        } else {
          a.state = 'windup';
          a.stateUntil = this.now + this.weapon(a).windup;
          a.swungAt = -1;
          a.aim = input.aim;
          this.events.push({ k: 'swing', role: a.role, x: a.pos.x, y: a.pos.y });
        }
      }
    }

    if (a.state !== 'windup') a.aim = input.aim;

    /* --- Déplacement --- */
    let speed = a.role === 'invader' ? CFG.invader.baseSpeed : CFG.castellan.baseSpeed;
    if (a.role === 'invader') speed *= CFG.invader.gait[a.gait].speedMul;
    speed *= stateSpeedMul(a.state);

    let move: Vec;
    if (a.state === 'dodge') {
      const k = CFG.combat.dodge.distance / CFG.combat.dodge.duration;
      move = { x: a.dodgeDir.x * k, y: a.dodgeDir.y * k };
    } else {
      const want = clampVec(input.move);
      move = { x: want.x * speed, y: want.y * speed };
    }

    // Petite inertie : assez pour que ça ne soit pas robotique, assez peu pour
    // que le changement d'allure se sente immédiatement.
    const rate = Math.hypot(move.x, move.y) > 0.01 ? CFG.invader.accel : CFG.invader.friction;
    a.vel.x += (move.x - a.vel.x) * Math.min(1, rate * dt);
    a.vel.y += (move.y - a.vel.y) * Math.min(1, rate * dt);

    const flying = a.state === 'dodge' && a.role === 'invader' && a.flying;
    const r = a.role === 'invader' ? CFG.invader.radius : CFG.castellan.radius;
    const next = this.castle.moveCircle(
      a.pos,
      { x: a.vel.x * dt, y: a.vel.y * dt },
      r,
      a.role,
      this.now,
      flying,
    );
    // Si un éboulement ou une herse l'a enfermé dans un mur, on le dégage.
    a.pos = next;
    if (this.castle.circleHits(a.pos.x, a.pos.y, r, a.role, this.now, flying)) {
      a.pos = this.castle.nearestFree(a.pos, r, a.role, this.now);
    }

    if (a.state === 'idle' && Math.hypot(a.vel.x, a.vel.y) > 0.2) a.state = 'move';
    else if (a.state === 'move' && Math.hypot(a.vel.x, a.vel.y) <= 0.2) a.state = 'idle';

    // Le grappin se termine quand l'élan s'arrête.
    if (a.flying && a.state !== 'dodge') a.flying = false;

    this.emitFootsteps(a, dt);
  }

  /**
   * Tir d'arbalète, commun aux deux camps. Le carreau rebondit sur les murs
   * (voir `updateEntities`) : un tir raté continue de vivre dans le couloir,
   * y compris pour celui qui l'a tiré.
   */
  private fireCrossbow(a: Actor, input: InputFrame): void {
    if (!input.secondary || !a.alive) return;
    if (this.now < a.actionLockUntil || this.now < a.crossbowReadyAt) return;
    if (a.state === 'windup' || a.state === 'recover' || a.state === 'casting') return;
    if (a.state === 'dodge' || a.state === 'stun' || a.state === 'immobile') return;
    if (a.role === 'castellan' && this.scrying) return;
    // À la course, on ne vise pas (§4 : la course interdit d'attaquer).
    if (a.role === 'invader' && !CFG.invader.gait[a.gait].canAttack) return;

    const dir = { x: Math.cos(a.aim), y: Math.sin(a.aim) };
    const e = this.spawnEntity(
      'bolt',
      // 0,4 tuile devant le tireur : assez pour sortir de son cercle, assez
      // peu pour ne pas naître de l'autre côté d'un mur mitoyen.
      { x: a.pos.x + dir.x * 0.4, y: a.pos.y + dir.y * 0.4 },
      { x: dir.x * CFG.combat.crossbow.speed, y: dir.y * CFG.combat.crossbow.speed },
      CFG.combat.crossbow.lifetime,
      a.role,
    );
    e.bounces = CFG.combat.crossbow.bounces;
    e.born = this.now;
    a.crossbowReadyAt = this.now + CFG.combat.crossbow.reload;
    a.actionLockUntil = Math.max(a.actionLockUntil, this.now + CFG.combat.crossbow.windup);
    this.events.push({ k: 'bolt', x: a.pos.x, y: a.pos.y });
  }

  /**
   * Les guets. Quand l'Envahisseur passe à portée d'un guet armé, le Châtelain
   * reçoit un indicateur — où qu'il soit. Le guet se tait ensuite quelques
   * secondes : il signale un passage, il ne diffuse pas une position en continu.
   */
  private updateSensors(): void {
    const inv = this.invader;
    if (!inv.alive) return;
    for (const g of this.sensors) {
      if (this.now < g.readyAt) continue;
      if (dist(inv.pos, { x: g.x, y: g.y }) > CFG.sensors.radius) continue;
      g.readyAt = this.now + CFG.sensors.cooldown;
      this.ping = { x: inv.pos.x, y: inv.pos.y, at: this.now };
      this.events.push({ k: 'sensor', x: inv.pos.x, y: inv.pos.y });
    }
  }

  private weapon(a: Actor) {
    return a.role === 'invader' ? CFG.combat.sword : CFG.combat.castellanBlade;
  }

  private resolveSwing(a: Actor): void {
    const w = this.weapon(a);
    const target = a.role === 'invader' ? this.castellan : this.invader;
    if (!target.alive) return;
    const d = dist(a.pos, target.pos);
    const tr = target.role === 'invader' ? CFG.invader.radius : CFG.castellan.radius;
    if (d > w.range + tr) return;
    const ang = Math.atan2(target.pos.y - a.pos.y, target.pos.x - a.pos.x);
    if (angleDelta(ang, a.aim) > w.arc / 2) return;

    const kb = { x: Math.cos(ang) * w.knockback, y: Math.sin(ang) * w.knockback };
    this.damage(target, w.damage, a.role === 'invader' ? 'épée' : 'lame du Châtelain', kb, a);
  }

  private emitFootsteps(a: Actor, dt: number): void {
    const moving = Math.hypot(a.vel.x, a.vel.y) > 0.4;
    if (!moving) return;
    a.stepPhase += Math.hypot(a.vel.x, a.vel.y) * dt;
    const stride = a.role === 'invader' && a.gait === 'run' ? 1.0 : 1.4;
    if (a.stepPhase < stride) return;
    a.stepPhase = 0;
    if (a.role === 'invader') {
      const noise = CFG.invader.gait[a.gait].noise;
      if (noise <= 0) return; // allure prudente : parfaitement silencieuse
      this.events.push({ k: 'step', role: 'invader', x: a.pos.x, y: a.pos.y, loud: a.gait === 'run' });
    } else {
      // Un Châtelain en Scrutation est silencieux : il ne bouge pas.
      this.events.push({ k: 'step', role: 'castellan', x: a.pos.x, y: a.pos.y, loud: false });
    }
  }

  /* ================================================================== */
  /* Dégâts                                                             */
  /* ================================================================== */

  damage(target: Actor, amount: number, source: string, knockback?: Vec, from?: Actor): void {
    if (!target.alive || this.now < target.invulnUntil) return;
    let dmg = Math.min(amount, CFG.combat.maxSingleHit);

    // Parade : réduction de face uniquement.
    if (target.state === 'parry' && from) {
      const ang = Math.atan2(from.pos.y - target.pos.y, from.pos.x - target.pos.x);
      if (angleDelta(ang, target.aim) <= CFG.combat.parry.arc / 2) {
        const perfect = this.now - target.swungAt <= CFG.combat.parry.perfectWindow;
        dmg *= 1 - CFG.combat.parry.reduction;
        this.events.push({ k: 'parry', x: target.pos.x, y: target.pos.y, perfect });
        if (perfect) {
          dmg = 0;
          from.state = 'stun';
          from.stateUntil = this.now + CFG.combat.parry.perfectStagger;
          from.actionLockUntil = this.now + CFG.combat.parry.perfectStagger;
        }
        knockback = undefined;
      }
    }

    // Écu : absorbe avant les PV.
    if (target.role === 'invader' && this.shieldHp > 0 && this.now < this.shieldUntil) {
      const absorbed = Math.min(this.shieldHp, dmg);
      this.shieldHp -= absorbed;
      dmg -= absorbed;
    }

    if (dmg <= 0) {
      target.invulnUntil = this.now + CFG.combat.invulnAfterHit;
      return;
    }

    target.hp = Math.max(0, target.hp - dmg);
    target.invulnUntil = this.now + CFG.combat.invulnAfterHit;
    target.actionLockUntil = Math.max(target.actionLockUntil, this.now + CFG.combat.hitstun);
    if (target.state === 'windup' || target.state === 'casting') {
      target.state = 'stun';
      target.stateUntil = this.now + CFG.combat.hitstun;
    }
    if (knockback) {
      target.vel.x += knockback.x / TICK_DT / 12;
      target.vel.y += knockback.y / TICK_DT / 12;
    }

    this.stats.damageBySource[source] = (this.stats.damageBySource[source] ?? 0) + dmg;
    this.events.push({ k: 'hit', target: target.role, dmg, x: target.pos.x, y: target.pos.y, source });

    if (target.hp <= 0) {
      target.alive = false;
      target.state = 'dead';
      this.events.push({ k: 'death', role: target.role, x: target.pos.x, y: target.pos.y });
    }
  }

  /* ================================================================== */
  /* Pièges automatiques (§8)                                           */
  /* ================================================================== */

  private updateTraps(dt: number): void {
    const inv = this.invader;
    if (!inv.alive) return;

    for (const t of this.traps) {
      const spec = CFG.traps[t.kind];
      const d = dist(inv.pos, { x: t.x, y: t.y });

      // Mémoire des pièges frôlés : « pièges évités » de l'écran de fin.
      if (d < 2 && t.discovered) t.approached = true;

      if (t.kind === 'decoy') continue; // un faux indice n'a rien à déclencher
      if (t.state !== 'armed') continue;
      if (d > spec.radius + CFG.invader.radius) continue;

      t.state = 'spent';
      t.triggeredAt = this.now;
      this.stats.trapsTriggered.push(t.id);
      this.stats.trapsUntouched = this.stats.trapsUntouched.filter((id) => id !== t.id);

      const ang = Math.atan2(inv.pos.y - t.y, inv.pos.x - t.x) || t.facing;
      const kbAmount = 'knockback' in spec ? (spec.knockback as number) : 0;
      const kb = kbAmount ? { x: Math.cos(ang) * kbAmount, y: Math.sin(ang) * kbAmount } : undefined;

      this.damage(inv, spec.damage, spec.label, kb);
      if (spec.immobilize > 0) {
        inv.state = 'immobile';
        inv.stateUntil = this.now + spec.immobilize;
        this.stats.lostTraps += spec.immobilize;
      }
      if (t.kind === 'collapse') {
        this.castle.setTile(Math.floor(t.x), Math.floor(t.y), T.PIT);
        this.refreshLight();
      }

      this.events.push({ k: 'trap', trap: t.kind, x: t.x, y: t.y, hit: true });
      // Le Châtelain voit ce qu'il a construit fonctionner, où qu'il soit (§11).
      this.events.push({ k: 'replay', trap: t.kind, x: t.x, y: t.y });
    }
    void dt;
  }

  /** Réarmement d'un piège, payé en Influence, déclenché en Scrutation. */
  rearmTrap(id: number): boolean {
    const t = this.traps.find((x) => x.id === id);
    if (!t || t.state !== 'spent') return false;
    if (!CFG.traps[t.kind].rearmable) return false;
    if (this.influence < CFG.castellan.rearmCost) return false;
    this.influence -= CFG.castellan.rearmCost;
    t.state = 'armed';
    return true;
  }

  /* ================================================================== */
  /* Mécanismes activables (§8)                                         */
  /* ================================================================== */

  private updateDevices(input: InputFrame): void {
    if (input.rearm >= 0 && this.scrying) this.rearmTrap(input.rearm);
    if (input.device < 0 || !this.scrying) return;
    const d = this.devices.find((x) => x.id === input.device);
    if (!d) return;
    this.activateDevice(d);
  }

  activateDevice(d: DeviceRuntime): boolean {
    const spec = CFG.devices[d.kind];
    if (d.used && 'once' in spec && spec.once) return false;
    if (this.now < d.activeUntil) return false;
    if (this.influence < spec.influence) return false;

    this.influence -= spec.influence;
    d.used = true;
    const at = { x: d.x, y: d.y };

    switch (d.kind) {
      case 'portcullis': {
        const until = this.now + CFG.devices.portcullis.duration;
        d.activeUntil = until;
        this.castle.addBlocker(Math.floor(d.x), Math.floor(d.y), until, 'portcullis');
        break;
      }
      case 'chandelier': {
        this.areaDamage(at, CFG.devices.chandelier.radius, CFG.devices.chandelier.damage, 'lustre');
        this.spawnEntity('chandelier_fall', at, { x: 0, y: 0 }, 0.6, 'castellan');
        d.activeUntil = Infinity;
        break;
      }
      case 'trapdoor': {
        if (dist(this.invader.pos, at) <= CFG.devices.trapdoor.radius) {
          this.invader.state = 'immobile';
          this.invader.stateUntil = this.now + CFG.devices.trapdoor.immobilize;
          this.stats.lostTraps += CFG.devices.trapdoor.immobilize;
          this.revealUntil = Math.max(this.revealUntil, this.now + CFG.devices.trapdoor.reveal);
        }
        d.activeUntil = this.now + 1.5;
        break;
      }
      case 'hound': {
        this.spawnEntity('hound', at, { x: 0, y: 0 }, CFG.devices.hound.duration, 'castellan', CFG.devices.hound.hp);
        d.activeUntil = Infinity;
        break;
      }
      case 'cavein': {
        this.castle.setTile(Math.floor(d.x), Math.floor(d.y), T.RUBBLE);
        this.refreshLight();
        d.activeUntil = Infinity;
        break;
      }
      case 'douse': {
        this.castle.dousedCenter = at;
        this.castle.dousedRadius = CFG.devices.douse.radius;
        this.castle.dousedUntil = this.now + CFG.devices.douse.duration;
        this.refreshLight();
        d.activeUntil = this.now + CFG.devices.douse.duration;
        break;
      }
    }

    this.events.push({ k: 'device', device: d.kind, x: d.x, y: d.y });
    return true;
  }

  private areaDamage(at: Vec, radius: number, dmg: number, source: string): void {
    for (const a of [this.invader, this.castellan]) {
      if (!a.alive) continue;
      const d = dist(a.pos, at);
      if (d > radius) continue;
      if (!this.castle.losClear(at, a.pos)) continue;
      const falloff = 1 - (d / radius) * 0.4;
      this.damage(a, dmg * falloff, source);
    }
    for (const e of this.entities) {
      if (e.kind !== 'hound' || e.hp === undefined) continue;
      if (dist(e.pos, at) <= radius) e.hp -= dmg;
    }
    this.events.push({ k: 'blast', x: at.x, y: at.y });
  }

  /* ================================================================== */
  /* Outils de l'Envahisseur (§8)                                       */
  /* ================================================================== */

  toolIndex(kind: ToolKind): number {
    return this.tools.findIndex((t) => t.kind === kind);
  }

  toolStates(): { uses: number; readyAt: number }[] {
    return this.tools.map((t) => ({ uses: t.uses, readyAt: t.readyAt }));
  }

  private updateTools(input: InputFrame, dt: number): void {
    const a = this.invader;
    if (this.shieldUntil > 0 && this.now >= this.shieldUntil) this.shieldHp = 0;
    if (this.probedUntil > 0 && this.now >= this.probedUntil) this.probedRoom = -1;

    if (input.tool < 0 || input.tool >= this.tools.length) return;
    const slot = this.tools[input.tool];
    if (!a.alive || this.now < a.actionLockUntil) return;
    if (a.state === 'windup' || a.state === 'casting' || a.state === 'dodge') return;
    if (this.now < slot.readyAt || slot.uses <= 0) return;

    switch (slot.kind) {
      case 'crossbow': {
        const dir = { x: Math.cos(a.aim), y: Math.sin(a.aim) };
        this.spawnEntity(
          'bolt',
          { x: a.pos.x + dir.x * 0.5, y: a.pos.y + dir.y * 0.5 },
          { x: dir.x * CFG.combat.crossbow.speed, y: dir.y * CFG.combat.crossbow.speed },
          CFG.combat.crossbow.lifetime,
          'invader',
        );
        slot.readyAt = this.now + CFG.combat.crossbow.reload;
        // Un tir manqué doit être puni : ni parade ni esquive pendant la recharge.
        a.actionLockUntil = this.now + CFG.combat.crossbow.windup;
        a.dodgeReadyAt = Math.max(a.dodgeReadyAt, this.now + CFG.combat.crossbow.reload);
        this.events.push({ k: 'bolt', x: a.pos.x, y: a.pos.y });
        break;
      }
      case 'probe': {
        slot.uses--;
        this.probedRoom = this.castle.roomAt(a.pos.x, a.pos.y);
        this.probedUntil = this.now + CFG.toolParams.probe.revealDuration;
        a.state = 'casting';
        a.stateUntil = this.now + CFG.toolParams.probe.castTime;
        this.events.push({ k: 'probe', x: a.pos.x, y: a.pos.y });
        break;
      }
      case 'grapple': {
        const dir = { x: Math.cos(a.aim), y: Math.sin(a.aim) };
        const target = this.grappleTarget(a.pos, dir);
        if (!target) return;
        slot.uses--;
        a.state = 'dodge';
        a.flying = true;
        a.dodgeDir = dir;
        const d = dist(a.pos, target);
        a.stateUntil = this.now + d / CFG.toolParams.grapple.travelSpeed;
        a.invulnUntil = this.now + 0.15;
        a.grappleTarget = target;
        this.events.push({ k: 'dodge', x: a.pos.x, y: a.pos.y });
        break;
      }
      case 'bombs': {
        slot.uses--;
        const dir = { x: Math.cos(a.aim), y: Math.sin(a.aim) };
        this.spawnEntity(
          'bomb',
          { x: a.pos.x + dir.x * 0.4, y: a.pos.y + dir.y * 0.4 },
          { x: dir.x * CFG.toolParams.bombs.throwSpeed, y: dir.y * CFG.toolParams.bombs.throwSpeed },
          CFG.toolParams.bombs.fuse,
          'invader',
        );
        slot.readyAt = this.now + 0.6;
        break;
      }
      case 'elixir': {
        slot.uses--;
        a.state = 'casting';
        a.stateUntil = this.now + CFG.toolParams.elixir.castTime;
        a.castKind = 'elixir';
        break;
      }
      case 'buckler': {
        slot.uses--;
        this.shieldHp = CFG.toolParams.buckler.absorb;
        this.shieldUntil = this.now + CFG.toolParams.buckler.duration;
        break;
      }
      case 'stolenmap':
        break;
    }
    void dt;
  }

  private finishCast(a: Actor): void {
    if (a.castKind === 'elixir') {
      a.hp = Math.min(CFG.invader.maxHp, a.hp + CFG.toolParams.elixir.heal);
      a.castKind = null;
    }
  }

  /** Point d'arrivée d'un grappin : par-dessus un trou, un muret, un vide. */
  private grappleTarget(from: Vec, dir: Vec): Vec | null {
    const max = CFG.toolParams.grapple.range;
    let crossedGap = false;
    for (let d = 0.5; d <= max; d += 0.25) {
      const p = { x: from.x + dir.x * d, y: from.y + dir.y * d };
      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y);
      const tile = this.castle.tile(tx, ty);
      if (tile === T.WALL || tile === T.RUBBLE || tile === T.FRAGILE || tile === T.SECRET) return null;
      if (tile === T.PIT || tile === T.LOW) {
        crossedGap = true;
        continue;
      }
      if (crossedGap && !this.castle.circleHits(p.x, p.y, CFG.invader.radius, 'invader', this.now)) {
        return p;
      }
    }
    return null;
  }

  /* ================================================================== */
  /* Entités                                                            */
  /* ================================================================== */

  private spawnEntity(
    kind: Entity['kind'],
    pos: Vec,
    vel: Vec,
    ttl: number,
    owner: Role,
    hp?: number,
  ): Entity {
    const e: Entity = {
      id: this.nextEntityId++,
      kind,
      pos: { ...pos },
      vel: { ...vel },
      ttl,
      owner,
      hp,
      nextActionAt: 0,
      angle: Math.atan2(vel.y, vel.x),
    };
    this.entities.push(e);
    return e;
  }

  private updateEntities(dt: number): void {
    // Le grappin déplace son porteur : traité ici pour rester lisible.
    const a = this.invader;
    if (a.flying && a.grappleTarget) {
      const to = a.grappleTarget;
      const d = dist(a.pos, to);
      const step = CFG.toolParams.grapple.travelSpeed * dt;
      if (d <= step) {
        a.pos = { ...to };
        a.flying = false;
        a.grappleTarget = null;
        a.state = 'idle';
        a.stateUntil = 0;
        a.vel = { x: 0, y: 0 };
      } else {
        a.pos = { x: a.pos.x + ((to.x - a.pos.x) / d) * step, y: a.pos.y + ((to.y - a.pos.y) / d) * step };
      }
    }

    for (const e of this.entities) {
      e.ttl -= dt;
      switch (e.kind) {
        case 'bolt': {
          // Un mur fait rebondir le carreau — jusqu'à trois fois, puis il se
          // fiche au quatrième impact. Les trous et les murets ne l'arrêtent
          // pas : il vole au-dessus.
          // La position courante est biaisée d'un cheveu vers l'arrière du
          // vol avant d'être rangée dans une tuile : un carreau posé pile sur
          // une frontière (x = 10,0 exactement) serait sinon classé dans la
          // colonne du mur qu'il longe, et rebondirait sur place jusqu'à
          // mourir sans avoir volé.
          const bx = e.pos.x - Math.sign(e.vel.x) * 1e-4;
          const by = e.pos.y - Math.sign(e.vel.y) * 1e-4;
          let vx = e.vel.x;
          let vy = e.vel.y;
          let nx = e.pos.x + vx * dt;
          let ny = e.pos.y + vy * dt;
          let bounced = false;
          if (this.boltBlocked(nx, by)) {
            vx = -vx;
            nx = e.pos.x + vx * dt;
            bounced = true;
          }
          if (this.boltBlocked(bx, ny)) {
            vy = -vy;
            ny = e.pos.y + vy * dt;
            bounced = true;
          }
          if (!bounced && this.boltBlocked(nx, ny)) {
            vx = -vx;
            vy = -vy;
            nx = e.pos.x + vx * dt;
            ny = e.pos.y + vy * dt;
            bounced = true;
          }
          if (bounced) {
            if ((e.bounces ?? 0) <= 0) {
              e.ttl = 0;
              break;
            }
            e.bounces = (e.bounces ?? 0) - 1;
            e.vel = { x: vx, y: vy };
            e.angle = Math.atan2(vy, vx);
            this.events.push({ k: 'ricochet', x: e.pos.x, y: e.pos.y });
          }
          e.pos = { x: nx, y: ny };

          // Après le premier rebond, le carreau ne connaît plus son camp :
          // il blesse quiconque le croise, tireur compris.
          const hasBounced = (e.bounces ?? 0) < CFG.combat.crossbow.bounces;
          for (const target of [this.invader, this.castellan]) {
            if (!target.alive || dist(e.pos, target.pos) >= 0.45) continue;
            const isOwner = target.role === e.owner;
            const fresh = this.now - (e.born ?? 0) < CFG.combat.crossbow.selfGrace;
            if (isOwner && !hasBounced && fresh) continue;
            if (isOwner && !hasBounced) continue;
            this.damage(target, CFG.combat.crossbow.damage, 'arbalète');
            e.ttl = 0;
            break;
          }
          if (e.ttl <= 0) break;
          for (const h of this.entities) {
            if (h.kind === 'hound' && h.hp !== undefined && dist(e.pos, h.pos) < 0.5) {
              h.hp -= CFG.combat.crossbow.damage;
              e.ttl = 0;
            }
          }
          break;
        }
        case 'bomb': {
          const next = { x: e.pos.x + e.vel.x * dt, y: e.pos.y + e.vel.y * dt };
          if (this.castle.circleHits(next.x, next.y, 0.15, 'invader', this.now, false)) {
            e.vel = { x: 0, y: 0 };
          } else {
            e.pos = next;
            e.vel.x *= 1 - 3 * dt;
            e.vel.y *= 1 - 3 * dt;
          }
          if (e.ttl <= 0) this.explode(e.pos);
          break;
        }
        case 'hound': {
          this.updateHound(e, dt);
          if (e.hp !== undefined && e.hp <= 0) e.ttl = 0;
          break;
        }
        default:
          break;
      }
    }

    this.entities = this.entities.filter((e) => e.ttl > 0);
  }

  /**
   * Un carreau est arrêté par ce qui arrête une flèche : la pierre, une porte
   * fermée, une herse. Il survole les trous et les murets.
   */
  private boltBlocked(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const t = this.castle.tile(tx, ty);
    if (t === T.WALL || t === T.RUBBLE || t === T.FRAGILE || t === T.SECRET) return true;
    if (this.castle.isBlocked(tx, ty, this.now)) return true;
    return false;
  }

  private explode(at: Vec): void {
    this.areaDamage(at, CFG.toolParams.bombs.radius, CFG.toolParams.bombs.damage, 'bombe');
    const r = Math.ceil(CFG.toolParams.bombs.radius);
    let changed = false;
    for (let y = Math.floor(at.y) - r; y <= Math.floor(at.y) + r; y++) {
      for (let x = Math.floor(at.x) - r; x <= Math.floor(at.x) + r; x++) {
        if (dist({ x: x + 0.5, y: y + 0.5 }, at) > CFG.toolParams.bombs.radius) continue;
        if (this.castle.tile(x, y) === T.FRAGILE) {
          this.castle.setTile(x, y, T.FLOOR);
          changed = true;
        }
      }
    }
    // Une bombe détruit aussi les mécanismes du sol.
    for (const t of this.traps) {
      if (t.state === 'armed' && dist({ x: t.x, y: t.y }, at) <= CFG.toolParams.bombs.radius) {
        t.state = 'disabled';
      }
    }
    if (changed) this.refreshLight();
  }

  private updateHound(e: Entity, dt: number): void {
    const target = this.invader;
    if (!target.alive) return;
    if (this.houndFieldAt < this.now - 0.4) {
      this.houndField = this.castle.bfsField(target.pos, 'invader', this.now);
      this.houndFieldAt = this.now;
    }
    const dir = this.houndField ? this.castle.descend(this.houndField, e.pos) : { x: 0, y: 0 };
    const near = dist(e.pos, target.pos);
    const chase =
      near < 1.4
        ? norm({ x: target.pos.x - e.pos.x, y: target.pos.y - e.pos.y })
        : dir;
    const sp = CFG.devices.hound.speed;
    e.vel = { x: chase.x * sp, y: chase.y * sp };
    e.pos = this.castle.moveCircle(e.pos, { x: e.vel.x * dt, y: e.vel.y * dt }, 0.3, 'invader', this.now);
    e.angle = Math.atan2(e.vel.y, e.vel.x);

    if (near < 0.75 && this.now >= (e.nextActionAt ?? 0)) {
      e.nextActionAt = this.now + CFG.devices.hound.biteCooldown;
      this.damage(target, CFG.devices.hound.damage, 'molosse');
    }
  }

  /* ================================================================== */
  /* Braseros (§7)                                                      */
  /* ================================================================== */

  private updateBraziers(input: InputFrame, dt: number): void {
    const a = this.invader;
    const litCount = this.braziers.filter((b) => b.lit).length;
    for (const b of this.braziers) {
      if (b.lit) continue;
      const near = a.alive && dist(a.pos, b.pos) < 0.9;
      if (near && input.interact && litCount < CFG.brazier.maxLit) {
        b.progress += dt / CFG.brazier.lightTime;
        if (b.progress >= 1) {
          b.lit = true;
          b.progress = 1;
          this.timeLeft += CFG.brazier.timeBonus;
          this.stats.braziersLit++;
          this.refreshLight();
          this.events.push({ k: 'brazier', id: b.id, x: b.pos.x, y: b.pos.y });
        }
      } else if (b.progress > 0) {
        b.progress = Math.max(0, b.progress - dt * 0.7);
      }
    }
  }

  /* ================================================================== */
  /* Le Cœur (§6)                                                       */
  /* ================================================================== */

  private updateCapture(dt: number): void {
    const inv = this.invader;
    const invIn = inv.alive && dist(inv.pos, this.heart) <= CFG.heart.roomRadius;
    const casIn = this.castellan.alive && dist(this.castellan.pos, this.heart) <= CFG.heart.roomRadius;
    this.contested = invIn && casIn;

    if (invIn && !casIn) {
      // La progression ne revient jamais en arrière : remettre à zéro
      // découragerait l'engagement (§6).
      this.captureProgress = Math.min(1, this.captureProgress + dt / CFG.heart.captureTime);
      if (!this.breached && this.captureProgress >= CFG.heart.breachAt) this.breach();
    }
    this.stats.captureProgress = Math.max(this.stats.captureProgress, this.captureProgress);
  }

  private breach(): void {
    this.breached = true;
    for (const t of this.traps) {
      if (dist({ x: t.x, y: t.y }, this.heart) <= CFG.heart.breachRadius && t.state === 'armed') {
        t.state = 'disabled';
      }
    }
    for (const [i, b] of Array.from(this.castle.blockers.entries())) {
      const x = i % this.plan.w;
      const y = Math.floor(i / this.plan.w);
      if (b.kind === 'lock' && dist({ x: x + 0.5, y: y + 0.5 }, this.heart) <= CFG.heart.breachRadius) {
        this.castle.blockers.delete(i);
        this.events.push({ k: 'door', x: x + 0.5, y: y + 0.5, open: true });
      }
    }
    this.events.push({ k: 'breach', x: this.heart.x, y: this.heart.y });
  }

  /* ================================================================== */
  /* Influence (§5)                                                     */
  /* ================================================================== */

  private updateInfluence(dt: number): void {
    const c = this.castellan;
    if (!c.alive) return;
    const atHeart = dist(c.pos, this.heart) <= CFG.heart.roomRadius;
    let regen = CFG.castellan.influenceRegen;
    if (atHeart) {
      regen = this.breached
        ? CFG.castellan.influenceRegenHeartBreached
        : CFG.castellan.influenceRegenHeart;
      c.hp = Math.min(CFG.castellan.maxHp, c.hp + CFG.castellan.heartHpRegen * dt);
    }
    // Le Cœur ne recharge pas celui qui scrute.
    //
    // Sans cette ligne, +7/s au Cœur contre −5/s de Scrutation donne +2/s net :
    // le Châtelain pourrait rester assis sur le Cœur, omniscient et gratuit,
    // en gelant indéfiniment la capture. Cela contredirait deux tensions de la
    // section 2 à la fois — « l'omniscience doit toujours se payer » et « un
    // Châtelain qui campe doit être structurellement perdant ».
    // Il doit choisir : recharger, ou regarder.
    if (atHeart && this.scrying) regen = 0;
    this.influence = clamp(this.influence + regen * dt, 0, CFG.castellan.influenceMax);
  }

  /* ================================================================== */
  /* Statistiques (§11)                                                 */
  /* ================================================================== */

  private updateStats(input: InputFrame, dt: number): void {
    const a = this.invader;
    if (!a.alive) return;

    const moving = Math.hypot(a.vel.x, a.vel.y) > 0.3;
    if (moving) {
      // Le temps réellement perdu à ralentir, et celui gagné à courir :
      // c'est la vraie mesure de la performance du Châtelain (§11).
      if (a.gait === 'careful') this.stats.lostCareful += dt * (1 - CFG.invader.gait.careful.speedMul);
      if (a.gait === 'run') this.stats.gainedRun += dt * (CFG.invader.gait.run.speedMul - 1);
    }
    if (a.state === 'immobile') {
      // déjà comptabilisé au déclenchement, on n'additionne pas deux fois
    }

    const ti = idx(Math.floor(a.pos.x), Math.floor(a.pos.y));
    const last = this.lastVisit.get(ti);
    if (last !== undefined && this.now - last > 8 && moving) {
      // Revenir sur ses pas huit secondes plus tard, c'est un détour.
      this.stats.lostDetour += dt;
    }
    this.lastVisit.set(ti, this.now);
    this.visited.add(ti);

    if (this.now - this.pathSampleAt >= 0.25) {
      this.pathSampleAt = this.now;
      this.stats.path.push({ x: a.pos.x, y: a.pos.y, t: this.now });
    }

    if (a.gait !== this.lastGait) this.lastGait = a.gait;
    void input;
  }

  /* ================================================================== */
  /* Perception                                                         */
  /* ================================================================== */

  /**
   * Indices actuellement perceptibles par l'Envahisseur.
   * Rien dans le retour ne distingue un vrai piège d'un faux (§4).
   */
  visibleTells(): TrapRuntime[] {
    const a = this.invader;
    if (!a.alive) return [];
    const g = CFG.invader.gait[a.gait];
    const out: TrapRuntime[] = [];
    const probing = this.probedRoom >= 0 && this.now < this.probedUntil;

    for (const t of this.traps) {
      if (t.state === 'spent' || t.state === 'disabled') continue;
      const p = { x: t.x, y: t.y };
      const d = dist(a.pos, p);
      const spec = CFG.traps[t.kind];

      let seen = false;
      if (probing && this.castle.roomAt(t.x, t.y) === this.probedRoom) {
        seen = true;
      } else if ('alwaysVisible' in spec && spec.alwaysVisible) {
        // Le coffre est un appât : il se voit de loin, c'est tout son intérêt.
        seen = d <= CFG.vision.invaderRange && this.castle.losClear(a.pos, p);
      } else if (d <= g.senseRadius && this.castle.losClear(a.pos, p)) {
        seen = !g.needsLight || this.castle.lightAt(t.x, t.y) >= CFG.vision.lightThreshold;
      }

      if (seen) {
        t.discovered = true;
        out.push(t);
      }
    }
    return out;
  }

  /** Le Châtelain perçoit-il l'Envahisseur, et par quel canal ? */
  castellanSees(): 'scry' | 'reveal' | 'sight' | null {
    if (!this.invader.alive) return null;
    if (this.scrying) return 'scry';
    if (this.now < this.revealUntil) return 'reveal';
    const c = this.castellan;
    const d = dist(c.pos, this.invader.pos);
    if (d <= CFG.vision.castellanRange && this.castle.losClear(c.pos, this.invader.pos)) return 'sight';
    return null;
  }

  /** L'Envahisseur voit-il le Châtelain ? */
  invaderSees(): boolean {
    if (!this.castellan.alive) return false;
    const a = this.invader;
    const d = dist(a.pos, this.castellan.pos);
    if (d > CFG.vision.invaderRange) return false;
    if (!this.castle.losClear(a.pos, this.castellan.pos)) return false;
    // Hors du cône de vue, on ne perçoit qu'à courte distance.
    const ang = Math.atan2(this.castellan.pos.y - a.pos.y, this.castellan.pos.x - a.pos.x);
    if (angleDelta(ang, a.aim) > CFG.vision.coneHalfAngle && d > CFG.vision.coneFalloffRange) {
      return false;
    }
    return true;
  }

  /* ================================================================== */
  /* Lumière et fin de manche                                           */
  /* ================================================================== */

  refreshLight(): void {
    if (this.castle.dousedUntil > 0 && this.now >= this.castle.dousedUntil) {
      this.castle.dousedCenter = null;
      this.castle.dousedUntil = 0;
    }
    const sources = this.braziers
      .filter((b) => b.lit)
      .map((b) => ({ pos: b.pos, radius: CFG.brazier.lightRadius, power: 0.95 }));
    sources.push({ pos: this.heart, radius: 5.5, power: 0.8 });
    this.castle.setDynamicSources(sources);
    this.lightDirtyAt = this.now;
  }

  private checkEnd(): void {
    if (this.over) return;
    if (this.captureProgress >= 1) {
      this.over = { winner: 'invader', outcome: 'capture' };
    } else if (!this.castellan.alive) {
      this.over = { winner: 'invader', outcome: 'kill_castellan' };
    } else if (!this.invader.alive) {
      this.over = { winner: 'castellan', outcome: 'kill_invader' };
    } else if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.over = { winner: 'castellan', outcome: 'timeout' };
    }
    if (this.over) {
      this.stats.trapsAvoided = this.traps
        .filter((t) => t.kind !== 'decoy' && t.approached && t.triggeredAt < 0)
        .map((t) => t.id);
    }
  }

  /** Vide et renvoie les événements accumulés depuis le dernier appel. */
  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Extinction en cours : l'aile est-elle éteinte ? */
  dousedInfo(): { x: number; y: number; r: number; until: number } | null {
    if (!this.castle.dousedCenter || this.now >= this.castle.dousedUntil) return null;
    return {
      x: this.castle.dousedCenter.x,
      y: this.castle.dousedCenter.y,
      r: this.castle.dousedRadius,
      until: this.castle.dousedUntil,
    };
  }
}

/* ==================================================================== */
/* Aides                                                                */
/* ==================================================================== */

function makeActor(role: Role, pos: Vec, hp: number): Actor {
  return {
    role,
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    aim: role === 'invader' ? 0 : Math.PI,
    hp,
    gait: 'normal',
    state: 'idle',
    stateUntil: 0,
    invulnUntil: 0,
    actionLockUntil: 0,
    swungAt: -1,
    dodgeReadyAt: 0,
    dodgeDir: { x: 1, y: 0 },
    alive: true,
    stepPhase: 0,
    flying: false,
    grappleTarget: null,
    castKind: null,
    crossbowReadyAt: 0,
  };
}

function stateSpeedMul(s: ActorState): number {
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

function clampVec(v: Vec): Vec {
  const m = Math.hypot(v.x, v.y);
  if (m <= 1) return v;
  return { x: v.x / m, y: v.y / m };
}

function norm(v: Vec): Vec {
  const m = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / m, y: v.y / m };
}

export type { TrapKind, DeviceKind, ToolKind };
