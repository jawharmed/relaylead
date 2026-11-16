# Lot 1.1 : robustesse — plan

> **Pour les agents qui exécutent :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`). Les titres de tâche gardent le mot anglais « Task » pour l'outillage. Chaque tâche correspond à une issue GitHub du jalon « Lot 1.1 : robustesse » ; la PR d'une tâche ferme son issue. Presque toutes les tâches touchent `core/messages.js`, `core/cli.js` ou `deliveries/local-merge.js` : elles s'exécutent en série, dans l'ordre du plan.

**But :** rendre le squelette du lot 1 sûr à réutiliser : un dossier reste verrouillé tant que sa mission n'est pas finie, une mission finie se supprime et laisse place à la suivante dans le même dossier, une tâche en échec se relance, les dépendances s'installent sans leurs scripts, les hooks git de l'utilisateur sont joués sur les commits de Relaylead, et les petits défauts relevés au lot 1 sont corrigés.

**Architecture :** aucun nouveau module de fond. Le verrou du dossier (`core/missions.js`) se juge sur l'état de la mission au lieu du PID du lead. Le contrat de livraison gagne deux fonctions, `cleanMission` (à l'arrêt et à la fin) et `removeMission` (pour `relaylead remove`). `core/tasks.js` gagne `retryTask`, qui archive la tentative précédente avant de relancer un équipier. Un petit module `core/timing.js` regroupe les attentes et les réessais aujourd'hui recopiés dans six fichiers.

**Outils :** Node.js 18 ou plus (CommonJS, aucune dépendance), `node --test`, git, GitHub Actions (ubuntu, macos, windows × Node 18, 24).

**Spec :** [`docs/specs/2026-11-14-relaylead-design.md`](../specs/2026-11-14-relaylead-design.md) (v6). Feuille de route : [`2026-11-15-feuille-de-route.md`](2026-11-15-feuille-de-route.md), ligne « 1.1 Robustesse ». Plan précédent : [`2026-11-15-lot-1-squelette.md`](2026-11-15-lot-1-squelette.md) ; relevé réel : [`docs/manual-checks/lot-1-claude-macos.md`](../manual-checks/lot-1-claude-macos.md). Ce lot tranche des décisions prises pendant l'exécution du lot 1, rappelées dans chaque tâche : verrou qui suit le PID du lead (F), tâche en échec non relançable (J), commits de Relaylead en `--no-verify` (M), `npm install` permis au développeur (Z), mission finie non relançable dans le même dossier (relecture finale, I-7), budget de réessai Windows fixé à 2 s (Task 2 du lot 1).

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
- Fichiers d'état nouveaux, chacun avec un seul rédacteur : `tasks/archive/<id>.<n>.json` (copie de l'enregistrement de la tentative `n`, écrite par le cœur) et `tasks/archive/<id>.<n>.result.json` (résultat de l'équipier de la tentative `n`, déplacé par le cœur par `rename`, jamais réécrit).
- Le contrat d'adaptateur ne change pas.

## Review Focus

1. **Lead relancé sous un autre PID** : le démon de Claude relance un lead tué (même id, nouveau processus), puis l'utilisateur lance une seconde mission sur le même dossier. Attendu : refus `dir-busy`, tant que la première n'est pas arrêtée ou finie. Test : Task 2, `the lock follows the mission state, not the lead pid`.
2. **`relaylead remove` sur du travail non livré** : une branche de tâche porte des commits absents de l'intégration, ou un worktree a des modifications non commitées. Attendu : refus qui nomme ce travail, rien de supprimé, sauf `--force` demandé. Test : Task 4, `remove refuses work not delivered unless --force`.
3. **Résultat tardif d'une tentative remplacée** : après `task retry`, l'équipier de la première tentative écrit encore `task done`. Attendu : refus `attempt-superseded`, le résultat de la nouvelle tentative n'est pas écrasé. Test : Task 5, `a result from a superseded attempt is refused`.
4. **Hook git qui échoue pendant une livraison** (`pre-merge-commit` ou `commit-msg` qui sort en 1 avec un long message). Attendu : fusion annulée, worktree d'intégration propre, tâche toujours `done`, erreur `hook-failed` qui montre la sortie du hook. Test : Task 7, `a failing hook stops the delivery with its output and the task stays done`.
5. **Installation détournée** : `npm ci --ignore-scripts=false`, `npm ci --ignore-scripts && npm install`, `npm_config_ignore_scripts=false npm ci --ignore-scripts`. Attendu : refusés par le hook d'autorisation, seul `npm ci --ignore-scripts` exact est permis. Test : Task 6, `the developer may install dependencies only without their scripts`.

---

## Structure des fichiers

Seuls les fichiers touchés par ce lot :

```
core/
  timing.js                  (nouveau) sleep, sleepSync, retrySync : attentes et réessais partagés
  store.js                   writeText, budget de réessai Windows réglable, .tmp toujours retiré
  config.js                  DEFAULTS : maxAttempts, delivery.runHooks
  missions.js                verrou jugé sur l'état, ménage à l'arrêt et à la fin, removeMission
  tasks.js                   retryTask, tentatives, limite parallel appliquée
  wait.js                    plus de changement de session rapporté
  cli.js                     remove, task retry, --help comme valeur d'option, retour de stop
  messages.js                nouveaux codes et textes (en, fr)
  guard.js                   Glob pattern et Grep glob jugés
deliveries/
  local-merge.js             cleanMission, removeMission, hooks git, message de commit, git interrompu
  files.js                   cleanMission et removeMission (rien à faire)
