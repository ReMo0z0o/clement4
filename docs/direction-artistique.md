# Direction artistique — Castle Siege

Dix lignes, écrites avant la première ligne de rendu.

1. **Un château médiéval vu du dessus, éclairé à la torche.** Pas de pixel art, pas de plat vectoriel : de la pierre, de la suie et du feu, dessinés à la forme et à la lumière plutôt qu'à la texture.
2. **La lisibilité prime absolument sur le détail.** Un joueur doit distinguer une dalle sûre d'une dalle suspecte en un dixième de seconde. Tout ce qui n'aide pas à cette lecture est retiré.
3. **La lumière est le langage du jeu.** Le brouillard n'est pas un carré noir : c'est une chute de luminosité. Les seules sources sont les torches, les braseros allumés, les pièges qui se déclenchent et le Cœur.
4. **Deux palettes franchement distinctes selon le rôle.** Chaude et large pour le Châtelain qui surveille son domaine ; froide et resserrée pour l'Envahisseur qui s'infiltre. On doit savoir de quel côté on est rien qu'en regardant un écran de loin.
5. **Les indices sont discrets mais jamais ambigus par manque de soin.** Ils sont dessinés à la main, trait par trait, et un vrai indice est rigoureusement identique à un faux — même géométrie, même bruit, même fondu. Si les indices sont mal dessinés, tout le jeu s'effondre.
6. **Typographie : une serif de caractère pour les titres et le code de session, une neutre pour le HUD.** Le code de session est énorme et dictable à voix haute. Aucune gothique illisible.
7. **Élément signature : la jauge de capture du Cœur.** Elle envahit progressivement l'écran des *deux* joueurs, en tension symétrique — montante et rouge pour celui qui prend, descendante et sourde pour celui qui perd. Toute la prise de risque visuelle est concentrée là ; le reste reste discipliné.
8. **Le mouvement dit l'allure.** La caméra se resserre en allure prudente et s'écarte à la course. Ce n'est pas un effet : c'est l'information « je vois mieux / je vois moins » rendue physique.
9. **Micro-interactions parcimonieuses.** Tremblement court sur les gros dégâts, vignette rouge sous 30 PV, léger flou en Scrutation pour rappeler que le corps est resté en arrière. Rien qui clignote sans raison.
10. **Écriture en voix active, phrases courtes, aucun jargon.** « Le Châtelain a quitté la partie », pas « Peer disconnected ». Un message d'erreur explique quoi faire ; il ne s'excuse pas.

## Palettes

| | Châtelain | Envahisseur |
|---|---|---|
| Fond | `#14100c` brun-noir chaud | `#0a0d12` bleu-noir froid |
| Pierre | `#3a3128` → `#5b4c3c` | `#242b36` → `#3d4756` |
| Accent | `#e8a13c` braise | `#7fd4e8` acier pâle |
| Lumière | ambre saturé | ambre désaturé, halo plus court |
| Ressource | Influence, ambre | Endurance des outils, acier |

Rouge de danger commun : `#e0503c`. Or du Cœur : `#f0c469`. Ces deux couleurs n'apparaissent nulle part ailleurs.
