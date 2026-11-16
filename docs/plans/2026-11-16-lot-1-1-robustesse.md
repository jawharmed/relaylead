# Lot 1.1 : robustesse — plan

> **Pour les agents qui exécutent :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`). Les titres de tâche gardent le mot anglais « Task » pour l'outillage. Chaque tâche correspond à une issue GitHub du jalon « Lot 1.1 : robustesse » ; la PR d'une tâche ferme son issue. Presque toutes les tâches touchent `core/messages.js`, `core/cli.js`, `core/missions.js` ou `deliveries/local-merge.js` : elles s'exécutent en série, dans l'ordre du plan.

**But :** rendre le squelette du lot 1 sûr à réutiliser : un dossier reste verrouillé tant que sa mission n'est pas finie et que ses sessions ne sont pas arrêtées, une mission finie se supprime et laisse place à la suivante dans le même dossier, une tâche en échec se relance, les dépendances s'installent sans leurs scripts, les hooks git de l'utilisateur sont joués sur les commits de Relaylead, et les petits défauts relevés au lot 1 sont corrigés.

**Architecture :** aucun nouveau module de fond. Le verrou de mission (aujourd'hui `withStartLock` dans `core/tasks.js`) sort dans `core/mission-lock.js` pour sérialiser aussi la fin de `state set done`, la fin de `stop` et toute la suppression d'une mission. Le verrou du dossier (`core/missions.js`) se juge sur l'état de la mission, porte son identité (`createdAt`) et reste tenu tant qu'un arrêt n'a pas fini. Le contrat de livraison gagne `cleanMission` (à l'arrêt et à la fin) et `removeMission` (pour `relaylead remove`). `core/tasks.js` gagne `retryTask`, qui archive la tentative précédente avant de relancer un équipier. `core/timing.js` regroupe les attentes et les réessais recopiés dans six fichiers.

**Outils :** Node.js 18 ou plus (CommonJS, aucune dépendance), `node --test`, git, GitHub Actions (ubuntu, macos, windows × Node 18, 24).

**Spec :** [`docs/specs/2026-11-14-relaylead-design.md`](../specs/2026-11-14-relaylead-design.md) (v6). Feuille de route : [`2026-11-15-feuille-de-route.md`](2026-11-15-feuille-de-route.md), ligne « 1.1 Robustesse ». Plan précédent : [`2026-11-15-lot-1-squelette.md`](2026-11-15-lot-1-squelette.md) ; relevé réel : [`docs/manual-checks/lot-1-claude-macos.md`](../manual-checks/lot-1-claude-macos.md). Ce lot tranche des décisions prises pendant l'exécution du lot 1, rappelées dans chaque tâche : verrou qui suit le PID du lead (F), tâche en échec non relançable (J), commits de Relaylead en `--no-verify` (M), `npm install` permis au développeur (Z), mission finie non relançable dans le même dossier (relecture finale, I-7), budget de réessai Windows fixé à 2 s (Task 2 du lot 1). Relecture contradictoire du plan faite le 16 nov. 2026 ; ses corrections sont intégrées.

## Contraintes globales

- Node.js 18 ou plus, CommonJS, **aucune dépendance**, aucune étape de compilation, aucune API absente de Node 18. Pas d'`await` au niveau racine (CommonJS) : `.then` ou une fonction `main`.
- Aucun appel à des outils absents de Windows (`jq`, `uuidgen`, `sleep`, `which`, `rm -rf`) dans le produit ni dans les tests. Chemins construits par `path.join`.
- Tests : `npm test` = `node --test` **sans argument**. Ces motifs par défaut exécutent **tout fichier `.js` sous `test/`** (vérifié) : les fixtures vont dans `fixtures/` à la racine, jamais sous `test/`.
- Tout test qui touche l'état fixe `RELAYLEAD_HOME` sur un dossier temporaire neuf. Aucun test n'écrit dans le vrai `~/.relaylead` ni dans `~/.claude`.
- Écriture d'état uniquement par `core/store.js` (fichier temporaire dans le même dossier, puis `rename`), et **un fichier par rédacteur** :
  - `lead.json` : identité du lead, écrite par le cœur ;
  - `state.json` : état déclaré par le lead ;
  - `sessions/<shortId>.json` : registre des sessions, tenu par le cœur ;
  - `tasks/<id>.json` : tâche, écrite par le cœur ;
  - `tasks/<id>.result.json` : résultat, écrit par l'équipier ;
  - `questions/<id>.json` et `questions/<id>.answer.json`.
- Heure : toujours `new Date().toISOString()` au moment de l'écriture.
- Noms : le nom de mission est un *slug* `[a-z0-9-]`, sans espace ni caractère spécial : il sert dans les noms de branche et de session.
- Messages de la CLI en anglais par défaut, français si `language: "fr"` (`core/messages.js`).
- Code simple, lisible par un débutant ; pas d'abstraction sans deuxième usage.
- Aucune mention de projets réels de l'auteur ; aucune donnée personnelle dans les fixtures.
- Commits en français, Conventional Commits ; aucune ligne `Co-Authored-By`, aucune mention d'outil de génération.
- Adaptateur Claude :
  - version minimale de Claude Code : 2.1.325 ;
  - options à valeurs multiples placées avant toutes les autres ;
  - jamais `--session-id` ni `--agents` ;
  - réveil sans options ;
  - une commande par appel dans les consignes.

Ajouts du lot 1.1 :

- Pas de shell : git et les agents se lancent par `execFileSync` ou `spawn` avec un tableau d'arguments, jamais `shell: true`.
- Chaque nouvelle erreur attendue est un `codedError` dont le code a son texte en anglais **et** en français dans `core/messages.js`.
- Fichiers d'état nouveaux, chacun avec un seul rédacteur : `tasks/archive/<id>.<n>.json` (copie de l'enregistrement de la tentative `n`, écrite par le cœur) et `tasks/archive/<id>.<n>.result.json` (résultat de l'équipier de la tentative `n`, déplacé par le cœur par `rename`, jamais réécrit). `state.json` peut porter `stopping: true`, écrit par le cœur seul (les écritures du lead sont refusées dès que l'état vaut `stopped` ou `done`).
- Avant toute suppression récursive sous `~/.relaylead/missions/`, le nom est vérifié par `/^[a-z0-9-]+$/`.
- Le contrat d'adaptateur ne change pas.

## Review Focus

1. **Lead relancé sous un autre PID, ou arrêt incomplet** : le démon de Claude relance un lead tué (même id, nouveau processus), ou `relaylead stop` n'arrive pas à arrêter une session ; l'utilisateur lance une seconde mission sur le même dossier. Attendu : refus `dir-busy` tant que la première n'est pas finie **et** toutes ses sessions arrêtées. Tests : Task 3, `the lock follows the mission state, not the lead pid` et `a stop that could not stop every session keeps the folder`.
2. **`relaylead remove` sur du travail non livré** : une branche de tâche porte des commits absents de l'intégration, ou un worktree a des modifications non commitées. Attendu : refus qui nomme ce travail, rien de supprimé, sauf `--force` demandé, qui dit les branches supprimées et leur dernier commit. Tests : Task 5, `remove refuses work not delivered unless --force` et `remove refuses a dirty worktree unless --force`.
3. **Résultat tardif d'une tentative remplacée** : pendant ou après `task retry`, l'équipier de la première tentative écrit encore `task done`. Attendu : refus `attempt-superseded`, ou, s'il passe la vérification juste avant le changement de tentative, un résultat ignoré parce que sa tentative diffère ; la tâche reste `running`. Tests : Task 6, `a result from a superseded attempt is refused` et `a late result written during the relaunch is ignored`.
4. **Hook git qui échoue pendant une livraison** (`pre-merge-commit` ou `commit-msg` qui sort en 1 avec un long message), à distinguer d'un `index.lock` tenu (« Unable to write index », sans fichier en conflit). Attendu : fusion annulée, worktree d'intégration propre, tâche toujours `done`, erreur `hook-failed` qui montre la sortie et indique `--no-hooks` ; un verrou tenu reste un réessai. Tests : Task 8, `a failing hook stops the delivery with its output and the task stays done` et `a delivery waits for a git lock to be released` (existant).
5. **Installation par habitude** : `npm ci --ignore-scripts=false`, `npm ci --ignore-scripts && npm install`, `npm_config_ignore_scripts=false npm ci --ignore-scripts`. Attendu : refusés par le hook d'autorisation ; seuls `npm ci --ignore-scripts` et `npm install --ignore-scripts` exacts sont permis. C'est un garde-fou contre l'habitude, pas contre une session hostile : `node *`, `npm test` et les alias git exécutent toujours du code. Test : Task 7, `the developer may install dependencies only without their scripts`.

Risques connus non couverts par un test : un processus enfant d'un hook git peut survivre au `SIGKILL` qui arrête git après son délai et garder un fichier ouvert (Task 9) ; la fusion de la branche de l'utilisateur au lancement (`prepareMission`) tourne sans le verrou de mission, car la mission n'existe pas encore (le verrou du dossier la protège d'un second lancement) ; un `Grep` sans `glob` sur un dossier parent du dossier d'état le parcourt (Task 10).

---

## Structure des fichiers

Seuls les fichiers touchés par ce lot :

```
core/
  timing.js                  (nouveau) sleep, sleepSync, retrySync : attentes et réessais partagés
  mission-lock.js            (nouveau) withMissionLock, sorti de core/tasks.js
  store.js                   writeText, budget de réessai Windows réglable, .tmp toujours retiré
  config.js                  DEFAULTS : maxAttempts, delivery.runHooks
  missions.js                verrou du dossier (état, stopping, identité), ménage à l'arrêt et à la fin, removeMission
  tasks.js                   retryTask, tentatives, limite parallel, --no-hooks
  wait.js                    plus de changement de session rapporté
  cli.js                     remove, task retry, deliver --no-hooks, --help comme valeur d'option, retour de stop
  messages.js                nouveaux codes et textes (en, fr)
  guard.js                   Glob pattern et Grep glob jugés