sources/tasks-dir.js         markDone par writeText ; ready() retiré
adapters/claude/index.js     sleep partagé
adapters/claude/settings.js  writeExecutable par writeText
adapters/fake/agent.js       échec au premier essai sur demande, relance par le faux lead
catalog/profiles/developer.md, catalog/profiles/lead.md, catalog/methods/code.md
README.md                    remove, retry, installation sans scripts, runHooks, RELAYLEAD_WRITE_RETRY_MS (en, fr)
test/                        timing.test.js (nouveau) ; store, missions, deliveries, tasks, wait, cli, guard, catalog, e2e
docs/manual-checks/lot-1-1-claude-macos.md   (nouveau) relevé humain
```

## Contrat de livraison (référence pour les Tasks 3, 4, 7, 8)

```js
// deliveries/local-merge.js et deliveries/files.js exposent tous deux :
{ prepareMission(mission), prepareTask(mission, task) -> {cwd, branch}, checkDone(mission, task),
  deliver(mission, task) -> Error[] /* avertissements */, finish(mission, task) -> Error[],
  cleanMission(mission) -> Error[],               // nouveau : à l'arrêt et à la fin, ne lève jamais
  removeMission(mission, {force}) -> void }       // nouveau : refuse avant de rien changer
```

---

### Task 1 : attentes et réessais partagés, budget Windows réglable

**Files :** créer `core/timing.js`, `test/timing.test.js` ; modifier `core/store.js`, `core/missions.js`, `core/tasks.js`, `core/wait.js`, `adapters/claude/index.js`, `adapters/claude/settings.js`, `deliveries/local-merge.js`, `sources/tasks-dir.js`, `test/store.test.js`, `test/tasks-dir.test.js`, `README.md`.

Constat du lot 1 : six copies de `sleep`, trois boucles de réessai Windows (`withWindowsRetry`, `retryFileWrite`, `removeWorktree`), un `ready()` de la source que plus rien n'appelle, un `.tmp` laissé quand le `rename` échoue après les réessais (`writeJson` le retire, mais un `rmSync` qui échoue à son tour masque l'erreur ; `markDone` ne le retire pas), un budget de 2 s fixé dans le code (décision de la Task 2 du lot 1 : « une écriture peut attendre jusqu'à 2 s sous Windows »).

**Interfaces :**
- `core/timing.js` :
  - `sleep(ms) -> Promise<void>` ;
  - `sleepSync(ms) -> void` (`Atomics.wait`, comme aujourd'hui) ;
  - `retrySync(action, {retryIf, budgetMs, delayMs}) -> any` : rend le résultat d'`action()` ; sur une erreur, réessaie tant que `retryIf(err)` est vrai et que le temps écoulé depuis le premier essai est inférieur à `budgetMs`, en attendant `delayMs(attempt)` entre deux essais ; sinon relance la dernière erreur.
- `core/store.js` :
  - `writeRetryMs() -> number` : `RELAYLEAD_WRITE_RETRY_MS` s'il vaut un entier positif ou nul, sinon `2000`, lu à chaque appel. Une variable d'environnement plutôt qu'une clé de configuration : `store.js` sert aussi aux hooks et ne lit pas la configuration (qui l'utilise elle-même).
  - `withWindowsRetry(action)` = `retrySync` avec `retryIf` : Windows et code `EPERM`, `EBUSY` ou `EACCES` ; `budgetMs: writeRetryMs()` ; délai inchangé (`min(10 × essai, 100)` + aléa de 0 à 20 ms).
  - `writeText(file, text, {mode} = {})` : crée les dossiers, écrit `file.<pid>.<aléa>.tmp` (avec `mode` s'il est donné, avant le `rename`), puis `rename` sous `withWindowsRetry`. Sur une erreur, retire le `.tmp` sans jamais lever (un retrait raté est ignoré) et relance l'erreur d'origine.
  - `writeJson(file, data)` = `writeText(file, JSON.stringify(data, null, 2) + '\n')` ; `writeJsonExclusive` retire son `.tmp` de la même façon.
- Usages : `missions.js`, `tasks.js`, `wait.js` et `adapters/claude/index.js` importent `sleep` ; `local-merge.js` importe `sleepSync` et `retrySync`. `retryFileWrite` disparaît (`markDone` passe par `writeText`, qui réessaie déjà). `removeWorktree` = `retrySync` avec `retryIf` : Windows ; `budgetMs: 5000` ; `delayMs: (n) => 200 * n`.
- `sources/tasks-dir.js` : `markDone` écrit par `writeText` ; `ready()` est retiré de la source et de ses exports.
- `adapters/claude/settings.js` : `writeExecutable` écrit par `writeText(file, text, {mode: 0o755})`, toujours seulement quand le contenu change.
- README (en, fr), section « Develop » / « Développer » : `RELAYLEAD_WRITE_RETRY_MS`, budget des réessais d'écriture sous Windows (2000 par défaut).

- [ ] **Étape 1 : tests qui échouent** :
  - `retrySync stops retrying once the budget is spent` : une action qui lève toujours `{code: 'EBUSY'}`, `retryIf` toujours vrai, `budgetMs: 100`, `delayMs: () => 10` ; l'appel lève `EBUSY` après au moins 100 ms et moins de 2000 ms, et l'action a été appelée plus d'une fois ;
  - `retrySync gives up at once on an error it does not retry` : `retryIf` faux → une seule tentative ;
  - `the Windows write retry budget follows RELAYLEAD_WRITE_RETRY_MS` : `'500'` → 500, `'0'` → 0, absente → 2000, `'abc'` → 2000 ;
  - `writeJson leaves no temporary file when the rename fails` : la cible est un dossier non vide ; l'appel lève, et le dossier parent ne contient aucun fichier `.tmp` ;
  - `writeText sets the mode before the file appears` (sauté sous Windows) : `mode: 0o755` → `(stat.mode & 0o777) === 0o755` ;
  - dans `test/tasks-dir.test.js` : `ready respects dependencies` est supprimé ; `unknown dependency is reported` appelle `checkDependencies`.
- [ ] **Étape 2 :** `npm test` → échecs attendus (module `core/timing` absent).
- [ ] **Étape 3 :** implémenter ; vérifier par `grep -rn "function sleep\|Atomics.wait\|retryFileWrite" core adapters deliveries sources` qu'il ne reste que `core/timing.js`.
- [ ] **Étape 4 :** `npm test` → tout vert, y compris les 212 tests existants.
- [ ] **Étape 5 :** commit `refactor(etat): attentes et réessais partagés, budget Windows réglable`.

### Task 2 : verrou du dossier jugé sur l'état de la mission

**Files :** modifier `core/missions.js`, `core/messages.js`, `test/missions.test.js`.

Décision F du lot 1 : le verrou porte le PID du lead et devient « mort » quand ce PID disparaît. Or le démon de Claude relance un lead tué sous un autre PID : le verrou paraît mort et une seconde mission peut démarrer sur le même dossier. Le verrou se juge désormais sur la mission elle-même ; un lead disparu pour de bon se règle par `relaylead stop` (la relance automatique relève du veilleur, lot 2a).

**Interfaces :**
- Le fichier de verrou garde `{pid, mission}`, où `pid` est celui de la commande `relaylead launch` qui l'a pris. La ligne qui y écrit le PID du lead après son lancement est retirée.
- `isStale(lock, realDir) -> boolean` :
  - `mission.json` de `lock.mission` absent → mort si et seulement si `lock.pid` est mort (lancement en cours, ou lancement planté avant d'écrire la mission) ;
  - `mission.json` présent mais `mission.dir !== realDir` → mort (nom réutilisé pour un autre dossier) ;
  - sinon → mort si et seulement si l'état (`state.json`) vaut `done` ou `stopped`. Le PID du lead n'est plus regardé.
- `dir-busy` (en, fr) : « the folder {dir} is busy with mission "{mission}" ({state}); if its lead is gone, stop it first with: relaylead stop {mission} » ; `{state}` vaut l'état lu, ou `starting`.

- [ ] **Étape 1 : tests qui échouent** :
  - `the lock follows the mission state, not the lead pid` : mission `one` lancée par le faux agent ; son lead tué (`fake.stop`) et son PID mort ; `launch --name two` sur le même dossier rend 1 et `/busy with mission "one"/` ; après `relaylead stop one`, `launch --name two` rend 0 ;
  - `a launch in progress keeps the folder` : verrou `{pid: process.pid, mission: 'ghost'}` sans `mission.json` → `dir-busy` ;
  - `a lock naming a mission of another folder is taken over` : `mission.json` de `elsewhere` dont `dir` est un autre dossier, verrou `{pid: process.pid, mission: 'elsewhere'}` → le lancement réussit et le verrou nomme la nouvelle mission ;
  - `a stale lock is taken over` (existant : lancement planté, PID mort, sans `mission.json`) reste vert.
- [ ] **Étape 2 :** échecs attendus (le premier test réussit le second lancement).
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(missions): verrou du dossier jugé sur l'état de la mission`.

