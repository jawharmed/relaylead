# Lot A1 (0.2) : plusieurs missions dans un même dépôt

Plan allégé, macOS seul. Conception : `docs/specs/2026-11-22-relaylead-console-design.md`, §5.3 « Isolement », « Ressources partagées » (verrou git par dépôt seulement) et « Missions de 0.1 en cours », §8 points 6 et 8. Lecture faite : `core/missions.js`, `core/mission-lock.js`, `core/tasks.js`, `core/config.js`, `deliveries/local-merge.js`, `deliveries/github-pr.js`, `deliveries/files.js`, `core/guard.js` (`holdsStateFolder`), tests des missions, des livraisons et e2e.

## 1. But et périmètre

But : deux missions lancées dans le même dépôt avancent en même temps et livrent chacune dans sa propre branche d'intégration ; leurs opérations git sur les parties communes du dépôt passent l'une après l'autre.

Dans le lot :
- verrou par mission au lieu du verrou par dossier ;
- branche d'intégration `relaylead/<mission>/integration`, worktrees `.relaylead/worktrees/<mission>/<tâche>` et `.relaylead/worktrees/<mission>/_integration` ;
- verrou git par dépôt (`~/.relaylead/locks/git-<empreinte>.lock`, empreinte du chemin réel du dossier git commun) ;
- compatibilité 0.1 : une mission 0.1 en cours garde son nommage, et bloque tout nouveau `launch` dans son dossier ;
- guide et README.

Hors lot (autres lots) : plafond de sessions, priorité, nettoyage de fin de mission, `merge`, console, mémoire, affichages. Le chevauchement et les conflits entre missions (§5.3) ne sont pas traités ici.

## 2. Décisions

- **Format.** `mission.json` des missions lancées par ce lot porte `format: 2`. Sans ce champ, la mission est au format 0.1 : chemins et branche d'avant (`relaylead/integration`, `.relaylead/worktrees/<tâche>`, `.relaylead/worktrees/_integration`). Les chemins se calculent en un seul endroit, `core/layout.js` (nouveau).
- **Branche d'intégration.** Écrite au lancement dans `mission.config.delivery.branch` (`relaylead/<mission>/integration`), seule source de vérité ensuite, comme en 0.1 : le code qui lit `delivery.branch` ne change pas. Le réglage `delivery.branch` de `.relaylead.json` n'est plus lu (deux missions ne peuvent pas partager une branche) ; retiré des valeurs par défaut.
- **Tâche `integration`.** Sa branche serait celle de l'intégration : refusée (`bad-task-id`) dans une mission au format 2.
- **Verrou de dossier supprimé.** Le nom de mission reste réservé par `mkdir` (unique sur la machine, §8 point 8). Le lancement prend le verrou de mission (`start.lock`) de la réservation du nom à l'écriture de `mission.json` ; `remove` d'un dossier sans `mission.json` passe sous ce même verrou (au lieu de lire les verrous de dossier). Le verrou de dossier des missions 0.1 en cours est encore libéré à leur fin (`releaseLock`, inchangé).
- **Refus 0.1.** Au lancement, si une mission sans `format: 2` du même dossier réel n'est ni finie ni en cours d'arrêt : erreur `old-mission-running` (anglais et français), rien n'est créé.
- **Verrou git par dépôt** (`withRepoLock(dir, command, action)` dans `core/mission-lock.js`) : pris autour de chaque appel à la livraison qui touche les parties communes : `prepareMission` (branche, worktree, fusion), `prepareTask` (branche, worktree), `deliver`/`finish` (fusion, commit, suppression de worktree et de branche), `cleanMission` et `removeMission` (suppressions). Dossier hors dépôt git (livraison `files`) : pas de verrou. Un attendant abandonne après `RELAYLEAD_REPO_LOCK_WAIT_MS` (10 min par défaut) avec `repo-busy` ; un verrou dont le détenteur est mort est repris comme celui de mission.
- **Ordre des verrous, sans interblocage** : verrou de mission d'abord, verrou git ensuite, jamais l'inverse ; l'action faite sous le verrou git n'attend aucun autre verrou (des commandes git synchrones). Aucun cycle d'attente n'est donc possible.

## 3. Tâches

### Tâche 1 : plan
Ce fichier (`docs: plan du lot A1`).

### Tâche 2 : chemins et branche par mission
- `core/layout.js` : `FORMAT = 2`, `isPerMission(mission)`, `integrationBranch(name)`, `worktreesDir(mission)`, `integrationDir(mission)`, `taskDir(mission, id)`.
- `createMission` écrit `format: 2` et `config.delivery.branch = integrationBranch(name)`.
- `deliveries/local-merge.js` et `core/tasks.js` (`sourceRoot`, `checkTaskId`) passent par `core/layout.js` ; `branchesClash` ne vaut que pour le format 0.1 ; messages `protected-branch`, `integration-mismatch`, `branch-clash`, `bad-task-id` relus.
- `core/config.js` : `delivery.branch` retiré des défauts. `fixtures/missions.js` `writeMission` écrit le format 2 (option `{ format: 1 }` pour une mission 0.1).
- Tests : ceux qui citaient `relaylead/integration` passent au nouveau nommage ; une livraison dans une mission 0.1 garde l'ancien.

### Tâche 3 : verrou par mission, refus 0.1
- `core/missions.js` : plus de verrou de dossier au lancement (`takeLock`, `readFolderLock`, `launchRunning`… retirés) ; lancement sous `withMissionLock(name, 'launch')` ; refus `old-mission-running` ; `remove` d'un dossier sans `mission.json` sous le verrou de mission.
- Tests : deux lancements simultanés dans un dossier réussissent tous les deux ; un lancement est refusé tant qu'une mission 0.1 du dossier tourne, accepté une fois qu'elle est finie ; les tests du verrou de dossier au lancement sont retirés.

### Tâche 4 : verrou git par dépôt
- `withRepoLock` dans `core/mission-lock.js`, branché dans `core/missions.js` (`createMission`, `cleanMission`, `removeMission`) et `core/tasks.js` (`launchCrew`, `deliverTask`).
- Tests : le verrou sérialise deux fusions (deux `relaylead task deliver` lancés en même temps dans deux processus, deux missions du même dépôt, un hook `pre-merge-commit` qui note entrée et sortie : les intervalles ne se chevauchent pas) ; un verrou laissé par un processus mort est repris.
- e2e : deux missions lancées dans le même dépôt avec le faux agent sont `done`, chacune a ses deux tâches fusionnées dans `relaylead/<mission>/integration`.

### Tâche 5 : documentation
`docs/guide.md` et `README.md` : branche `relaylead/<mission>/integration`, worktree `.relaylead/worktrees/<mission>/_integration`, plusieurs missions par dossier (`--name` pour la deuxième), plus de `delivery.branch`, refus en présence d'une mission 0.1.

## 4. Critère « terminé »

`npm test` vert sous macOS, dont les trois tests demandés : deux missions dans le même dépôt livrent chacune dans sa branche ; refus en présence d'une mission 0.1 ; le verrou git sérialise deux fusions.
