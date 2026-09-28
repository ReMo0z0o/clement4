# Castle Siege — analyse des dynamiques de jeu

Écrit après lecture ligne à ligne de la simulation, du filtrage réseau et du
rendu, et après une session complète jouée dans un vrai navigateur. C'est un
état des lieux honnête : ce qui tient, ce qui ne tient pas, et ce qui reste
invérifiable sans deux humains devant l'écran.

Le repère est la section 2 du cahier des charges — les cinq tensions, les deux
boucles de trente secondes, les anti-patrons. Le reste du document s'y réfère.

---

## 0. Deuxième passe : « ça bugue, et parfois on ne peut plus bouger »

Cette plainte avait plusieurs causes indépendantes. Chacune a été **mesurée
avant d'être corrigée**, et chaque correction a un test qui échoue sur l'ancien
code — vérifié en faisant tourner les tests sur une copie de la version
précédente.

### 0.1 Figé contre un angle — la cause principale

Deux touches enfoncées (une diagonale) contre un angle saillant — un montant de
porte, un pilier — et le joueur ne bougeait plus d'un millième tant qu'il ne
lâchait pas une touche. La collision résolvait les deux axes séparément ; contre
un sommet, chacun rapprochait le cercle du coin, et les deux étaient refusés. Le
« dégagement d'angle » censé l'éviter ne se déclenchait presque jamais : il
testait une vitesse *exactement* nulle, que l'inertie n'atteint qu'après 12 s.

**Mesuré sur tout le château (`npm run sweep`) : 7,6 % des déplacements
finissaient figés — 2 630 situations. Après : 0 sur 34 600.**

La collision fonctionne désormais par **expulsion** : on avance, puis on repousse
le cercle hors de la pierre le long de la normale de contact. Contre un sommet,
cette normale est oblique et le joueur glisse autour de l'angle. Un test de
propriété vérifie qu'on ne traverse jamais un mur, même à 9 tuiles/s depuis
chaque dalle dans seize directions.

### 0.2 Figé sur place en appuyant sur Espace

Espace est la touche de course de l'Envahisseur. Chez le Châtelain, elle
lançait la Scrutation, qui **immobilisait le corps : 0 % de sa vitesse**. Un
joueur qui changeait de rôle entre deux manches appuyait par réflexe et ne
comprenait pas pourquoi il ne bougeait plus. La Scrutation est retirée (voir 0.7).

### 0.3 Ralenti de moitié en gardant le clic enfoncé

Le clic gauche transmettait l'état du bouton, pas un clic : le garder enfoncé
enchaînait les coups sans fin, et chaque coup ralentit. **Mesuré : 49 % de la
vitesse normale, 22 % en allure prudente.** Un clic donne maintenant un coup, et
un clic tombé pendant la récupération est mémorisé un quart de seconde au lieu
d'être perdu.

### 0.4 Une touche ignorée après un Alt+Tab

Revenir dans la fenêtre sans relâcher Z : le navigateur n'envoie plus que des
répétitions, que le code jetait *avant* de réenregistrer la touche. Le
personnage refusait d'avancer jusqu'à ce qu'on relâche et ré-enfonce.

### 0.5 L'invité recalé dix fois par seconde

Mesuré avec les vrais moteurs derrière un réseau simulé (`npm run netbench`),
sans que personne ne touche l'invité :

| Réseau | Recalages/s avant | après | Pire recalage avant | après |
|---|---|---|---|---|
| Même machine | 10,5 | **0** | 0,42 tuile | **0** |
| Fibre | 9,7 | **0,05** | 0,42 | 0,09 |
| Wifi chargé | 6,4 | **0,10** | 0,54 | 0,10 |
| 4G médiocre | 6,4 | **0,15** | 0,71 | 0,10 |

Quatre causes, toutes corrigées :

- **L'hôte écrasait la trame de l'invité au lieu de la consommer.** Deux trames
  entre deux ticks : le pas de la première disparaissait mais était acquitté.
  Aucune : la même était jouée deux fois. C'est maintenant une file, jouée
  exactement une fois par trame.
- **Deux modèles de déplacement.** L'hôte avait de l'inertie, l'invité non ;
  l'invité ne prédisait pas ses esquives (jusqu'à 1,9 tuile d'écart) et restait
  figé plus longtemps que son étourdissement réel. Il n'y a plus qu'un modèle,
  `movement.ts`, exécuté des deux côtés.
