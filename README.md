# Castle Siege

Un joueur piège son château. L'autre s'y infiltre. Duel 1 contre 1 asymétrique,
dans le navigateur, avec un code de partie à six caractères.

Le **Châtelain** prépare un château, puis le défend depuis l'intérieur en
manipulant ses mécanismes. L'**Envahisseur** doit capturer le Cœur du Château —
vingt secondes de présence — ou tuer le Châtelain, avant la fin du chrono.

---

## Démarrer

```bash
npm install
npm run dev
```

Ouvrez <http://localhost:3000>, créez une partie, puis cliquez sur **« Ouvrir la
seconde fenêtre »** : elle s'ouvre déjà branchée sur le code, il n'y a rien à
retaper. Le jeu est jouable immédiatement, sans aucune configuration.

### La limite du mode sans configuration

Sans variables d'environnement, le jeu passe par un canal local
(`BroadcastChannel`). **Il ne relie que deux fenêtres du même navigateur, sur le
même ordinateur.** Deux personnes sur deux appareils ne pourront jamais se
rejoindre dans ce mode, quel que soit le code — c'est la cause de très loin la
plus fréquente d'un « je n'arrive pas à rejoindre ». Le lobby le dit désormais
en clair, et signale au bout de huit secondes qu'il n'y a personne en face.

Pour jouer à deux, à distance, il faut configurer Supabase ci-dessous.

> Deux *fenêtres*, pas deux onglets. Un onglet caché voit son
> `requestAnimationFrame` bridé par le navigateur : la boucle de jeu de celui
> qui héberge la partie s'arrêterait de tourner. Deux fenêtres côte à côte
> restent visibles toutes les deux — et de toute façon, on veut voir les deux
> écrans.

### Jouer à distance — configurer Supabase

Cinq minutes, une seule fois. Aucune base de données n'est nécessaire : le jeu
n'utilise que le service temps réel (Broadcast), disponible sur le plan gratuit.

1. **Créez un projet** sur <https://supabase.com/dashboard> → *New project*.
   N'importe quelle région proche de vous. Attendez la fin de l'installation.
2. **Relevez les deux valeurs** dans *Project Settings → API* :
   - *Project URL* → `https://xxxxxxxx.supabase.co`
   - *Project API keys → **anon** / publishable* → `eyJhbGciOi...`

   > Prenez bien la clé **anon**, jamais la clé `service_role`. La clé anonyme
   > est publique par nature — elle part dans le navigateur, c'est son rôle.
   > La clé de service donnerait à n'importe quel visiteur un accès complet.
