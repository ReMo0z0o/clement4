/**
 * Castle Siege — types partagés.
 *
 * Ce fichier est le contrat entre la simulation (`src/game`), le réseau
 * (`src/net`), le rendu (`src/render`) et l'UI (`src/components`).
 * Il ne dépend ni de React ni du DOM : la simulation doit tourner dans un
 * test Node (§18).
 */

import type { DeviceKind, IntelKind, TellKind, ToolKind, TrapKind } from './config';

// Ré-exportés ici pour que le reste du projet n'ait qu'un seul point d'entrée
// de types, sans avoir à savoir lesquels sont dérivés de la configuration.
export type { DeviceKind, IntelKind, TellKind, ToolKind, TrapKind };

/* ==================================================================== */
/* Géométrie                                                            */
/* ==================================================================== */

/** Position en TUILES (pas en pixels). */
export interface Vec {
  x: number;
  y: number;
}

/* ==================================================================== */
/* Le château                                                           */
/* ==================================================================== */

export const T = {
  WALL: 0,
  FLOOR: 1,
  DOOR: 2,
  SECRET: 3,
  /** Trou laissé par un sol effondré : infranchissable sans grappin. */
  PIT: 4,
  /** Éboulement : passage condamné définitivement. */
  RUBBLE: 5,
  /** Mur fragile : ouvrable à la bombe. */
  FRAGILE: 6,
  /** Muret : bloque le pas, pas le regard, franchissable au grappin. */
  LOW: 7,
} as const;

export type TileId = (typeof T)[keyof typeof T];

/** Caractères d'écriture des plans (lisibles en ASCII art). */
export const PLAN_CHARS: Record<string, TileId> = {
  '#': T.WALL,
  '.': T.FLOOR,
  '+': T.DOOR,
  '%': T.SECRET,
  ',': T.LOW,
  f: T.FRAGILE,
  // marqueurs : la tuile dessous est du sol
  S: T.FLOOR,
  C: T.FLOOR,
  H: T.FLOOR,
  B: T.FLOOR,
  t: T.WALL, // torche murale
};

export type PlanId = 'compact' | 'labyrinth' | 'open';

/** Un plan tel qu'il est écrit à la main, avant compilation. */
export interface PlanSource {
  id: PlanId;
  name: string;
  blurb: string;
  rows: string[];
  /**
   * Fourchette de surface jouable visée, en fraction de la grille.
   * Chaque plan a son identité : un labyrinthe doit être dense, une grande
   * salle doit être aérée. Vérifié par `npm run plans`.
   */
  density: [number, number];
}

/** Plan compilé, prêt pour la simulation. */
export interface CastlePlan {
  id: PlanId;
  name: string;
  blurb: string;
  w: number;
  h: number;
  /** Longueur w*h, indexé y*w+x. */
  tiles: TileId[];
  invaderSpawn: Vec;
  castellanSpawn: Vec;
  /** Les 3 emplacements candidats du Cœur. */
  heartCandidates: Vec[];
  brazierSpots: Vec[];
  torches: Vec[];
  /** Portes (tuiles DOOR), verrouillables à la préparation. */
  doors: Vec[];
  /** Emplacements où un passage secret peut être percé. */
  secretSpots: Vec[];
  /** Identifiant de pièce par tuile (−1 pour les murs), pour la Sonde. */
  rooms: Int16Array;
  roomCount: number;
}

/* ==================================================================== */
/* Préparation                                                          */
/* ==================================================================== */

export interface TrapPlacement {
  id: number;
  kind: TrapKind;
  x: number;
  y: number;
  /** Apparence de l'indice. Pour un faux indice, choisie par le joueur. */
  tell: TellKind;
  /** Orientation, utile aux flèches murales. */
  facing: number;
}

export interface SensorPlacement {
  id: number;
  x: number;
  y: number;
}

export interface DevicePlacement {
  id: number;
  kind: DeviceKind;
  x: number;
  y: number;
  facing: number;
}

/** Ce que le Châtelain a construit. Persisté entre les manches 1 et 3. */
export interface BuildOrder {
  planId: PlanId;
  heartIndex: number;
  traps: TrapPlacement[];
  devices: DevicePlacement[];
  /** Index dans `plan.doors`. */
  lockedDoors: number[];
  /** Index dans `plan.secretSpots`. */
  secretDoors: number[];
  /** Les guets du Châtelain : trois détecteurs de passage. */
  sensors?: SensorPlacement[];
  spent: number;
}

/** Ce que l'Envahisseur a acheté. */
export interface Loadout {
  tools: ToolKind[];
  intel: IntelKind[];
  spent: number;
}

