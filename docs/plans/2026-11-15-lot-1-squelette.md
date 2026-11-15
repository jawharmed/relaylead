# Lot 1 : squelette marchant — plan

> **Pour les agents qui exécutent :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`). Les titres de tâche gardent le mot anglais « Task » pour l'outillage. Chaque tâche correspond à une issue GitHub du jalon « Lot 1 : squelette marchant » ; la PR d'une tâche ferme son issue. Les tâches qui modifient `core/cli.js` ou `adapters/fake/agent.js` s'exécutent en série.

**But :** un outil `relaylead` installable qui mène, sur un dépôt jouet, une mission de deux tâches de bout en bout : avec un faux agent sur macOS, Linux et Windows (CI), et avec Claude Code sur macOS, sans autre intervention qu'une question posée puis répondue par `relaylead answer`.

**Architecture :** un paquet Node.js sans dépendance. Le cœur (`core/`) tient l'état en fichiers JSON écrits de façon atomique sous `~/.relaylead/`. Il ne parle aux agents qu'à travers le contrat d'adaptateur (`adapters/`). Deux adaptateurs :
- `fake`, un faux agent scripté qui rejoue un lead et des équipiers sans IA ni quota (tests et CI) ;
- `claude`, qui applique les recettes prouvées par l'essai.

Le lead et les équipiers n'écrivent l'état que par l'outil `relaylead`. Toute fusion et tout marquage de la source se font dans un worktree d'intégration, jamais dans le dossier de travail de l'utilisateur.

**Outils :** Node.js 18 ou plus (CommonJS, aucune dépendance), `node --test`, git, GitHub Actions (dépôt public : minutes gratuites).

**Spec :** [`docs/specs/2026-11-14-relaylead-design.md`](../specs/2026-11-14-relaylead-design.md) (v6). Résultats de l'essai : [`docs/spike-results.md`](../spike-results.md). Feuille de route : [`2026-11-15-feuille-de-route.md`](2026-11-15-feuille-de-route.md), ligne « 1. Squelette marchant ». Relecture contradictoire du plan faite le 15 nov. 2026 ; ses corrections sont intégrées.

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

## Review Focus

1. **Écritures concurrentes** : `relaylead task done` d'un équipier et `relaylead state set` du lead écrivent en même temps dans la même mission. Attendu : aucun fichier tronqué, aucune perte. Test : Task 2, `concurrent writers never leave a truncated file`.
2. **Chemins Windows** : espaces et antislashs dans le dossier de la mission et dans le chemin des hooks. Attendu : les hooks se lancent. Test : Tasks 8 et 9, chemins avec espace, rejoués par la CI Windows.
3. **Deux lancements sur le même dossier** en même temps, même sous deux noms différents, ou après un plantage qui a laissé un verrou. Attendu : un seul lead, un message clair, et un verrou mort repris. Test : Task 3.
4. **Sortie inattendue de `claude`** : version trop ancienne, dossier non approuvé, copie au lieu de réveil, sortie sans id. Attendu : erreur claire, aucune session orpheline non signalée. Test : Task 10, faux binaire qui rejoue chaque sortie relevée à l'essai.
5. **Équipier fini ou mort sans résultat**. Une session Claude `done` garde un processus vivant, et un `kill -9` est relancé par le démon. Attendu : la tâche passe en `failed` d'après l'état rendu par l'adaptateur, jamais d'après le seul PID, et jamais « en cours » pour toujours. Test : Task 5.

---

## Structure des fichiers

```
package.json                 nom relaylead, bin, engines node >=18, scripts.test "node --test"
bin/relaylead.js             point d'entrée : appelle core/cli.js
core/
  cli.js                     analyse des arguments et sous-commandes
  messages.js                textes de la CLI (anglais, français)
  paths.js                   dossiers de Relaylead (RELAYLEAD_HOME), slug
  store.js                   lecture et écriture atomique de JSON
  config.js                  configuration à trois niveaux, secrets par référence
  missions.js                lancer, lister, arrêter une mission ; verrou par dossier
  sessions.js                registre des sessions d'une mission
  tasks.js                   tâches : démarrage (consigne, worktree, profil), résultat
  wait.js                    attente d'un changement, avec instantané
  questions.js               questions et réponses
  profiles.js                profils et méthodes (Markdown + en-tête)
  guard.js                   règles du garde-fou
  hooks/pretool.js           hook PreToolUse
  hooks/permission.js        hook PermissionRequest
