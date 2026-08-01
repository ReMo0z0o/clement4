/**
 * Banc d'essai headless.
 *
 *   npx tsx scripts/playtest.ts [nombre de manches]
 *
 * Fait jouer deux robots des manches complètes, en boucle.
 *
 * CE QU'IL PROUVE, et c'est déjà beaucoup :
 *   - toute manche se termine, sur les trois plans, quoi qu'il arrive ;
 *   - aucun instantané ne laisse fuir une information interdite ;
 *   - la simulation tourne de bout en bout sans DOM ni React (§18) ;
 *   - rien ne casse quand on enchaîne des centaines de manches.
 *
 * CE QU'IL NE PROUVE PAS : l'équilibrage. Les robots sont faibles — le robot
 * Châtelain n'attire personne dans une pièce préparée, il se contente de tenir
 * son Cœur. Les chiffres de plaisir de la section 19 (changements d'allure,
 * entrées en Scrutation, temps perdu aux faux indices) ne veulent donc rien
 * dire ici : le cahier précise lui-même qu'ils se vérifient « en playtest réel,
 * à deux ». Ils sont affichés à titre indicatif, jamais comme une validation.
 */

import { CFG, TICK_DT } from '../src/game/config';
import type { TrapKind } from '../src/game/config';
import { getPlan } from '../src/game/plans';
import { World } from '../src/game/sim';
import { sanitizeBuild, sanitizeLoadout } from '../src/game/prep';
import { SnapshotFilter, auditSnapshot } from '../src/game/snapshot';
import { T, dist, emptyInput } from '../src/game/types';
import type { BuildOrder, CastlePlan, Loadout, PlanId, Vec } from '../src/game/types';
import { idx } from '../src/game/grid';

/* ==================================================================== */
/* Un château plausible, construit par une heuristique simple            */
/* ==================================================================== */

function autoBuild(plan: CastlePlan, seed: number): BuildOrder {
  const rng = mulberry(seed);
  const floors: Vec[] = [];
  for (let y = 0; y < plan.h; y++) {
    for (let x = 0; x < plan.w; x++) {
      if (plan.tiles[idx(x, y)] !== T.FLOOR) continue;
      const c = { x: x + 0.5, y: y + 0.5 };
      if (dist(c, plan.invaderSpawn) < 3) continue;
      floors.push(c);
    }
  }
  const heartIndex = Math.floor(rng() * plan.heartCandidates.length);
  const heart = plan.heartCandidates[heartIndex];
  // On piège plus densément autour du Cœur : c'est ce que ferait un joueur.
  floors.sort((a, b) => dist(a, heart) - dist(b, heart));

  const build: BuildOrder = {
    planId: plan.id,
    heartIndex,
    traps: [],
    devices: [],
    lockedDoors: [],
    secretDoors: [],
    spent: 0,
  };

  const menu: TrapKind[] = ['spikes', 'arrows', 'collapse', 'boulder', 'chest'];
  let spent = 0;
  let id = 0;
  const take = (pool: Vec[]) => pool[Math.floor(rng() * pool.length)];
  const near = floors.slice(0, Math.max(12, Math.floor(floors.length * 0.45)));

  while (spent < 62 && build.traps.length < 12) {
    const kind = menu[Math.floor(rng() * menu.length)];
    const cost = CFG.traps[kind].cost;
    if (spent + cost > 62) break;
    const p = take(near);
    if (build.traps.some((t) => Math.floor(t.x) === Math.floor(p.x) && Math.floor(t.y) === Math.floor(p.y))) {
      continue;
    }
    build.traps.push({ id: id++, kind, x: p.x, y: p.y, tell: CFG.traps[kind].tell, facing: 0 });
    spent += cost;
  }
  // Des faux indices : l'investissement le plus rentable du jeu.
  while (spent + CFG.traps.decoy.cost <= 78 && build.traps.length < 22) {
    const p = take(floors);
    if (build.traps.some((t) => Math.floor(t.x) === Math.floor(p.x) && Math.floor(t.y) === Math.floor(p.y))) {
      continue;
    }
    build.traps.push({ id: id++, kind: 'decoy', x: p.x, y: p.y, tell: 'seam', facing: 0 });
    spent += CFG.traps.decoy.cost;
  }
  // Un ou deux mécanismes, et un passage secret.
  const devs: ('trapdoor' | 'portcullis' | 'chandelier')[] = ['trapdoor', 'chandelier', 'portcullis'];
  for (const d of devs) {
    const cost = CFG.devices[d].cost;
    if (spent + cost > 95) break;
    if (d === 'portcullis') {
      const door = plan.doors[Math.floor(rng() * plan.doors.length)];
      if (!door) continue;
      build.devices.push({ id: build.devices.length, kind: d, x: door.x, y: door.y, facing: 0 });
    } else {
      const p = take(near);
      build.devices.push({ id: build.devices.length, kind: d, x: p.x, y: p.y, facing: 0 });
    }
    spent += cost;
  }
  if (spent + CFG.fixtures.secretDoor.cost <= 100 && plan.secretSpots.length) {
    build.secretDoors.push(Math.floor(rng() * plan.secretSpots.length));
  }
  return sanitizeBuild(plan, build).build;
}