deliveries/
  local-merge.js             cleanMission, removeMission, hooks git, LC_ALL=C, message de commit, git interrompu
  files.js                   cleanMission et removeMission (rien à faire)
sources/tasks-dir.js         markDone par writeText, réessais plus longs ; ready() retiré
adapters/claude/index.js     sleep partagé
adapters/claude/settings.js  writeExecutable par writeText ; RELAYLEAD_WRITE_RETRY_MS transmis
adapters/fake/agent.js       échec au premier essai sur demande, relance par le faux lead
catalog/profiles/developer.md, catalog/profiles/lead.md, catalog/methods/code.md
fixtures/toy-repo/           une petite dépendance et son package-lock.json
README.md                    remove, retry, installation sans scripts, runHooks, --no-hooks, RELAYLEAD_WRITE_RETRY_MS (en, fr)
test/                        timing.test.js (nouveau) ; store, missions, deliveries, tasks, wait, cli, guard, catalog, claude-settings, tasks-dir, e2e
docs/manual-checks/lot-1-1-claude-macos.md   (nouveau) relevé humain
```

## Contrat de livraison (référence pour les Tasks 4, 5, 8, 9)

```js
// deliveries/local-merge.js et deliveries/files.js exposent tous deux :
{ prepareMission(mission), prepareTask(mission, task) -> {cwd, branch}, checkDone(mission, task),
  deliver(mission, task, {runHooks}) -> Error[] /* avertissements */, finish(mission, task, {runHooks}) -> Error[],
  cleanMission(mission, {keepDirs}) -> Error[],    // nouveau : à l'arrêt et à la fin, ne lève jamais
  removeMission(mission, {force}) -> string[] }    // nouveau : refuse avant de rien changer ; rend les branches supprimées « nom sha »
```

---

### Task 1 : attentes et réessais partagés, budget Windows réglable

**Files :** créer `core/timing.js`, `test/timing.test.js` ; modifier `core/store.js`, `core/missions.js`, `core/tasks.js`, `core/wait.js`, `adapters/claude/index.js`, `adapters/claude/settings.js`, `deliveries/local-merge.js`, `sources/tasks-dir.js`, `test/store.test.js`, `test/tasks-dir.test.js`, `test/claude-settings.test.js`, `README.md`.

Constat du lot 1 : six copies de `sleep`, trois boucles de réessai Windows (`withWindowsRetry`, `retryFileWrite`, `removeWorktree`), un `ready()` de la source que plus rien n'appelle, et deux défauts d'écriture : dans `writeJson`, un `rmSync` du `.tmp` qui échoue à son tour masque l'erreur d'origine ; `markDone` ne retire jamais son `.tmp`. Le budget de 2 s est fixé dans le code (décision de la Task 2 du lot 1).

**Interfaces :**
- `core/timing.js` :
  - `sleep(ms) -> Promise<void>` ;
  - `sleepSync(ms) -> void` (`Atomics.wait`, comme aujourd'hui) ;
  - `retrySync(action, {retryIf, budgetMs, delayMs}) -> any` : rend le résultat d'`action()` ; sur une erreur, réessaie tant que `retryIf(err)` est vrai et que le temps écoulé depuis le premier essai est inférieur à `budgetMs`, en attendant `delayMs(attempt)` entre deux essais ; sinon relance la dernière erreur.
- `core/store.js` :
  - `writeRetryMs() -> number` : `RELAYLEAD_WRITE_RETRY_MS` s'il vaut un entier positif ou nul, sinon `2000`, lu à chaque appel. Une variable d'environnement plutôt qu'une clé de configuration : `store.js` sert aussi aux hooks et ne lit pas la configuration (qui l'utilise elle-même).
  - `withWindowsRetry(action, budgetMs = writeRetryMs())` = `retrySync` avec `retryIf` : Windows et code `EPERM`, `EBUSY` ou `EACCES` ; délai inchangé (`min(10 × essai, 100)` + aléa de 0 à 20 ms).
  - `writeText(file, text, {mode, retryMs} = {})` : crée les dossiers, écrit `file.<pid>.<aléa>.tmp`, applique `mode` par `fs.chmodSync` sur le `.tmp` (pas par l'option de `writeFileSync`, que le masque `umask` réduirait), puis `rename` sous `withWindowsRetry(…, retryMs)`. Sur une erreur, retire le `.tmp` dans un `try` qui ignore tout échec, puis relance l'erreur d'origine.
  - `writeJson(file, data)` = `writeText(file, JSON.stringify(data, null, 2) + '\n')` ; `writeJsonExclusive` retire son `.tmp` de la même façon.
- Usages : `missions.js`, `tasks.js`, `wait.js` et `adapters/claude/index.js` importent `sleep` ; `local-merge.js` importe `sleepSync` et `retrySync`. `retryFileWrite` disparaît. `removeWorktree` = `retrySync` avec `retryIf` : Windows ; `budgetMs: 5000` ; `delayMs: (n) => 200 * n`.
- `sources/tasks-dir.js` : `markDone` lit sous `withWindowsRetry(…, MARK_DONE_RETRY_MS)` et écrit par `writeText(file, text, {retryMs: MARK_DONE_RETRY_MS})`, avec `MARK_DONE_RETRY_MS = 5000` : le fichier de tâche vient d'être touché par la fusion, un antivirus peut le tenir plus longtemps qu'un fichier d'état (c'était le budget de `retryFileWrite`, environ 5 s). `ready()` est retiré de la source et de ses exports.
- `adapters/claude/settings.js` : `writeExecutable` écrit par `writeText(file, text, {mode: 0o755})`, toujours seulement quand le contenu change ; `sessionSettings` met `RELAYLEAD_WRITE_RETRY_MS` dans l'env de la session quand il est défini dans celui de Relaylead (une session `--bg` n'hérite pas de l'env du lanceur).
- README (en, fr), section « Develop » / « Développer » : `RELAYLEAD_WRITE_RETRY_MS`, budget des réessais d'écriture sous Windows (2000 par défaut).

- [ ] **Étape 1 : tests qui échouent** :
  - `retrySync stops retrying once the budget is spent` : une action qui lève toujours `{code: 'EBUSY'}`, `retryIf` toujours vrai, `budgetMs: 100`, `delayMs: () => 10` ; l'appel lève `EBUSY` après au moins 100 ms et moins de 2000 ms, et l'action a été appelée plus d'une fois ;
  - `retrySync gives up at once on an error it does not retry` : `retryIf` faux → une seule tentative ;
  - `the Windows write retry budget follows RELAYLEAD_WRITE_RETRY_MS` : `'500'` → 500, `'0'` → 0, absente → 2000, `'abc'` → 2000 ;
  - `a failing temporary file removal does not hide the write error` : `fs.renameSync` remplacé par une fonction qui lève `{code: 'EXDEV'}`, `fs.rmSync` par une qui lève `{code: 'EBUSY'}` ; `writeJson` lève l'erreur `EXDEV` ;
  - `markDone leaves no temporary file when the rename fails` : `fs.renameSync` remplacé par une fonction qui lève `{code: 'EXDEV'}` ; `markDone` lève, et le dossier `tasks/` ne contient aucun fichier `.tmp` ;
  - `writeText sets the mode despite the umask` (sauté sous Windows) : `process.umask(0o077)` pendant le test, `mode: 0o755` → `(stat.mode & 0o777) === 0o755` ;
  - `the session environment passes the write retry budget on` (`test/claude-settings.test.js`) : `RELAYLEAD_WRITE_RETRY_MS='4000'` dans `process.env` → `settings.env.RELAYLEAD_WRITE_RETRY_MS === '4000'` ; absente → clé absente ;
  - dans `test/tasks-dir.test.js` : `ready respects dependencies` est supprimé ; `unknown dependency is reported` appelle `checkDependencies`.
- [ ] **Étape 2 :** `npm test` → échecs attendus (module `core/timing` absent, erreur masquée, `.tmp` laissé, mode réduit).
- [ ] **Étape 3 :** implémenter ; vérifier par `grep -rn "function sleep\|Atomics.wait\|retryFileWrite" core adapters deliveries sources` qu'il ne reste que `core/timing.js`.
- [ ] **Étape 4 :** `npm test` → tout vert, y compris les 212 tests existants.
- [ ] **Étape 5 :** commit `refactor(etat): attentes et réessais partagés, budget Windows réglable`.

### Task 2 : verrou de mission pour la fin de mission et l'arrêt

**Files :** créer `core/mission-lock.js` ; modifier `core/tasks.js`, `core/missions.js`, `core/messages.js`, `test/tasks.test.js`, `test/missions.test.js`.

Relecture du plan : `done` et `stopped` sont visibles avant que la fin de mission ait fini son travail (arrêt des équipiers, lancement de l'assistant d'arrêt du lead, écriture de `reaper.json`). Une suppression (Task 5) ou un nouveau lancement du même nom peut s'y croiser : `writeJson(reaper.json)` recrée alors `missions/<nom>/` sans `mission.json`. La fin de `state set done`, la fin de `stop` et, plus tard, toute la suppression passent donc par le même verrou que les démarrages et les livraisons. Ce verrou vit aujourd'hui dans `core/tasks.js`, qui importe `core/missions.js` : il sort dans son propre module.

**Interfaces :**
- `core/mission-lock.js` : `withMissionLock(name, command, action) -> Promise<any>` = l'actuel `withStartLock`, déplacé tel quel avec `tryCreateLock`, `readLock`, `isStaleLock`, `takeOverStaleLock` et `removeQuietly` (même fichier `missions/<nom>/start.lock`, mêmes codes `start-busy` et `start-stuck`, même délai `startLockStuckMs`). Nouveau : si le dossier de la mission n'existe pas, `mission-unknown` au lieu d'une erreur `ENOENT` brute. `core/tasks.js` l'importe ; le nom de fichier ne change pas, donc les fixtures non plus.
- `setState(name, 'done', note)` : l'état est écrit d'abord (un lead relancé ne l'efface pas), puis `endMission` et la libération du verrou du dossier tournent dans `withMissionLock(name, 'state set done', …)`.
- `stopMission(name)` : l'état `stopped` est écrit d'abord, hors verrou (pour qu'un démarrage en cours le voie à sa revérification) ; l'arrêt des sessions, la seconde écriture et la libération du verrou du dossier tournent dans `withMissionLock(name, 'stop', …)`. Si l'attente du verrou abandonne (`start-busy` ou `start-stuck`, derrière une livraison lente), `stop` lève `stop-pending` `{mission, holder}` (en : « mission "{mission}" is stopped, but its sessions are not stopped yet: "relaylead {holder}" still holds the mission; run relaylead stop {mission} again ») ; l'état reste `stopped` avec `stopping: true` (Task 3), donc le dossier reste verrouillé.

- [ ] **Étape 1 : tests qui échouent** :
  - `the end of state set done holds the mission lock` : `fake.stop` remplacé par une fonction qui attend 500 ms ; pendant `state set done`, `withMissionLock('demo', 'probe', …)` ne s'exécute qu'après la fin de `state set done`, et `reaper.json` existe déjà à ce moment ;
  - `a stop waits for the holder of the mission lock` : le test tient `withMissionLock('demo', 'probe', …)` 500 ms ; un `stop` lancé pendant ce temps écrit `stopped` tout de suite, mais n'appelle `fake.stop` qu'après la libération (horodatages des appels comparés à celui de la libération) ;
  - `the mission lock of an unknown mission is a coded error` : `withMissionLock('ghost', …)` → `mission-unknown` ;
  - `a stop that gives up behind a slow holder says to run it again` : attente du verrou raccourcie par `RELAYLEAD_START_LOCK_WAIT_MS=300` (lu à l'appel, 60 s par défaut) ; le test tient le verrou 2 s ; `relaylead stop demo` rend 1 avec `run relaylead stop demo again` ; l'état vaut `stopped` ;
  - les tests existants du verrou de démarrage (`a start lock left by a dead process is taken over`, `the start lock names its holder`, etc.) restent verts sans changement de fichier.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `refactor(missions): verrou de mission partagé par la fin de mission et l'arrêt`.

