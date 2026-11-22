# Lot A2 (0.2) : plafond de sessions, priorité, fusion et fin de mission

Plan allégé, macOS seul. Conception : `docs/specs/2026-11-22-relaylead-console-design.md`, §5.2 (fin de mission et nettoyage), §5.3 (« Ressources partagées », « Priorité », « Conflits (option b) »), §8 points 1 et 2. Lecture faite : `core/missions.js`, `core/tasks.js`, `core/mission-lock.js`, `core/watcher.js`, `core/watcher-rules.js`, `core/cli.js`, `core/overview.js`, `core/console-wait.js`, `core/told.js`, `deliveries/*.js`, `adapters/fake/*`, `plugin/skills/relaylead/SKILL.md`.

## 1. But et périmètre

Dans le lot : plafond global `maxSessions` et file d'attente ordonnée par priorité ; `relaylead priority` ; `relaylead merge` avec tâche de résolution des conflits ; retrait des sessions de `claude agents` en fin de mission ; suppression du dossier de mission par le veilleur une fois l'intégration fusionnée ; mission abandonnée signalée ; skill de console, guide et README.

Hors lot : chevauchement prévu au lancement (fait par la console, lot B), fusion automatique (jamais).

## 2. Décisions

- **Places.** `maxSessions` (config globale, défaut 4) borne les tâches `running` de la machine, toutes missions confondues (missions non finies, plus celles dont une résolution de fusion est en cours). Compté sur les fiches `tasks/<id>.json` (état `running` sans résultat de la même tentative), jamais par un appel à l'agent ; les leads ne comptent pas.
- **File.** Sans place, ou si une tâche en file la précède (priorité plus haute ou égale, donc plus ancienne), `task start`/`task retry` écrit la fiche `queued` (`queuedAt`, profil, tentative) et rend la main : rien n'est arrêté ni préempté. `queued` compte dans la limite `parallel` de la mission. Le veilleur, à chaque passage (complet ou ciblé), démarre les tâches en file dans l'ordre priorité (`high`, `normal`, `low`) puis `queuedAt`, tant qu'il reste des places ; une mission finie ou en pause d'usage ne sort pas de file. Un démarrage depuis la file qui échoue passe la tâche en `failed` (le lead la voit).
- **Verrou des places** `~/.relaylead/locks/sessions.lock` (`withPlacesLock`), pris du choix de la place à l'écriture de la fiche. Ordre des verrous : mission, places, git ; jamais l'inverse (en tête de `core/mission-lock.js`).
- **Priorité.** `relaylead priority <mission> <high|normal|low>` réécrit `priority` de `mission.json` sous le verrou de mission ; `--priority` est vérifié au lancement (`bad-priority`). Agit sur les seuils de quota (déjà) et sur la file.
- **Fusion.** `relaylead merge <mission>` (utilisateur seul, mission `done`) fusionne `relaylead/<mission>/integration` dans la branche cible : celle de l'utilisateur au lancement (`baseBranch` noté dans `mission.json`), sinon `main`, sinon `master`. Sous le verrou de mission puis le verrou git. La fusion se fait dans le worktree où la cible est extraite (souvent le dossier de l'utilisateur, qui doit être propre : `merge-target-dirty`), sinon dans un worktree temporaire `.relaylead/worktrees/<mission>/_merge`. En conflit : `git merge --abort`, rien n'est laissé à moitié.
- **Résolution.** Sur conflit, `merge.json` (écrit par `core/merge.js` seul, sous le verrou de mission) passe `resolving` et décrit une tâche `merge-into-<cible>` qui s'ajoute à `relaylead task list`. Un équipier la reçoit (par la file s'il le faut) sur une branche tirée de l'intégration : il fusionne la cible dans sa branche (il voit les deux côtés), résout, lance les tests, commite, `task done`. Pas de relance du lead (coût en jetons) : le veilleur joue son rôle pour cette tâche, sans IA. Tâche finie : livraison dans l'intégration, arrêt de l'équipier, nouvelle tentative de fusion (2 résolutions automatiques au plus). Tâche échouée : question à l'humain « Resolve it here with me » / « Relaunch a crew member with hints » / « Pause the mission » ; le contexte dit comment résoudre à la main ; les indications passent par `relaylead tell`, accepté pendant une fusion. Réponse 2 : nouvel équipier avec ces indications ; réponses 1 et 3 : `paused`, `relaylead merge` relance quand l'utilisateur veut. `task-not-retryable`, `mission-done` ne bloquent pas cette tâche-là (option `merge` interne).
- **github-pr.** `merge` pousse l'intégration, ouvre (ou retrouve) la PR intégration → cible et la fusionne par `gh` ; PR non fusionnable : même tâche de résolution (fusion de `<remote>/<cible>`), livrée dans l'intégration locale puis poussée sur la branche de la PR.
- **Fin de mission.** Une fois ses sessions arrêtées (fin ou `stop`), chacune est retirée de `claude agents` (`forget`, au mieux) ; le lead d'une mission `done` l'est par l'assistant `_reap` après son arrêt. Le faux agent gagne `forget` (journal `fake-forget.log`).
- **Nettoyage.** À chaque passage complet, une mission au format 2 livrée par git, finie, sans fusion en cours ni assistant `_reap` actif, dont la branche d'intégration est supprimée, ou fusionnée dans la cible (par `merge`, ou à la main : sa pointe, différente du commit de départ `startCommit`, est contenue dans la cible locale ou distante), est retirée comme par `relaylead remove` (sans `--force`) plus son worktree d'intégration propre ; la branche d'intégration reste. Un refus (travail non livré) est noté une fois (`cleanup.json`) et la mission reste.
- **Abandon.** Mission non finie, au moins une question ouverte, aucun fichier de son dossier modifié depuis `abandonDays` jours (défaut 7 ; `watch.json` exclu, le veilleur y écrit) : règle 31, une notification par période d'inactivité ; `list` (« abandoned ») et `doctor` (avertissement) la signalent. Rien n'est supprimé.
- **Affichages.** `list` et `show` ajoutent `(n queued)` et `(abandoned)` à l'état ; `overview` donne l'état `queued` des tâches et `sessions: {running, max}` ; panneau et page web ont un libellé pour `queued`. `wait --all` gagne l'événement `merge` (fusion faite).