### Task 3 : ménage des worktrees de tâche à l'arrêt et à la fin

**Files :** modifier `deliveries/local-merge.js`, `deliveries/files.js`, `core/missions.js`, `core/cli.js`, `core/messages.js`, `test/deliveries.test.js`, `test/missions.test.js`.

Relecture finale du lot 1 (I-7) : les worktrees de tâche d'une mission précédente restent dans `<dir>/.relaylead/worktrees/<id>` et font échouer le `task start` de la mission suivante (`worktree-mismatch`). Une mission arrêtée ou finie retire donc ses worktrees de tâche propres ; les branches restent (les commits survivent), un worktree avec des modifications non commitées est gardé et signalé.

**Interfaces :**
- `local-merge` :
  - `missionWorktrees(mission) -> [{dir, branch}]` : lu dans `git worktree list --porcelain` (dans `mission.dir`), les worktrees dont la branche est `refs/heads/relaylead/<mission>/…` ; `branch` sans `refs/heads/` ;
  - `cleanMission(mission) -> Error[]`, ne lève jamais : pour chaque worktree de `missionWorktrees`, `git status --porcelain` vide → `removeWorktree` (Task 1) ; sinon avertissement `worktree-kept` `{dir, branch, mission}`. Puis `git worktree prune`. Une erreur git devient l'avertissement `mission-cleanup-failed` `{mission, detail}`. Le worktree d'intégration et toutes les branches restent.
- `files.cleanMission() -> []` : `out/` appartient à l'utilisateur.
- `stopMission(name) -> Promise<{outcome, warnings}>` :
  - `outcome` : `'stopped'` (la mission tournait et est maintenant arrêtée), `'already-done'` (mission finie, sessions redemandées à un adaptateur `stopById`) ou `'nothing'` (rien à faire, comme le `false` d'aujourd'hui) ;
  - une fois toutes les sessions arrêtées sans erreur, `warnings = delivery.cleanMission(mission)`, puis libération du verrou comme aujourd'hui.
- `endMission` (`state set done`) : après l'arrêt des équipiers, `cleanMission` ; chaque avertissement est écrit au journal (`writeJournal(name, 'relaylead', <texte>)`) et ne fait jamais échouer `state set done`.
- CLI `stop` : `stopped` → `missionStopped` ; `already-done` → nouveau texte `missionDoneSessionsStopped` (en : « mission {mission} is done; its remaining sessions were stopped ») ; `nothing` → `missionNothingToStop`. Chaque avertissement va sur stderr (`relaylead stop: <texte>`). Corrige le mineur « `stop` d'une mission finie affiche « stopped » ».
- `worktree-mismatch` (en, fr) : le texte propose d'abord `relaylead remove <mission précédente>` (Task 4), lue dans la branche `relaylead/<mission>/<id>` du dossier, puis `git worktree remove "{dir}"`.