sources/tasks-dir.js         source « fichiers de tâches »
deliveries/files.js          livraison « fichiers dans un dossier »
deliveries/local-merge.js    livraison « branche fusionnée en local » (worktree d'intégration)
adapters/index.js            contrat et choix de l'adaptateur
adapters/fake/index.js       faux agent : launch, list, stop, attach
adapters/fake/agent.js       processus du faux agent (lead ou équipier scripté)
adapters/claude/args.js      profil → options de lancement
adapters/claude/settings.js  réglages propres à la session
adapters/claude/sessions.js  lecture de `claude agents --json` et de la sortie de lancement
adapters/claude/index.js     launch, list, stop, attach, wake
catalog/profiles/lead.md, catalog/profiles/developer.md, catalog/methods/code.md
fixtures/                    faux binaire claude, sorties relevées, dépôt jouet
test/                        un fichier de test par module, plus test/e2e/
.github/workflows/ci.yml     ubuntu, macos, windows × Node 18, 24
```

## Contrat d'adaptateur (référence pour les Tasks 3, 5, 10, 11)

```js
// Session : ce que list() rend et ce que le cœur enregistre dans sessions/<shortId>.json
{ sessionId, shortId, name, role: 'lead'|'crew', state: 'working'|'waiting'|'done'|'stopped'|'failed', pid /* ou null */, cwd }
// spec passée à launch()
{ mission, name, role, profile /* objet de core/profiles.js */, prompt, cwd, env, permissionMode: 'allowlist'|'all' }
// Adaptateur
{ name, capabilities: ['launch','list','stop','attach', 'wake'?],
  launch(spec) -> Promise<Session>, list(mission) -> Promise<Session[]>, stop(session) -> Promise<void>,
  attach(session) -> Promise<number> /* code de sortie */, wake?(session, message) -> Promise<Session> }
```

---

### Task 1 : paquet, CLI vide et CI sur trois systèmes

**Files :** créer `package.json`, `bin/relaylead.js`, `core/cli.js`, `core/messages.js`, `test/cli.test.js`, `.github/workflows/ci.yml` ; modifier `README.md` (section « Développer » : `npm test`).

**Interfaces :** `run(argv: string[], io: {out, err, env, cwd}) -> Promise<number>` (code de sortie) ; `t(key, vars, lang) -> string`.

- [ ] **Étape 1 : tests qui échouent** (`test/cli.test.js`) :
  - `prints the version` : `run(['--version'])` écrit la version de `package.json` et rend 0 ;
  - `unknown command exits 2 with help` ;
  - `help lists the commands` : `launch list show stop task state wait question answer`.
- [ ] **Étape 2 :** `npm test` → échec (module absent).
- [ ] **Étape 3 :** écrire `run` (table `{nom: fonction}` ; les sous-commandes non livrées rendent 1 « not implemented yet ») et `bin/relaylead.js` (`#!/usr/bin/env node`, `run(...).then((code) => { process.exitCode = code; })`).
- [ ] **Étape 4 :** `npm test` → 3 réussis.
- [ ] **Étape 5 :** `ci.yml` :
  - déclenché sur `push` et `pull_request` ;
  - matrice `os: [ubuntu-latest, macos-latest, windows-latest]` × `node: [18, 24]` ;
  - étapes `actions/checkout`, `actions/setup-node`, `npm test` ;
  - aucun secret.
- [ ] **Étape 6 :** commit `chore: paquet, CLI vide et tests sur trois systèmes` ; PR verte sur les six combinaisons.

### Task 2 : état en fichiers et configuration à trois niveaux

**Files :** créer `core/paths.js`, `core/store.js`, `core/config.js`, `test/store.test.js`, `test/config.test.js`, `test/paths.test.js`.

**Interfaces :**
- `home()` : `RELAYLEAD_HOME`, sinon `path.join(os.homedir(), '.relaylead')`.
- `missionDir(name)`.
- `slug(text)` : minuscules, `[a-z0-9-]`, tirets fusionnés, 40 caractères au plus. Une chaîne vide est une erreur.
- `writeJson(file, data)` : crée les dossiers, écrit `file.<pid>.<aléa>.tmp`, puis `renameSync`. Sous Windows, il réessaie jusqu'à 5 fois sur `EPERM` ou `EBUSY`, avec 50 ms d'attente par `Atomics.wait`.
- `readJson(file, fallback)` : un fichier absent rend `fallback` ; un JSON invalide donne une erreur qui nomme le fichier.
- `loadConfig({dir, params}) -> object` : fusion profonde `DEFAULTS < ~/.relaylead/config.json < <dir>/.relaylead.json < params`.
- `resolveSecret(ref)` pour `env:NOM` et `file:chemin`. Toute autre forme donne l'erreur « secrets must be references ».
- `DEFAULTS` :

  ```js
  {
    language: 'en', agent: 'claude', permissionMode: 'allowlist', parallel: 4, priority: 'normal',
    questions: { onTimeout: 'wait' },
    source: { type: 'tasks-dir', dir: 'tasks' },
    delivery: { type: 'local-merge', branch: 'relaylead/integration' },
    guard: { protectedBranches: ['main', 'master'], secrets: ['.env', '.env.*'], allow: [] },
    attribution: null,
  }
  ```

- [ ] **Étape 1 : tests qui échouent** :
  - `writeJson then readJson round-trips` ;
  - `readJson returns the fallback for a missing file` ;
  - `readJson names the file when JSON is invalid` ;
  - `concurrent writers never leave a truncated file` : 2 processus enfants écrivent 200 fois chacun le même fichier ; 200 lectures faites pendant ce temps donnent toujours un JSON valide ;
  - `project config overrides machine config, params override both` ;
  - `resolveSecret reads env: and file: references` et `rejects a plain secret value` ;
  - `slug turns "My Project 2" into "my-project-2"`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(etat): écriture atomique et configuration à trois niveaux`.

### Task 3 : lancer, lister et arrêter une mission avec le faux agent (balle traçante)

**Files :** créer `core/missions.js`, `core/sessions.js`, `adapters/index.js`, `adapters/fake/index.js`, `adapters/fake/agent.js`, `test/missions.test.js`, `test/fake-adapter.test.js` ; modifier `core/cli.js` (`launch`, `list`, `stop`, `state`).

**Interfaces :**
- `getAdapter(name) -> Adapter` (contrat ci-dessus).
- `createMission({name, dir, request, team, priority, agent, params}) -> Mission` :
  - écrit `missions/<name>/mission.json` = `{name, dir, request, team, priority, agent, createdAt, config}`, où `config` est la fusion résolue par `loadConfig` et figée au lancement ;
  - lance le lead (`role: 'lead'`, `env.RELAYLEAD_MISSION = name`, `env.RELAYLEAD_HOME = home()`, nom de session `<mission>/lead/1`) ;
  - écrit `lead.json` = `{sessionId, shortId, sessionName, startedAt}` et `sessions/<shortId>.json`.
- **Verrou par dossier** : création exclusive (`fs.openSync(…, 'wx')`) de `locks/<hash du chemin réel du dossier>.lock`, qui contient le PID et le nom de mission.
  - Un verrou dont le PID est mort est repris.
  - Une mission non terminée sur ce dossier donne l'erreur `dir-busy`.
  - Un nom déjà pris donne l'erreur `mission-exists`.
  - Le verrou est retiré à `stop` et à la fin de la mission.
- `name` vaut par défaut `slug(basename(dir))`.
- `listMissions() -> [{name, dir, state, lead}]`, où `state` est lu dans `state.json` (`starting` s'il n'existe pas encore).
- `stopMission(name)` : arrête toutes les sessions du registre par l'adaptateur, puis écrit `state.json` = `{state: 'stopped'}` en tant que cœur.
- `relaylead state get|set <starting|working|waiting|done> [--note …]` : écrit `state.json` (mission lue dans `RELAYLEAD_MISSION` ou `--mission`). `set` est refusé si l'état vaut `stopped`, pour qu'un lead relancé n'efface pas un arrêt.
- Faux agent :
  - `launch` démarre `process.execPath adapters/fake/agent.js` détaché (`detached: true`, `stdio: 'ignore'`, `windowsHide: true`, puis `unref()`) ;
  - le faux id est `fake-<aléa>` : `shortId` = ses 8 premiers caractères ;
  - `list` relit le registre et vérifie le PID ; `stop` tue le PID ; `attach` rend 0 et note l'appel (pour les tests) ;
  - dans cette tâche, `agent.js` en rôle `lead` lance `relaylead state set working`, puis attend.

- [ ] **Étape 1 : tests qui échouent** :
  - `launch creates mission.json with the resolved config and starts a lead` : `list` montre `<nom>/lead/1` et l'état `working` en moins de 5 s ;
  - `second launch on the same dir is refused` : deux lancements simultanés sous deux noms ; un seul réussit, l'autre rend `dir-busy` ;
  - `a stale lock is taken over` ;
  - `name defaults to the folder slug` ;
  - `stop stops every session of the mission` : PID mort, état `stopped`, `state set working` refusé ensuite.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(missions): lancer, lister et arrêter une mission avec le faux agent` ; CI verte sur les trois systèmes.

### Task 4 : source « fichiers de tâches »

**Files :** créer `sources/tasks-dir.js`, `test/tasks-dir.test.js`.

**Interfaces :** module pur, sans état Relaylead.
- Format : un Markdown par tâche dans `<racine>/<source.dir>/`. L'en-tête, entre `---`, porte :
  - `title` ;
  - `state` : `todo`, `doing` ou `done` ;
  - `depends` : liste `[a, b]` d'ids, l'id étant le nom de fichier sans `.md` ;
  - `ask` (facultatif) : une question à poser à l'humain avant de lancer la tâche.
- `list(root, dir) -> [{id, title, state, depends, ask, body}]`.
- `ready(tasks) -> tasks` : les tâches `todo` dont toutes les dépendances sont `done`. Une dépendance inconnue donne une erreur qui nomme le fichier.
- `markDone(root, dir, id)` : réécrit seulement la ligne `state:`.

- [ ] **Étape 1 : tests qui échouent** :
  - `lists tasks with their front matter (ask included)` ;
  - `ready respects dependencies` ;
  - `unknown dependency is reported` ;
  - `markDone rewrites only the state line` (le reste du fichier est identique, octet pour octet) ;
  - `CRLF files are read` (Windows).
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(source): fichiers de tâches`.

### Task 5 : tâches d'une mission et attente du lead

**Files :** créer `core/tasks.js`, `core/wait.js`, `test/tasks.test.js`, `test/wait.test.js` ; modifier `core/cli.js` (`task`, `wait`), `adapters/fake/agent.js` (lead et équipier scriptés).

**Interfaces :**
- `listTasks(mission)` :
  - fusionne la source (tâches de la source, lues dans le worktree d'intégration s'il existe, sinon dans `dir`), `tasks/<id>.json` et `tasks/<id>.result.json` ;
  - état de chaque tâche : `todo`, `running`, `done` ou `failed` (source `done` → `delivered`).
- `startTask(mission, {id, profile = 'developer'})` :
  - **idempotent** : une tâche `running` rend l'existant sans relancer ;
  - prépare le lieu de travail par la livraison (Task 6 ; d'ici là, `cwd = dir`) ;
  - compose la consigne de l'équipier : titre, corps de la tâche, dossier de travail, branche, puis « finish with `relaylead task done <id> --summary "<one line>"` or `relaylead task fail <id> --summary …`, one command per call » ;
  - lance un équipier (`role: 'crew'`, nom `<mission>/<profil>/<n>`) et écrit `tasks/<id>.json` = `{id, profile, state: 'running', session: shortId, cwd, branch, startedAt}`.
- `finishTask(mission, id, {state, summary})` : écrit `tasks/<id>.result.json` (rédacteur : l'équipier).
- `relaylead task list|start <id> [--profile p]|done <id>|fail <id> [--summary …]` : `list` imprime du JSON.
- `relaylead wait [--timeout <s>]` : délai par défaut **100 s**, maximum 540 s.
  - L'instantané des tâches, questions et sessions est gardé dans `missions/<m>/wait-snapshot.json`.
  - Elle rend dès qu'une différence apparaît avec cet instantané, imprime les changements en JSON (`{changes: [{kind: 'task'|'question'|'session', id, from, to}]}`) et met l'instantané à jour. Un changement survenu entre deux appels n'est donc jamais perdu.
  - Elle détecte une fin sans résultat **d'après l'état rendu par l'adaptateur** :
    - session `done`, `stopped` ou `failed` sans résultat : la tâche devient `failed` (« crew session ended without a result ») ;
    - session `working` sans PID : délai de grâce de 60 s (relance automatique possible) avant le même constat.
  - Elle arrête par l'adaptateur la session d'un équipier dont le résultat est lu, car une session Claude `done` garde un processus vivant.
- Faux agent :
  - lead scripté : `task list`, lancer les tâches prêtes (au plus `config.parallel`), `wait`, recommencer jusqu'à ce que tout soit `done` ou `failed`, puis `state set done` ;
  - équipier scripté : attendre 1 s, `task done <id> --summary "fake work"`, s'arrêter.

- [ ] **Étape 1 : tests qui échouent** :
  - `startTask launches a crew member and records the task` ;
  - `startTask twice does not launch twice` ;
  - `wait reports a finished task as a JSON change` (moins de 3 s après `task done`) ;
  - `a change between two waits is not lost` ;
  - `crew session done without a result marks the task failed` ;
  - `fake mission runs two dependent tasks to done` (B lancée après A).
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(taches): tâches d'une mission et attente du lead`.

### Task 6 : livraisons et worktree d'intégration

**Files :** créer `deliveries/local-merge.js`, `deliveries/files.js`, `test/deliveries.test.js` ; modifier `core/missions.js` (préparation au lancement), `core/tasks.js` (lieu de travail d'une tâche), `core/cli.js` (`task deliver <id>`), `adapters/fake/agent.js` (l'équipier écrit un fichier et commite).

**Interfaces :**
- `local-merge` :
  - `prepareMission(mission)` : au lancement, crée la branche d'intégration (`delivery.branch`) depuis la branche courante si elle n'existe pas, et son worktree `<dir>/.relaylead/worktrees/_integration`. Il ajoute `.relaylead/` à `.git/info/exclude`. C'est **le seul lieu** des fusions et des écritures dans la source.
  - `prepareTask(mission, task) -> {cwd, branch}` : branche `relaylead/<mission>/<id>` depuis la branche d'intégration, worktree `<dir>/.relaylead/worktrees/<id>`.
  - `deliver(mission, task)`, **idempotent** : fusion `--no-ff` dans le worktree d'intégration, `markDone` de la source, puis commit `chore(relaylead): <id> livrée`. Ensuite, retrait du worktree et de la branche de la tâche. Une tâche déjà livrée rend « déjà livrée ».
  - Refus si `delivery.branch` est une branche protégée.
- `files` : `prepareTask` → dossier `<dir>/out/<id>/` ; `deliver` vérifie qu'il n'est pas vide, puis marque la tâche livrée dans `tasks/<id>.json`.
- Git uniquement par `execFileSync('git', [...], {cwd})`.

- [ ] **Étape 1 : tests qui échouent** (dépôt git temporaire, chemin avec espace) :
  - `prepareMission creates the integration worktree without touching the user checkout` (branche courante et fichiers du dossier inchangés) ;
  - `deliver merges the task branch and marks the source done` ;
  - `deliver twice is a no-op` ;
  - `refuses a protected integration branch` ;
  - `files delivery checks the output folder` ;
  - `deliver removes the task worktree and branch`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(livraison): worktree d'intégration, fusion locale et fichiers`.

### Task 7 : questions et réponses

**Files :** créer `core/questions.js`, `test/questions.test.js` ; modifier `core/cli.js` (`question ask|list`, `answer`), `core/wait.js` (une réponse est un changement), `adapters/fake/agent.js` (une tâche qui porte `ask` fait poser la question avant son lancement, puis attendre la réponse).

**Interfaces :**
- `askQuestion(mission, {key, text, context, options, recommended}) -> {id, existing}` :
  - **idempotent par `key`** : une question ouverte de même clé rend l'existante ;
  - écrit `questions/<id>.json` = `{id, key, text, context, options, recommended, state: 'open', askedAt}`.
- `answerQuestion(mission, id, choice)` : écrit `questions/<id>.answer.json` = `{choice, answeredAt}`. `choice` est un numéro ou le texte d'une option, sinon c'est une erreur.
- `listQuestions(mission, {state})`.
- CLI :
  - `relaylead question ask --key … --text … --option … --option … [--recommended 1]` imprime l'id ;
  - `relaylead answer <mission> <id> <choix>` ;
  - `relaylead question list [<mission>]` : questions ouvertes, recommandation en premier.
- Sans réponse : le lead attend (`questions.onTimeout: 'wait'`) ; l'application de la recommandation après un délai est hors de ce lot.

- [ ] **Étape 1 : tests qui échouent** :
  - `ask then answer` ;
  - `asking twice with the same key returns the same question` ;
  - `answer accepts the option number or its text` ;
  - `answering an unknown question fails clearly` ;
  - `wait reports an answered question` ;
  - `fake mission waits for the answer then finishes`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(questions): questions du lead et réponses par relaylead answer`.

### Task 8 : garde-fou minimal

**Files :** créer `core/guard.js`, `core/hooks/pretool.js`, `core/hooks/permission.js`, `test/guard.test.js`, `test/hooks.test.js`.

**Interfaces :**
- `checkToolUse({tool_name, tool_input, cwd}, guard) -> {decision: 'allow'|'deny', reason?}`.
- Une commande Bash est découpée sur `&&`, `||`, `;` et `|`, et chaque morceau est jugé.
- Refus, quel que soit le mode :
  - push vers une branche protégée : `git push <remote> <branche>`, `HEAD:<branche>`, `--all`, `--mirror`, ou `git push` nu quand la branche courante (`git rev-parse --abbrev-ref HEAD` dans `cwd`) est protégée ;
  - `git push --force`, `-f` ou `--force-with-lease` ;
  - lecture ou écriture d'un secret déclaré (`Read`, `Write`, `Edit` par `file_path` ; `Bash` dont un morceau cite le chemin) ;
  - `git commit` sur une branche protégée.
- `hooks/pretool.js` : lit l'entrée sur stdin, charge `config.guard` dans `mission.json` (mission tirée de `RELAYLEAD_MISSION` et `RELAYLEAD_HOME`), puis rend `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<message>}}`, ou rien.
- `hooks/permission.js` :
  - une commande qui correspond à `guard.allow` ou aux outils du profil rend `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` ;
  - sinon `…"decision":{"behavior":"deny","message":<message>}`, **sans créer de question** (la question d'autorisation relève du lot 3).
- Message de refus : « Blocked by Relaylead: <raison>. Continue with the rest of the task, one command per call. » Chaque refus ajoute une ligne au journal de la mission.

- [ ] **Étape 1 : tests qui échouent** : un test par refus, et un par cas permis voisin :
  - `git push origin relaylead/x` est permis ;
  - `git push origin main`, `git push origin HEAD:main`, `cd x && git push origin main`, et `git push` nu sur `main`, sont refusés ;
  - `git push -f` est refusé ;
  - `cat .env` et un `Read` de `.env` sont refusés ;
  - `pretool hook prints a deny decision` et `permission hook allows a listed command and denies the rest` tournent en vrais processus, avec l'entrée JSON sur stdin et une mission dont le chemin contient une espace.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts, y compris sur la CI Windows.
- [ ] **Étape 5 :** commit `feat(garde-fou): refus des pushes protégés, forcés et des secrets`.

### Task 9 : adaptateur Claude, parties pures

**Files :** créer `core/profiles.js`, `adapters/claude/args.js`, `adapters/claude/settings.js`, `adapters/claude/sessions.js`, `test/profiles.test.js`, `test/claude-args.test.js`, `test/claude-settings.test.js`, `test/claude-sessions.test.js`, `fixtures/claude/agents-*.json`, `fixtures/claude/launch-*.txt`.

**Interfaces :**
- `loadProfile(name, {dir}) -> {name, agent, model, effort, tools, instructions}` :
  - recherche dans `<dir>/.relaylead/profiles/`, puis `~/.relaylead/profiles/`, puis `catalog/profiles/` ;
  - en-tête `---` simple (`clé: valeur`, listes `[a, b]`).
- `buildLaunchArgs({profile, name, settingsFile, permissionMode, prompt}) -> string[]`, dans cet ordre :
  1. `--allowedTools <outils…>` : en mode `allowlist`, les outils du profil ; en mode `all`, `Bash Read Write Edit Glob Grep` ;
  2. `--permission-mode acceptEdits` ;
  3. `--bg --name <name> --model <m> --effort <e> --append-system-prompt <consignes> --settings <fichier> --setting-sources project,local --strict-mcp-config` ;
  4. la consigne, en dernier.
- `sessionSettings({mission, packageDir}) -> object` :

  ```js
  {
    env: { RELAYLEAD_MISSION, RELAYLEAD_HOME, BASH_DEFAULT_TIMEOUT_MS: '600000' },
    hooks: { PreToolUse: [...], PermissionRequest: [...] },
    attribution: config.attribution, // seulement s'il est défini
  }
  ```

  - Chaque commande de hook vaut `"<node>" "<packageDir>/core/hooks/<x>.js"`, avec guillemets.
  - Le résultat est écrit dans `missions/<m>/settings/<session>.json`.
- `parseLaunchOutput(text) -> {shortId, copyOf?}|{error: 'untrusted-dir'|'unknown'}` : lit la ligne `backgrounded · <id> · <nom>`, la note « started a copy as », et « Workspace not trusted ».
- `mapState(row) -> Session` : `blocked` → `waiting` ; `working`, `done`, `stopped` et `failed` gardés.
- `compareVersion(text, '2.1.325') -> boolean`.

- [ ] **Étape 1 : tests qui échouent** :
  - `allowedTools comes before every other option` ;
  - `prompt is the last argument` ;
  - `never passes --session-id or --agents` ;
  - `hook commands quote paths with spaces` ;
  - `settings carry mission, home and bash timeout` ;
  - `parses the short id, a copy and an untrusted folder from recorded outputs` ;
  - `maps claude states` ;
  - `profile lookup prefers the project, then the user, then the catalog`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(claude): traduction des profils et réglages de session`.