### Task 3 : verrou du dossier jugé sur l'état de la mission

**Files :** modifier `core/missions.js`, `core/messages.js`, `test/missions.test.js`.

Décision F du lot 1 : le verrou porte le PID du lead et devient « mort » quand ce PID disparaît. Or le démon de Claude relance un lead tué sous un autre PID : le verrou paraît mort et une seconde mission peut démarrer sur le même dossier. Le verrou se juge désormais sur la mission ; un lead disparu pour de bon se règle par `relaylead stop` (la relance automatique relève du veilleur, lot 2a). Mais `state.json` dit `stopped` ou `done` avant que les sessions soient arrêtées : un marqueur `stopping` garde le dossier tant que l'arrêt n'a pas fini.

**Interfaces :**
- Fichier de verrou : `{pid, mission, createdAt}`, où `pid` est celui de la commande `relaylead launch` et `createdAt` celui de `mission.json` (calculé avant la prise du verrou). La ligne qui écrit le PID du lead après son lancement est retirée.
- `state.json` : `stopMission` écrit `{state: 'stopped', stopping: true, updatedAt}` ; `setState('done')` écrit `{state: 'done', note, stopping: true, updatedAt}`. Une fois toutes les sessions (équipiers ; le lead pour `stop`) arrêtées sans erreur **et** leurs processus finis (Task 4 : `alive` vide), le cœur réécrit l'état sans `stopping`, puis libère le verrou. Un arrêt qui échoue, ou une session encore vivante après l'attente, laisse `stopping: true` et le verrou.
- `isStale(lock, realDir) -> boolean` :
  - `mission.json` de `lock.mission` absent → mort si et seulement si `lock.pid` est mort (lancement en cours, ou lancement planté avant d'écrire la mission) ;
  - `mission.json` présent mais `mission.dir !== realDir`, ou `lock.createdAt` présent et différent de `mission.createdAt` → mort (nom réutilisé pour un autre dossier ou une autre mission). Un verrou sans `createdAt` (écrit avant ce lot) compte comme celui de la mission qu'il nomme ;
  - sinon → mort si et seulement si l'état vaut `done` ou `stopped` **et** `stopping` est absent. Le PID du lead n'est plus regardé.
- Fichier de verrou vide ou illisible : mort s'il a plus de 10 s (`mtime`), comme `start.lock` ; sinon `dir-busy` comme aujourd'hui.
- `releaseLock(realDir, mission)` reçoit l'objet mission et ne retire le verrou que si `lock.mission === mission.name` **et** (`lock.createdAt` absent ou égal à `mission.createdAt`).
- `stopMission` : une mission `stopped` ou `done` dont `stopping` vaut `true` est toujours rejouée, quel que soit l'adaptateur (elle n'a pas fini de s'arrêter, ses PID sont récents). Exception : quand le `updatedAt` de cet état a plus d'une heure, les PID ne sont plus sûrs ; un adaptateur qui arrête par PID (sans `stopById`) n'est plus appelé, le marqueur est retiré, le verrou libéré, et la sortie le dit (`missionStopSkipped` : « the sessions of mission {mission} were not stopped again: their process ids are more than an hour old »). `setState('done')` rejoué suit les mêmes règles.
- `dir-busy` (en, fr) : « the folder {dir} is busy with mission "{mission}" ({state}); if its lead is gone, stop it first with: relaylead stop {mission} » ; `{state}` vaut l'état lu, suivi de « , stopping » quand le marqueur est là.

- [ ] **Étape 1 : tests qui échouent** :
  - `the lock follows the mission state, not the lead pid` : mission `one` lancée par le faux agent ; son lead tué (`fake.stop`) et son PID mort ; `launch --name two` sur le même dossier rend 1 et `/busy with mission "one"/` ; après `relaylead stop one`, `launch --name two` rend 0 ;
  - `a stop that could not stop every session keeps the folder` : `fake.stop` remplacé par une fonction qui lève ; `stop one` rend 1 ; `state.json` porte `stopping: true` ; `launch --name two` → `dir-busy` ; `fake.stop` rétabli, `stop one` rend 0, `stopping` absent, `launch --name two` rend 0 ;
  - `a failed crew stop at done keeps the folder` : même déroulé avec `state set done` et un équipier dont l'arrêt lève ;
  - `a lock of a newer mission of the same name is not released` : verrou `{mission: 'demo', createdAt: <plus récent>}` ; `releaseLock(dir, {name: 'demo', createdAt: <ancien>})` laisse le fichier ;
  - `a lock naming a mission of another folder is taken over` : `mission.json` de `elsewhere` (état `working`) dont `dir` est un autre dossier, verrou `{pid: process.pid, mission: 'elsewhere', createdAt}` → le lancement réussit et le verrou nomme la nouvelle mission ;
  - `a lock written before this lot is released by its mission` : verrou `{pid, mission: 'demo'}` sans `createdAt` ; `state set done` le retire ;
  - `an old stopping marker does not replay a stop by pid` : `state.json` `{state: 'stopped', stopping: true, updatedAt: <il y a 2 h>}`, adaptateur `fake` ; `stop` n'appelle pas `fake.stop`, rend 0 avec `missionStopSkipped`, le marqueur est retiré et le dossier libre ;
  - `an empty folder lock older than 10 s is taken over` : fichier de verrou vide, `mtime` reculé de 20 s (`fs.utimesSync`) → le lancement réussit ; le même fichier tout neuf → `dir-busy` (non-régression) ;
  - `a stale lock is taken over` et `second launch on the same dir is refused` (existants) restent verts.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(missions): verrou du dossier jugé sur l'état de la mission et la fin de son arrêt`.

### Task 4 : ménage des worktrees de tâche à l'arrêt et à la fin

**Files :** modifier `deliveries/local-merge.js`, `deliveries/files.js`, `core/missions.js`, `core/cli.js`, `core/messages.js`, `README.md`, `test/deliveries.test.js`, `test/missions.test.js`.

Relecture finale du lot 1 (I-7) : les worktrees de tâche d'une mission précédente restent dans `<dir>/.relaylead/worktrees/<id>` et font échouer le `task start` de la mission suivante (`worktree-mismatch`). Une mission arrêtée ou finie retire donc ses worktrees de tâche propres ; les branches restent (les commits survivent). Un worktree avec des modifications non commitées, ou dont l'équipier tourne encore, est gardé et signalé.

**Interfaces :**
- `local-merge` :
  - `missionWorktrees(mission) -> [{dir, branch}]` : lu dans `git worktree list --porcelain` (dans `mission.dir`), les worktrees dont la branche est `refs/heads/relaylead/<mission>/…` ; `branch` sans `refs/heads/` ;
  - `cleanMission(mission, {keepDirs = []}) -> Error[]`, ne lève jamais, chaque worktree traité à part (un échec n'empêche pas les suivants) : dossier de `keepDirs` → avertissement `worktree-busy` `{dir, branch}` ; `git status --porcelain` non vide → `worktree-kept` `{dir, branch}` ; sinon `removeWorktree` (Task 1), qui retire aussi les fichiers ignorés (`node_modules`, par exemple) ; une erreur git sur un worktree → `mission-cleanup-failed` `{mission, detail}`. Puis `git worktree prune`. Le worktree d'intégration et toutes les branches restent.
- `files.cleanMission() -> []` : `out/` appartient à l'utilisateur.
- `stopSessionsAndWait(mission, sessions) -> Promise<{failed: Session[], alive: Session[]}>` dans `core/missions.js` : arrête chaque session par l'adaptateur ; pour chaque session arrêtée, attend (`RELAYLEAD_STOP_WAIT_MS`, lu à l'appel, 30 s par défaut ; sondage toutes les 250 ms) que son processus soit mort : PID lu dans `adapter.list` quand il y figure, sinon celui du registre. `alive` : celles dont le processus vit encore à l'échéance ; elles comptent comme un arrêt inachevé (`stopping` reste, Task 3) et `stop` rend 1 avec le message `session-still-alive` `{mission, shortId}` (« … run relaylead stop {mission} again »).
- `stopMission(name) -> Promise<{outcome, warnings}>` (sous le verrou de mission, Task 2) :
  - `outcome` : `'stopped'` (la mission tournait), `'already-done'` (mission finie, sessions redemandées à un adaptateur `stopById` ou marqueur `stopping`) ou `'nothing'` ;
  - dans les trois cas, `warnings = delivery.cleanMission(mission, {keepDirs})`, où `keepDirs` = dossiers (`cwd` du registre) des sessions `failed` ou `alive` : le chemin `nothing` sert ainsi à refaire un ménage qui avait échoué ; un arrêt d'équipier raté n'empêche pas le ménage des autres worktrees ;
  - erreur d'arrêt : levée après le ménage, comme aujourd'hui.
- `endMission` (`state set done`) : même suite après l'arrêt des équipiers ; chaque avertissement est écrit au journal (`writeJournal(name, 'relaylead', <texte>)`) et ne fait jamais échouer `state set done` à lui seul.
- CLI `stop` : `stopped` → `missionStopped` ; `already-done` → nouveau texte `missionDoneSessionsStopped` (en : « mission {mission} is done; its remaining sessions were stopped ») ; `nothing` → `missionNothingToStop`. Chaque avertissement va sur stderr (`relaylead stop: <texte>`). Corrige le mineur « `stop` d'une mission finie affiche « stopped » ».
- `worktree-kept` et `worktree-busy` (en, fr) disent quoi faire : committer ou retirer les modifications, ou attendre la fin de la session, puis `relaylead stop <mission>` pour refaire le ménage. (Le renvoi vers `relaylead remove` arrive avec la Task 5.)
- README (en, fr) : à l'arrêt et à la fin, les worktrees de tâche propres sont retirés, **fichiers ignorés compris** (`node_modules`, sorties de build) ; les branches restent.

- [ ] **Étape 1 : tests qui échouent** (assertions de chemins sur `path.basename` ou après `fs.realpathSync.native`, pour Windows) :
  - `cleanMission removes the clean task worktrees and keeps their branches` : tâche `a` commitée et propre, avec un fichier ignoré ; tâche `b` avec un fichier non commité ; après `cleanMission` : dossier de `a` absent, branche `relaylead/demo/a` présente ; dossier de `b` présent, avertissement `worktree-kept` qui le nomme ; worktree d'intégration présent ;
  - `cleanMission keeps a worktree in keepDirs and goes on with the others` : `keepDirs` = dossier de `a` → avertissement `worktree-busy`, `b` (propre) retiré ;
  - `cleanMission leaves the worktrees of other missions alone` : un worktree `relaylead/other/a` reste ;
  - `stop cleans the task worktrees of its mission` : mission écrite par `writeMission`, tâche `a` préparée et commitée ; `relaylead stop demo` rend 0, état `stopped`, dossier de `a` absent ;
  - `stop keeps the worktree of a crew session whose stop failed, and cleans the others` : deux tâches, l'arrêt d'un équipier lève ; `stop` rend 1, le worktree de cet équipier reste, l'autre est retiré ;
  - `a session still alive after the wait keeps the folder` : `RELAYLEAD_STOP_WAIT_MS=300` ; `fake.stop` remplacé par une fonction qui ne tue rien ; `stop` rend 1, `stopping: true`, le worktree de la session reste (`worktree-busy`), `launch` sur le même dossier → `dir-busy` ;
  - `a stop with nothing to do still cleans` : mission déjà `stopped`, worktree propre restant → `relaylead stop demo` rend 0 avec `missionNothingToStop`, dossier retiré ;
  - `done cleans the task worktrees and notes the kept ones in the journal` : `state set done` rend 0 avec un worktree non propre ; `journal.log` contient le nom de son dossier ;
  - `stop of a done mission says it is done` : `fake.stopById = true`, mission finie ; la sortie vaut `mission demo is done; its remaining sessions were stopped\n` ;
  - `stop on a stopped or done mission kills nothing` et `stop runs again for an adapter that stops by id…` (existants) restent verts.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts, y compris sous Windows.
- [ ] **Étape 5 :** commit `feat(livraison): ménage des worktrees de tâche à l'arrêt et à la fin`.

### Task 5 : `relaylead remove <mission>`

**Files :** modifier `deliveries/local-merge.js`, `deliveries/files.js`, `core/missions.js`, `core/cli.js`, `core/messages.js`, `README.md`, `test/deliveries.test.js`, `test/missions.test.js`, `test/cli.test.js`, `test/e2e/fake-mission.test.js`.

Suite de I-7 : un nom de mission n'est jamais libéré, et le nom par défaut est celui du dossier ; une seconde mission dans le même dossier exige donc de supprimer la première. La suppression reste explicite.

**Interfaces :**
- `local-merge` :
  - `missionBranches(mission) -> string[]` : `git for-each-ref --format=%(refname:short) refs/heads/relaylead/<mission>/` ;
  - `removeMission(mission, {force = false}) -> string[]` : **vérifie tout avant de rien changer** ; travail non livré = worktrees de `missionWorktrees` dont le `git status --porcelain` n'est pas vide, et branches de `missionBranches` dont `git rev-list --count <intégration>..<branche>` n'est pas `0`. S'il y en a et que `force` est faux → `remove-unmerged-work` `{mission, items}`. Sinon : chaque worktree retiré (`removeWorktree`, `--force`), chaque branche supprimée (`git branch -D`), puis `git worktree prune`. Rend les branches supprimées sous la forme `<nom> <sha>`. La branche et le worktree d'intégration restent.
  - Choix pour `--force` : il supprime les branches, sans mode qui les garde. Garder des branches `relaylead/<ancienne>/…` laisserait au prochain `remove` le même refus ; la sortie imprime chaque branche supprimée avec son dernier commit, ce qui permet de la recréer (`git branch <nom> <sha>`) tant que git garde l'objet. Le texte de `remove-unmerged-work` le dit : « remove anyway with: relaylead remove {mission} --force; it deletes these branches and changes ».
- `files.removeMission() -> []`.
- `removeMission(name, {force}) -> Promise<string[]>` dans `core/missions.js` :
  1. `name` hors de `/^[a-z0-9-]+$/` → `usage` ;
  2. **dossier sans `mission.json`** (suppression interrompue, ou dossier recréé par un ancien assistant) : si aucun fichier de `~/.relaylead/locks/` ne nomme cette mission avec un PID vivant, le dossier est supprimé et la commande rend `[]` ; sinon `dir-busy` (un lancement est en cours) ;
  3. le reste dans `withMissionLock(name, 'remove', …)` (Task 2) : état autre que `done` ou `stopped`, ou `stopping` présent → `mission-running` `{mission, state}` (« stop it first with: relaylead stop {mission} ») ; si l'adaptateur a `stopById`, `adapter.stop` de chaque session du registre (un échec lève, rien de supprimé) ; si `mission.dir` existe encore, `delivery.removeMission(mission, {force})`, sinon cette étape est sautée ; `releaseLock(mission.dir, mission)` ;
  4. après le verrou, suppression du dossier `missions/<name>` (`fs.rmSync` récursif, `maxRetries: 5`).
- CLI : `relaylead remove <mission> [--force]`, refusé depuis une session (`refuseInSession`) ; `force` rejoint `FLAGS` ; l'aide liste `remove    remove a finished mission` ; sortie `missionRemoved` (« mission {mission} removed »), puis une ligne `deleted branch <nom> <sha>` par branche supprimée.
- `mission-exists` (en, fr) ajoute : « or remove the finished one with: relaylead remove {mission} ».
- `worktree-mismatch` (en, fr) : quand la branche trouvée vaut `relaylead/<m>/<id>`, le texte propose d'abord `relaylead remove <m>` ; sinon (branche hors Relaylead) seulement `git worktree remove "{dir}"`. `worktree-kept` et `worktree-busy` renvoient désormais aussi vers `relaylead remove`.
- README (en, fr), « Use » : `relaylead remove <mission>`, ce qu'il garde (la branche d'intégration), ce qu'il supprime, et `--force`.