3. **Écrivez-les** dans un fichier `.env.local` à la racine du projet :

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```

4. **Vérifiez que ça marche vraiment** :

   ```bash
   npm run supabase:check
   ```

   Ce script ne regarde pas si la clé « a l'air bonne » : il ouvre deux clients
   distincts sur un même canal, comme deux joueurs, et fait passer un message de
   l'un à l'autre. Il vous dit en clair ce qui bloque le cas échéant — projet en
   pause, mauvaise clé, WebSockets filtrés.

5. **Reportez les deux variables sur Vercel** : *Settings → Environment
   Variables*, pour les trois environnements, puis **redéployez**. Sans ça,
   l'URL déployée reste en mode local et deux personnes ne pourront pas se
   rejoindre.

Une fois en ligne, le lobby le dit : « votre adversaire peut être n'importe où ».

#### Si un projet gratuit se met en pause

Supabase suspend les projets gratuits après une période sans activité. Le jeu
affichera alors « Le serveur de partie ne répond pas ». Il suffit de rouvrir le
tableau de bord Supabase pour le réveiller.

#### La table `sessions` est facultative

Elle ne sert qu'à conserver le score en cas de rechargement, et son absence est
silencieusement tolérée. Le jeu fonctionne entièrement sans elle.

```sql
create table sessions (
  code text primary key,
  host_id uuid not null,
  guest_id uuid,
  status text not null default 'lobby',   -- lobby | playing | finished
  round int not null default 0,
  score_host int not null default 0,
  score_guest int not null default 0,
  castle_host jsonb,
  castle_guest jsonb,
  created_at timestamptz not null default now()
);
alter table sessions enable row level security;
```

### Déployer

Le projet se déploie sur Vercel sans configuration. **Mais un déploiement sans
les deux variables `NEXT_PUBLIC_*` reste en mode local** : chaque visiteur ne
peut jouer que contre une seconde fenêtre de son propre navigateur. Pour que
deux personnes jouent ensemble sur l'URL déployée, renseignez
`NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY` dans les
variables d'environnement du projet Vercel, puis redéployez.

---

## Commandes

| Commande | Ce qu'elle fait |
|---|---|
| `npm run dev` | Serveur de développement |
| `npm run build` | Build de production, types vérifiés |
| `npm run typecheck` | TypeScript seul |
| `npm test` | Tests de la simulation, en Node, sans navigateur |
| `npm run plans` | Valide la topologie des trois châteaux |
| `npm run playtest` | Fait jouer deux robots des dizaines de manches |
| `npm run duel` | Vérifie que le Châtelain perd un duel loyal |
| `npm run e2e` | Joue une session complète dans un vrai navigateur (serveur `dev` requis) |
| `npm run supabase:check` | Vérifie qu'une configuration Supabase permet réellement de jouer |

---

## Commandes de jeu

Les déplacements acceptent **ZQSD, WASD et les flèches** : pas besoin de changer
de clavier.

| | Envahisseur | Châtelain |
|---|---|---|
| Se déplacer | ZQSD / WASD | ZQSD / WASD |
| Viser | souris | souris |
| Frapper | clic gauche | clic gauche |
| Parer | clic droit (maintenu) | — |
| **Maj (maintenu)** | avancer prudemment | — |
| **Espace (maintenu)** | courir | **Scrutation** |
| F | esquive roulée | — |
| E | allumer un brasero | interagir |
| 1 2 3 | outils | — |
| clic en Scrutation | — | déclencher un mécanisme |
| ² ou ~ | panneau de réglage | panneau de réglage |

`Espace` maintenu est la grande touche des deux camps. Aucun des deux rôles ne
peut faire les deux : la touche n'est jamais ambiguë.

---

## Comment le jeu est fait

```
src/game/      simulation pure — ni React, ni DOM, testable en Node
  config.ts      TOUTES les constantes de gameplay, sans exception
  types.ts       le contrat partagé par le réseau, le rendu et l'UI
  grid.ts        collisions, ligne de vue, lumière, pièces
  sim.ts         la manche : acteurs, pièges, capture, Influence
  prep.ts        budgets et placement, revalidés côté hôte
  snapshot.ts    filtrage de l'information par destinataire
  match.ts       l'arc des quatre manches
  plans/         les trois châteaux, écrits en ASCII

src/net/       réseau
  transport.ts   interface + canal local (BroadcastChannel)
  supabase.ts    Supabase Realtime
  clientView.ts  prédiction, réconciliation, interpolation
  engine.ts      machine à états du match, autorité côté hôte

