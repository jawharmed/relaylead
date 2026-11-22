# Relaylead 0.2 : la console dans Claude, plusieurs missions, mémoire et tableau de bord

Conception du 22 novembre 2026, discutée et validée avec l'auteur. Base : la version publiée 0.1.0 (`main` 9fc42d3), dont le design reste [`2026-11-14-relaylead-design.md`](2026-11-14-relaylead-design.md). Ce document dit ce qui change ; tout ce qu'il ne cite pas reste tel quel.

## 1. Pourquoi

En 0.1.0, tout passe par la commande `relaylead` dans un terminal. Quand le lead pose une question, l'utilisateur reçoit au mieux une notification Mac, puis doit taper `relaylead question list` et `relaylead answer`. Il ne voit rien depuis Claude, et rien dans Claude Desktop ni sur mobile.

L'auteur veut **piloter Relaylead depuis une conversation Claude** : `/relaylead` ou « utilise relaylead pour… », voir les questions et l'avancement dans la conversation, être notifié par Claude (mobile compris), garder **tous** les garde-fous actuels (veilleur, quota, reprise, worktrees, branches, nettoyage), et pouvoir mener **plusieurs missions en parallèle** sur un même projet (ex. une mission backend et une frontend, ou deux fonctionnalités backend).

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs**
- Lancer, suivre, répondre et donner des consignes depuis une conversation Claude (terminal, Desktop en local).
- Plusieurs missions à la fois, par projet et sur la machine, chacune avec son cycle de vie.
- Une mémoire de projet utile et à coût borné.
- Trois affichages : ligne d'état, panneau à côté de la conversation, page web locale.

**Non-objectifs**
- Sessions cloud : les équipiers restent des sessions Claude Code locales en arrière-plan, gardées par launchd.
- Linux et Windows (toujours macOS seul).
- Un « super-lead » qui orchestre les leads (écarté, §4).

**Anti-objectifs** (échec même si « ça marche »)
- Une question perdue ou non vue.
- Une conversation fermée qui casse ou arrête une mission.
- Une perte de travail ou une branche supprimée sans l'accord de l'utilisateur.
- Un coût en jetons qui grimpe avec la durée de vie du projet (mémoire non bornée, session qui tourne pour rien).
- Toucher aux réglages Claude de l'utilisateur sans pouvoir les rendre à l'identique.

## 3. Contraintes

- Node 18+, CommonJS, aucune dépendance ; tests `node --test` avec le faux agent ; CI macOS (Node 18 et 24).
- Tout nouvel appel git ou `gh` synchrone passe par `runFileSync` (`core/run-file.js`).
- Les sessions restent des `claude --bg` lancées par Relaylead, avec leurs réglages (hooks de garde, permissions, `apiKeyHelper`, modèle, relève au contexte plein).
- Le panneau et l'entrée de ligne d'état sont des « mods » de Claude Code (module de hooks dans le plugin) ; vérifié sur Claude Code 2.1.330 : `$.ui.open` (panneau, dessiné sur terminal, desktop, vscode, mobile), `$.ui.status`, `$.ui.toast`, `$.fs.read` (chemins absolus), `$.clock.every`, boutons. Sans support des mods, Relaylead fonctionne sans ces deux affichages.

## 4. Approches considérées

| | Principe | Verdict |
|---|---|---|
| A. La conversation est le lead | La conversation de l'utilisateur orchestre ; un lead de secours en arrière-plan prend le relais si elle disparaît, et `/relaylead reprendre` rend la main. | Écartée. Rouvre la partie la plus fragile (cycle de vie du lead, deux sortes de leads, détection d'une conversation morte). Relaylead ne contrôle pas les réglages d'une conversation ouverte par l'utilisateur (hooks, clé API, relève, interdiction de coder). Économie de jetons douteuse : le lead porterait toute la discussion. |
| **B. La conversation est une console** | Le lead reste en arrière-plan, inchangé. La conversation lance, suit, affiche les questions telles quelles, transmet réponses et consignes. | **Choisie.** Ne touche pas au moteur testé ; fermer la conversation est un non-événement ; surcoût estimé +2 à 5 % des jetons d'une mission (non mesuré). Prix accepté : on ne parle pas au lead en direct. |
| C. Sous-agents de Claude Code | Tout dans la conversation, sans sessions en arrière-plan. | Écartée : perd veilleur, pause de quota et reprise. |

