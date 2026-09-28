/**
 * Le réseau, joué de bout en bout : les VRAIS moteurs hôte et invité, reliés
 * par un réseau simulé (latence, gigue, pertes) et pilotés par une horloge
 * fictive. Voir `scripts/netbench.ts` pour le banc lui-même.
 *
 * Chaque test ici est né d'un défaut constaté : un invité recalé dix fois par
 * seconde, un invité figé toute une manche faute d'un message, une esquive
 * appuyée et jamais exécutée. Ils échouent si le défaut revient.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { playRound } from '../scripts/netbench';
import type { NetMessage } from '../src/game/types';

/** Un joueur qui explore : il tourne, s'arrête, repart, esquive de temps en temps. */
const explorer = (t: number) => {
  const dirs = [
    { x: 1, y: 0 },
    { x: 0.7, y: 0.7 },
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: -0.7, y: 0.7 },
    { x: -1, y: 0 },
  ];
  return { move: dirs[Math.floor(t / 0.7) % 6], aim: t, dodge: Math.floor(t * 10) % 37 === 0 };
};

describe('prédiction de l’invité', () => {
  test('sur une même machine, il n’est JAMAIS recalé', () => {
    // Personne ne le touche : un modèle de prédiction juste n'a aucune excuse.
    // L'ancien code le recalait 10,5 fois par seconde, jusqu'à 0,42 tuile.
    const r = playRound({ latency: 2, jitter: 1 }, explorer, 10);
    assert.equal(r.correctionsPerSec, 0, `${r.correctionsPerSec} recalages/s, pire ${r.worst.toFixed(3)} tuile`);
    assert.ok(r.travelled > 10, `l'invité n'a parcouru que ${r.travelled.toFixed(1)} tuiles`);
  });

  test('sur une 4G médiocre, les recalages restent rares et invisibles', () => {
    // 90 ms ± 70 ms : des paquets qui arrivent groupés, d'autres en retard.
    // L'ancien code : 6,4 recalages/s, jusqu'à 0,71 tuile.
    const r = playRound({ latency: 90, jitter: 70 }, explorer, 15);
    assert.ok(r.correctionsPerSec < 0.5, `${r.correctionsPerSec.toFixed(2)} recalages/s`);
    assert.ok(r.worst < 0.2, `un recalage de ${r.worst.toFixed(3)} tuile`);
  });

  test('chaque esquive appuyée est exécutée, même quand les trames arrivent groupées', () => {
    // L'hôte écrasait la trame précédente à chaque réception : une impulsion
    // tombée entre deux ticks disparaissait. On appuie UNE fois toutes les
    // 4 s (la recharge est de 3 s) : chaque appui doit donner une esquive.
    const once = (t: number) => ({
      ...explorer(t),
      dodge: Math.round(t * 60) % 240 === 30,
    });
    const seconds = 20;
    const attempts = Math.floor((seconds * 60 - 30) / 240) + 1;
    const r = playRound({ latency: 60, jitter: 80 }, once, seconds);
    assert.equal(r.dodges, attempts, `${r.dodges} esquives exécutées pour ${attempts} appuis`);
  });
});

describe('messages perdus', () => {
  const lose = (phase: string) => (msg: NetMessage, to: 'host' | 'guest') =>
    to === 'guest' && msg.type === 'phase' && msg.phase === phase;

  test('l’annonce de l’invasion se perd : l’invité joue quand même', () => {
    // Elle ne partait qu'une fois, sans accusé : perdue, l'invité restait en
    // compte à rebours et n'envoyait plus une seule entrée de la manche.
    let dropped = 0;
    const r = playRound(
      {
        latency: 30,
        jitter: 10,
        drop: (m, to) => {
          // On perd la première annonce d'invasion, pas les renvois.
          if (lose('invasion')(m, to) && dropped === 0) {
            dropped++;
            return true;
          }
          return false;
        },
      },
      explorer,
      6,
    );
    assert.equal(dropped, 1, 'le test doit réellement perdre l’annonce');
    assert.ok(r.travelled > 5, `l'invité est resté figé (${r.travelled.toFixed(1)} tuiles parcourues)`);
  });

  test('l’ouverture de la manche se perd : l’invité reçoit quand même son plan', () => {
    // Sans elle, pas de plan, pas de rôle, pas de vue : écran figé.
    let dropped = 0;
    const r = playRound(
      {
        latency: 30,
        jitter: 10,
        drop: (m, to) => {
          if (lose('countdown')(m, to) && dropped === 0) {
            dropped++;
            return true;
          }
          return false;
        },
      },
      explorer,
      6,
    );
    assert.equal(dropped, 1, 'le test doit réellement perdre l’ouverture');
    assert.ok(r.travelled > 5, `l'invité est resté figé (${r.travelled.toFixed(1)} tuiles parcourues)`);
  });
});
