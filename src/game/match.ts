/**
 * L'arc d'adaptation (§3).
 *
 * Chaque joueur possède son propre château pour tout le match : il le
 * construit une fois, puis l'ajuste entre ses deux défenses. C'est cette
 * structure — et pas la manche isolée — qui produit le mind game. La manche 1
 * est une découverte ; la manche 3 est une conversation entre deux joueurs qui
 * savent ce que l'autre sait.
 *
 * Logique pure, sans réseau : l'hôte l'applique, l'invité l'affiche.
 */

import { CFG } from './config';
import type { BuildOrder, Loadout, PlanId, Role, RoundResult, RoundStats } from './types';

export type Side = 'host' | 'guest';

export const TOTAL_ROUNDS = 4;
export const TIEBREAK_ROUND = 5;

export interface PlayerSlot {
  plan: PlanId | null;
  build: BuildOrder | null;
  /** Équipement choisi pour la manche où ce joueur envahit. */
  loadout: Loadout | null;
  score: number;
  /** Meilleur temps de capture réalisé en tant qu'Envahisseur, en secondes. */
  bestCapture: number | null;
  /** Pièges de son château repérés par l'adversaire, cumulés sur le match. */
  burnedTraps: number[];
  /** Trajet de l'adversaire lors de sa dernière défense (carte de chaleur). */
  lastHeat: { x: number; y: number; t: number }[];
}

export interface MatchState {
  round: number;
  host: PlayerSlot;
  guest: PlayerSlot;
  results: RoundResult[];
  finished: boolean;
  winner: Side | null;
}

export function emptySlot(): PlayerSlot {
  return { plan: null, build: null, loadout: null, score: 0, bestCapture: null, burnedTraps: [], lastHeat: [] };
}

export function newMatch(): MatchState {
  return { round: 0, host: emptySlot(), guest: emptySlot(), results: [], finished: false, winner: null };
}

/* ==================================================================== */
/* Qui défend, et pendant combien de temps                              */
/* ==================================================================== */

/**
 * Manches 1 et 3 : l'hôte défend. Manches 2 et 4 : l'invité défend.
 * Manche décisive : **le plus lent des deux à avoir capturé** défend — le
 * meilleur envahisseur du match récupère donc le rôle qu'il maîtrise.
 */
export function defenderOf(round: number, m: MatchState): Side {
  if (round <= TOTAL_ROUNDS) return round % 2 === 1 ? 'host' : 'guest';
  const h = m.host.bestCapture;
  const g = m.guest.bestCapture;
  if (h === null && g === null) return 'host';
  if (h === null) return 'host';
  if (g === null) return 'guest';
  return h > g ? 'host' : 'guest';
}

export function invaderOf(round: number, m: MatchState): Side {
  return defenderOf(round, m) === 'host' ? 'guest' : 'host';
}

export function roleOf(side: Side, round: number, m: MatchState): Role {
  return defenderOf(round, m) === side ? 'castellan' : 'invader';
}

/** Manches 1 et 2 : construction. Manches 3 et 4 : réaménagement. */
export function isRedress(round: number): boolean {
  return round === 3 || round === 4;
}

export function prepDuration(round: number): number {
  if (round > TOTAL_ROUNDS) return CFG.match.prepTiebreak;
  return isRedress(round) ? CFG.match.prepRedress : CFG.match.prepBuild;
}

export function roundDuration(round: number): number {
  return round > TOTAL_ROUNDS ? CFG.match.tiebreakDuration : CFG.match.roundDuration;
}

export function slot(m: MatchState, side: Side): PlayerSlot {
  return side === 'host' ? m.host : m.guest;
}

/* ==================================================================== */
/* Résolution d'une manche                                              */
/* ==================================================================== */

export function applyResult(
  m: MatchState,
  round: number,
  winnerRole: Role,
  outcome: RoundResult['outcome'],
  stats: RoundStats,
  timeLeft: number,
): RoundResult {
  const defender = defenderOf(round, m);
  const invader = invaderOf(round, m);
  const winnerSide: Side = winnerRole === 'castellan' ? defender : invader;

  slot(m, winnerSide).score += 1;

  // Le temps de capture sert à désigner le défenseur du bris d'égalité.
  if (outcome === 'capture') {
    const elapsed = stats.timeElapsed;
    const s = slot(m, invader);
    s.bestCapture = s.bestCapture === null ? elapsed : Math.min(s.bestCapture, elapsed);
  }

  // Le défenseur récupère le trajet adverse et la liste de ses pièges grillés :
  // c'est la matière première du réaménagement.
  const def = slot(m, defender);
  def.lastHeat = stats.path;

  const result: RoundResult = { round, winner: winnerRole, outcome, stats, timeLeft };
  m.results.push(result);
  m.round = round;

  const decided = decide(m, round);
  if (decided) {
    m.finished = true;
    m.winner = decided;
  }
  return result;
}

/** Enregistre les pièges que l'adversaire a repérés pendant sa manche. */
export function recordBurned(m: MatchState, defender: Side, discoveredTrapIds: number[]): void {
  const s = slot(m, defender);
  s.burnedTraps = Array.from(new Set([...s.burnedTraps, ...discoveredTrapIds]));
}

/**
 * Le match s'arrête dès qu'il ne peut plus basculer : inutile d'imposer une
 * manche dont l'issue ne change rien (§2.4 — la partie décidée à 40 %).
 */
function decide(m: MatchState, round: number): Side | null {
  const played = round;
  if (played >= TIEBREAK_ROUND) {
    if (m.host.score === m.guest.score) return null; // ne devrait pas arriver
    return m.host.score > m.guest.score ? 'host' : 'guest';
  }
  const remaining = TOTAL_ROUNDS - played;
  const lead = Math.abs(m.host.score - m.guest.score);
  if (remaining <= 0) {
    if (m.host.score === m.guest.score) return null; // → manche décisive
    return m.host.score > m.guest.score ? 'host' : 'guest';
  }
  // Avance insurmontable : on ne fait pas jouer des manches sans enjeu.
  if (lead > remaining) return m.host.score > m.guest.score ? 'host' : 'guest';
  return null;
}

export function nextRound(m: MatchState): number | null {
  if (m.finished) return null;
  const played = m.results.length;
  if (played < TOTAL_ROUNDS) return played + 1;
  if (m.host.score === m.guest.score) return TIEBREAK_ROUND;
  return null;
}

/** Résumé lisible du score, pour l'écran de fin. */
export function scoreLine(m: MatchState): string {
  return `${m.host.score} – ${m.guest.score}`;
}

/**
 * Ce qui se joue dans la manche, en une phrase, côté joueur. Pas de jargon :
 * un message dit ce qui se passe, il ne s'excuse pas (§15).
 */
export function roundHeadline(round: number, role: Role): string {
  if (round > TOTAL_ROUNDS) {
    return role === 'castellan' ? 'Manche décisive — tenez votre château.' : 'Manche décisive — prenez le Cœur.';
  }
  if (isRedress(round)) {
    return role === 'castellan'
      ? 'Il connaît votre château. Changez-le.'
      : 'Vous connaissez ce château. Il le sait.';
  }
  return role === 'castellan' ? 'Préparez votre château.' : 'Château inconnu. Trouvez le Cœur.';
}