/** Renseignement résolu, calculé par l'hôte au début de la manche. */
export interface IntelResult {
  /** Candidats du Cœur éliminés (indices dans `plan.heartCandidates`). */
  eliminatedHeart?: number[];
  /** Brasero révélé (index dans `braziers`). */
  brazier?: number;
  /** Répartition du budget adverse. */
  budget?: { traps: number; devices: number; decoys: number; fixtures: number };
}

/* ==================================================================== */
/* Entités de simulation                                                */
/* ==================================================================== */

export type Gait = 'careful' | 'normal' | 'run';
export type Role = 'castellan' | 'invader';

export type ActorState =
  | 'idle'
  | 'move'
  | 'windup'
  | 'recover'
  | 'parry'
  | 'dodge'
  | 'stun'
  | 'immobile'
  | 'casting'
  | 'scrying'
  | 'dead';

export interface Actor {
  role: Role;
  pos: Vec;
  vel: Vec;
  /** Angle de visée, en radians. */
  aim: number;
  hp: number;
  gait: Gait;
  state: ActorState;
  /** Fin (en temps de manche) de l'état courant. */
  stateUntil: number;
  /** Immunité aux dégâts jusqu'à. */
  invulnUntil: number;
  /** Interdiction d'agir jusqu'à (hitstun, reprise de Scrutation). */
  actionLockUntil: number;
  /** L'attaque en cours a-t-elle déjà touché ? */
  swungAt: number;
  dodgeReadyAt: number;
  /** Direction de l'esquive en cours. */
  dodgeDir: Vec;
  alive: boolean;
  /** Distance parcourue depuis le dernier pas, pour le son. */
  stepPhase: number;
  /** Au grappin : franchit les trous et les murets. */
  flying: boolean;
  grappleTarget: Vec | null;
  /** Outil en cours d'incantation. */
  castKind: 'elixir' | null;
  /** Prochaine seconde à laquelle l'arbalète peut tirer. */
  crossbowReadyAt: number;
}

export interface TrapRuntime extends TrapPlacement {
  state: 'armed' | 'spent' | 'disabled';
  /** L'Envahisseur a vu l'indice au moins une fois → « grillé » en manche 3. */
  discovered: boolean;
  /** L'Envahisseur s'est approché à moins de 2 tuiles sans le déclencher. */
  approached: boolean;
  triggeredAt: number;
}

export interface DeviceRuntime extends DevicePlacement {
  used: boolean;
  /** Instant de fin d'effet (herse levée, extinction, molosse). */
  activeUntil: number;
  discovered: boolean;
}

export type EntityKind =
  | 'bolt'
  | 'bomb'
  | 'hound'
  | 'grapple'
  | 'blast'
  | 'chandelier_fall'
  | 'boulder_fall';

export interface Entity {
  id: number;
  kind: EntityKind;
  pos: Vec;
  vel: Vec;
  /** Temps de vie restant, en secondes. */
  ttl: number;
  owner: Role;
  hp?: number;
  /** Cooldown interne (morsure du molosse). */
  nextActionAt?: number;
  angle?: number;
  /** Carreau : rebonds restants. */
  bounces?: number;
  /** Carreau : instant de tir, pour l'immunité du tireur avant rebond. */
  born?: number;
}

export interface Brazier {
  id: number;
  pos: Vec;
  lit: boolean;
  /** Progression d'allumage, 0..1. */
  progress: number;
}

/* ==================================================================== */
/* Statistiques de manche (§11)                                         */
/* ==================================================================== */

export interface RoundStats {
  /** Secondes perdues par l'Envahisseur, ventilées par cause. */
  lostCareful: number;
  lostTraps: number;
  lostDetour: number;
  /** Secondes gagnées à la course (compteur miroir, pour la lisibilité). */
  gainedRun: number;
  damageBySource: Record<string, number>;
  trapsTriggered: number[];
  trapsAvoided: number[];
  trapsUntouched: number[];
  /** Trajet échantillonné (~4 Hz) pour la carte de chaleur du réaménagement. */
  path: { x: number; y: number; t: number }[];
  braziersLit: number;
  captureProgress: number;
  scryCount: number;
  scryTime: number;
  gaitSwitches: number;
  timeElapsed: number;
}

export function emptyStats(): RoundStats {
  return {
    lostCareful: 0,
    lostTraps: 0,
    lostDetour: 0,
    gainedRun: 0,
    damageBySource: {},
    trapsTriggered: [],
    trapsAvoided: [],
    trapsUntouched: [],
    path: [],
    braziersLit: 0,
    captureProgress: 0,
    scryCount: 0,
    scryTime: 0,
    gaitSwitches: 0,
    timeElapsed: 0,
  };
}

/* ==================================================================== */
/* Entrées joueur                                                       */
/* ==================================================================== */