- [ ] **Étape 1 : tests qui échouent** :
  - `remove is refused while the mission runs` : état `working` → `mission-running` ; dossier de la mission, branches et worktrees intacts ;
  - `remove deletes the task worktrees, branches and mission folder, and keeps the integration branch` : mission écrite par `writeMission`, une tâche `a` livrée, une tâche `b` dont la branche est fusionnée à la main dans l'intégration et dont le worktree est encore là, état `stopped` écrit par le test ; après `relaylead remove demo` : code 0, `missions/demo` absent, aucune branche `relaylead/demo/*`, aucun worktree de tâche, `relaylead/integration` et son worktree présents ;
  - `remove refuses work not delivered unless --force` : une branche `relaylead/demo/b` avec un commit absent de l'intégration → code 1, le message nomme `relaylead/demo/b`, rien de supprimé ; `remove demo --force` → code 0, sortie `deleted branch relaylead/demo/b <sha>`, branche absente ;
  - `remove refuses a dirty worktree unless --force` : worktree de `b` avec un fichier non commité et une branche déjà fusionnée → code 1, le message nomme ce dossier ; `--force` → dossier absent ;
  - `remove waits for the end of state set done` : `fake.stop` remplacé par une fonction qui attend 500 ms ; `state set done` et `remove demo` lancés ensemble ; `remove` rend 0 après la fin de `state set done` ; à la fin, `missions/demo` n'existe pas (aucun `reaper.json` tardif ne l'a recréé) ;
  - `remove finishes an interrupted removal` : `missions/demo/` ne contient que `reaper.json` → `remove demo` rend 0, dossier absent ; ensuite `launch --name demo` rend 0 ;
  - `remove skips the delivery cleanup when the project folder is gone` : mission arrêtée dont `dir` a été supprimé → `remove` rend 0, dossier de mission absent ;
  - `remove is refused from inside a session` (`test/cli.test.js`) : `not-from-a-session` ;
  - e2e `a second mission runs in the same folder after remove` : mission du dépôt jouet menée à `done` (question répondue) ; le test commite une tâche `c` sur `main` ; `relaylead remove <m>` → 0 ; `relaylead launch` du même nom → `done` en 60 s au plus ; `c.txt` présent sur `relaylead/integration` ; `relaylead list` ne montre qu'une mission.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts sur les six combinaisons.