- [ ] **Étape 1 : tests qui échouent** :
  - `cleanMission removes the clean task worktrees and keeps their branches` : mission préparée, tâche `a` avec un commit et sans modification, tâche `b` avec un fichier non commité ; après `cleanMission` : dossier de `a` absent, branche `relaylead/demo/a` présente ; dossier de `b` présent, un avertissement de code `worktree-kept` qui nomme ce dossier ; worktree d'intégration présent ;
  - `cleanMission leaves the worktrees of other missions alone` : un worktree `relaylead/other/a` reste ;
  - `stop cleans the task worktrees of its mission` : mission écrite par `writeMission`, tâche `a` préparée et commitée ; `relaylead stop demo` rend 0, état `stopped`, dossier de `a` absent ;
  - `done cleans the task worktrees and notes the kept ones in the journal` : `state set done` rend 0 avec un worktree non propre ; `journal.log` contient son chemin ;
  - `stop of a done mission says it is done` : `fake.stopById = true`, mission finie ; la sortie vaut `mission demo is done; its remaining sessions were stopped\n` ;
  - `stop on a stopped or done mission kills nothing` et `stop runs again for an adapter that stops by id…` (existants) restent verts.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts, y compris sous Windows (un équipier tout juste arrêté peut encore tenir son dossier : `removeWorktree` réessaie).
- [ ] **Étape 5 :** commit `feat(livraison): ménage des worktrees de tâche à l'arrêt et à la fin`.

### Task 4 : `relaylead remove <mission>`

**Files :** modifier `deliveries/local-merge.js`, `deliveries/files.js`, `core/missions.js`, `core/cli.js`, `core/messages.js`, `README.md`, `test/deliveries.test.js`, `test/missions.test.js`, `test/cli.test.js`, `test/e2e/fake-mission.test.js`.

Suite de I-7 : un nom de mission n'est jamais libéré, et le nom par défaut est celui du dossier ; une seconde mission dans le même dossier exige donc de supprimer la première. La suppression reste explicite : aucun lancement ne supprime une mission tout seul.

**Interfaces :**
- `local-merge` :
  - `missionBranches(mission) -> string[]` : `git for-each-ref --format=%(refname:short) refs/heads/relaylead/<mission>/` ;
  - `removeMission(mission, {force = false})` : **vérifie tout avant de rien changer** ; travail non livré = worktrees de `missionWorktrees` dont le `git status --porcelain` n'est pas vide, et branches de `missionBranches` dont `git rev-list --count <intégration>..<branche>` n'est pas `0`. S'il y en a et que `force` est faux → `remove-unmerged-work` `{mission, items}` (`items` : les branches et dossiers, séparés par des virgules). Sinon : chaque worktree retiré (`removeWorktree`, `--force`), chaque branche supprimée (`git branch -D`), puis `git worktree prune`. La branche et le worktree d'intégration restent.
- `files.removeMission()` : rien.
- `removeMission(name, {force}) -> Promise<void>` dans `core/missions.js` :
  1. `readMission(name)` ; état autre que `done` ou `stopped` → `mission-running` `{mission, state}` (« stop it first with: relaylead stop {mission} ») ;
  2. si l'adaptateur a `stopById`, `adapter.stop` de chaque session du registre ; un échec lève et ne supprime rien ;
  3. `delivery.removeMission(mission, {force})` ;
  4. `releaseLock(mission.dir, name)` ;
  5. suppression du dossier `missions/<name>` (`fs.rmSync` récursif, `maxRetries: 5`) : registre, réglages de session, tâches, questions et journal.
- CLI : `relaylead remove <mission> [--force]`, refusé depuis une session (`refuseInSession`) ; `force` rejoint `FLAGS` ; l'aide liste `remove    remove a finished mission` ; sortie `missionRemoved` (« mission {mission} removed »).
- `mission-exists` (en, fr) ajoute : « or remove the finished one with: relaylead remove {mission} ».
- README (en, fr), « Use » : `relaylead remove <mission>`, ce qu'il garde (la branche d'intégration) et ce qu'il supprime.

- [ ] **Étape 1 : tests qui échouent** :
  - `remove is refused while the mission runs` : état `working` → `mission-running` ; dossier de la mission, branches et worktrees intacts ;
  - `remove deletes the task worktrees, branches and mission folder, and keeps the integration branch` : mission écrite par `writeMission`, une tâche `a` livrée, une tâche `b` dont la branche est fusionnée à la main dans l'intégration et dont le worktree est encore là, état `stopped` écrit par le test ; après `relaylead remove demo` : code 0, `missions/demo` absent, aucune branche `relaylead/demo/*`, aucun worktree de tâche, `relaylead/integration` et son worktree présents ;
  - `remove refuses work not delivered unless --force` : une branche `relaylead/demo/b` avec un commit absent de l'intégration → code 1, le message nomme `relaylead/demo/b`, rien de supprimé ; `remove demo --force` → code 0, branche absente ;
  - `remove is refused from inside a session` (`test/cli.test.js`) : `not-from-a-session` ;
  - e2e `a second mission runs in the same folder after remove` : mission du dépôt jouet menée à `done` (question répondue) ; le test commite une tâche `c` sur `main` ; `relaylead remove <m>` → 0 ; `relaylead launch` du même nom → `done` en 60 s au plus ; `c.txt` présent sur `relaylead/integration` ; `relaylead list` ne montre qu'une mission.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts sur les six combinaisons.
- [ ] **Étape 5 :** commit `feat(missions): relaylead remove libère le nom et le dossier d'une mission finie`.

### Task 5 : relancer une tâche en échec

**Files :** modifier `core/tasks.js`, `core/config.js`, `core/cli.js`, `core/messages.js`, `adapters/fake/agent.js`, `catalog/profiles/lead.md`, `catalog/methods/code.md`, `test/tasks.test.js`, `test/catalog.test.js`.