### Task 10 : adaptateur Claude, lancement, arrêt, réveil

**Files :** créer `adapters/claude/index.js`, `fixtures/claude/fake-claude.js`, `test/claude-adapter.test.js`.

**Interfaces :**
- La commande `claude` est réglable : `RELAYLEAD_CLAUDE` vaut un chemin. S'il se termine par `.js`, l'adaptateur lance `[process.execPath, chemin]` ; sinon `claude` du `PATH`. **Jamais de `shell: true`** : Node refuse de lancer un `.cmd` sans shell, et le shell casserait les guillemets des consignes.
- `launch(spec)` :
  - refuse si la version est inférieure à 2.1.325 ;
  - écrit les réglages (Task 9), puis lance avec `cwd = spec.cwd` ;
  - si le dossier n'est pas approuvé, rend l'erreur `untrusted-dir` avec la marche à suivre (« run `claude` once in <dir> and accept ») ;
  - lit l'id court dans la sortie, puis la ligne complète dans `claude agents --json --all` ;
  - vérifie dans les 30 s que la session a commencé son tour (état autre que `waiting`, ou transcript non vide), sinon rend l'erreur `not-started` ;
  - rend la `Session`.
- `list(mission)` : `claude agents --json --all`, filtré sur les ids du registre de la mission.
- `stop(session)` : `claude stop <shortId>`.
- `attach(session)` : `claude attach <shortId>`, `stdio: 'inherit'`.
- `wake(session, message)` :
  1. `stop` ;
  2. attente de la fin du PID (60 s maximum, puis erreur `wake-timeout`) ;
  3. `claude --bg --resume <sessionId> <message>`, sans autre option, avec `cwd = session.cwd` ;
  4. vérifier que la sortie nomme le même id court ; sinon, arrêter la copie et rendre l'erreur `wake-copy`.