Super-lead : écarté. Ce qui se coordonne entre missions (plafond de sessions, priorité, verrou git, détection de conflits) est déterministe : le veilleur le fait sans IA. La seule valeur d'un super-lead (prévoir les chevauchements) est rendue par la console, une fois, au lancement (§5.3).

Conflits entre missions : option **b** choisie (le lead résout, l'utilisateur en dernier recours) plutôt que a (Relaylead détecte, l'utilisateur résout).

## 5. Conception

### 5.1 La console

- **Entrée** : un skill du plugin Relaylead, déclenché par `/relaylead` ou par une demande en langage naturel (« utilise relaylead pour… »). Les commandes `/relaylead:*` existantes restent.
- **Premier usage dans un projet** : si `relaylead` ou le veilleur launchd manque, la console le dit et propose `relaylead install`. Sans `.relaylead.json`, elle pose les questions d'`init` dans la conversation et écrit les fichiers (mêmes fichiers qu'en 0.1 : `~/.relaylead/config.json` global, `.relaylead.json` par projet). L'utilisateur peut ensuite demander des changements en clair (« limite à 2 équipiers ici »).
- **Lancement** : la console rédige la mission avec l'utilisateur, la lance (`relaylead launch`), puis attend les événements en tâche de fond (`relaylead wait`, sans bloquer la conversation et sans consommer de jetons entre deux événements).
- **Questions** : affichées telles quelles (texte, options numérotées, recommandée), jamais reformulées, avec le nom de la mission ; la réponse part par `relaylead answer`.
- **Consignes** : « dis au lead de… » devient une nouvelle commande `relaylead tell <mission> <texte>` : le message est enregistré dans la mission (il sert aussi de mémoire de mission) et réveille le lead, qui le lit à son réveil.
- **Suivi** : « où en est X ? » lit l'état (`relaylead list`/`show`, journal) ; la console se réveille seulement sur question, échec, conflit et fin de mission, pas à chaque tâche.
- **Notifications** : le veilleur garde la notification Mac à chaque question (même sans console). La console notifie aussi par Claude, ce qui atteint le mobile quand l'app est reliée à la session.
- **Reprise** : toute nouvelle conversation qui charge la console liste les missions non terminées et **toutes** les questions ouvertes avant autre chose.
- **Critères d'acceptation** (testés avec le faux agent) : aucune question manquée, y compris posée pendant que la console est fermée ; chaque événement nomme sa mission ; tout est retrouvé à la réouverture ; une consigne `tell` arrive au lead et figure dans la mission ; coût en jetons de la console mesuré lors de l'essai réel.

### 5.2 Fin de mission et nettoyage

- Une mission ne finit que de deux façons : le lead la déclare terminée (toutes les tâches livrées), ou l'utilisateur l'arrête (`stop`, ou « arrête la mission » à la console). Fermer une conversation ne change rien.
- Déjà en 0.1 : à chaque livraison, worktree et branche de la tâche sont supprimés ; à la fin, le veilleur arrête toutes les sessions de la mission.
- Nouveau :
  - en fin de mission, les sessions sont aussi retirées de la liste `claude agents` ;
  - le dossier `~/.relaylead/missions/<mission>/` est supprimé quand la branche d'intégration de la mission a été fusionnée ou supprimée (vérifié par le veilleur), ou par `relaylead remove` ;
  - mission abandonnée (question sans réponse et aucune activité depuis `abandonDays`, 7 par défaut) : notification, et `list`/`doctor` la signalent. Rien n'est supprimé sans l'utilisateur.

### 5.3 Plusieurs missions en parallèle

- **Isolement** : un verrou par mission, et non plus par dossier ; branche d'intégration `relaylead/<mission>/integration` et worktrees `.relaylead/worktrees/<mission>/<tâche>` et `.relaylead/worktrees/<mission>/_integration`. Les branches de tâches sont déjà `relaylead/<mission>/<tâche>`.
- **Ressources partagées** :
  - verrou git par dépôt pour les opérations sur les parties communes (création de worktree, fusion, refs) : deux fusions passent l'une après l'autre ;
  - plafond global de sessions Claude sur la machine (`maxSessions` dans la config globale), toutes missions confondues ;
  - quota : unique pour la machine ; seuils de pause par priorité (réglage `usage`, existant).