Décision J du lot 1 : une tâche `failed` ne se relance pas. Le lead peut désormais la relancer, dans une limite de tentatives, sans casser la règle « un fichier par rédacteur » : le résultat de la tentative précédente est archivé par un `rename`, jamais réécrit.

**Interfaces :**
- `DEFAULTS.maxAttempts = 2`.
- `tasks/<id>.json` gagne `attempt` (1 pour le premier lancement). `listTasks` rend `attempt` (`record ? record.attempt || 1 : 0`).
- `retryTask(name, {id, profile}) -> Promise<record>`, sous `withStartLock(name, 'task retry <id>')` :
  1. mission `stopped` ou `done` → mêmes refus que `startTask` ;
  2. tâche `running` → rend l'enregistrement existant (une relance rejouée ne lance personne) ; état autre que `failed` → `task-not-retryable` `{id, state}` ;
  3. `attempt >= mission.config.maxAttempts` → `task-retry-limit` `{id, max}` ;
  4. la session de l'équipier précédent, si elle est au registre, est arrêtée par l'adaptateur (sans effet sur une session déjà finie) ; un échec lève avant toute écriture ;
  5. archive, dans cet ordre (chaque étape rejouable) : `writeJson(tasks/archive/<id>.<n>.json, record)` ; `writeJson(tasks/<id>.json, {...record, state: 'failed'})` ; `rename` de `tasks/<id>.result.json`, s'il existe, vers `tasks/archive/<id>.<n>.result.json` (sous `withWindowsRetry`) ;
  6. `launchCrew(mission, id, profile || record.profile, {attempt: n + 1, previousSummary})`.
- `launchCrew` reçoit `{attempt = 1, previousSummary = null}` : accepte une tâche `failed` quand `attempt > 1` ; ajoute `RELAYLEAD_ATTEMPT: String(attempt)` à l'env de l'équipier ; écrit `attempt` dans l'enregistrement ; la consigne gagne, avant « Working folder », la ligne `Attempt <n>: an earlier attempt failed ("<previousSummary>"); its commits, if any, are already on your branch.`
- `finishTask(name, id, {state, summary, attempt})` : `attempt` défini et différent de `record.attempt || 1` → `attempt-superseded` `{id, attempt, current}`. La CLI passe `io.env.RELAYLEAD_ATTEMPT`.
- CLI : `relaylead task retry <id> [--profile p]` imprime l'enregistrement en JSON ; refusé à un équipier (`not-for-crew`, avec `start` et `deliver`) ; l'usage le cite.
- `task-not-startable` (en, fr) ajoute : « a failed task can be tried again with: relaylead task retry {id} ».
- `lead.md`, « When something fails » : la phrase « A failed task cannot be started again in this version » devient : une tâche en échec peut être relancée une fois par `relaylead task retry <id>` quand son résumé montre une cause qu'un nouvel essai peut lever ; Relaylead refuse au-delà de `maxAttempts` ; sinon, ou après le second échec, la question `failed-<id>` comme aujourd'hui. `code.md`, étape 5 : « retry or report every new failure ».
- Faux agent :
  - équipier : si `RELAYLEAD_FAKE_FAIL_FIRST` (ids séparés par des virgules) contient sa tâche et que `RELAYLEAD_ATTEMPT` vaut `1`, il lance `task fail <id> --summary "fake failure"` au lieu de travailler ;
  - lead : une tâche `failed` dont `attempt < maxAttempts` est relancée par `task retry` (elle compte dans la limite `parallel`) ; la fin est atteinte quand chaque tâche est `delivered`, ou `failed` avec `attempt >= maxAttempts`.

- [ ] **Étape 1 : tests qui échouent** (`test/tasks.test.js`, livraison `files`) :
  - `retry archives the failed result and launches a new crew` : tâche `a` lancée, son équipier arrêté, `finishTask` `failed` avec le résumé `tests broke` ; `retryTask` → `attempt: 2`, une session nouvelle ; `archive/a.1.result.json` vaut l'ancien résultat, `archive/a.1.json` l'ancien enregistrement ; `a.result.json` absent ; `listTasks` → `a` `running`, `attempt` 2 ; la consigne lancée contient `Attempt 2` et `tests broke`, et l'env porte `RELAYLEAD_ATTEMPT: '2'` ;
  - `retry works for a task failed by wait, without a result` : enregistrement passé `failed` par `markFailed` ; `retryTask` réussit, seule `archive/a.1.json` existe ;
  - `retry refuses a task that has not failed, and replays a running one` : `todo` et `delivered` → `task-not-retryable` ; après la relance, un second `retryTask` rend le même enregistrement sans nouveau lancement ;
  - `retry stops at maxAttempts` : `maxAttempts: 2`, seconde tentative en échec → `task-retry-limit` ;
  - `a result from a superseded attempt is refused` : après la relance, `finishTask(..., {attempt: '1'})` → `attempt-superseded` ; `a.result.json` toujours absent ;
  - `fake mission retries a failed task and delivers it` : `RELAYLEAD_FAKE_FAIL_FIRST=a` ; la mission finit `done` ; `a` `delivered` avec `attempt` 2 ; `archive/a.1.result.json` a le résumé `fake failure` ;
  - `startTask launches a crew member and records the task` (existant) : l'enregistrement attendu gagne `attempt: 1` ;
  - `catalog profiles parse with the expected fields` : les consignes du lead citent `relaylead task retry`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(taches): relancer une tâche en échec, tentative précédente archivée`.

### Task 6 : installation des dépendances sans leurs scripts

**Files :** modifier `catalog/profiles/developer.md`, `README.md`, `test/catalog.test.js`.

Décision Z du lot 1 : le profil `developer` a reçu `Bash(npm ci*)` et `Bash(npm install*)` pour pouvoir lancer les tests dans un worktree neuf. Mais les scripts d'installation des dépendances exécutent le code de centaines de paquets tiers avec les droits de l'utilisateur, hors de portée du garde-fou, qui ne voit que la commande `npm`. Le développeur n'a plus droit qu'à `npm ci --ignore-scripts`, motif exact (sans `*`, sinon `npm ci --ignore-scripts=false` passerait). Le hook d'autorisation lit ces motifs dans `RELAYLEAD_ALLOW` et `--allowedTools` les reçoit tels quels : aucun code ne change, seulement le profil.

**Interfaces :**
- `developer.md`, outils : `[Bash(git *), Bash(npm test*), Bash(npm ci --ignore-scripts), Bash(node *), Bash(relaylead task *), Read, Write, Edit, Glob, Grep]`.
- `developer.md`, étape 3 : « `npm ci --ignore-scripts` first if the dependencies are missing ; never `npm install` ». Si les tests échouent faute de scripts d'installation (module natif, par exemple), le développeur le dit dans son résumé au lieu de chercher un détour.
- README (en, fr), nouvelle sous-section « Dependencies » / « Dépendances » : pourquoi seul `npm ci --ignore-scripts` ; un projet qui a besoin des scripts ajoute, en connaissance de cause, `"guard": {"allow": ["Bash(npm ci)"]}` à `.relaylead.json` ; le mode `all` reste un choix explicite qui ne les bloque pas.

- [ ] **Étape 1 : tests qui échouent** (`test/catalog.test.js`) :
  - `catalog profiles parse with the expected fields` : la liste des outils du développeur vaut la liste ci-dessus ;
  - `the developer may install dependencies only without their scripts` : `isAllowed` avec les outils du profil chargé rend vrai pour `npm ci --ignore-scripts`, faux pour `npm ci`, `npm install`, `npm i left-pad`, `npm ci --ignore-scripts=false`, `npm ci --ignore-scripts && npm install`, `npm_config_ignore_scripts=false npm ci --ignore-scripts` ;
  - `the developer instructions never advise npm install` : les consignes contiennent `npm ci --ignore-scripts` et pas `npm install` en dehors de la phrase qui l'interdit (`/never `npm install`/`).
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** modifier le profil et le README.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(catalogue): dépendances installées sans leurs scripts`.