function autoLoadout(seed: number): Loadout {
  const rng = mulberry(seed + 91);
  const pool: Loadout['tools'] = ['crossbow', 'probe', 'grapple', 'bombs', 'elixir', 'buckler'];
  const tools: Loadout['tools'] = [];
  let spent = 0;
  while (tools.length < 3) {
    const t = pool[Math.floor(rng() * pool.length)];
    if (tools.includes(t)) continue;
    if (spent + CFG.tools[t].cost > 48) break;
    tools.push(t);
    spent += CFG.tools[t].cost;
  }
  const intel: Loadout['intel'] = rng() > 0.5 ? ['brazier'] : [];
  return sanitizeLoadout({ tools, intel, spent: 0 }).loadout;
}

/* ==================================================================== */
/* Les robots                                                            */
/* ==================================================================== */

interface Report {
  outcome: string;
  winner: string;
  seconds: number;
  gaitSwitches: number;
  scryCount: number;
  scryTime: number;
  lostCareful: number;
  lostTraps: number;
  lostDetour: number;
  trapsTriggered: number;
  trapsUntouched: number;
  capture: number;
  braziers: number;
  invaderHp: number;
  castellanHp: number;
  /** Progression de capture à mi-manche : sert à détecter les manches jouées d'avance. */
  halfwayCapture: number;
  leaks: string[];
}

