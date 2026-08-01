import type { PlanSource } from '../types';

/**
 * « Le Donjon » — neuf salles en 3×3, murs épais, portes nettes.
 *
 * Intention de design : lignes de vue courtes, tout est proche, on tombe sur
 * l'adversaire par surprise. Chaque salle est reliée à ses voisines par au
 * moins deux itinéraires, ce qui rend le placement des pièges spéculatif
 * plutôt que mécanique.
 *
 * Les piliers intérieurs ne sont pas décoratifs : ce sont les seuls angles
 * morts d'un plan où l'on se voit vite. C'est là que le Châtelain embusque, et
 * c'est autour d'eux que l'Envahisseur tourne quand il veut jouer la parade.
 *
 * Le Cœur central (11,11) est le plus dangereux pour le Châtelain — trois
 * portes — mais c'est aussi celui qui le laisse recharger au milieu de tout.
 * Les deux candidats en diagonale l'obligent à choisir un camp du château.
 */
export const COMPACT: PlanSource = {
  id: 'compact',
  name: 'Le Donjon',
  blurb: 'Neuf salles serrées. Courtes distances, embuscades constantes.',
  density: [0.45, 0.62],
  rows: [
    '###t#######t#######t####',
    '#......#.......#.......#',
    '#.S....#..#B#..#..###..#',
    't..##..+..#.#..+...H...t',
    '#.#..#.#.......#.#...#.#',
    '#..##..%..###..f.......#',
    '#......#.......#..#.#..#',
    '###+#######+#%###f#+####',
    '#...#..#.......#..#.#..#',
    '#.#..#.t..#.#..t.......#',
    '#......#.#...#.#..#.#..#',
    't..##..+...H...+....B..t',
    '#......#.#..C#.%..#.#..#',
    '#.#..#.f..#.#..#.......#',
    '#...#..#.......#..#.#..#',
    '###+#%#####+#f#####+####',
    '#...#..#..#.#..#..#.#..#',
    '#.#..#.%.......#.......#',
    '#..##..#..,,,..#.#...#.#',
    't......+.......+.......t',
    '#..B...#..#.#..#....H..#',
    '#.#..#.t.......t..#.#..#',
    '#......#.#...#.#.#...#.#',
    '###t#######t#######t####',
  ],
};