- [ ] **Étape 5 :** commit `feat(missions): relaylead remove libère le nom et le dossier d'une mission finie`.

### Task 6 : relancer une tâche en échec

**Files :** modifier `core/tasks.js`, `core/wait.js`, `core/config.js`, `core/cli.js`, `core/messages.js`, `adapters/fake/agent.js`, `catalog/profiles/lead.md`, `catalog/methods/code.md`, `test/tasks.test.js`, `test/cli.test.js`, `test/catalog.test.js`.

Décision J du lot 1 : une tâche `failed` ne se relance pas. Le lead peut désormais la relancer, dans une limite de tentatives, sans casser la règle « un fichier par rédacteur » : le résultat de la tentative précédente est archivé par un `rename`, jamais réécrit, et un résultat tardif de l'ancien équipier ne peut pas passer pour celui du nouveau.

**Interfaces :**
- `DEFAULTS.maxAttempts = 2` ; lu `mission.config.maxAttempts || DEFAULTS.maxAttempts`, pour une mission lancée avant ce lot.
- `tasks/<id>.json` gagne `attempt` (1 au premier lancement). `listTasks` rend `attempt` (`record ? record.attempt || 1 : 0`).
- Résultat : `finishTask(name, id, {state, summary, attempt})` écrit `{id, state, summary, attempt, finishedAt}`, où `attempt` vaut `Number(attempt)` s'il est donné, sinon `record.attempt || 1`. La CLI passe `io.env.RELAYLEAD_ATTEMPT`. Refus `attempt-superseded` `{id, attempt, current}` quand `Number(attempt) !== (record.attempt || 1)`.
- `taskState` ignore un résultat dont `attempt` (1 s'il manque) diffère de `record.attempt || 1`.
- `retryTask(name, {id, profile}) -> Promise<record>`, sous `withMissionLock(name, 'task retry <id>')` :
  1. mission `stopped` ou `done` → mêmes refus que `startTask` ;
  2. tâche `running` avec une session → rend l'enregistrement existant (une relance rejouée ne lance personne) ; enregistrement `running` ou `failed` avec `session: null` et `attempt > 1` (tentative déjà comptée mais jamais lancée : lancement raté, arrêt brutal) → reprend à l'étape 6 avec la même tentative, sans repasser par les étapes 3 à 5 ; autre état que `failed` → `task-not-retryable` `{id, state}` ;
  3. `attempt >= maxAttempts` → `task-retry-limit` `{id, max}` ;
  4. la session précédente, si elle est au registre, est arrêtée par l'adaptateur (sans effet sur une session déjà finie), puis son processus attendu 30 s au plus (`stopSessionsAndWait`, Task 4) ; échec ou processus encore vivant → `crew-still-running` `{id, shortId}`, avant toute écriture ;
  5. archive, dans cet ordre : `writeJson(tasks/archive/<id>.<n>.json, record)` ; `rename` de `tasks/<id>.result.json`, s'il existe, vers `tasks/archive/<id>.<n>.result.json` (sous `withWindowsRetry`) ; `writeJson(tasks/<id>.json, {...record, attempt: n + 1, state: 'running', session: null})`. La tentative change **avant** le lancement : dès lors, `finishTask` de l'ancien équipier est refusé, et un résultat écrit juste avant est ignoré par `taskState`. Un arrêt brutal entre deux étapes laisse soit une tâche `failed` (relance rejouée depuis le début), soit une tâche `running` à l'ancienne session arrêtée, que `wait` passe `failed` : la relance se rejoue alors ;
  6. `launchCrew(mission, id, profile || record.profile, {attempt: n + 1, previousSummary})`. Si le lancement échoue, `retryTask` réécrit l'enregistrement `{...record, attempt: n + 1, state: 'failed', session: null, summary: 'retry launch failed: <message>'}` puis relève l'erreur : la tâche est `failed`, le lead la voit et peut relancer la même tentative. La reprise d'un `running` sans session ne sert qu'après un arrêt brutal entre l'étape 5 et la fin du lancement.
- `launchCrew` reçoit `{attempt = 1, previousSummary = null}` : accepte une tâche `running` sans session quand `attempt > 1` ; ajoute `RELAYLEAD_ATTEMPT: String(attempt)` à l'env de l'équipier ; écrit `attempt` et la session dans l'enregistrement ; la consigne gagne, avant « Working folder », les lignes `Attempt <n>: an earlier attempt failed ("<previousSummary>"). Its commits, if any, are already on your branch, and its uncommitted leftovers may still be in the folder: run git status first and keep or remove them.`
- `wait` : une tâche `running` dont la session vaut `null` (relance en cours, ou interrompue par un arrêt brutal) reçoit le délai de grâce de 60 s (clé `lostSince` : `task:<id>`), puis passe `failed` par `markFailed` avec le résumé `retry interrupted before its crew started` ; `session` reste `null`, donc `task retry` reprend la même tentative.
- CLI : `relaylead task retry <id> [--profile p]` imprime l'enregistrement en JSON ; refusé à un équipier (`not-for-crew`, avec `start` et `deliver`) ; l'usage le cite.
- `task-not-startable` (en, fr) ajoute : « a failed task can be tried again with: relaylead task retry {id} ».
- `lead.md`, « When something fails » : la phrase « A failed task cannot be started again in this version » devient : une tâche en échec peut être relancée par `relaylead task retry <id>` quand son résumé montre une cause qu'un nouvel essai peut lever ; Relaylead refuse au-delà de la limite de tentatives de la mission ; sinon, ou quand la relance est refusée, la question `failed-<id>` comme aujourd'hui. `code.md`, étape 5 : « retry or report every new failure ».
- Faux agent :
  - équipier : si `RELAYLEAD_FAKE_FAIL_FIRST` (ids séparés par des virgules) contient sa tâche et que `RELAYLEAD_ATTEMPT` vaut `1`, il lance `task fail <id> --summary "fake failure"` au lieu de travailler ;
  - lead : une tâche `failed` dont `attempt < maxAttempts` est relancée par `task retry` (elle compte dans la limite `parallel`) ; la fin est atteinte quand chaque tâche est `delivered`, ou `failed` avec `attempt >= maxAttempts`.

- [ ] **Étape 1 : tests qui échouent** (`test/tasks.test.js`, livraison `files`) :
  - `retry archives the failed result and launches a new crew` : tâche `a` lancée, son équipier arrêté, `finishTask` `failed` avec le résumé `tests broke` ; `retryTask` → `attempt: 2`, une session nouvelle ; `archive/a.1.result.json` vaut l'ancien résultat, `archive/a.1.json` l'ancien enregistrement ; `a.result.json` absent ; `listTasks` → `a` `running`, `attempt` 2 ; la consigne contient `Attempt 2`, `tests broke` et `git status first` ; l'env porte `RELAYLEAD_ATTEMPT: '2'` ;
  - `retry works for a task failed by wait, without a result` : enregistrement passé `failed` par `markFailed` ; `retryTask` réussit, seule `archive/a.1.json` existe ;
  - `retry refuses a task that has not failed, and replays a running one` : `todo` et `delivered` → `task-not-retryable` ; après la relance, un second `retryTask` rend le même enregistrement sans nouveau lancement ;
  - `a retry whose launch fails leaves a failed task that can be retried` : `fake.launch` lève une fois pendant la relance ; `retryTask` lève ; `tasks/a.json` vaut `failed`, `session: null`, `attempt: 2`, résumé `retry launch failed: …` ; un second `retryTask` (malgré `maxAttempts: 2`) lance un équipier avec `RELAYLEAD_ATTEMPT: '2'`, sans nouvelle archive ;
  - `a retry interrupted before its launch is marked failed after the grace` : enregistrement `running`, `session: null`, `attempt: 2`, et `lostSince` de `task:a` reculé de 61 s dans l'instantané ; `wait(5)` rapporte `a` `running` → `failed` ; `retryTask` reprend la tentative 2 ;
  - `retry stops at maxAttempts` : seconde tentative en échec → `task-retry-limit` ; une mission dont la configuration figée n'a pas `maxAttempts` se comporte comme avec 2 ;
  - `a result from a superseded attempt is refused` : après la relance, `finishTask(..., {attempt: '1'})` → `attempt-superseded` ; `a.result.json` absent ;
  - `a late result written during the relaunch is ignored` : `fake.launch` remplacé par une fonction qui écrit d'abord `a.result.json` = `{state: 'done', attempt: 1}`, puis lance ; après `retryTask`, `listTasks` → `a` `running` ;
  - `retry is refused to a crew member` (`test/cli.test.js`) : `RELAYLEAD_TASK` défini → `not-for-crew` ;
  - `fake mission retries a failed task and delivers it` : `RELAYLEAD_FAKE_FAIL_FIRST=a` ; la mission finit `done` ; `a` `delivered` avec `attempt` 2 ; `archive/a.1.result.json` a le résumé `fake failure` ;
  - `startTask launches a crew member and records the task` (existant) : l'enregistrement attendu gagne `attempt: 1` ;
  - `catalog profiles parse with the expected fields` : les consignes du lead citent `relaylead task retry`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(taches): relancer une tâche en échec, tentative précédente archivée`.

### Task 7 : installation des dépendances sans leurs scripts

**Files :** modifier `catalog/profiles/developer.md`, `README.md`, `fixtures/toy-repo/package.json`, créer `fixtures/toy-repo/package-lock.json`, `fixtures/toy-repo/.gitignore`, `fixtures/toy-repo/lib/duration.js`, `fixtures/toy-repo/test/duration.test.js` ; modifier `test/catalog.test.js`.

Décision Z du lot 1 : le profil `developer` a reçu `Bash(npm ci*)` et `Bash(npm install*)`. Les scripts d'installation des dépendances exécutent le code de paquets tiers avec les droits de l'utilisateur, et le garde-fou ne voit que la commande `npm`. Le développeur n'a plus droit qu'à `npm ci --ignore-scripts` et `npm install --ignore-scripts`, motifs exacts (sans `*`, sinon `npm ci --ignore-scripts=false` passerait). C'est un garde-fou contre l'habitude d'un agent qui installe « comme d'habitude », pas contre une session hostile : `node *`, `npm test` et les alias git exécutent toujours du code. Le hook d'autorisation lit ces motifs dans `RELAYLEAD_ALLOW` et `--allowedTools` les reçoit tels quels : aucun code ne change.

**Interfaces :**
- `developer.md`, outils : `[Bash(git *), Bash(npm test*), Bash(npm ci --ignore-scripts), Bash(npm install --ignore-scripts), Bash(node *), Bash(relaylead task *), Read, Write, Edit, Glob, Grep]`.
- `developer.md`, étape 3 : installer les dépendances manquantes par `npm ci --ignore-scripts` (ou `npm install --ignore-scripts` sans `package-lock.json`) ; si les tests échouent ensuite faute de scripts d'installation (module natif, par exemple), essayer une fois `npm ci` sans l'option : Relaylead le refuse sauf si le projet l'a permis ; refusé, finir et le dire dans le résumé, sans chercher de détour. La phrase actuelle « `npm ci` or `npm install` first » disparaît.
- README (en, fr), nouvelle sous-section « Dependencies » / « Dépendances » : pourquoi seules ces deux commandes, et que c'est un garde-fou contre l'habitude, pas contre une session hostile ; un projet qui a besoin des scripts ajoute, en connaissance de cause, `"guard": {"allow": ["Bash(npm ci)"]}` à `.relaylead.json` ; le mode `all` reste un choix explicite qui ne les bloque pas : `npm ci` y est permis et **lance les scripts d'installation** (le profil le dit aussi, dans une ligne de ses règles).
- Dépôt jouet : une petite dépendance sans script ni dépendance propre (`ms@2.1.3`), `package-lock.json` commité ; `node_modules/` dans son `.gitignore` ; un petit module `lib/duration.js` qui la requiert et son test `test/duration.test.js`, de sorte que `npm test` échoue tant qu'un développeur ne l'a pas installée. Les tâches `a` et `b` du dépôt jouet ne changent pas. Aucun test automatique de Relaylead n'installe rien (les tests restent hors réseau) ; le relevé humain (Task 12) vérifie l'installation.

- [ ] **Étape 1 : tests qui échouent** (`test/catalog.test.js`) :
  - `catalog profiles parse with the expected fields` : la liste des outils du développeur vaut la liste ci-dessus ;
  - `the developer may install dependencies only without their scripts` : `isAllowed` avec les outils du profil chargé rend vrai pour `npm ci --ignore-scripts` et `npm install --ignore-scripts`, faux pour `npm ci`, `npm install`, `npm i left-pad`, `npm install --ignore-scripts left-pad`, `npm ci --ignore-scripts=false`, `npm ci --ignore-scripts && npm install`, `npm_config_ignore_scripts=false npm ci --ignore-scripts` ;
  - `the developer instructions install without scripts` : les consignes contiennent `npm ci --ignore-scripts` et ne contiennent plus `` `npm ci` or `npm install` first `` ;
  - `the toy repository pins a dependency without scripts` : `package-lock.json` du dépôt jouet a `ms` en `2.1.3` et aucun paquet avec `hasInstallScript` ; `lib/duration.js` contient `require('ms')`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** modifier le profil, le dépôt jouet et le README.
- [ ] **Étape 4 :** tests verts (le test e2e copie le dépôt jouet : il reste vert sans réseau).
- [ ] **Étape 5 :** commit `fix(catalogue): dépendances installées sans leurs scripts`.

### Task 8 : hooks git joués sur les commits de Relaylead, message de commit dans la langue choisie

**Files :** modifier `deliveries/local-merge.js`, `core/tasks.js`, `core/cli.js`, `core/config.js`, `core/messages.js`, `catalog/profiles/lead.md`, `README.md`, `test/deliveries.test.js`, `test/cli.test.js`.

Décision M du lot 1 : les commits propres à Relaylead (fusion `--no-ff` à la livraison, fusion de la branche de l'utilisateur au lancement, commit de la ligne d'état) passent `--no-verify`. Ils jouent désormais les hooks par défaut ; un hook qui refuse donne une erreur codée avec sa sortie, la tâche reste `done`, et l'utilisateur seul peut livrer sans hooks. Au passage, le commit `chore(relaylead): <id> livrée` s'écrivait en français quelle que soit la langue.

**Interfaces :**
- `DEFAULTS.delivery.runHooks = true`, lu `mission.config.delivery.runHooks !== false` (une mission lancée avant ce lot joue les hooks).
- Git de Relaylead lancé avec `env: {...process.env, LC_ALL: 'C'}` : ses messages sont lus en anglais quelle que soit la langue du système (les hooks héritent de cette variable). `LOCK_FILE` gagne `unable to write index`.
- `deliver(mission, task, {runHooks})` et `finish(mission, task, {runHooks})` : `runHooks` vaut l'option si elle est donnée, sinon la configuration. `--no-verify` n'est passé que si `runHooks` est faux. La fusion de lancement (`updateIntegration`) suit la configuration.
- `mergeOrAbort(integration, args, {what, runHooks})` : une fusion qui échoue sans conflit et sans délai dépassé est annulée (`merge --abort` si une fusion est en cours) ; si la sortie de git est passagère (`isTransientGitError`), elle est retentée, `LOCK_ATTEMPTS` fois au plus (environ 5 s, comme aujourd'hui) ; sinon, ou quand ces essais sont épuisés : `hook-failed` `{what, id, branch, output}` si les hooks sont joués, l'erreur git d'origine sinon. Un hook dont la sortie ressemble à un verrou est donc retenté au plus `LOCK_ATTEMPTS` fois, puis signalé. `output` est la sortie de git et du hook, coupée à 2000 caractères ; `what` vaut `merge` ou `integration update`.
- `hook-failed` (en) : « a git hook (or git itself) refused relaylead's {what} for task "{id}"; nothing was merged and the task stays done. Output: {output}. Fix the cause on branch {branch} and deliver again, or deliver without hooks yourself with: relaylead task deliver {id} --no-hooks --mission {mission} » ; au lancement, le texte propose `"delivery": {"runHooks": false}` dans `.relaylead.json` (la mission n'existe pas encore) ; texte français équivalent.
- `deliverTask(name, id, {runHooks})` ; CLI `relaylead task deliver <id> --no-hooks` : `no-hooks` rejoint `FLAGS` ; refusé depuis une session (`not-from-a-session` avec la commande `task deliver --no-hooks`), car la configuration est figée dans `mission.json` et seul l'utilisateur peut y déroger.
- `finish` : un échec du commit de la ligne d'état rend l'avertissement `hook-failed` (`what: 'state line commit'`) quand les hooks sont joués et que le délai n'est pas dépassé, `cleanup-failed` sinon ; la ligne reste non commitée et le `deliver` suivant la commite.
- `lead.md`, « When something fails » : sur `hook-failed`, ne pas relivrer de lui-même ; poser la question `deliver-<id>` avec la sortie du hook, options « I fixed it: deliver again » et « Finish without this task » (l'utilisateur peut aussi livrer lui-même avec `--no-hooks`).
- Message du commit d'état : `t('deliveryCommit', {id}, mission.config.language)` ; en : `chore(relaylead): deliver {id}` ; fr : `chore(relaylead): {id} livrée`.
- README (en, fr) : `delivery.runHooks` (`true` par défaut), la marche à suivre quand un hook refuse, `--no-hooks`, et le fait que Relaylead lance git, donc les hooks de l'utilisateur, avec `LC_ALL=C`.

- [ ] **Étape 1 : tests qui échouent** :
  - `relaylead commits run the git hooks by default` : hooks `pre-merge-commit` et `pre-commit` qui ajoutent leur nom à un fichier témoin hors du dépôt ; `deliver('a')` rend 0 ; le témoin contient les deux noms ;
  - `a failing hook stops the delivery with its output and the task stays done` : `pre-merge-commit` qui écrit `lint failed` sur stderr et sort en 1 ; `deliver('a')` rend 1, stderr contient `lint failed` et `--no-hooks` ; `git status --porcelain` du worktree d'intégration vide, pas de `MERGE_HEAD` ; `listTasks` → `a` `done` ; le hook retiré, `deliver('a')` rend 0 ;
  - `deliver --no-hooks is for the user only and skips the hooks` : même hook ; avec `RELAYLEAD_MISSION` dans l'env → `not-from-a-session` ; sans → code 0, fusion faite ;
  - `a hook refusing the state line commit is a warning, and the next deliver commits it` : `pre-commit` qui sort en 1 (une fusion joue `pre-merge-commit`, pas `pre-commit`) ; `deliver('a')` rend 0 avec un avertissement `hook-failed` ; le hook retiré, le `deliver` suivant crée le commit d'état ;
  - `delivery.runHooks false skips the git hooks` (renommage de `relaylead commits skip the git hooks`) ;
  - `the state line commit follows the mission language` : `language: 'fr'` → `chore(relaylead): a livrée` ; défaut → `chore(relaylead): deliver a`. Les assertions existantes sur `a livrée` et `b livrée` passent au texte anglais ;
  - `a held index lock is retried, not taken for a hook` : `LC_ALL` du test réglé sur une autre langue ; `index.lock` du worktree d'intégration créé à la main puis retiré après 300 ms ; `deliver('a')` rend 0. `a delivery waits for a git lock to be released` et `git messages that a short wait cures are recognised` (existants, ce dernier avec `error: Unable to write index.`) restent verts.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts, y compris sous Windows (Git pour Windows lance les hooks `#!/bin/sh` par son propre shell).
- [ ] **Étape 5 :** commit `feat(livraison): hooks git joués sur les commits de Relaylead`.

### Task 9 : commandes git interrompues, worktree d'intégration modifié, écriture de la source après fusion

**Files :** modifier `deliveries/local-merge.js`, `core/messages.js`, `test/deliveries.test.js`.

Trois mineurs du lot 1 : seul un `merge` tué par le délai retire son `index.lock` (`cancelKilledMerge`), un `commit` tué le laisse et toute livraison suivante bute dessus ; des fichiers non suivis ou des modifications parasites dans le worktree d'intégration donnent une erreur git brute à la synchronisation du lancement ; un `markDone` qui échoue après une fusion réussie fait sortir `task deliver` en 1 avec une erreur brute.

**Interfaces :**
- `gitInIntegration(mission, args) -> string` remplace `cancelKilledMerge` : appelle `git(integrationDir(mission), args)` ; si la commande dépasse son délai, retire l'`index.lock` du worktree d'intégration et annule une fusion en cours, puis relève l'erreur avec la suite actuelle (« ; the merge was cancelled » ou « ; it could not be cancelled … »). Toutes les commandes git lancées dans ce worktree passent par elle. Les livraisons y tournent sous le verrou de mission ; la fusion de lancement non (voir Review Focus), mais le verrou du dossier écarte un second lancement. Les commandes lancées dans le dossier de l'utilisateur ne touchent jamais à ses verrous.
- `finish` : un commit d'état qui dépasse son délai reste l'avertissement `cleanup-failed` (avec « did not end within … »), jamais `hook-failed` (Task 8).
- `prepareMission`, quand le worktree d'intégration existe, avant toute fusion :
  1. `commitPendingStateLines(mission)` : chaque fichier suivi et modifié sous le dossier de la source (`<source.dir>/<id>.md`) est une ligne d'état laissée exprès par une livraison (hook qui a refusé le commit d'état, délai dépassé) ; il est commité par le même commit que `finish` (`deliveryCommit`, hooks selon la configuration ; un refus donne `hook-failed` avec `what: 'state line commit'`) ;
  2. puis `git status --porcelain --untracked-files=all` non vide → `integration-dirty` `{dir, files, tasksDir}` (en : « the integration worktree {dir} has changes nobody committed ({files}); commit them there, or remove the ones that are not under {tasksDir}, then launch again; files under {tasksDir} hold the state of delivered tasks: never remove them »).