### Task 7 : hooks git joués sur les commits de Relaylead, message de commit dans la langue choisie

**Files :** modifier `deliveries/local-merge.js`, `core/config.js`, `core/messages.js`, `README.md`, `test/deliveries.test.js`.

Décision M du lot 1 : les commits propres à Relaylead (fusion `--no-ff` à la livraison, fusion de la branche de l'utilisateur au lancement, commit de la ligne d'état) passent `--no-verify`, si bien qu'un hook de l'utilisateur n'y est jamais joué. Ils jouent désormais les hooks par défaut ; un hook qui refuse donne une erreur codée avec sa sortie, et la tâche reste `done`. Au passage, le commit `chore(relaylead): <id> livrée` s'écrivait en français quelle que soit la langue.

**Interfaces :**
- `DEFAULTS.delivery.runHooks = true`. Lu `mission.config.delivery.runHooks !== false` : une mission lancée avant ce lot (configuration figée sans la clé) joue les hooks.
- `--no-verify` n'est passé aux trois commits que si `runHooks` vaut `false`.
- `mergeOrAbort(integration, args, what)` : une fusion qui échoue sans conflit et sans délai dépassé est annulée (`merge --abort` si une fusion est en cours) ; puis, si la sortie de git est passagère (`isTransientGitError`), elle est retentée comme aujourd'hui ; sinon, quand les hooks sont joués, elle lève `hook-failed` `{what, id, branch, output}`, où `output` est la sortie de git et du hook, coupée à 2000 caractères ; quand ils ne le sont pas, l'erreur git d'origine. `what` vaut `merge` (livraison) ou `integration update` (lancement).
- `hook-failed` (en) : « a git hook (or git itself) refused relaylead's {what} for task "{id}"; nothing was merged and the task stays done. Output: {output}. Fix the cause on branch {branch} and deliver again, or set "delivery": {"runHooks": false} in .relaylead.json » ; au lancement, `id` et `branch` nomment la branche d'intégration ; texte français équivalent.
- `finish` : un échec du commit de la ligne d'état rend l'avertissement `hook-failed` (`what: 'state line commit'`) quand les hooks sont joués, `cleanup-failed` sinon ; la ligne reste non commitée et le `deliver` suivant la commite (comportement actuel).
- Message du commit d'état : `t('deliveryCommit', {id}, mission.config.language)` ; en : `chore(relaylead): deliver {id}` ; fr : `chore(relaylead): {id} livrée`.
- README (en, fr) : `delivery.runHooks` (`true` par défaut) et la marche à suivre quand un hook refuse.

- [ ] **Étape 1 : tests qui échouent** :
  - `relaylead commits run the git hooks by default` : hooks `pre-merge-commit` et `pre-commit` qui ajoutent leur nom à un fichier témoin hors du dépôt ; `deliver('a')` rend 0 ; le témoin contient les deux noms ;
  - `a failing hook stops the delivery with its output and the task stays done` : `pre-merge-commit` qui écrit `lint failed` sur stderr et sort en 1 ; `deliver('a')` rend 1, stderr contient `lint failed` et `runHooks` ; `git status --porcelain` du worktree d'intégration vide, pas de `MERGE_HEAD` ; `listTasks` → `a` `done` ; le hook retiré, `deliver('a')` rend 0 ;
  - `a hook refusing the state line commit is a warning, and the next deliver commits it` : `pre-commit` qui sort en 1 (une fusion joue `pre-merge-commit`, pas `pre-commit`) ; `deliver('a')` rend 0 avec un avertissement `hook-failed` sur stderr ; le hook retiré, le `deliver` suivant crée le commit d'état ;
  - `delivery.runHooks false skips the git hooks` (renommage de `relaylead commits skip the git hooks`) : avec `"delivery": {"runHooks": false}`, des hooks qui sortent en 1 n'empêchent rien ;
  - `the state line commit follows the mission language` : `language: 'fr'` → `chore(relaylead): a livrée` ; défaut → `chore(relaylead): deliver a`. Les assertions existantes sur `chore(relaylead): a livrée` et `b livrée` passent au texte anglais.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts, y compris sous Windows (Git pour Windows lance les hooks `#!/bin/sh` par son propre shell).