- `fake-claude.js` rejoue, selon `FAKE_CLAUDE_SCENARIO`, les sorties relevées à l'essai (`fixtures/claude/launch-*.txt`) : lancement normal, dossier non approuvé, version ancienne, réveil en copie, réveil réussi.

- [ ] **Étape 1 : tests qui échouent** :
  - `launch returns the session read from agents --json` ;
  - `refuses an old claude version` ;
  - `reports an untrusted folder with the fix` ;
  - `reports a session that never started` ;
  - `wake resumes under the same id` ;
  - `wake detects a copy and stops it`.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts sur les trois systèmes.
- [ ] **Étape 5 :** commit `feat(claude): lancement, arrêt et réveil des sessions`.

### Task 11 : catalogue, consigne du lead et `show`

**Files :** créer `catalog/profiles/lead.md`, `catalog/profiles/developer.md`, `catalog/methods/code.md`, `test/catalog.test.js` ; modifier `core/missions.js` (consigne du lead), `core/cli.js` (`show`).

**Interfaces :**
- `lead.md` :
  - modèle `opus`, effort `medium` ;
  - outils `Bash(relaylead *)`, `Bash(git status)`, `Bash(git log *)`, `Read`, `Glob`, `Grep` ;
  - consignes : ne produit rien lui-même. Il lit `relaylead task list`. Pour une tâche qui porte `ask`, il pose la question (`relaylead question ask --key <id> …`) et ne la lance qu'après la réponse. Il lance les tâches prêtes (`relaylead task start <id>`), attend par `relaylead wait` (en boucle), livre chaque tâche faite (`relaylead task deliver <id>`) et finit par `relaylead state set done`. Une commande par appel.