- `deliver` : un échec de `markDone` après la fusion lève `mark-failed` `{id, detail}` (en : « task "{id}" is merged, but its state line could not be written ({detail}); run relaylead task deliver {id} again to finish »). Le `deliver` suivant trouve la branche `merged` et finit sans seconde fusion.

- [ ] **Étape 1 : tests qui échouent** :
  - `a state line commit that does not end leaves no index.lock behind` (sauté sous Windows, faux `git` comme les tests de délai existants) : le `commit` crée `index.lock` puis attend 30 s ; `RELAYLEAD_GIT_TIMEOUT_MS=1000` ; `deliver('a')` rend 0 avec un avertissement qui contient `did not end within 1 s` ; aucun `index.lock` dans le worktree d'intégration ; le vrai git rétabli, le `deliver` suivant crée le commit d'état ;
  - `a launch after a mission that ended with an uncommitted state line commits it` : livraison de `a` avec un `pre-commit` qui sort en 1 (avertissement `hook-failed`, ligne d'état non commitée) ; hook retiré ; `prepareMission` d'une nouvelle mission réussit, le dernier commit de l'intégration vaut `chore(relaylead): deliver a`, et `listTasks` de la nouvelle mission montre `a` `delivered` ;
  - `a launch refuses an integration worktree with stray changes` : un fichier non suivi dans le worktree d'intégration → `prepareMission` lève `integration-dirty` qui nomme ce dossier ; la branche d'intégration n'a pas bougé ;
  - `a state line that cannot be written after the merge is a coded error, and the next deliver finishes` : `tasksDirSource.markDone` remplacé par une fonction qui lève une fois ; `deliver('a')` rend 1, stderr contient `is merged` ; le `deliver` suivant rend 0 ; `git log --merges relaylead/integration` ne compte qu'une fusion de `relaylead/demo/a` ;
  - `a merge that does not end is cancelled` (existant) reste vert.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(livraison): git interrompu sans verrou laissé, worktree d'intégration vérifié, écriture de la source après fusion`.

### Task 10 : aide, message `no-mission` et garde-fou de Glob et Grep

**Files :** modifier `core/cli.js`, `core/messages.js`, `core/guard.js`, `test/cli.test.js`, `test/guard.test.js`.

Trois mineurs de la relecture finale du lot 1 : `--help` reconnu même comme valeur d'option ; le message `no-mission` conseille encore `RELAYLEAD_MISSION`, alors que cette variable fait refuser les commandes de l'utilisateur ; un `Glob` dont le `pattern` est absolu, ou un `Grep` dont le `glob` vise le dossier d'état, échappe au garde-fou, qui ne regarde que leur `path`. Un `Grep` dont le `glob` vaut `.env` lit même le contenu des secrets.

**Interfaces :**
- `wantsHelp(args) -> boolean` dans `core/cli.js` : vrai quand un argument vaut `--help` ou `-h` sans être la valeur de l'option qui le précède. Une option prend la valeur suivante quand elle commence par `--`, n'a pas de `=` et n'est pas dans `FLAGS`. `run` l'utilise à la place du test actuel.
- `no-mission` : en « no mission given; use --mission <name> » ; fr « aucune mission indiquée ; utilisez --mission <nom> ».
- `checkToolUse`, en plus du `path` :
  - `Glob` : `pattern`, résolu depuis `path` (ou `cwd`), est refusé s'il peut atteindre le dossier d'état (`inStateFolder`, après expansion des accolades). Un `pattern` qui vise un secret reste permis : Glob ne rend que des noms ;
  - `Grep` : `glob`, résolu de même, passe par `checkFileWord` (dossier d'état **et** noms de secrets) ;
  - `globMayReach` : un segment `**` traverse les dossiers ; dès que les segments qui le précèdent correspondent aux premiers segments du dossier d'état, le chemin peut l'atteindre.
- Reste connu, écrit en commentaire de `checkToolUse` : un `Grep` sans `glob` dont le `path` est un dossier parent du dossier d'état (le dossier personnel, par exemple) le parcourt ; le refuser bloquerait toute recherche dans le dossier personnel. À reprendre avec les garde-fous complets (lot 3).

- [ ] **Étape 1 : tests qui échouent** :
  - `an option value --help is not a request for help` : `run(['state', 'set', 'working', '--note', '--help', '--mission', 'ghost'])` rend 1, stderr `/no mission named "ghost"/`, stdout sans `Usage:` ; `--help after a command prints the help` (existant) reste vert ;
  - `no-mission advises --mission only` : `run(['task', 'list'])` sans env → stderr contient `--mission <name>` et pas `RELAYLEAD_MISSION` ; même vérification en français ;
  - `a Glob pattern that may reach the mission state folder is refused` : `pattern` = `<dossier d'état>/*` sans `path` → refus ; `pattern` `**/*.json` avec `path` = dossier parent de `RELAYLEAD_HOME` → refus ; `src/**/*.js` dans le projet → permis ; `**/.env` → permis ;
  - `a Grep glob naming a secret or the state folder is refused` : `glob: '.env'` → refus « secret » ; `glob: '.relaylead/**'` avec `path` = dossier parent de `RELAYLEAD_HOME` → refus ; `glob: '*.{ts,js}'` → permis.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(cli): aide, message no-mission et garde-fou de Glob et Grep`.

### Task 11 : un réveil par tâche finie, limite `parallel` appliquée

**Files :** modifier `core/wait.js`, `core/tasks.js`, `core/messages.js`, `catalog/profiles/lead.md`, `test/wait.test.js`, `test/tasks.test.js`.

Deux mineurs du lot 1 : chaque tâche finie réveille le lead deux fois (le résultat, puis le changement de sa session), ce qui coûte un tour de lead pour rien ; et `parallel` n'est appliqué que par la consigne du lead, pas par `task start`.

**Interfaces :**
- `relaylead wait` ne rapporte plus que les changements de tâches et de questions : `{changes: [{kind: 'task'|'question', id, from, to}]}`. La fin d'un équipier se lit déjà comme un changement de tâche (`done`, `failed`, y compris par le délai de grâce), et le lead n'attend pas sa propre session. Les sessions restent lues pour `crewEnded` et `lostSince` ; l'instantané perd sa clé `sessions`.
- `lead.md` : « blocks until a task or a question changes » ; la phrase « It may report a session change just after a task change » est retirée.
- `launchCrew` (après le cas idempotent `running`, avant toute préparation) : autant de tâches `running` que `mission.config.parallel` → `parallel-limit` `{mission, limit, running}` (en : « mission "{mission}" already runs {limit} tasks ({running}), its limit; start this one once a task finishes »). Une relance (Task 6) qui reprend sa propre tentative interrompue ne se compte pas elle-même.

- [ ] **Étape 1 : tests qui échouent** :
  - `a finished task wakes the lead once` : tâche `a` lancée, `wait(5)` ; l'équipier finit et sa session se termine ; `wait(5)` rend exactement `[{kind: 'task', id: 'a', from: 'running', to: 'done'}]` ; `wait(0)` rend `[]` ;
  - `a change between two waits is not lost` (existant) : la liste attendue perd sa ligne `kind: 'session'` ;
  - `a start beyond the parallel limit is refused, naming the running tasks` : `.relaylead.json` `{parallel: 1}` et une tâche `c` sans dépendance ; `startTask a` réussit ; `startTask c` → `parallel-limit`, message qui nomme `a` ; `startTask a` rejoué rend l'enregistrement existant ;
  - `a retry obeys the parallel limit` : `{parallel: 1}`, `a` en échec, `c` lancée ; `retryTask a` → `parallel-limit`, aucune archive écrite.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter (le contrôle de la limite dans `retryTask` se place avant l'archive).
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(attente): un réveil par tâche finie, limite parallel appliquée au lancement`.

### Task 12 (humain) : ce qui a changé, essayé avec Claude Code sur macOS

**Files :** créer `docs/manual-checks/lot-1-1-claude-macos.md` (procédure et relevé, même forme que celui du lot 1).

- [ ] **Étape 1 :** `npm link` depuis `main` après la Task 11 ; copier le dépôt jouet dans un dossier neuf, `git init -b main`, tout commiter, approuver le dossier dans Claude Code. Ajouter un hook `pre-merge-commit` qui passe (il écrit une ligne dans un fichier hors du dépôt).
- [ ] **Étape 2 :** `relaylead launch --agent claude --request "Do the tasks in tasks/"`. Dès que le lead travaille, `kill -9` de son processus ; `relaylead launch --name autre` dans le même dossier → `dir-busy`.
- [ ] **Étape 3 :** `relaylead stop <mission>` ; relever qu'il ne reste aucune session (`claude agents --json`), lead relancé par le démon compris ; `relaylead remove <mission>`, puis relancer la même commande dans le même dossier.
- [ ] **Étape 4 :** pendant cette seconde mission, `claude stop` du développeur de la tâche `a` en plein travail ; relever que la tâche passe `failed`, que le lead lance `relaylead task retry a`, et que la seconde tentative est livrée.
- [ ] **Étape 5 :** avant la livraison de `b`, remplacer le hook par un hook qui sort en 1 ; relever l'erreur `hook-failed` et la question posée par le lead ; livrer par `relaylead task deliver b --no-hooks --mission <mission>`, répondre, attendre `done`.
- [ ] **Étape 6 :** relever : les durées ; les sessions lancées ; les refus du garde-fou ; l'installation des dépendances par `npm ci --ignore-scripts` (journal de la session, `node_modules/ms` dans le worktree) ; les commits `chore(relaylead): deliver <id>` ; la ligne écrite par le hook qui passe ; aucun worktree de tâche restant ; aucune session restante ; le dossier de l'utilisateur inchangé.
- [ ] **Étape 7 :** commit `docs(essai): robustesse du lot 1.1 avec Claude Code`. Chaque défaut trouvé devient une issue.

---

## Hors périmètre

- **Vivacité du lead lue par l'adaptateur** pour le verrou : l'état de la mission et le marqueur `stopping` suffisent et ne dépendent pas d'un appel à `claude agents` ; un lead disparu pour de bon se règle par `relaylead stop` (le message le dit), sa relance automatique relève du veilleur (lot 2a).
- **Mode de `remove --force` qui garde les branches** : écarté (Task 5) ; la sortie donne de quoi les recréer.
- **Verrous git du dossier de l'utilisateur** laissés par une commande tuée (`worktree add`, `branch -D`) : l'utilisateur peut y lancer git lui-même, Relaylead n'y retire rien ; l'erreur garde le message de git.
- **Règle `PreToolUse` contre `npm install` en mode `all`**, et `yarn`, `pnpm`, `bun` : le mode `all` est un choix explicite, la spec ne range pas les scripts d'installation parmi les garde-fous communs, et le garde-fou du profil vise l'habitude, pas une session hostile ; à revoir avec la liste blanche complète (lot 3).
- **Réutilisation automatique du nom d'une mission finie** au lancement : la suppression reste explicite (`relaylead remove`), `mission-exists` y renvoie.
- **Autres mineurs du registre du lot 1**, jugés trop rares ou mieux traités plus tard : compteur de parenthèses du garde-fou trompé par une obfuscation délibérée (refonte de `guard.js` au lot 3) ; liens durs refusés par FAT ou un partage réseau (`writeJsonExclusive`, `~/.relaylead` est local) ; limite de 32 k caractères de la ligne de commande Windows (consignes courtes ; essai sur machine Windows réelle au lot 4) ; BOM UTF-8 qui masque l'en-tête d'une tâche ; `finishTask` qui ne vérifie pas l'état de la tâche hors tentative ; `start-busy` qui compte toute la file ; mission qui reste `working` quand le faux lead s'arrête sur un échec (faux agent seulement) ; `git init -b` qui exige git 2.28 (tests seulement). Les fichiers non suivis et les modifications parasites du worktree d'intégration sont traités (Task 9).
