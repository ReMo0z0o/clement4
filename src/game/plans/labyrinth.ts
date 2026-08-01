import type { PlanSource } from '../types';

/**
 * « Les Oubliettes » — couloirs d'une seule tuile, virages incessants.
 *
 * Intention de design : on ne voit jamais loin. Aucune enfilade ne dépasse six
 * tuiles, la vue moyenne tombe à une tuile. Chaque angle est une décision, ce
 * qui récompense l'allure prudente : l'Envahisseur qui court ici traverse ses
 * indices sans les lire, et se prend les embuscades de plein fouet.
 *
 * Contrepartie obligatoire : le plan est entièrement bouclé. Aucune tuile du
 * château n'est un point d'articulation — murer n'importe quelle case, ou
 * verrouiller n'importe quelle porte, laisse les trois candidats Cœur
 * accessibles. Les couloirs sont étroits mais jamais uniques ; le Châtelain
 * peut gêner, jamais fermer.
 *
 * Neuf pièces, cinq d'entre elles portent un enjeu :
 *   — le corps de garde (apparition Envahisseur) tourne autour d'une torche
 *     murale et compte trois sorties : on ne peut pas l'y enfermer ;
 *   — les trois salles d'angle abritent les candidats Cœur, à 18 tuiles les
 *     unes des autres. Chacune a exactement deux portes ET un mur fragile :
 *     le Châtelain peut poser deux verrous, la bombe reste la réponse ;
 *   — le donjon central (apparition Châtelain) suit la même règle, avec sa
 *     fissure en (16,11).
 *
 * Les braseros vivent en périphérie, dans des niches à deux tuiles de large —
 * les seules bouffées d'air du plan, et les seuls endroits où l'on voit venir.
 * Aucun n'est enfermable derrière une porte unique.
 *
 * Les cinq passages secrets coupent de vrais angles : (4,7) économise vingt
 * pas au Châtelain, (17,4) et (18,17) le posent derrière l'Envahisseur au lieu
 * de le croiser de face — indispensable quand la Scrutation le laisse figé et
 * qu'il doit rentrer recharger.
 *
 * Les murets (2,8), (6,6), (11,6), (13,4) et (14,16) sont des meurtrières :
 * dans un plan aussi aveugle, ce sont les seuls endroits où l'on se voit sans
 * pouvoir se toucher. Terrain d'arbalète et de face-à-face.
 *
 * Le cul-de-sac en (19,17) est volontaire : il finit sur un mur fissuré qui
 * ouvre la salle d'angle sud-est. Une impasse qui annonce sa récompense.
 */
export const LABYRINTH: PlanSource = {
  id: 'labyrinth',
  name: 'Les Oubliettes',
  blurb: 'Couloirs tordus, angles morts, on ne voit jamais loin.',
  density: [0.28, 0.42],
  rows: [
    '##t#########t#######t###',
    '#.S.#######.B.###.+...##',
    't.t.+..####...###.#.H.##',
    '#...##..###+#..#..f...##',
    '#..####.###.#,...%#+####',
    '#..##...##..%..##...####',
    '##.##.,....,#.###..#####',
    't...%...##....####.#####',
    '#.,+######.#######...+##',
    '#...#####+.##########..t',
    '#.#f#####.###########.B#',
    't...###...t##...f......#',
    '###.###+#.###.C.t.######',
    '##...##...###...+.######',
    '##.#.##.######+##.######',
    '##......#####..%...#####',
    '####.######...,#.#...+##',
    '###..######+#..f.#%.#..#',
    '###+#######.##.#...f#..t',
    '#...###.....##...#+....#',
    't.H.+.t.#.####..###.H.##',
    '#...f.....#########...##',
    '#######.B.##########t###',
    '########t###############',
  ],
};