## 3. Tâches

### Tâche 1 : plan
Ce fichier (`docs: plan du lot A2`).

### Tâche 2 : plafond de sessions et file d'attente
- `core/config.js` : `maxSessions: 4`, `abandonDays: 7`. `core/mission-lock.js` : `withPlacesLock`, ordre des verrous. `core/places.js` : places prises, file ordonnée.
- `core/tasks.js` : `launchCrew` met en file faute de place ; `startQueued` démarre la file ; `queued` dans `checkParallelLimit`, `retryTask`. `core/watcher.js` : la file après chaque passage, complet ou ciblé.
- `list`/`show`/`overview`, panneau, page web ; profil du lead et méthode `code` (`queued` compte comme `running`) ; faux lead idem.
- Tests : la 5ᵉ tâche avec `maxSessions` 4 va en file ; une place libérée, le veilleur démarre la plus prioritaire puis la plus ancienne ; e2e : deux missions du faux agent avec `maxSessions` 1 finissent toutes deux.

### Tâche 3 : `relaylead priority`
CLI, message, vérification de `--priority`. Test : la priorité changée réordonne la file.

### Tâche 4 : fin de mission et abandon
- `forget` après les arrêts (`stopAndFree`, `reapLead`) ; `forget` du faux agent.
- Règle 31, action `notify` ; `core/abandon.js` partagé par l'observation, `list` et `doctor`.
- Tests : `stop` retire les sessions de la liste de l'agent ; mission abandonnée notifiée une fois, signalée par `list` et `doctor`, rien supprimé.

### Tâche 5 : `relaylead merge` et résolution des conflits
- `core/merge.js` (commande, `tendMerge` du veilleur) ; `deliveries/local-merge.js` (`mergeTarget`, `mergeIntoTarget`, `integrationState`, livraison de la tâche de résolution), `deliveries/github-pr.js` ; `baseBranch` et `startCommit` au lancement ; `tell` pendant une fusion ; événement `merge` de `wait --all` ; skill de console.
- Tests : fusion sans conflit (dossier de l'utilisateur sur la cible, et cible non extraite) ; conflit : fusion annulée, tâche de résolution confiée à un équipier du faux agent, livrée, nouvelle tentative réussie ; résolution échouée : question aux trois choix.

### Tâche 6 : nettoyage après fusion
`removeIfMerged` dans le passage complet. Tests : dossier supprimé après `merge` ; gardé tant que rien n'est fusionné.

### Tâche 7 : documentation
`docs/guide.md` et `README.md`.

## 4. Critère « terminé »

`npm test` vert sous macOS, dont : file d'attente et priorité, fusion sans conflit, fusion en conflit qui crée la tâche de résolution, nettoyage après fusion, abandon.
