import type { PlanSource } from '../types';

/**
 * « La Grande Salle » — deux nefs à colonnades, ceintes d'un anneau de communs.
 *
 * Intention de design : ici on se voit venir. Les deux salles (16×7 au nord,
 * 16×8 au sud) ne sont pas cloisonnées mais rythmées par des colonnades — des
 * piliers d'une seule tuile, alignés en x=6, 9, 14, 17 — qui découpent la vue
 * sans la couper. Les bas-côtés (y=4, y=10, y=12/13, y=18/19) et la nef centrale
 * portent le regard sur seize tuiles : c'est la carte de l'arbalète, la seule où
 * courir reste raisonnable, et celle où le Châtelain ne survit pas au milieu.
 *
 * Faute de recoins, la couverture vient des murets — on voit par-dessus, on ne
 * passe pas. Des parapets tendus d'un fût à l'autre (x=7-8 et x=15-16) ferment
 * les travées latérales : la nef reste ouverte à la vue sur seize tuiles mais ne
 * s'aborde qu'en sept points, aux extrémités et par la travée centrale. C'est là
 * qu'un piège est plausible, et c'est là qu'on ralentit.
 *
 * La balustrade (11,5)-(11,9) coupe la nef nord en deux sans rien cacher : on se
 * voit, on ne se rejoint pas, il faut contourner par un bas-côté. Au sud, les
 * murets x=9 et x=13 plus (11,14) et (11,17) forment un chancel autour du Cœur
 * (11,16) : quatre entrées d'une tuile, aucune couverture pour y arriver.
 *
 * L'anneau périphérique — deux tuiles de large, recloisonné en huit communs par
 * des portes — est le contrepoint : lignes courtes, angles, alcôves. Les
 * contreforts (10,2)/(14,2) et (10,21)/(13,21) y ménagent des niches devant le
 * mur fragile (12,3) et le passage secret (12,20). Les trois braseros vivent
 * écartés en (21,2), (22,12) et (2,22) : les allumer oblige l'Envahisseur à
 * quitter les nefs, donc à renoncer à ses longues vues.
 *
 * Les passages secrets sont taillés pour le Châtelain, qui ne tient pas debout au
 * milieu : chacun économise un détour réel — (3,5) et (20,14) le font entrer par
 * le flanc d'une nef sans traverser l'autre (8 pas gagnés), (11,11) relie les
 * deux salles par l'axe médian que l'Envahisseur, lui, paye de deux portes
 * (8 pas), et (12,20) le rend à la galerie basse derrière le Cœur (22 pas).
 *
 * Les murs fragiles sont la réponse de l'assaillant, chacun perçant la coque là
 * où aucune porte ne mène : (12,3) ouvre la galerie haute sur la nef nord et
 * épargne 22 pas, (20,9) et (3,14) déverrouillent les flancs pour 8.
 */
export const OPEN: PlanSource = {
  id: 'open',
  name: 'La Grande Salle',
  blurb: 'Deux nefs à colonnades. On se voit de loin, on se cache mal.',
  density: [0.52, 0.7],
  rows: [
    '###t#######t########t###',
    '#.S...+..........+.....#',
    '#.....#...#...#..#...B.#',
    '#..###+####tf####+###..#',
    '#..#................#..#',
    '#..%.......,........+..#',
    't..#..#,,t.,..#,,#..#..t',
    '#..t...H...,....H...t..#',
    '##+#..#,,#.,..t,,#..#+##',
    '#..+.......,........f..#',
    '#..#................#..#',
    '#..####+###%####+####..#',
    '#..#................#.B#',
    '#..#................#..#',
    '#..f..#,,#.,..t,,#..%..#',
    '##+#.....,...,......#+##',
    '#..t.....,.H.,..C...t..#',
    't..#..#,,t.,..#,,#..#..t',
    '#..+................+..#',
    '#..#................#..#',
    '#..###+####t%####+###..#',
    '#.....#...#..#...#.....#',
    '#.B...+..........+.....#',
    '###t#######t########t###',
  ],
};