- `developer.md` :
  - modèle `sonnet`, effort `medium` ;
  - outils `Bash(git *)`, `Bash(npm test*)`, `Bash(node *)`, `Bash(relaylead task *)`, `Read`, `Write`, `Edit`, `Glob`, `Grep` ;
  - consignes : travaille seulement dans le dossier donné, lance les tests du projet, commite sur sa branche, puis finit par `relaylead task done|fail`. Une commande par appel.
- `code.md` : la boucle ci-dessus et le critère de fin (toutes les tâches de la source livrées ou en échec signalé).
- Consigne du lead = `method.instructions` + demande + nom de la mission. Le profil passe par `--append-system-prompt` (Task 9).
- `relaylead show <mission>` : `attach` de la session de `lead.json`.

- [ ] **Étape 1 : tests qui échouent** :
  - `catalog profiles parse with the expected fields` ;
  - `lead tools only allow relaylead and read-only git` ;
  - `lead prompt contains the method and the request` ;
  - `show attaches to the current lead` (faux adaptateur).
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** écrire les fichiers et `show`.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(catalogue): profils lead et développeur, méthode code`.

### Task 12 : mission de bout en bout avec le faux agent

**Files :** créer `test/e2e/fake-mission.test.js`, `fixtures/toy-repo/` (`tasks/a.md` ; `tasks/b.md`, qui dépend de `a` et porte `ask`).

- [ ] **Étape 1 : test qui échoue** : `fake mission delivers two tasks with one answered question`.
  - Mise en place : copie du dépôt jouet dans un dossier temporaire dont le chemin contient une espace (`git init` et premier commit faits par le test).
  - Déroulé : `relaylead launch --agent fake --request "Do the tasks"`, attente de la question ouverte, `relaylead answer`, puis attente de `state: done` (60 s maximum).
  - Vérifications : les deux branches sont fusionnées dans `relaylead/integration` ; les deux tâches sont `done` dans la source de la branche d'intégration ; aucun processus du faux agent ne reste vivant ; il ne reste aucun worktree de tâche ; le dossier de l'utilisateur est inchangé.
- [ ] **Étape 2 :** `npm test` → échec tant que l'assemblage manque ; corriger dans le module fautif, chaque correction avec son test.
- [ ] **Étape 3 :** CI verte sur les six combinaisons.
- [ ] **Étape 4 :** commit `test(e2e): mission de bout en bout avec le faux agent`.

### Task 13 (humain) : mission réelle avec Claude Code sur macOS

**Files :** créer `docs/manual-checks/lot-1-claude-macos.md` (procédure et relevé).

- [ ] **Étape 1 :** `npm link` depuis le dépôt de Relaylead.
- [ ] **Étape 2 :** copier le dépôt jouet, puis l'approuver une fois dans Claude Code (`claude` dans le dossier).
- [ ] **Étape 3 :** lancer `relaylead launch --agent claude --request "Do the tasks in tasks/"` ; suivre par `relaylead list` et `relaylead show`.
- [ ] **Étape 4 :** répondre à la question par `relaylead answer`.
- [ ] **Étape 5 :** relever :
  - la durée ;
  - les sessions lancées ;
  - les refus du garde-fou ;
  - aucune demande d'autorisation restée en attente ;
  - les branches fusionnées dans `relaylead/integration` ;
  - aucune session restante après `state: done` (`claude agents --json`).
- [ ] **Étape 6 :** commit `docs(essai): mission réelle du lot 1 avec Claude Code`. Chaque défaut trouvé devient une issue.