export interface InputFrame {
  seq: number;
  /** Horodatage client, en secondes. */
  t: number;
  move: Vec;
  aim: number;
  gait: Gait;
  primary: boolean;
  /** Tir d'arbalète (clic droit). Impulsion : ne vaut que pour un tick. */
  secondary: boolean;
  parry: boolean;
  dodge: boolean;
  interact: boolean;
  scry: boolean;
  /** Index d'outil déclenché ce tick, ou −1. */
  tool: number;
  /** Mécanisme déclenché en Scrutation ce tick, ou −1. */
  device: number;
  /** Piège à réarmer en Scrutation, ou −1. */
  rearm: number;
}

export function emptyInput(seq = 0): InputFrame {
  return {
    seq,
    t: 0,
    move: { x: 0, y: 0 },
    aim: 0,
    gait: 'normal',
    primary: false,
    secondary: false,
    parry: false,
    dodge: false,
    interact: false,
    scry: false,
    tool: -1,
    device: -1,
    rearm: -1,
  };
}

/* ==================================================================== */
/* Phases et état de match                                              */
/* ==================================================================== */

export type Phase =
  | 'lobby'
  | 'plan_select'
  | 'prep'
  | 'countdown'
  | 'invasion'
  | 'round_end'
  | 'match_end';

export type RoundOutcome = 'capture' | 'kill_castellan' | 'kill_invader' | 'timeout';

export interface RoundResult {
  round: number;
  /** Vainqueur : le rôle gagnant. */
  winner: Role;
  outcome: RoundOutcome;
  stats: RoundStats;
  /** Temps restant au moment de la fin, en secondes. */
  timeLeft: number;
}

/* ==================================================================== */
/* Instantanés réseau (§13)                                             */
/* ==================================================================== */

/** Indice tel qu'il est transmis : rien ne distingue un vrai d'un faux. */
export interface VisibleTell {
  id: number;
  tell: TellKind;
  x: number;
  y: number;
  facing: number;
}

export interface SnapshotSelf {
  x: number;
  y: number;
  hp: number;
  aim: number;
  gait: Gait;
  state: ActorState;
  influence: number;
  scrying: boolean;
  dodgeReadyAt: number;
  actionLockUntil: number;
  /** Usages restants par outil, dans l'ordre du loadout. */
  toolUses: number[];
  toolCooldowns: number[];
  shieldHp: number;
  /** Temps restant avant le prochain tir d'arbalète. */
  crossbowCooldown: number;
}

export interface SnapshotOther {
  x: number;
  y: number;
  aim: number;
  state: ActorState;
  gait: Gait;
  hp: number;
  /** Pourquoi cette position est visible — utile au rendu. */
  via: 'sight' | 'scry' | 'reveal' | 'alarm' | 'sensor';
}

export interface Snapshot {
  tick: number;
  ackSeq: number;
  phase: Phase;
  timeLeft: number;
  /** Temps écoulé de manche, référence commune pour les timers. */
  now: number;
  self: SnapshotSelf;
  /** `null` si l'adversaire n'est pas perçu — jamais de position cachée. */
  other: SnapshotOther | null;
  entities: { id: number; kind: EntityKind; x: number; y: number; a: number; ttl: number }[];
  /** Filtré côté hôte selon l'allure et la ligne de vue. */
  tells: VisibleTell[];
  /** Pièges déclenchés visibles / connus (fosses ouvertes, trous). */
  scars: { id: number; kind: TrapKind; x: number; y: number }[];
  capture: { progress: number; contested: boolean; breached: boolean };
  braziers: { id: number; x: number; y: number; lit: boolean; progress: number }[];
  /**
   * Tuiles nouvellement révélées à ce destinataire, en delta. Le client
   * accumule. C'est ce qui garantit que le tracé des murs reste une
   * information à mériter — ou à acheter (Plan volé, §8).
   */
  newTiles: { i: number; t: TileId }[];
  /** Modifications de tuiles depuis le plan de base (trous, éboulements). */
  tileEdits: { i: number; t: TileId }[];
  /**
   * Herses baissées et portes verrouillées.
   *
   * `kind` voyage avec l'obstacle : une herse arrête tout le monde, un verrou
   * ne gêne que l'Envahisseur. Sans lui, le client prédisait les deux comme des
   * verrous et traversait les herses avant de se faire recaler par l'hôte.
   */
  blockers: { x: number; y: number; until: number; kind: 'portcullis' | 'lock' }[];
  doused: { x: number; y: number; r: number; until: number }[];
  alarm: boolean;
  /** Réservé au Châtelain : état de ses mécanismes. */
  devices?: { id: number; kind: DeviceKind; x: number; y: number; ready: boolean; used: boolean }[];
  /** Réservé au Châtelain : ses propres pièges. */
  ownTraps?: { id: number; kind: TrapKind; x: number; y: number; state: string }[];
  /** Réservé au Châtelain : ses guets, leur réserve et celui qui veille. */
  sensors?: { id: number; x: number; y: number; watchLeft: number; watching: boolean }[];
  /** Réservé au Châtelain : dernier point de passage vu par un guet. */
  ping?: { x: number; y: number; age: number } | null;
  /**
   * Réservé à l'Envahisseur : il est dans le cercle d'un guet, et il le sait.
   *
   * On lui donne la position du guet qui le tient, pas celle des autres : ce
   * qu'il apprend, il vient de le mériter en entrant dedans. C'est ce qui
   * transforme la détection en décision — contourner, fuir, ou user la réserve.
   */
  spotted?: { x: number; y: number } | null;
  /** `null` tant que l'Envahisseur ne l'a pas trouvé. */
  heart: { x: number; y: number } | null;
  /**
   * Distance au Cœur, toujours transmise : c'est le battement qui sert de
   * boussole à l'Envahisseur, sans minimap (§10). Une distance seule ne
   * donne pas de direction.
   */
  heartDist: number;
  /** Indices de braseros connus par renseignement. */
  hintedBraziers?: number[];
  hintedHearts?: number[];
  score: { host: number; guest: number };
  round: number;
}