src/render/    Canvas 2D, hors de React
src/audio/     synthèse procédurale, aucun fichier son
src/components/ React — le HUD et les écrans, rien d'autre
```

**La boucle de jeu ne vit pas dans React.** Elle tourne dans
`requestAnimationFrame`, à pas fixe de 30 ticks/s avec accumulateur. React ne
rend que le HUD, rafraîchi à 10 Hz. Aucune entité n'existe dans le DOM.

### Autorité et réseau

Le créateur de la session est l'**hôte** et le reste tout le match, quel que soit
son rôle dans la manche en cours. Il fait tourner la simulation autoritative ;
l'invité envoie ses entrées à 30 Hz, reçoit des instantanés à 20 Hz, et prédit
localement son propre déplacement avec réconciliation sur `ackSeq`.

**L'hôte filtre chaque instantané selon ce que son destinataire a le droit de
percevoir.** C'est la règle centrale du projet : dans un jeu à information
cachée, transmettre une donnée en comptant sur l'affichage pour la masquer est
la faille la plus évidente qui soit. Concrètement, l'Envahisseur ne reçoit
jamais la position du Châtelain qu'il ne voit pas, ni l'Influence de celui-ci,
ni la liste de ses pièges, ni le tracé d'un mur qu'il n'a pas exploré — les
tuiles lui sont envoyées en delta, au fur et à mesure qu'il les découvre.

`auditSnapshot()` vérifie cette propriété, et `npm run playtest` l'exécute sur
soixante manches.

### Anti-triche : aucun, l'hôte est de confiance

C'est un choix assumé. L'hôte connaît le château de son adversaire dans sa
mémoire JavaScript quand c'est l'invité qui défend — il ne l'affiche pas, mais
rien ne l'empêcherait techniquement de le lire. Le jeu est conçu pour deux
personnes qui se sont échangé un code, pas pour un classement public. Y consacrer
du travail se ferait au détriment du plaisir de jeu.

---

## Régler le jeu

> « Le plaisir se règle par itération, pas par intuition. »

- **Toutes** les constantes sont dans `src/game/config.ts`. Il n'y en a nulle
  part ailleurs.
- La touche **²** ouvre un panneau qui modifie ces constantes **en direct**,
  y compris pendant une manche. Les valeurs ne sont pas sauvegardées : reportez
  dans `config.ts` ce qui vous convient.
- `npm run playtest` fait jouer deux robots et vérifie que toute manche se
  termine et qu'aucune information ne fuit. Il affiche aussi des indicateurs de
  plaisir — **ils ne valident rien**. Les robots jouent mal, et le robot
  Châtelain n'attire personne dans une pièce préparée. Ces critères-là se
  vérifient à deux, sur un vrai match.
- `npm run duel` vérifie une contrainte de conception qui ne se négocie pas :
  le Châtelain doit perdre un affrontement loyal en terrain neutre. S'il le
  gagnait, il n'aurait plus aucune raison de préparer son château, et tout le
  jeu s'effondrerait.
- `npm run plans` refuse tout château dont le Cœur serait coupable d'une seule
  porte, dont un brasero serait muré, ou qui serait trop sombre pour être lu.
- `npm run e2e` pilote deux fenêtres et joue une session entière. C'est le seul
  contrôle qui prouve que le jeu *tourne* : un build qui passe ne dit rien du
  câblage entre React, le canvas et le réseau. Il a déjà attrapé un nettoyage
  React qui fermait la connexion à peine ouverte, et un Châtelain qui ne
  recevait jamais les tuiles de son propre château.

### Un arbitrage signalé

Le cahier des charges fixe la régénération d'Influence au Cœur à **+7/s** et le
coût de la Scrutation à **−5/s**. Pris à la lettre, ces deux nombres donnent
**+2/s net** : le Châtelain peut rester assis sur son Cœur, omniscient et
gratuit, en gelant indéfiniment la capture. Cela contredit deux tensions de la
section 2 à la fois — « l'omniscience doit toujours se payer » et « un Châtelain
qui campe doit être structurellement perdant ».

Le correctif retenu est le plus petit possible : **le Cœur ne recharge pas celui
qui scrute** (`sim.ts`, `updateInfluence`). Les deux nombres du cahier restent
intacts ; le Châtelain doit simplement choisir entre recharger et regarder.

---

## Ce qui n'est pas fait

- Pas de compte, pas de matchmaking public, pas de progression : tout le contenu
  est disponible dès la première partie, c'est voulu.
- Le mode observateur et l'enregistrement d'une manche rejouable (§17) ne sont
  pas implémentés. `scripts/playtest.ts` couvre le besoin de mesure, pas celui
  d'analyser une partie humaine a posteriori.
- La reprise après déconnexion met la partie en pause pendant 30 secondes et la
  reprend si le joueur revient ; elle ne survit pas à une fermeture d'onglet du
  côté de l'hôte.