- **Tout l'écran traînait de 70 ms**, hôte compris : l'affichage poursuivait la
  position par un filtre, et la caméra et la visée suivaient cette position en
  retard. On interpole désormais entre les deux derniers pas simulés.
- **Des impulsions perdues** : une esquive ou un tir tombé entre deux ticks
  disparaissait.

### 0.6 Deux blocages d'une manche entière

- **La partie au ralenti dès que la fenêtre de l'hôte passait derrière une
  autre.** La simulation suivait le rafraîchissement d'écran, que le navigateur
  bride à ~1 image/s. Un worker non bridé réveille maintenant la boucle.
- **L'invité figé toute la manche si un message se perdait.** Le passage en
  invasion n'était annoncé qu'une fois, sans accusé ; perdu, l'invité n'envoyait
  plus une seule entrée. L'instantané porte désormais la phase, et l'hôte
  renvoie l'ouverture de manche jusqu'à la première entrée de l'invité.

### 0.7 La vision redistribuée

À la demande du joueur :

- **Le Châtelain perd la Scrutation.** Il garde ses trois yeux de guet, qui
  voient à travers les murs : c'est sa seule vision à distance. L'Influence, qui
  ne servait qu'à elle, disparaît du HUD.
- **L'Envahisseur gagne trois coups d'œil à la carte de cinq secondes** (M). Le
  tracé du château, sans le Châtelain, les pièges ni le Cœur. Rien de ce qu'il y
  voit n'entre dans sa mémoire du plan — sans quoi le premier coup d'œil aurait
  rendu les deux autres inutiles. Le prix n'est pas l'immobilité, mais
  l'aveuglement : la caméra recule, et l'on ne voit plus venir le danger.

Le tracé transmis masque les passages secrets en murs : la valeur brute les
aurait livrés à quiconque ouvre l'inspecteur réseau — un défaut qui existait
déjà dans l'exploration normale, corrigé du même coup.

### 0.8 Les Oubliettes refaites

« Trop difficile à jouer. » Mesuré, ce n'était pas une impression : le plan
n'était pas dur, il était **illisible**.

| | Avant | Après | Donjon | Grande Salle |
|---|---|---|---|---|
| Pire trajet jusqu'au Cœur | 55 pas | **38 pas** | 36 | 26 |
| Virages sur ce trajet | **27** | **6** | 8 | 5 |
| Surface jouable | 37 % | 57 % | 60 % | 62 % |
| Couloirs d'une tuile | 28 % | **4 %** | 22 % | 5 % |
| Plus longue ligne droite | 6 tuiles | 16 | 22 | 22 |

Un virage tous les deux pas, des couloirs d'une tuile, jamais plus de six tuiles
de vue : on butait sur chaque angle sans voir venir l'adversaire, et l'on refaisait
sa visée à chaque pas.

Le nouveau plan garde l'esprit — des cellules, des angles, des portes — mais se
lit : un **anneau de galeries de deux tuiles** (on s'y croise, l'esquive a la
place de se faire) autour de **huit cellules** de 2×2 dont la porte ouvre sur la
galerie, une **salle des gardes** centrale à piliers et murets, et **quatre
salles d'angle** isolées pour l'apparition et les Cœurs. Les portes sont décalées
d'une rangée : aucune ligne droite ne traverse le château. Le plan est à symétrie
d'ordre 4 (un quart de tour le laisse identique) : rien n'avantage un côté, seuls
les départs et les Cœurs brisent la symétrie. Vingt-deux torches, parce qu'ici la
lumière est de la lisibilité.

Le validateur de plans (`npm run plans`) mesure désormais ce qui manquait : il
refuse un trajet de plus de 45 pas ou de plus de 12 virages jusqu'à un candidat
Cœur. **L'ancien labyrinthe échoue à ces deux contrôles** — vérifié en le
remettant en place — et les deux autres plans les passent avec de la marge.

Un test de marche à pied (`tests/grid.test.ts`) vérifie en plus, dans la vraie
simulation, que depuis l'apparition on atteint chaque Cœur et chaque brasero de
chaque plan en temps raisonnable. Il ne juge pas la lisibilité — l'ancien plan
le passait aussi : un joueur guidé sur le plus court chemin s'y déplaçait sans
encombre. Ce sont le validateur et les mesures ci-dessus qui portent la
différence.