- **Priorité** (`high`, `normal`, `low`, affichées haute, normale, basse ; `normal` par défaut, valeurs déjà existantes en 0.1) :
  - fixée par l'utilisateur au lancement ou plus tard (« passe X en haute ») ;
  - au lancement, si une autre mission est active **sur la machine**, la console demande la priorité en rappelant les missions en cours et leur priorité, et permet de les changer dans la même réponse ; pas de question avec `--priority` ou sans personne pour répondre ;
  - effets : seuil de pause de quota (seuils par priorité déjà en place dans `usage.thresholds`), et attribution des places quand le plafond de sessions est atteint (la plus prioritaire d'abord).
- **Chevauchement prévu** : au lancement, la console compare ce que la nouvelle mission va toucher avec les missions en cours et prévient (« X et Y touchent `src/api/` : je les enchaîne ou en parallèle ? »).
- **Conflits (option b)** : la mission qui livre en second se met à jour sur `main` (ou sur l'intégration de l'autre si celle-ci est déjà fusionnée) ; en cas de conflit, son lead crée une tâche de résolution pour un équipier, qui voit le code des deux missions, puis les tests tournent. Si l'équipier échoue : question à la console avec au moins « je le résous ici avec toi », « relance un équipier avec ces indications », « mets la mission en pause ». Rien n'est forcé ni écrasé.
- **Missions de 0.1 en cours** lors de la mise à jour : elles finissent avec l'ancien nommage (`relaylead/integration`) ; les nouvelles prennent le nouveau.

### 5.4 Mémoire

- **Mémoire de mission** : dans `~/.relaylead/missions/<mission>/` (état, tâches, questions, réponses, journal, consignes `tell`) et un fichier `decisions.md` où le lead note chaque décision prise avec l'utilisateur. Lue seulement par le lead de cette mission ; supprimée avec elle.
- **Mémoire de projet** : `.relaylead/memoire.md` dans le dépôt : conventions du projet, résumé d'une ligne par mission passée, leçons. Lue par chaque nouveau lead au démarrage.
  - **Plafond** : 200 lignes par défaut (`memory.maxLines` dans `.relaylead.json`).
  - **Compaction** en fin de mission, par le lead : la mission devient une ligne, les leçons sont fusionnées, le périmé retiré ; les anciennes entrées vont dans `.relaylead/memoire-archive/`, jamais lue.
  - **Garde-fou sans IA** : au démarrage, si le fichier dépasse le plafond, le lead doit le compacter avant de commencer ; `doctor` le signale.
  - **Écritures concurrentes** : chaque mission écrit sa propre entrée dans son dossier ; la fusion dans `memoire.md` se fait en fin de mission, sous verrou.
- **À l'`init`** du projet, deux questions : activer la mémoire de projet (oui par défaut) ; la versionner avec le code ou la garder hors de git (hors de git par défaut, via `.git/info/exclude`, sans toucher au `.gitignore`).

### 5.5 Affichages

Les trois lisent les mêmes fichiers de `~/.relaylead`. Leur ergonomie (contenu, hiérarchie, couleurs, actions) fait l'objet de **maquettes validées par l'auteur avant d'être codées**.

- **Ligne d'état** : entrée posée par le plugin avec `$.ui.status`, sans toucher au `statusLine` des réglages de l'utilisateur ; affichée seulement s'il y a une mission en cours ou une question, effacée sinon, disparaît avec le plugin. À enrichir sans encombrer (ex. `relaylead · 2 missions · ❓1 · quota 62 %`). Active d'office, désactivable (`display.statusLine`).
- **Panneau** à côté de la conversation (mod du plugin, `$.ui.open`) : missions, tâches, questions avec boutons de réponse, quota ; relecture des fichiers à intervalle régulier. Proposé une fois, au premier lancement d'une mission : « Toujours / Cette fois / Jamais », choix retenu (`display.pane`) ; `/panneau` l'ouvre ou le ferme. Dans le terminal, ouverture automatique seulement si la fenêtre est assez large (environ 144 colonnes).
- **Page web locale** : `relaylead dashboard` sert une page sur `127.0.0.1` seulement (port configurable) et l'ouvre dans le navigateur ; fonctionne même Claude fermé. Actions (répondre, arrêter) protégées par un jeton aléatoire par lancement, pour qu'aucun autre site ouvert dans le navigateur ne puisse les déclencher. Jamais imposée : la console la propose quand elle est utile (plusieurs missions, question restée longtemps sans réponse) ; la notification Mac peut porter son lien.

## 6. Ce qui ne change pas

Le veilleur et ses règles (relance, réveil, relève, disjoncteur, pause de quota), les hooks de garde, les livraisons `local-merge` et `github-pr`, la source GitHub, l'authentification compte ou clé API, `install`/`uninstall`, et l'interface en ligne de commande (la console s'appuie dessus).

## 7. Laissé au constructeur

- Le découpage en lots et leur ordre (proposition : multi-mission et ressources partagées, puis console et `tell`, puis mémoire, puis affichages).
- Le format exact des fichiers nouveaux (`decisions.md`, consignes, verrous) et des clés de configuration, en suivant les conventions existantes.
- Comment le skill attend `relaylead wait` en tâche de fond dans Claude Code et comment il notifie le mobile, à vérifier sur la version courante de Claude Code.
- Le choix du port par défaut de la page web.

## 8. Précisions après relecture

Une relecture « constructeur » a posé huit questions ; voici les réponses. Celles marquées *(choix du concepteur)* n'ont pas été tranchées par l'auteur et peuvent être revues.

1. **Fusion dans `main`.** Elle n'est jamais automatique : en fin de mission, la console demande « je la fusionne dans main ? » et, sur un oui, lance `relaylead merge <mission>` (nouvelle commande). C'est à ce moment que se règlent les conflits entre missions : si la fusion entre en conflit avec `main` (qui contient déjà l'autre mission), la mission rouvre une tâche de résolution confiée à un équipier, puis tests, puis nouvelle tentative ; si l'équipier échoue, question à la console (§5.3). Avec `github-pr`, c'est la PR qui porte le conflit, et la même tâche de résolution s'applique à sa branche. *(choix du concepteur pour la commande et le moment)*
2. **`maxSessions` saturé.** Les nouvelles sessions d'équipiers attendent leur tour dans une file ordonnée par priorité, puis par ancienneté ; rien n'est arrêté ni préempté. Les leads ne comptent pas dans le plafond, pour que chaque mission puisse toujours avancer et poser ses questions. Défaut : 4 équipiers sur la machine. *(choix du concepteur)*
3. **Maquettes.** L'auteur est joignable pour ce projet : les maquettes des trois affichages sont une étape du plan, avant leur code ; le reste avance sans attendre.
4. **Seuils de quota par priorité.** Ils existent déjà (`usage.thresholds.low|normal|high`) ; rien à inventer, la priorité de mission les utilise tels quels.
5. **Chemin de la mémoire de projet.** Toujours le dépôt principal (`<projet>/.relaylead/memoire.md`, chemin absolu), jamais un worktree ; le verrou de fusion est un fichier de `~/.relaylead/locks/` propre au dépôt. La compaction fait partie de la fin de mission : le lead compacte, puis seulement se déclare terminé ; le veilleur n'arrête les sessions qu'après. *(choix du concepteur)*
6. **Mission 0.1 en cours lors de la mise à jour.** Tant qu'une mission au format 0.1 tourne dans un dossier, une nouvelle mission y est refusée avec un message clair ; après elle, le multi-mission s'applique. Pas de cohabitation des deux nommages. *(choix du concepteur)*
7. **Contrat de `relaylead wait` et reprise.** Pas de curseur par conversation : à l'ouverture, la console affiche toutes les questions ouvertes et l'état de chaque mission non terminée (dont échecs et fins survenus entre-temps, lus dans l'état et le journal). `wait` garde son contrat actuel. *(choix du concepteur)*
8. **Identifiant de mission.** Inchangé : le nom de la mission, unique sur la machine (`~/.relaylead/missions/<nom>`) ; `tell`, `answer`, `stop`, `merge` le prennent sans projet explicite.