function runRound(planId: PlanId, seed: number): Report {
  const plan = getPlan(planId);
  const build = autoBuild(plan, seed);
  const loadout = autoLoadout(seed);
  const w = new World({ plan, build, loadout, duration: CFG.match.roundDuration });

  const invFilter = new SnapshotFilter('invader', w, {});
  const casFilter = new SnapshotFilter('castellan', w, {});
  const leaks = new Set<string>();

  const rng = mulberry(seed * 7 + 3);
  let goal: Vec = w.heart;
  let field = w.castle.bfsField(goal, 'invader', 0);
  let fieldAt = -10;
  let halfwayCapture = -1;

  let knowsHeart = false;
  /** Dernière position connue de l'Envahisseur, et sa fraîcheur. */
  let lastSeen: Vec | null = null;
  let lastSeenAt = -99;
  let scryUntil = -1;
  let nextScryAt = 1.5;

  const steps = Math.ceil((CFG.match.roundDuration + 60) / TICK_DT);
  for (let i = 0; i < steps && !w.over; i++) {
    const invIn = emptyInput(i);
    const casIn = emptyInput(i);
    const gap = dist(w.invader.pos, w.castellan.pos);

    /* ================= Envahisseur =================
     * Il ne sait pas où est le Cœur. Il explore, exactement comme un joueur :
     * lui donner la position dès la première seconde transformerait chaque
     * manche en course de huit secondes et ne mesurerait plus rien. */
    if (!knowsHeart && w.seenHeart) knowsHeart = true;
    if (knowsHeart) {
      goal = w.heart;
    } else if (w.now > 18 && rng() < 0.004) {
      // Il n'a pas trouvé : il va chercher du temps ailleurs (plan B, §7).
      const unlit = w.braziers.filter((b) => !b.lit && w.seenBraziers.has(b.id));
      if (unlit.length) goal = unlit[Math.floor(rng() * unlit.length)].pos;
    } else if (!knowsHeart && (w.now - fieldAt > 0.5 || dist(w.invader.pos, goal) < 1.2)) {
      goal = frontier(w) ?? goal;
    }

    if (w.now - fieldAt > 0.5) {
      field = w.castle.bfsField(goal, 'invader', w.now);
      fieldAt = w.now;
    }
    const dir = w.castle.descend(field, w.invader.pos);
    invIn.move = dir;
    if (dir.x !== 0 || dir.y !== 0) invIn.aim = Math.atan2(dir.y, dir.x);

    const engaged = w.invaderSees() && gap < 2.6;
    if (engaged) {
      // En prise, il fait face : sans ça il frappe le vide et la mesure du
      // duel n'a plus aucun sens.
      const c = w.castellan.pos;
      invIn.aim = Math.atan2(c.y - w.invader.pos.y, c.x - w.invader.pos.x);
      invIn.move = gap > 1.15 ? { x: Math.cos(invIn.aim), y: Math.sin(invIn.aim) } : { x: 0, y: 0 };
      invIn.gait = 'normal';
      invIn.primary = gap < 1.35;
    } else {
      // Il ralentit sur un indice, court quand la voie lui paraît nette.
      // Le balayage périodique évite qu'il reste figé en allure prudente dès
      // qu'un indice traîne dans son rayon — ce qui fausserait la mesure.
      const tellsNear = w.visibleTells().length > 0;
      const scanning = Math.floor(w.now / 2.5) % 2 === 0;
      invIn.gait = tellsNear && scanning ? 'careful' : Math.floor(w.now / 3.5) % 3 === 0 ? 'run' : 'normal';
    }
    invIn.interact = dist(w.invader.pos, goal) < 1 && goal !== w.heart;

    /* ================= Châtelain ==================
     * Il joue comme le cahier le demande : il ne charge jamais en terrain
     * neutre (§9), il reste tiré vers son Cœur pour recharger (§2.1), et il
     * n'engage que ce qu'il a préparé. */
    const via = w.castellanSees();
    if (via) {
      lastSeen = { ...w.invader.pos };
      lastSeenAt = w.now;
    }
    const fresh = w.now - lastSeenAt < 6;

    // Scrutation par salves : chercher, puis agir. Jamais avec l'autre sur le dos.
    if (w.now >= nextScryAt && w.influence > 25 && gap > 4) {
      scryUntil = w.now + 1 + rng() * 1.2;
      nextScryAt = w.now + 4 + rng() * 3;
    }
    casIn.scry = w.now < scryUntil && w.influence > 8 && gap > 3;

    if (casIn.scry) {
      // Vu d'en haut, il déclenche ce qui se trouve sous les pieds de l'autre.
      const ready = w.devices.find(
        (d) =>
          !d.used &&
          w.influence >= CFG.devices[d.kind].influence &&
          dist({ x: d.x, y: d.y }, w.invader.pos) < 2.2,
      );
      if (ready) casIn.device = ready.id;
    } else {
      const vulnerable =
        w.invader.state === 'immobile' || w.invader.state === 'stun' || w.invader.hp < 35;
      let target: Vec;
      if (fresh && lastSeen && vulnerable) {
        target = lastSeen; // une ouverture : c'est le seul moment où il fond
      } else if (w.influence < 55) {
        target = w.heart; // sa batterie le rappelle
      } else if (fresh && lastSeen) {
        // Il se rapproche sans se montrer : il veut le recevoir chez lui.
        target = w.captureProgress > 0.15 ? w.heart : lastSeen;
      } else {
        target = w.heart;
      }
      const f = w.castle.bfsField(target, 'castellan', w.now);
      const d = w.castle.descend(f, w.castellan.pos);
      // Il garde ses distances tant qu'il n'a pas d'ouverture.
      const holdBack = !vulnerable && gap < 2.2 && target !== w.heart;
      casIn.move = holdBack ? { x: -d.x, y: -d.y } : d;
      if (d.x !== 0 || d.y !== 0) casIn.aim = Math.atan2(d.y, d.x);
      if (gap < 1.3) {
        casIn.aim = Math.atan2(w.invader.pos.y - w.castellan.pos.y, w.invader.pos.x - w.castellan.pos.x);
        casIn.primary = true;
      }
    }

    w.step(invIn, casIn);
    w.drainEvents();

    if (halfwayCapture < 0 && w.timeLeft <= CFG.match.roundDuration / 2) {
      halfwayCapture = w.captureProgress;
    }

    /* --- Contrôle de fuite d'information, à chaque instantané --- */
    if (i % 6 === 0) {
      const opts = { phase: 'invasion' as const, tick: i, ackSeq: i, score: { host: 0, guest: 0 }, round: 1 };
      for (const p of auditSnapshot(invFilter.build(w, opts), 'invader', w)) leaks.add(p);
      for (const p of auditSnapshot(casFilter.build(w, opts), 'castellan', w)) leaks.add(p);
    }
  }

  const s = w.stats;
  return {
    outcome: w.over?.outcome ?? 'INTERMINABLE',
    winner: w.over?.winner ?? '—',
    seconds: s.timeElapsed,
    gaitSwitches: s.gaitSwitches,
    scryCount: s.scryCount,
    scryTime: s.scryTime,
    lostCareful: s.lostCareful,
    lostTraps: s.lostTraps,
    lostDetour: s.lostDetour,
    trapsTriggered: s.trapsTriggered.length,
    trapsUntouched: s.trapsUntouched.length,
    capture: w.captureProgress,
    braziers: s.braziersLit,
    invaderHp: w.invader.hp,
    castellanHp: w.castellan.hp,
    halfwayCapture: halfwayCapture < 0 ? 0 : halfwayCapture,
    leaks: Array.from(leaks),
  };
}