/* ==================================================================== */
/* Événements ponctuels fiables (§13)                                   */
/* ==================================================================== */

export type GameEvent =
  | { k: 'trap'; trap: TrapKind; x: number; y: number; hit: boolean }
  | { k: 'device'; device: DeviceKind; x: number; y: number }
  | { k: 'hit'; target: Role; dmg: number; x: number; y: number; source: string }
  | { k: 'alarm'; x: number; y: number }
  | { k: 'brazier'; id: number; x: number; y: number }
  | { k: 'breach'; x: number; y: number }
  | { k: 'step'; role: Role; x: number; y: number; loud: boolean }
  | { k: 'swing'; role: Role; x: number; y: number }
  | { k: 'parry'; x: number; y: number; perfect: boolean }
  | { k: 'dodge'; x: number; y: number }
  | { k: 'bolt'; x: number; y: number }
  | { k: 'blast'; x: number; y: number }
  | { k: 'death'; role: Role; x: number; y: number }
  | { k: 'scry'; on: boolean }
  | { k: 'sensor'; x: number; y: number }
  | { k: 'ricochet'; x: number; y: number }
  | { k: 'probe'; x: number; y: number }
  | { k: 'door'; x: number; y: number; open: boolean }
  | { k: 'replay'; trap: TrapKind; x: number; y: number };

/* ==================================================================== */
/* Messages réseau                                                      */
/* ==================================================================== */

export interface NetInput {
  type: 'input';
  frame: InputFrame;
}

export interface NetSnapshot {
  type: 'snapshot';
  snap: Snapshot;
}

export interface NetEvents {
  type: 'events';
  tick: number;
  events: GameEvent[];
}

export interface NetPrepUpdate {
  type: 'prep';
  ready: boolean;
  /** Progression affichée à l'adversaire, sans rien révéler. */
  spent: number;
  placed: number;
}

export interface NetBuild {
  type: 'build';
  build: BuildOrder;
}

export interface NetLoadout {
  type: 'loadout';
  loadout: Loadout;
}

export interface NetPhase {
  type: 'phase';
  phase: Phase;
  round: number;
  /** Rôle du destinataire pour cette manche. */
  role: Role;
  timeLeft: number;
  score: { host: number; guest: number };
  planId?: PlanId;
  /** Budget de préparation du destinataire (réduit au réaménagement). */
  budget?: number;
  /** Le château précédent est conservé : manches 3, 4 et décisive. */
  keepBuild?: boolean;
  result?: RoundResult;
  intel?: IntelResult;
  matchWinner?: 'host' | 'guest';
  /** Carte de chaleur du trajet adverse, pour le réaménagement. */
  heat?: { x: number; y: number; t: number }[];
  burned?: number[];
}

export interface NetHello {
  type: 'hello';
  playerId: string;
  name: string;
}

export interface NetPing {
  type: 'ping' | 'pong';
  t: number;
}

export type NetMessage =
  | NetInput
  | NetSnapshot
  | NetEvents
  | NetPrepUpdate
  | NetBuild
  | NetLoadout
  | NetPhase
  | NetHello
  | NetPing;

/* ==================================================================== */
/* Utilitaires                                                          */
/* ==================================================================== */

export function dist(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function dist2(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolation d'angle par le plus court chemin. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Écart angulaire absolu, dans [0, π]. */
export function angleDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}
