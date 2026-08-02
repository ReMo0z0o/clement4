# Castle Siege — analyse des dynamiques de jeu

Écrit après lecture ligne à ligne de la simulation, du filtrage réseau et du
rendu, et après une session complète jouée dans un vrai navigateur. C'est un
état des lieux honnête : ce qui tient, ce qui ne tient pas, et ce qui reste
invérifiable sans deux humains devant l'écran.

Le repère est la section 2 du cahier des charges — les cinq tensions, les deux
boucles de trente secondes, les anti-patrons. Le reste du document s'y réfère.

---

## 1. Ce qui a été corrigé dans cette passe

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

**« L'omniscience se paie toujours. »** — *Tenue.* La Scrutation coûte 5/s, le
Cœur ne recharge plus celui qui scrute, et l'œil de guet consomme une réserve
finie. Aucun canal de vision n'est gratuit.

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
Châtelain connaît le plan, dispose de la Scrutation, des mécanismes et des
yeux ; l'Envahisseur a les trois allures, l'esquive et l'initiative. C'est
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

- `npm run check` — typage, plans, duel, 112 tests unitaires.
- `npm run duel` — épées identiques, rebonds plafonnés, carreau qui blesse son
  tireur, veille qui se consomme et s'épuise, chrono suspendu et redémarré.
- `tests/watch.test.ts` — 13 tests neufs : vision à travers les murs bornée au
  cercle, réserve non facturée deux fois, avertissement filtré dans les deux
  sens, chrono gelé, absence de régénération pendant la contestation, et la
  prédiction client qui ne se cogne plus dans l'inexploré tout en s'arrêtant
  sur un mur transmis.
- `npm run build` puis `npm run e2e` — une session complète jouée dans un vrai
  navigateur : création, connexion, préparation, invasion, déplacement,
  changements d'allure, Scrutation. **Zéro erreur de console.**

Ce qui n'a pas pu être vérifié : le mode à distance. Le bac à sable bloque les
WebSockets sortants, donc le transport Supabase est inatteignable d'ici. Le
code de secours fonctionne et affiche la bonne cause — c'est visible sur la
capture — mais une vraie partie entre deux machines reste à faire par vous.