/**
 * Case inexplorée la plus proche, atteignable à pied.
 *
 * C'est ce qui rend le robot honnête : il ne connaît que ce que la simulation
 * lui a réellement montré, via le même ensemble `explored` que celui qui filtre
 * les instantanés réseau.
 */
function frontier(w: World): Vec | null {
  const start = idx(Math.floor(w.invader.pos.x), Math.floor(w.invader.pos.y));
  const seen = new Set<number>([start]);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % w.plan.w;
    const cy = Math.floor(cur / w.plan.w);
    if (!w.explored.has(cur)) return { x: cx + 0.5, y: cy + 0.5 };
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w.plan.w || ny >= w.plan.h) continue;
      const ni = idx(nx, ny);
      if (seen.has(ni)) continue;
      seen.add(ni);
      if (w.castle.blocksMove(nx, ny, 'invader', w.now)) continue;
      queue.push(ni);
    }
  }
  return null;
}

function mulberry(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================================================================== */
/* Rapport                                                              */
/* ==================================================================== */

const N = Number(process.argv[2] ?? 12);
const plans: PlanId[] = ['compact', 'labyrinth', 'open'];
const all: Report[] = [];

console.log(`Banc d'essai — ${N} manches par plan\n`);

for (const p of plans) {
  const rows: Report[] = [];
  for (let i = 0; i < N; i++) rows.push(runRound(p, i * 137 + 11));
  all.push(...rows);

  const avg = (f: (r: Report) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const count = (f: (r: Report) => boolean) => rows.filter(f).length;

  console.log(`## ${p}`);
  console.log(`   issues        ${tally(rows.map((r) => r.outcome))}`);
  console.log(
    `   durée         ${avg((r) => r.seconds).toFixed(0)} s · capture atteinte ${(avg((r) => r.capture) * 100).toFixed(0)} %`,
  );
  console.log(
    `   PV finaux     Envahisseur ${avg((r) => r.invaderHp).toFixed(0)} · Châtelain ${avg((r) => r.castellanHp).toFixed(0)}`,
  );
  console.log(
    `   pièges        ${avg((r) => r.trapsTriggered).toFixed(1)} déclenchés · ${avg(
      (r) => r.trapsUntouched,
    ).toFixed(1)} jamais approchés`,
  );
  console.log(`   manches finies ${count((r) => r.outcome !== 'INTERMINABLE')} / ${rows.length}`);
  const leaks = new Set(rows.flatMap((r) => r.leaks));
  console.log(`   fuites info   ${leaks.size === 0 ? '✓ aucune' : `✗ ${Array.from(leaks).join(' | ')}`}`);
  console.log(
    `   [indicatif]   ${avg((r) => r.gaitSwitches).toFixed(0)} changements d'allure · ` +
      `${avg((r) => r.scryCount).toFixed(1)} entrées en Scrutation · ` +
      `${(avg((r) => r.lostCareful) + avg((r) => r.lostTraps) + avg((r) => r.lostDetour)).toFixed(1)} s perdues`,
  );
  console.log('');
}

const stuck = all.filter((r) => r.outcome === 'INTERMINABLE');
const invWins = all.filter((r) => r.winner === 'invader').length;
console.log('## Ensemble');
console.log(`   ${all.length} manches · Envahisseur ${invWins} / Châtelain ${all.length - invWins}`);
if (stuck.length) {
  console.error(`   ✗ ${stuck.length} manche(s) ne se terminent pas.`);
  process.exit(1);
}
const anyLeak = all.some((r) => r.leaks.length);
if (anyLeak) {
  console.error('   ✗ Fuite d’information détectée.');
  process.exit(1);
}
console.log('   ✓ Toutes les manches se terminent, aucune fuite d’information.');
console.log('');
console.log('   Les lignes [indicatif] ne valident rien : les robots jouent mal, et');
console.log('   surtout le robot Châtelain n’utilise presque pas ses pièges. Les');
console.log('   critères de plaisir de la section 19 se vérifient à deux, sur un vrai');
console.log('   match — c’est ce que le cahier des charges demande.');

function tally(list: string[]): string {
  const m = new Map<string, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}