- [ ] **Étape 5 :** commit `feat(livraison): hooks git joués sur les commits de Relaylead`.

### Task 8 : commandes git interrompues et écriture de la source après fusion

**Files :** modifier `deliveries/local-merge.js`, `core/messages.js`, `test/deliveries.test.js`.

Deux mineurs du lot 1 : seul un `merge` tué par le délai retire son `index.lock` (`cancelKilledMerge`) ; un `commit` tué de la même façon le laisse, et toute livraison suivante bute dessus. Et un `markDone` qui échoue après une fusion réussie fait sortir `task deliver` en 1 avec une erreur brute, alors que le travail est fusionné.

**Interfaces :**
- `gitInIntegration(mission, args) -> string` remplace `cancelKilledMerge` : appelle `git(integrationDir(mission), args)` ; si la commande dépasse son délai, retire l'`index.lock` du worktree d'intégration et annule une fusion en cours, puis relève l'erreur avec la suite actuelle (« ; the merge was cancelled » ou « ; it could not be cancelled … »). Seul le détenteur de `start.lock` lance git dans ce worktree, donc ce verrou est forcément périmé. Toutes les commandes git lancées dans le worktree d'intégration (fusions, `status`, commit d'état) passent par elle. Les commandes lancées dans le dossier de l'utilisateur ne touchent jamais à ses verrous.
- `finish` : un commit d'état qui dépasse son délai reste l'avertissement `cleanup-failed` (avec « did not end within … »), jamais `hook-failed` (Task 7).
- `deliver` : un échec de `markDone` après la fusion lève `mark-failed` `{id, detail}` (en : « task "{id}" is merged, but its state line could not be written ({detail}); run relaylead task deliver {id} again to finish »). Le `deliver` suivant trouve la branche `merged` et finit sans seconde fusion (comportement actuel).

- [ ] **Étape 1 : tests qui échouent** :
  - `a state line commit that does not end leaves no index.lock behind` (sauté sous Windows, faux `git` comme les tests de délai existants) : le `commit` du worktree d'intégration crée `index.lock` puis attend 30 s ; `RELAYLEAD_GIT_TIMEOUT_MS=1000` ; `deliver('a')` rend 0 avec un avertissement qui contient `did not end within 1 s` ; aucun `index.lock` dans le worktree d'intégration ; le vrai git rétabli, le `deliver` suivant crée le commit d'état ;
  - `a state line that cannot be written after the merge is a coded error, and the next deliver finishes` : `tasksDirSource.markDone` remplacé par une fonction qui lève une fois ; `deliver('a')` rend 1, stderr contient `is merged` ; le `deliver` suivant rend 0 ; `git log --merges relaylead/integration` ne compte qu'une fusion de `relaylead/demo/a` ;
  - `a merge that does not end is cancelled` (existant) reste vert.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(livraison): commande git interrompue sans verrou laissé, écriture de la source après fusion`.

### Task 9 : aide, message `no-mission` et garde-fou de Glob et Grep

**Files :** modifier `core/cli.js`, `core/messages.js`, `core/guard.js`, `test/cli.test.js`, `test/guard.test.js`.

Trois mineurs de la relecture finale du lot 1 : `--help` reconnu même comme valeur d'option (`--note --help` affiche l'aide) ; le message `no-mission` conseille encore `RELAYLEAD_MISSION`, alors que cette variable fait refuser les commandes de l'utilisateur ; un `Glob` dont le `pattern` est absolu, ou un `Grep` dont le `glob` vise le dossier d'état, échappe au garde-fou, qui ne regarde que leur `path`. Un `Grep` dont le `glob` vaut `.env` lit même le contenu des secrets.

**Interfaces :**
- `wantsHelp(args) -> boolean` dans `core/cli.js` : vrai quand un argument vaut `--help` ou `-h` sans être la valeur de l'option qui le précède. Une option prend la valeur suivante quand elle commence par `--`, n'a pas de `=` et n'est pas dans `FLAGS`. `run` l'utilise à la place du test actuel.
- `no-mission` : en « no mission given; use --mission <name> » ; fr « aucune mission indiquée ; utilisez --mission <nom> ».
- `checkToolUse`, en plus du `path` :
  - `Glob` : `pattern`, résolu depuis `path` (ou `cwd`), est refusé s'il peut atteindre le dossier d'état (`inStateFolder`, après expansion des accolades). Un `pattern` qui vise un secret reste permis : Glob ne rend que des noms ;
  - `Grep` : `glob`, résolu de même, passe par `checkFileWord` (dossier d'état **et** noms de secrets) ;
  - `globMayReach` : un segment `**` traverse les dossiers ; dès que les segments qui le précèdent correspondent aux premiers segments du dossier d'état, le chemin peut l'atteindre.

- [ ] **Étape 1 : tests qui échouent** :
  - `an option value --help is not a request for help` : `run(['state', 'set', 'working', '--note', '--help', '--mission', 'ghost'])` rend 1, stderr `/no mission named "ghost"/`, stdout sans `Usage:` ; `--help after a command prints the help` (existant) reste vert ;
  - `no-mission advises --mission only` : `run(['task', 'list'])` sans env → stderr contient `--mission <name>` et pas `RELAYLEAD_MISSION` ; même vérification en français ;
  - `a Glob pattern that may reach the mission state folder is refused` : `pattern` = `<dossier d'état>/*` sans `path` → refus ; `pattern` `**/*.json` avec `path` = dossier parent de `RELAYLEAD_HOME` → refus ; `src/**/*.js` dans le projet → permis ; `**/.env` → permis ;
  - `a Grep glob naming a secret or the state folder is refused` : `glob: '.env'` → refus « secret » ; `glob: '.relaylead/**'` avec `path` = dossier parent de `RELAYLEAD_HOME` → refus ; `glob: '*.{ts,js}'` → permis.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(cli): aide, message no-mission et garde-fou de Glob et Grep`.

### Task 10 : un réveil par tâche finie, limite `parallel` appliquée

**Files :** modifier `core/wait.js`, `core/tasks.js`, `core/messages.js`, `catalog/profiles/lead.md`, `test/wait.test.js`, `test/tasks.test.js`.

Deux mineurs du lot 1 : chaque tâche finie réveille le lead deux fois (le résultat, puis le changement de sa session), ce qui coûte un tour de lead pour rien ; et `parallel` n'est appliqué que par la consigne du lead, pas par `task start`.

**Interfaces :**
- `relaylead wait` ne rapporte plus que les changements de tâches et de questions : `{changes: [{kind: 'task'|'question', id, from, to}]}`. La fin d'un équipier se lit déjà comme un changement de tâche (`done`, `failed`, y compris par le délai de grâce), et le lead n'attend pas sa propre session. Les sessions restent lues pour `crewEnded` et `lostSince` ; l'instantané perd sa clé `sessions`.
- `lead.md` : « blocks until a task or a question changes » ; la phrase « It may report a session change just after a task change » est retirée.
- `launchCrew` (après le cas idempotent `running`, avant toute préparation) : autant de tâches `running` que `mission.config.parallel` → `parallel-limit` `{mission, limit, running}` (en : « mission "{mission}" already runs {limit} tasks ({running}), its limit; start this one once a task finishes »). `task retry` (Task 5) y est soumis aussi.

- [ ] **Étape 1 : tests qui échouent** :
  - `a finished task wakes the lead once` : tâche `a` lancée, `wait(5)` ; l'équipier finit et sa session se termine ; `wait(5)` rend exactement `[{kind: 'task', id: 'a', from: 'running', to: 'done'}]` ; `wait(0)` rend `[]` ;
  - `a change between two waits is not lost` (existant) : la liste attendue perd sa ligne `kind: 'session'` ;
  - `a start beyond the parallel limit is refused, naming the running tasks` : `.relaylead.json` `{parallel: 1}` et une tâche `c` sans dépendance ; `startTask a` réussit ; `startTask c` → `parallel-limit`, message qui nomme `a` ; `startTask a` rejoué rend l'enregistrement existant.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(attente): un réveil par tâche finie, limite parallel appliquée au lancement`.

### Task 11 (humain) : deux missions de suite avec Claude Code sur macOS

**Files :** créer `docs/manual-checks/lot-1-1-claude-macos.md` (procédure et relevé, même forme que celui du lot 1).

- [ ] **Étape 1 :** `npm link` depuis `main` après la Task 10 ; copier le dépôt jouet dans un dossier neuf, `git init -b main`, tout commiter, approuver le dossier dans Claude Code.
- [ ] **Étape 2 :** `relaylead launch --agent claude --request "Do the tasks in tasks/"` ; répondre à la question ; attendre `done`.
- [ ] **Étape 3 :** commiter une tâche `c` sur `main` ; `relaylead remove <mission>` ; relancer la même commande dans le même dossier ; attendre `done`.
- [ ] **Étape 4 :** pendant la seconde mission, `relaylead launch --name autre` dans le même dossier → refus `dir-busy`.
- [ ] **Étape 5 :** relever : les durées ; les sessions lancées ; les refus du garde-fou ; les commits `chore(relaylead): deliver <id>` ; aucun worktree de tâche restant après chaque mission ; aucune session restante (`claude agents --json`) ; le dossier de l'utilisateur inchangé.
- [ ] **Étape 6 :** commit `docs(essai): deux missions de suite avec Claude Code`. Chaque défaut trouvé devient une issue.

---

## Hors périmètre

- **Vivacité du lead lue par l'adaptateur** pour le verrou : l'état de la mission suffit et ne dépend pas d'un appel à `claude agents` ; un lead disparu pour de bon se règle par `relaylead stop` (le message le dit), sa relance automatique relève du veilleur (lot 2a).
- **Verrous git du dossier de l'utilisateur** laissés par une commande tuée (`worktree add`, `branch -D`) : l'utilisateur peut y lancer git lui-même, Relaylead n'y retire rien ; l'erreur garde le message de git.
- **Règle `PreToolUse` contre `npm install` en mode `all`**, et `yarn`, `pnpm`, `bun` : le mode `all` est un choix explicite et la spec ne range pas les scripts d'installation parmi les garde-fous communs ; à revoir avec la liste blanche complète (lot 3).
- **Réutilisation automatique du nom d'une mission finie** au lancement : la suppression reste explicite (`relaylead remove`), `mission-exists` y renvoie.
- **Autres mineurs du registre du lot 1**, jugés trop rares ou mieux traités plus tard : compteur de parenthèses du garde-fou trompé par une obfuscation délibérée (refonte de `guard.js` au lot 3) ; liens durs refusés par FAT ou un partage réseau (`writeJsonExclusive`, `~/.relaylead` est local) ; limite de 32 k caractères de la ligne de commande Windows (consignes courtes ; essai sur machine Windows réelle au lot 4) ; BOM UTF-8 qui masque l'en-tête d'une tâche ; `finishTask` qui ne vérifie pas l'état de la tâche hors tentative ; `start-busy` qui compte toute la file ; mission qui reste `working` quand le faux lead s'arrête sur un échec (faux agent seulement) ; `git init -b` qui exige git 2.28 (tests seulement).
