import type { PlanSource } from '../types';

/**
 * « Les Oubliettes » — un anneau de galeries autour d'un bloc de cellules.
 *
 * Refonte : la première version était un labyrinthe de couloirs d'une tuile.
 * Mesuré, c'était injouable — 27 virages sur le chemin de l'Envahisseur vers le
 * Cœur sud-est (un tous les deux pas ; le Donjon en compte 8 au plus, la Grande
 * Salle 5), 37 % de surface jouable, aucune ligne droite au-delà de 6 tuiles :
 * on butait sur chaque angle sans jamais voir venir l'adversaire. Un labyrinthe
 * qui se lit mal n'est pas difficile, il est confus.
 *
 * Ce qui reste des oubliettes : des cellules, des angles, des portes, et un
 * plan qu'on doit apprendre. Ce qui a changé : on voit venir.
 *
 *   — QUATRE SALLES D'ANGLE de 5×5, isolées par des murs pleins. L'Envahisseur
 *     apparaît dans celle du nord-ouest (le corps de garde) ; les trois autres
 *     abritent les candidats Cœur, à 17 tuiles au moins les uns des autres.
 *     Chacune a deux issues, si bien que fermer une porte ne coupe jamais un
 *     Cœur du monde. Le corps de garde en a une sans porte : on ne l'y enferme pas.
 *
 *   — UN ANNEAU DE GALERIES de deux tuiles de large, où deux joueurs se croisent
 *     et où l'esquive a la place de se faire. Les portes des salles d'angle sont
 *     décalées d'une rangée : aucune enfilade ne traverse tout le château, la plus
 *     longue fait 16 tuiles.
 *
 *   — HUIT CELLULES de 2×2, deux par côté, dont la porte s'ouvre sur la galerie.
 *     Ce sont les oubliettes : des cachettes, mais peu profondes et éclairées —
 *     ouverte, la porte ne cache rien, on voit ce qu'il y a dedans depuis la
 *     galerie. Aucune n'est un cul-de-sac dangereux.
 *
 *   — LA SALLE DES GARDES au centre (apparition du Châtelain), 10×10, quatre
 *     piliers de 2×2. Deux d'entre eux sont des murets : on voit à travers et l'on
 *     tire par-dessus, sans passer. Ses quatre portes sont en tourniquet, chacune
 *     dans un coin, pour qu'on n'y entre jamais dans l'axe d'une autre.
 *
 * Le plan est à symétrie d'ordre 4 — un quart de tour laisse les galeries, les
 * cellules et les portes exactement où elles étaient. Rien n'avantage donc un
 * côté : ce sont les apparitions et les Cœurs qui brisent la symétrie, comme il
 * se doit.
 *
 * Les quatre passages secrets relient chaque salle d'angle au passage voisin
 * (le Châtelain surgit dans le flanc de l'Envahisseur, ou dans son corps de
 * garde). Les quatre murs fragiles ouvrent la salle des gardes sur une cellule.
 *
 * Vingt-deux torches : ici, la lumière fait partie de la lisibilité. Les
 * braseros sont au milieu des galeries nord, est et sud — pas à l'ouest, trop
 * près de l'apparition — à neuf tuiles du Cœur le plus proche.
 */
export const LABYRINTH: PlanSource = {
  id: 'labyrinth',
  name: 'Les Oubliettes',
  blurb: 'Un anneau de galeries autour des cellules. Des angles, mais on voit venir.',
  density: [0.45, 0.62],
  rows: [
    '###t######t##t######t###',
    '#.....#.....B....+.....#',
    '#.....+..........#.....#',
    't..S..#.#+##+#####..H..t',
    '#.....%.#..#..####.....#',
    '#.....#.#..#..####.....#',
    '#.#####+##f#t######%#+##',
    '#..####..........+.....#',
    '#..####..........####..#',
    '#..####..##..,,..#..+..#',
    't..#..#..#t..,,..f..#..t',
    '#..+..t..........####..#',
    '#..####.....C....t..+.B#',
    't..#..f..,,..t#..#..#..t',
    '#..+..#..,,..##..####..#',
    '#..####..........####..#',
    '#.....+..........####..#',
    '##+#%######t#f##+#####+#',
    '#.....####..#..#.#.....#',
    '#.....####..#..#.%.....#',
    't..H..#####+##+#.#..H..t',
    '#.....#..........+.....#',
    '#.....+....B.....#.....#',
    '###t######t##t######t###',
  ],
};