**Ce qui n'est pas validé** : l'équilibre de ce plan. Les robots terminent leurs
36 manches sans fuite d'information, mais ils jouent trop mal pour dire si le
Châtelain y est trop fort ou trop faible. Une remarque à vérifier à deux : depuis
l'apparition, l'Envahisseur est à 21 pas des Cœurs nord-est et sud-ouest, le
Châtelain à 19 — presque à égalité, là où l'ancien plan donnait 31 contre 24.
Le Cœur sud-est reste le plus favorable au défenseur (38 pas contre 18).

---

## 1. Première passe

Quatre défauts constatés en jouant. Trois étaient des bugs, un était une règle
qui produisait le contraire de son intention.

### 1.1 On se cognait dans du vide (bug, invité uniquement)

**Symptôme** — « parfois il est difficile de se déplacer même quand il n'y a
pas de mur. »

**Cause** — `ClientView` construisait sa carte de collision à partir d'un plan
où **toute tuile non encore reçue vaut `WALL`**. C'est le bon réglage pour
l'affichage : ce qu'on n'a pas exploré doit rester noir. C'est le pire possible
pour la prédiction : l'invité poussait vers une dalle que l'hôte savait libre
mais dont le delta n'était pas encore arrivé, la prédiction refusait, puis
l'instantané suivant le replaçait deux pas plus loin. Le joueur n'avançait pas,
il **tressautait à 20 Hz**.

Le défaut ne touchait que l'invité : l'hôte ne prédit rien, sa vue est
reconstruite depuis la simulation à chaque tick.

**Correction** — deux cartes, mêmes révélations, défauts opposés. `castle`
(affichage) part de `WALL`, `predictCastle` (déplacement) part de `FLOOR`.

Le défaut inverse est presque toujours juste : l'hôte transmet aussi les murs
qui bordent ce qu'on vient de voir, donc **un mur qu'on peut heurter est déjà
connu**. Dans le cas rare où la prédiction se trompe, l'hôte tranche — il est
seul à faire autorité, et l'erreur se paie d'un recalage de 50 ms au lieu d'un
blocage permanent.

Au passage : le client rejouait tous les obstacles en `'lock'`, quelle que soit
leur nature. Une herse — qui bloque tout le monde, y compris son propriétaire —
était donc prédite comme un verrou, que le Châtelain traverse. `kind` voyage
maintenant avec l'obstacle.

### 1.2 Le personnage de l'hôte ne tournait jamais (bug)

**Symptôme** — « le défenseur bouge mal, c'est difficile de savoir dans quel
sens il est pour tirer. »

**Cause** — `ClientView.aim` n'était écrit que dans `pushInput()`, que **seul
l'invité appelle**. Chez l'hôte, `aim` restait à sa valeur initiale : `0`.
Son propre personnage regardait donc plein est pendant toute la manche, quoi
que fasse la souris. Les tirs partaient au bon endroit — la simulation lit
`input.aim`, pas la vue — mais l'image disait autre chose que le jeu.

**Correction** — quand aucune entrée n'est en attente (le cas de l'hôte, par
construction), `aim` vient de l'instantané, qui fait autorité.

### 1.3 On ne lisait pas l'orientation, même correcte

Un sprite vu du dessus qui pivote ne suffit pas : à 35 pixels, heaume et
capuche se ressemblent. Ajouté sous le corps, dans la couleur du rôle :

- un **cône au sol** à l'angle exact de l'épée (90°), qui répond à la seule
  question du duel — « où porte ma lame ? » ;
- une **pointe** franche, lisible même dans une pièce éclairée où le cône se
  dilue.

Le cône est plus long et plus opaque pour soi que pour l'adversaire : on doit
lire son propre engagement d'un coup d'œil, et *deviner* celui d'en face.

### 1.4 Le Cœur disputé récompensait l'immobilité (règle)

C'était le point le plus grave, et ce n'était pas un bug : le code faisait
exactement ce qui était écrit.

**Avant** — le chrono tournait pendant la contestation, et le Châtelain gagne
au temps écoulé. Entrer dans la salle et **ne rien faire** était donc une
stratégie gagnante : la capture est gelée, le temps s'écoule, la manche tombe
du bon côté. Pire, le défenseur y régénérait 3 PV/s : il gagnait aussi le duel
s'il finissait par avoir lieu.

C'est l'anti-patron nommé en toutes lettres par §2 — *un Châtelain qui campe
doit être structurellement perdant* — et le jeu en faisait la ligne optimale.

**Après**, selon la demande (« quand la zone est contestée, temps infini tant
que quelqu'un ne la quitte pas ou ne meurt pas ») :

- le chrono **se suspend** tant que les deux camps sont dans la salle ;
- le Cœur **ne soigne plus** son défenseur pendant ce temps ;
- il ne recharge plus l'Influence à plein régime non plus.

L'attente ne rapporte donc plus rien à personne. Il ne reste que trois issues,
toutes actives : frapper, partir, ou mourir. Le face-à-face au Cœur devient le
moment le plus tendu de la manche au lieu d'en être le point mort.

Un garde-fou a été vérifié : camper **seul** sur le Cœur ne gèle rien. La
suspension exige les deux joueurs.

---

## 2. Le nouvel œil de guet

Demande : « un gadget qui révèle l'ennemi dans une zone ronde, même derrière
un mur. »

Les trois guets ne sonnent plus, ils **regardent** : tant que l'Envahisseur est
dans le cercle (4 tuiles), le Châtelain le voit **en direct, à travers les
murs**, où qu'il soit lui-même.

C'est un pouvoir considérable, et trois zones de vision permanentes auraient
été de l'omniscience gratuite. Trois garde-fous, chacun adossé à une tension
de §2 :

**Une réserve de veille (18 s par œil).** Elle ne se consomme que pendant la
veille effective. Un œil posé sur un couloir jamais emprunté ne coûte rien mais
ne rapporte rien : le placement redevient un pari. Et deux cercles superposés
ne facturent qu'une réserve — on ne paie pas deux fois la même information.

**L'Envahisseur est prévenu.** L'œil rouge apparaît sur son écran, avec son
cercle. Il apprend l'existence de *celui qui le tient*, pas des deux autres :
ce qu'il découvre, il vient de le mériter en entrant dedans. Une information
qui arrive sans qu'on puisse rien en faire n'est pas du jeu, c'est une
punition — et l'avertissement transforme la détection en décision : contourner,
fuir, ou **user la réserve exprès** pour aveugler le couloir avant le vrai
passage.

**La mémoire du château.** Le même plan ressert aux manches 3 et 4. Un œil
repéré est un œil qu'il faudra déplacer : le réaménagement prend un sens
supplémentaire.

À la sortie du cercle, le dernier point vu reste huit secondes puis s'efface :
le Châtelain garde une piste, pas une laisse.

Le tout est filtré à la source. `auditSnapshot` refuse désormais un instantané
où l'avertissement partirait vers le Châtelain, ou où la position transmise à
l'Envahisseur ne serait pas celle de l'œil qui le tient. Les tests le vérifient
sur la simulation réelle, pas sur la configuration.

---

## 3. État des cinq tensions

**« L'omniscience se paie toujours. »** — *Tenue, et mieux répartie.* Il n'y a
plus d'omniscience à durée libre : l'œil de guet consomme une réserve finie, et
le coup d'œil à la carte est compté (trois fois cinq secondes) et payé par
l'aveuglement local. Aucun canal de vision n'est gratuit.

**« Un Châtelain qui campe est structurellement perdant. »** — *Tenue depuis
cette passe, pas avant.* Voir 1.4. C'était le trou principal.

**« L'information se mérite. »** — *Tenue.* Les tuiles partent en delta et
seulement une fois explorées, la distance au Cœur est bornée et quantifiée
contre la trilatération, les cicatrices de pièges jamais repérés ne fuient pas.

**« Un faux indice doit être indiscernable d'un vrai. »** — *Tenue au niveau
de la charge utile* : le test compare la liste exacte des champs transmis.

**« Le déplacement doit être agréable. »** — *Réparée, pas encore validée.*
Les deux bugs de 1.1 et 1.2 sont corrigés et le cône rend l'orientation
lisible. Le reste — inertie, glissement le long des murs, dégagement d'angle —
n'a jamais été mesuré contre autre chose que mon propre ressenti.

---

## 4. Ce qui me paraît encore fragile

Par ordre de gravité pour le plaisir de jeu.

**L'équilibre n'est pas validé, et je ne peux pas le valider seul.** Les bots
de `playtest.ts` sont trop faibles pour produire un verdict : ils ne feintent
pas, ne tendent pas d'embuscade, n'apprennent pas le plan d'une manche à
l'autre. Les chiffres qu'ils produisent disent que le code tourne, pas que le
jeu est juste. Les critères de plaisir de §19 demandent explicitement deux
humains ; c'est la seule mesure qui vaudra.

**L'asymétrie s'est amincie.** Les deux camps ont désormais la même épée, la
même arbalète et la même vitesse. Ce qui distingue réellement les rôles : le
Châtelain connaît le plan en permanence et a ses trois yeux ; l'Envahisseur a
les trois allures, l'esquive, l'initiative et trois coups d'œil à la carte.
Sans Scrutation, le Châtelain est nettement moins omniscient qu'avant : si les
Envahisseurs se mettent à gagner trop souvent, c'est ici qu'il faut regarder
d'abord — la réserve des yeux ou leur rayon. C'est
défendable — l'avantage vient du terrain, pas de l'acier — mais c'est une
asymétrie de **connaissance**, plus de **capacité**. Si les parties se mettent
à se ressembler, c'est le premier levier à rouvrir.

**L'arbalète à rebond est très forte en couloir.** 40 dégâts sur 100 PV,
2,5 s de recharge, trois rebonds, et le carreau blesse son propre tireur après
le premier rebond. Sur le papier, l'auto-dégât équilibre. En pratique, dans un
couloir droit, tirer reste presque toujours rentable. À surveiller en premier
lors d'un vrai playtest.

**Le duel peut se figer au Cœur.** Le temps suspendu supprime le camping
passif, mais si les deux joueurs refusent absolument d'engager, plus rien ne
progresse. Ni soin ni recharge ne récompensent l'attente, donc la position est
symétrique et quelqu'un finira par frapper — mais c'est un raisonnement, pas
une garantie. Si un playtest montre des enlisements, la réponse la plus propre
serait une usure lente et partagée dans la salle disputée.

**Les braseros restent un plan B théorique.** +25 s pour 2 s d'allumage à
découvert, c'est bien tarifé, mais rien ne pousse l'Envahisseur à y penser
tant que le Cœur est atteignable. Ils ne deviennent intéressants que dans les
manches où il a déjà échoué une fois.

**Observateur et rejeu de manche (§17) ne sont pas implémentés.**

---

## 5. Vérifications exécutées

- `npm run check` — typage, plans, duel, balayage des angles (0 pincement sur
  34 600 déplacements) et **130 tests unitaires**, tous verts.
- `tests/net.test.ts` — les vrais moteurs derrière un réseau simulé : zéro
  recalage sur une même machine, moins de 0,5/s en 4G médiocre, chaque esquive
  appuyée exécutée, et l'invité qui joue quand même si l'annonce d'invasion ou
  l'ouverture de manche se perd. **Ces cinq tests échouent tous sur l'ancien
  code** : ce sont bien les corrections qui les font passer.
- `tests/grid.test.ts` — aucune traversée de mur à 9 tuiles/s sur les trois
  plans, les quatre coins d'un pilier contournés en diagonale sans un tick figé,
  aucun dérapage latéral contre un mur plat.
- `tests/sim.test.ts` — Scrutation impossible même envoyée par un client
  trafiqué, Espace qui ne fige plus, trois coups d'œil de cinq secondes, rien
  versé dans la mémoire du plan, inaccessible au Châtelain.
- `npm run playtest` — 36 manches de robots, toutes terminées, aucune fuite
  d'information.
- `npm run build` puis `npm run e2e` — une session complète dans un vrai
  navigateur : création, connexion, préparation, invasion, déplacement,
  changements d'allure, coup d'œil à la carte qui se replie seul en consommant
  exactement une charge, Espace sans effet chez le Châtelain. **Zéro erreur de
  console.**

Ce qui n'a pas pu être vérifié : le mode à distance. Le bac à sable bloque les
WebSockets sortants, donc le transport Supabase est inatteignable d'ici. Le
code de secours fonctionne et affiche la bonne cause — c'est visible sur la
capture — mais une vraie partie entre deux machines reste à faire par vous.
