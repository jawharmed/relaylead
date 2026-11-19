# Lot 2a : continuité — plan

> **Pour les agents qui exécutent :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`). Les titres de tâche gardent le mot anglais « Task » pour l'outillage. La Task 1 ferme #67, la Task 2 ferme #71 ; les autres tâches n'ont pas d'issue, leur PR cite la tâche du plan. Presque toutes touchent `core/messages.js`, `core/cli.js`, `core/missions.js` ou `core/watcher*.js` : elles s'exécutent en série, dans l'ordre du plan.

**But :** une mission survit seule à ce qui arrête ou endort son lead. Un lead tué est relancé sans perte ; un lead dont le contexte se remplit passe la main à une session neuve ; un lead qui a fini son tour est réveillé quand un équipier finit, qu'une réponse arrive ou qu'un message l'attend ; jamais deux leads, jamais d'arrêt au seul motif qu'une session attend ; trois relances ratées arrêtent la mission.

**Architecture :** un **veilleur** sans IA (`core/watcher.js`) passe sur chaque mission non finie. Un passage observe la mission (`observe`, aucune écriture), décide par des règles pures (`core/watcher-rules.js`, `decide`), puis agit sous le verrou de mission (`act`), après une seconde observation faite sous ce verrou : arrêter un lead de trop ou un équipier orphelin, déclarer perdu un équipier disparu, réveiller, relancer, relever, écrire au courrier, déclencher le disjoncteur. Les sessions écrivent leurs **relevés** par des hooks passés à chaque lancement (`core/hooks/posttool.js`, `stop.js`, `stopfailure.js`, `statusline.js`, logique dans `core/readings.js`) : battement de cœur, contexte, échec ; elles lisent leur **courrier** (`core/mailbox.js`). Le veilleur tourne de trois façons, toutes par le même code : un passage complet (`relaylead watcher run`), un passage ciblé détaché juste après la fin d'un équipier, une réponse ou une demande de relève (`relaylead watcher run --mission <nom>`), et une boucle détachée toutes les 5 min (`relaylead watcher start`, lancée par `relaylead launch`). L'enregistrement dans launchd passe au lot 4 avec `install` (« Risques et questions tranchées », point 1).

**Outils :** Node.js 18 ou plus (CommonJS, aucune dépendance), `node --test`, git, GitHub Actions (ubuntu, macos, windows × Node 18, 24).

**Spec :** [`docs/specs/2026-11-14-relaylead-design.md`](../specs/2026-11-14-relaylead-design.md) (v6, amendée le 19 nov. 2026) : « Le veilleur », « Cycle de vie » (3. Relève), « Mesures », contrat d'adaptateur (`wake`, `inject`, `heartbeat`, `context`). Feuille de route : [`2026-11-15-feuille-de-route.md`](2026-11-15-feuille-de-route.md), ligne « 2a. Continuité ». Essai jetable : [`docs/spike-results.md`](../spike-results.md). Plan précédent : [`2026-11-16-lot-1-1-robustesse.md`](2026-11-16-lot-1-1-robustesse.md) ; relevé réel : [`docs/manual-checks/lot-1-1-claude-macos.md`](../manual-checks/lot-1-1-claude-macos.md). Mesures préalables sur Claude Code 2.1.328 (relevé `mesures-2a.md` du 19 nov. 2026, hors dépôt) : leurs faits sont recopiés dans « Faits mesurés », seule source à lire pour l'exécution. Décisions de l'auteur du 19 nov. 2026 : première version publique **macOS seulement** (essais réels sous macOS, la CI garde les trois systèmes avec le faux agent) ; planificateur du système **launchd seulement**, ailleurs une erreur codée (lot 4) ; lot 6 supprimé, le lot 7 suit le lot 5. Relecture contradictoire du plan faite le 19 nov. 2026 (2 critiques, 17 importants, 11 mineurs) : toutes ses corrections sont intégrées.

## Faits mesurés

Claude Code 2.1.328, macOS, 19 nov. 2026. Mesures faites avec les options de lancement de l'adaptateur (`adapters/claude/args.js`), lignes lues par `claude agents --json --all` toutes les 100 à 500 ms, mort du processus datée par `kill -0` toutes les 5 ms. Huit sessions `rl-2a-probe-*`, toutes arrêtées et supprimées.

1. **Après `claude stop`, la ligne perd son PID avant la fin du processus.** Le PID quitte la ligne 0,1 à 0,5 s après `claude stop` (avant même que la commande rende, en 0,8 à 1,1 s) ; le processus vit encore jusqu'à 1,4 à 2,0 s après l'arrêt, soit au moins 0,9 s de plus. Pendant l'arrêt d'une session en plein tour, la ligne montre environ 1,5 s de `working` sans PID et parfois une lecture `failed` passagère, puis `stopped`. Une session inactive arrêtée reste `done` (jamais `stopped`). La ligne reste dans `--all` et sort de la liste sans `--all`. Conséquence : une session arrêtée a fini quand la ligne n'a plus de PID **et** que le PID lu avant l'arrêt est mort (Tasks 2, 11, 12).
2. **`status` vaut `busy` pendant tout un tour**, appels d'outils longs (Bash de 60 s) et intervalles entre outils compris (127 lectures, aucune `idle`) ; il passe à `idle` (`done`/`idle`) moins de 0,5 s après la fin du tour. Seul faux `idle` observé : au début d'un tour (lancement ou réveil), environ 1 s de `working` sans PID ni `status`, puis **une** lecture `working`/`idle` avec PID (0,5 à 1 s), puis `busy`. Conséquence : deux lectures `idle` à 2 s d'écart, et un court silence (10 s) après une action du veilleur sur le lead (Task 9).
3. **La barre d'état est appelée pendant le tour**, environ 0,5 s après chaque réponse du modèle puis une seconde fois environ 3 s plus tard ; jamais pendant l'exécution d'un outil (le contexte ne bouge pas non plus). Premier appel, avant toute réponse : `context_window.context_window_size` déjà donné (1 000 000), `current_usage: null`, `used_percentage: null`. Ensuite : `context_window.current_usage` porte `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (et `output_tokens`) ; la somme des trois champs d'entrée égale `total_input_tokens` et, au jeton près, le calcul sur le transcript (dernière réponse du fil principal). `rate_limits` paraît dès le deuxième appel. Le transcript reçoit chaque réponse 1 à 3 s après son horodatage. Conséquence : la fenêtre est connue dès le début de toute session, équipier d'un seul tour compris ; plus de fenêtre par défaut (Task 4).
4. **L'id court et le `session_id` complet ne changent pas** après un réveil (`claude stop`, puis `claude --bg --resume <sessionId> "<message>"` sans options : « woke session <id> with its saved options… », même id, nouveau PID ; arrêt en 0,8 s, processus fini en 1,4 à 1,6 s) ni après une relance par le démon (`kill -9` : `working` sans PID pendant 11 s, puis même id, nouveau PID). Hooks et barre d'état gardent le même `session_id` et le même `transcript_path`. La relance par le démon **rejoue en entier** l'outil interrompu. Conséquence : relevés et courrier restent sous le même id court ; les actions du lead doivent rester idempotentes (Tasks 4, 5, 11).
5. Hors lot : à l'invite d'approbation d'un dossier, l'option par défaut est « No, exit » (à retenir pour l'assistant `init`, lot 4).

## Contraintes globales

- Node.js 18 ou plus, CommonJS, **aucune dépendance**, aucune étape de compilation, aucune API absente de Node 18. Pas d'`await` au niveau racine (CommonJS) : `.then` ou une fonction `main`.
- Aucun appel à des outils absents de Windows (`jq`, `uuidgen`, `sleep`, `which`, `rm -rf`) dans le produit ni dans les tests. Chemins construits par `path.join`.
- Tests : `npm test` = `node --test` **sans argument** (par `fixtures/run-tests.js`, qui ajoute un chien de garde). Ces motifs par défaut exécutent **tout fichier `.js` sous `test/`** : les fixtures vont dans `fixtures/` à la racine, jamais sous `test/`.
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

Ajouts du lot 1.1 (toujours en vigueur) :

- Pas de shell : git, les agents et les assistants détachés se lancent par `execFileSync` ou `spawn` avec un tableau d'arguments, jamais `shell: true`.
- Tout nouvel appel git synchrone passe par `runFileSync` (`core/run-file.js`).
- Chaque nouvelle erreur attendue est un `codedError` dont le code a son texte en anglais **et** en français dans `core/messages.js`.
- Fichiers `tasks/archive/<id>.<n>.json` et `<id>.<n>.result.json` ; `state.json` peut porter `stopping: true`, écrit par le cœur seul.
- Avant toute suppression récursive sous `~/.relaylead/missions/`, le nom est vérifié par `/^[a-z0-9-]+$/`.

Ajouts du lot 2a :

- **Fichiers d'état nouveaux, chacun avec un seul rédacteur** (détail dans « Fichiers d'état du lot »).
- **Fin d'une session arrêtée, en deux temps, partout** (arrêt, relance de tâche, réveil, relève) : (1) la liste de l'adaptateur ne lui donne plus de processus, (2) le PID lu **avant** l'arrêt est mort. Le second temps dure jusqu'au délai de l'attente sous POSIX (un PID n'y est pas repris en quelques secondes), au plus 5 s sous Windows (`RELAYLEAD_CLAUDE_WAKE_SETTLE_MS`, borne le défaut #71). Aucune session n'est jugée vivante ou finie sur son seul PID.
- **Aucune session n'est arrêtée au seul motif qu'elle attend** (`waiting`, `blocked`, `idle`) ; un lead silencieux ou qui ne répond pas aux réveils est signalé, jamais arrêté.
- **`observe` n'écrit rien** ; toute écriture du veilleur (tâche déclarée perdue, `watch.json`, courrier, état) se fait dans `act`, sous le verrou de mission, après une seconde observation sous ce verrou.
- **Aucune écriture dans la configuration de l'utilisateur** : ni `~/Library/LaunchAgents`, ni `~/.claude`, ni sa barre d'état. Hooks et barre d'état de mesure passent par `--settings` à chaque lancement.
- Hooks et barre d'état : rapides (aucun appel réseau ni à `claude`, lecture du transcript bornée à ses 256 derniers Kio), ne lèvent jamais (une erreur : rien n'est écrit, sortie 0), n'écrivent que sous `missions/<mission>/`.
- **Le contrat d'adaptateur change** (au lot 1.1, il ne changeait pas) : il gagne `stopById` (déjà lu par le cœur), `wake` obligatoire pour la continuité, et `idle` dans les lignes de `list` ; un `pid` nul ne veut plus dire « processus fini » (section « Contrat d'adaptateur »).
- Textes adressés aux sessions (réveil, courrier, consignes) et lignes de `watcher.log` en anglais, comme les profils.
- **`RELAYLEAD_WATCHER=off`**, posée par `fixtures/run-tests.js` pour toute la suite, coupe la boucle lancée par `launch` et les passages ciblés ; seuls les tests qui les éprouvent la retirent, le temps du test. Les passages des tests e2e sont lancés à la main (`relaylead watcher run`), jamais par la boucle.
- Délais lus à l'appel et raccourcis par variable d'environnement dans les tests : `RELAYLEAD_RESTART_GRACE_MS`, `RELAYLEAD_IDLE_RECHECK_MS`, `RELAYLEAD_LEAD_QUIET_MS`, `RELAYLEAD_HELPER_RECHECK_MS`, `RELAYLEAD_HELPER_PATIENCE_MS`, `RELAYLEAD_RATE_LIMIT_HOLD_MS`, `RELAYLEAD_CLAUDE_WAKE_SETTLE_MS`, `RELAYLEAD_FAKE_WAKE_MS` ; ceux des lots précédents restent.
- Chaque capacité nouvelle de l'adaptateur Claude a son équivalent dans le faux agent, éprouvé par la CI sur les trois systèmes ; le faux agent ne juge pas non plus une session tuée sur son PID (témoin `.killed`). Essais réels sous macOS seulement.

## Review Focus

1. **Lead qui attend une réponse humaine pendant des heures** (tour fini, `done`/`idle` avec processus, ou processus disparu, état `waiting`). Attendu : jamais arrêté, jamais relancé, réveillé une seule fois par changement réel. Tests : Task 6, `a lead waiting for an input is never stopped` ; Task 9, `an idle lead with nothing new is left alone pass after pass` et `an absent lead of a waiting mission is left alone, then woken by a change`.
2. **Le démon de Claude relance un lead tué pendant que le veilleur passe** (`working` sans PID pendant 11 s, fait mesuré 4). Attendu : délai de grâce, pas de seconde session ; si le veilleur a relancé après la grâce et que l'ancien revient, il est arrêté comme lead de trop ; une grâce entière à chaque disparition. Tests : Task 11, `a lead restarting by itself is not relaunched during the grace`, `a lead restarted by its agent after the watcher relaunched it is stopped as an extra lead` et `a lead that came back by itself gets a full grace the next time`.
3. **Deux équipiers finissent au même instant**, chacun lance un passage ciblé, et la boucle passe aussi. Attendu : un seul réveil (verrou de mission, seconde observation sous le verrou, vue déjà réveillée retenue). Test : Task 9, `two targeted passes at once wake the lead once`.
4. **Lead remplacé qui continue** (relève, ou relance pendant que l'ancien finit une commande) : `state set`, `task start`, `question ask`, `wait`. Attendu : refus `not-current-lead`, y compris pour une commande qui attendait le verrou pendant la relève ; l'état, les tâches et l'instantané ne bougent pas. Tests : Task 8, `a replaced lead can no longer drive the mission` et `a start queued behind a handover is refused once the lead is replaced`.
5. **Mission arrêtée, supprimée ou relancée sous le même nom pendant un passage ou un assistant détaché**. Attendu : le passage ne fait rien (il compare `createdAt` sous le verrou), l'ancien reaper non plus, et un arrêt demandé l'emporte sur une relance ou une relève en cours. Tests : Task 2, `an old reaper does nothing for a newer mission of the same name` ; Task 6, `a pass for a mission removed or replaced meanwhile does nothing` ; Task 11, `a stop during a relaunch leaves no lead running` ; Task 12, `a stop during a handover is not erased`.

Risques connus non couverts par un test : sous Windows, le second temps de la fin d'une session est borné à 5 s, donc un processus encore vivant après 5 s y est tenu pour fini (défaut #62 borné) ; la boucle du veilleur ne survit pas à un redémarrage de la machine (launchd au lot 4) ; un passage ciblé lancé depuis le Bash d'un équipier que l'on arrête aussitôt doit survivre à cet arrêt (processus détaché, mesuré à la Task 13).

---

## Structure des fichiers

Seuls les fichiers touchés par ce lot :

```
core/
  readings.js        (nouveau) relevés des sessions : battement, contexte (barre d'état, transcript), échec ; seuils
  mailbox.js         (nouveau) sendMail, readMail, markRead, unreadCount
  watcher.js         (nouveau) passage, verrou, STOP, observe, act, boucle, start/stop/status
  watch-log.js       (nouveau) watchLog : une ligne de watcher.log (sans dépendance vers missions.js)
  watcher-rules.js   (nouveau) decide : règles pures du veilleur
  detached.js        (nouveau) spawnDetached : assistants détachés (reaper, passage ciblé, boucle)
  hooks/posttool.js  (nouveau) battement, contexte du transcript, courrier en contexte additionnel
  hooks/stop.js      (nouveau) battement de fin de tour, courrier qui retient la fin du tour
  hooks/stopfailure.js (nouveau) échec de la session (rate_limit…)
  hooks/statusline.js  (nouveau) barre d'état de mesure : contexte exact et taille de la fenêtre
  sessions.js        settleBoundMs
  missions.js        fin en deux temps (#71), launchWhileOpen, reaper lié à sa mission, launchLead, réservation du numéro, handover, stopMission(note)
  wait.js            viewOf (vue pure), unseenChanges, refus d'un lead remplacé
  tasks.js           environnement des équipiers (rôle, nom), lead actuel vérifié sous le verrou
  store.js           writeTextExclusive
  cli.js             watcher run|start|stop|status|loop, passages ciblés, lead actuel, handover
  config.js          DEFAULTS : context, watcher
  messages.js        nouveaux codes et textes (en, fr)
adapters/
  claude/index.js    fin du processus en deux temps avant la reprise (#71)
  claude/settings.js hooks PostToolUse, Stop, StopFailure et statusLine de mesure
  fake/index.js      stopById (#67), wake, fin de tour, témoin de mort brutale
  fake/agent.js      relevés, courrier, fin de tour, barrière, réactions au courrier
catalog/profiles/lead.md, catalog/profiles/developer.md, catalog/methods/code.md
fixtures/
  claude/transcript.jsonl (nouveau) transcript synthétique
  fake-429.js        (nouveau) faux serveur de limite d'usage, pour l'essai réel
  run-tests.js       RELAYLEAD_WATCHER=off
  helpers.js         RELAYLEAD_WATCHER=off au chargement, killSession, userEnv sans rôle ni nom de session
docs/specs/2026-11-14-relaylead-design.md   encart d'amendement du 19 nov. 2026
README.md            veilleur, STOP, réveil, relève, réglages context et watcher, déblocage à la main (en, fr)
test/                readings, mailbox, watcher-rules, watcher, watcher-loop (nouveaux) ; missions, claude-adapter,
                     fake-adapter, hooks, claude-settings, store, wait, cli, catalog, e2e/continuity (nouveau), e2e/fake-mission
docs/manual-checks/lot-2a-claude-macos.md   (nouveau) relevé humain
```

## Contrat d'adaptateur

```js
// Ligne rendue par list(mission) : celle du lot 1, plus idle.
{ sessionId, shortId, name, role, state: 'working'|'waiting'|'done'|'stopped'|'failed', pid /* null : aucun processus */, cwd,
  idle /* true : aucun tour en cours */ }
// Adaptateur
{ name, capabilities: ['launch','list','stop','attach','wake'], stopById /* true : stop(session) sans danger sur une session déjà finie */,
  launch(spec), list(mission), stop(session), attach(session), wake(session, message) -> Promise<Session> }
```

Règles : un `pid` rendu par `list` veut dire « l'agent connaît un processus vivant » ; `pid: null` ou une session absente veut dire « l'agent ne connaît plus de processus », **pas** « le processus est fini » (fait mesuré 1) : la fin d'une session arrêtée se juge en deux temps (« Contraintes globales »). Le cœur ne relit le PID du registre qu'en repli, quand `list` échoue. Les deux adaptateurs ont `wake` et `stopById` ; le veilleur ne prévoit pas d'adaptateur sans eux (YAGNI).

## Fichiers d'état du lot

| Fichier | Contenu | Seul rédacteur | Tâche |
|---|---|---|---|
| `missions/<m>/heartbeats/<shortId>.json` | `{at, tool, contextTokens, baseTokens}` | hooks `PostToolUse` et `Stop` de la session (faux agent : la session elle-même) | 4, 5 |
| `missions/<m>/context/<shortId>.json` | `{at, contextTokens, windowTokens, baseTokens}` | barre d'état de mesure de la session | 4 |
| `missions/<m>/failures/<shortId>.json` | `{at, error, message}` | hook `StopFailure` de la session | 5 |
| `missions/<m>/mailbox/<shortId>/<nnnnnn>-<horodatage>.md` | un message ; `nnnnnn` strictement croissant | le cœur le crée par lien exclusif ; le hook de la session destinataire le **déplace** dans `read/` par `rename` après l'avoir transmis, jamais réécrit | 5 |
| `missions/<m>/watch.json` | mémoire du veilleur pour la mission (ci-dessous) | le veilleur, dans `act`, sous le verrou de mission | 6 |
| `missions/<m>/lead-launch.json` | `{n, name, at, failed}` : numéro réservé du prochain lead, écrit **avant** son lancement ; `failed: true` si ce lancement a levé | le cœur (`launchLead`), sous le verrou de mission (au premier lancement, sous le verrou du dossier) | 8 |
| `missions/<m>/state.json` | peut valoir `handover` (avec `by`), écrit par le lead ; `starting` après une relève, écrit par le cœur | lead ; cœur pour `stopped`, `stopping` et `starting` | 12 |
| `~/.relaylead/watcher.lock` | `{pid, since}` : un passage complet à la fois | le passage complet | 6 |
| `~/.relaylead/watcher.log` (et `watcher.log.1`) | une ligne par action : `<heure ISO> <mission ou -> <action> <détail>` | ajouts du veilleur (passages et assistants) ; bascule vers `.1` au-delà de 1 Mio, par le passage complet seul | 6 |
| `~/.relaylead/STOP` | présent : le veilleur ne fait rien | l'utilisateur | 6 |
| `~/.relaylead/watcher-loop.json` | `{pid, startedAt, version, beatAt, lastPassAt, everySeconds}` ; `pid` + `startedAt` = jeton de la boucle | la boucle qui porte ce jeton | 7 |
| `~/.relaylead/watcher-loop.stop` | demande d'arrêt de la boucle ; tant qu'il existe, aucun passage ciblé ne relance la boucle | `relaylead watcher stop` le crée et le laisse ; `watcher start` (donc `launch`) le retire avant de lancer | 7 |

`watch.json` : `{leadLostSince, crewLostSince: {}, failedRelaunches, lastRelaunchAt, lastFailedRelaunchAt, lastLeadActionAt, lastWakeAt, lastWakeView, ineffectiveWakes, lastIneffectiveAt, stuckNoticeFor, interruptWakeFor, rateLimitNoticeFor, unlistedNoticeFor, handoverNoticeFor, contextFullNotices: [], baseAlerts: [], silentNoticeFor, failuresSeen: {}, tripped}` ; absent, chaque champ vaut `null`, `0`, `false`, `[]` ou `{}`.

## Réglages du lot

Dans `core/config.js`, `DEFAULTS` :

```js
context: { budgets: { lead: 150000, crew: 250000 }, capPercent: 40, hardPercent: 20 },
watcher: { autoStart: true, helpers: true, everySeconds: 300 },
```

`context` se règle aux trois niveaux (`.relaylead.json` pour forcer un seuil bas) ; une mission lancée avant ce lot, dont la configuration figée n'a pas `context`, est complétée par `DEFAULTS.context`. `watcher` est lu dans la configuration machine seule (`loadConfig()` sans dossier), au moment de l'appel ; `RELAYLEAD_WATCHER=off` vaut `autoStart: false` et `helpers: false`.

Seuils d'une session : `soft = base + budgets[role]`, plafonné à `floor(capPercent / 100 × window)` quand la fenêtre est mesurée ; `hard = floor(soft × (100 + hardPercent) / 100)`. `base` est sa première mesure, `window` la `context_window_size` de sa barre d'état (connue dès le premier appel, fait mesuré 3). Fenêtre inconnue : pas de plafond. Un relevé de plus de 30 min n'est périmé que pour un lead **actif** : celui d'une session inactive ou morte ne bouge plus et reste exact.

## Règles du veilleur

#### États du lead

Lus sur la ligne de `list` qui porte le `shortId` de `lead.json` :

- **actif** : `working`, avec processus, pas inactif ;
- **inactif** : avec processus et `waiting` ou `done` ; ou `working` et `idle` sur deux lectures à `RELAYLEAD_IDLE_RECHECK_MS` (2000) d'écart (fait mesuré 2 : une seule lecture `idle` peut tomber au début d'un tour) ; ou **absent alors que l'état vaut `waiting`** (le réveil marche sur une session arrêtée) ;
- **en relance** : `working` sans processus, ou absent de la liste, depuis moins de `restartGraceMs()` (`RELAYLEAD_RESTART_GRACE_MS`, 120000) comptés depuis `watch.leadLostSince` ; ou absent mais avec un battement datant de moins de `restartGraceMs()` (ligne `lead-unlisted-but-alive <shortId>`, une fois, `unlistedNoticeFor`) ;
- **absent** : `stopped` ou `failed` ; `waiting` ou `done` sans processus ; en relance depuis plus que la grâce.

Lead actif ou inactif : `leadLostSince` repasse à `null` (une grâce entière à chaque disparition). Si `list` échoue (`obs.listError`), aucune règle de session ne s'applique à ce passage et `decide` émet la ligne `list-failed <message>`. Si `listTasks` lève (`obs.tasksError`), les règles 3, 5, 14 et 19 ne sont pas évaluées et `decide` émet `tasks-failed <message>`. `decide` ne s'applique pas à une ligne lue pendant un arrêt demandé par le veilleur : chaque action s'exécute sous le verrou, et la décision suivante vient d'une nouvelle observation sous ce verrou. « Battement » veut dire celui du lead actuel ; un lead qui n'a jamais battu a pour âge de battement le temps écoulé depuis `lead.startedAt`.

#### Cumul

Les règles 2 à 7 et 19 s'appliquent toutes. Sur le lead, **au plus une action par passage** : la première qui s'applique parmi 8 à 16, dans l'ordre ; 17 et 18 seulement si aucune de 8 à 16 n'a agi. La règle 11 arrête l'évaluation des règles 12 à 16 tant qu'elle tient. « Une fois » veut dire une fois par session (ou par valeur indiquée), retenu dans `watch.json`. Un « motif de réveil » est une des conditions des règles 14 à 16 (garde du réveil comprise). « Équipier » veut dire une session de rôle `crew` au registre ; « lead » une session de rôle `lead`. Le nom du lead actuel est le champ `sessionName` de `lead.json`.

#### Table des règles

| # | Condition | Action | Ligne de `watcher.log` | Task |
|---|---|---|---|---|
| 0 | `STOP` présent | aucun passage | — | 6 |
| 1 | état `done` ou `stopped`, ou marqueur `stopping`, ou pas de `lead.json` (lancement en cours) | rien ; sauf `watch.tripped` et `stopping` : rejouer `stopMission` | — | 6, 11 |
| 2 | session du registre de rôle `lead`, autre que celle de `lead.json`, listée avec processus | `stop-session` | `stop-extra-lead <shortId>` | 6 |
| 3 | session d'équipier listée avec processus, dont la tâche ne la fait plus tourner (tâche finie, livrée, autre session, ou aucune tâche ne la nomme) | `stop-session` | `stop-orphan-crew <shortId> task <id ou ->` | 6 |
| 4 | fichier de `failures/` (tout le dossier, registre ou non) plus récent que `failuresSeen[shortId]` | journal | `session-failure <shortId> <error>: <message>` | 6 |
| 5 | lead pas actif, `unseen.toFail` non vide (équipier perdu au-delà de la grâce de `wait`, `crewLostSince`) | `mark-failed` | `crew-lost <shortId> task <id>` | 9 |
| 6 | lead en relance, première observation | journal | `lead-restarting <shortId>` | 6 |
| 7 | lead actif, dernier battement de plus de 30 min, une fois | journal (jamais d'arrêt) | `lead-silent <shortId> <minutes> min` | 6 |
| 8 | lead **absent**, `failedRelaunches` ≥ 3 après décompte | `trip-breaker`, après la sortie du verrou | `breaker-tripped after 3 failed relaunches` | 11 |
| 9 | `state.json` vaut `handover`, `by` = `sessionName` de `lead.json` ou `user` | `hand-over` (arrête l'ancien s'il a un processus) | `hand-over <ancien> to <nouveau>: <note>` | 12 |
| 10 | lead absent, état ni `waiting`, ni `done`, ni `stopped` (donc `working`, `starting`, ou `handover` demandé par un lead remplacé) | `relaunch-lead` : reprise si son contexte est connu et sous le seuil souple, sinon session neuve ; reprise ratée → session neuve dans la même action | `relaunch-lead <shortId> resumed` ou `relaunch-lead <shortId> as <nom>` | 11 |
| 11 | lead inactif, échec `rate_limit` postérieur à son dernier battement et de moins de `RELAYLEAD_RATE_LIMIT_HOLD_MS` (5 h) | ni relève ni réveil (12 à 16 sautées) ; journal une fois par `at` de l'échec (`rateLimitNoticeFor`) | `lead-rate-limited <shortId>` | 9 |
| 12 | lead **actif**, contexte ≥ seuil dur | `hand-over` forcé | `hand-over <ancien> to <nouveau>: forced at <tokens> tokens` | 12 |
| 13 | lead inactif, contexte ≥ seuil souple (seuil dur compris), et un motif de réveil existe | `hand-over` (au lieu d'un réveil) | `hand-over <ancien> to <nouveau>: idle past the soft threshold` | 12 |
| 14 | lead inactif, `unseen.changes` non vide et `viewKey` ≠ `lastWakeView` ; garde du réveil | `wake-lead` | `wake-lead <shortId>: <changements>` | 9 |
| 15 | lead inactif, courrier non lu pour lui ; garde du réveil | `wake-lead` | `wake-lead <shortId>: mail` | 9 |
| 16 | lead inactif (avec processus), état `working` ou `starting`, clé `record.updatedAt \|\| lead.startedAt` ≠ `interruptWakeFor`, dernier battement `(stop)` ou âge de battement de plus de 11 min ; garde du réveil | `wake-lead` | `wake-lead <shortId>: turn ended while working` | 9 |
| 17 | lead actif, relevé frais, contexte ≥ seuil souple, une fois | `mail` au lead (avis de relève) | `notify-handover <shortId> <tokens>/<soft>` | 12 |
| 18 | base > moitié du seuil souple, une fois | journal | `base-high <shortId> <base>/<soft>` | 12 |
| 19 | équipier listé avec processus, sa tâche tourne, fenêtre **mesurée**, contexte ≥ seuil dur, une fois | `mail` à l'équipier (contexte plein) | `notify-context-full <shortId> task <id>` | 12 |

#### Garde du réveil

Elle s'applique aux règles 14 à 16 et entre dans le « motif de réveil » de la règle 13 :
- **silence** : aucun réveil dans les `RELAYLEAD_LEAD_QUIET_MS` (10000) qui suivent `lastLeadActionAt` (réveil, relance ou relève) ; la mesure ne demande que de couvrir le faux `idle` d'au plus 1 s d'un début de tour, déjà couvert par les deux lectures à 2 s ;
- **réveil en attente de jugement** : aucun réveil tant que `lastWakeAt` est posé, sans battement postérieur, depuis moins de 5 min (`INEFFECTIVE_AFTER_MS`) ;
- **réveil sans effet** : un réveil qu'aucun battement ne suit dans les 5 min, ou un réveil qui lève dans `act`. Effets : `ineffectiveWakes` + 1, `lastIneffectiveAt` = maintenant, `lastWakeAt` = `null`, et `lastWakeView` et `interruptWakeFor` repassent à `null` (le motif redevient dû) ;
- **espacement** : après 1, 2 puis 3 réveils sans effet, le suivant n'est permis qu'après 15 min, 30 min, puis 1 h depuis `lastIneffectiveAt` ; au-delà de 3, plus aucun réveil et `lead-stuck <shortId>` une fois (`stuckNoticeFor`), dans `watcher.log` et `journal.log` ;
- **remise à zéro** : tout battement du lead postérieur à `lastWakeAt` ou à `lastIneffectiveAt` remet `ineffectiveWakes` à 0 et efface `stuckNoticeFor` (un lead débloqué à la main se réveille de nouveau) ;
- `lastWakeView` repasse à `null` dès que `unseen.changes` est vide.

#### Décompte du disjoncteur

Seuls deux endroits comptent. (a) Le `decide` qui émet `relaunch-lead` : si `lastRelaunchAt` est posé et qu'aucun battement du lead actuel ne lui est postérieur, `failedRelaunches` + 1, `lastFailedRelaunchAt` = maintenant, `lastRelaunchAt` = `null`. (b) `act` : `relaunch-lead` ou `hand-over` qui lève, `failedRelaunches` + 1, `lastFailedRelaunchAt` = maintenant, `lastRelaunchAt` = `null`. **Tout battement du lead actuel postérieur à `lastRelaunchAt` ou à `lastFailedRelaunchAt`** remet `failedRelaunches` à 0 et ces deux champs à `null` : un lead revenu autrement (démon, utilisateur) efface le compte, et seules trois relances ratées d'affilée arrêtent la mission. `relaunch-lead` et `hand-over` posent `lastRelaunchAt` et `lastLeadActionAt` à l'heure de **début** de l'action. La seconde observation, sous le verrou, relit `watch.json` : le `watch` du premier `decide` est jeté, si bien que deux observations d'un même passage comptent une fois. La règle 8 ne vise qu'un lead absent : jamais un lead en relance par le démon.

## Textes envoyés aux sessions

En anglais, exacts :

- réveil : « Relaylead woke you: {reasons}. Carry on with the method: run `relaylead task list` first. » ; `{reasons}` joint par « ; » des éléments `task a is now done`, `question q-b is now answered`, `you have mail`, `your turn ended while the mission was working` ;
- reprise d'un lead absent : « Relaylead restarted you after your session ended. Carry on with the method: run `relaylead task list` first. » ;
- section insérée **avant** « ## This mission » dans la consigne d'un nouveau lead après relance : « ## Restart » puis « The previous lead session {old} ended unexpectedly. You take its place: you remember nothing, the files hold everything. Start with `relaylead task list`. » ;
- après relève : « ## Handover » puis « You take over from the lead session {old}, which handed over with this note: {note}. You remember nothing, the files hold everything. Start with `relaylead task list`. » (relève forcée : « which handed over when its context was full » ; lead inactif au-dessus du seuil : « which was idle past its context threshold ») ; `{note}` sur une ligne, 500 caractères au plus (au-delà, coupée et terminée par « … ») ;
- avis de relève (courrier) : « Your context holds {tokens} tokens, past the handover threshold of {soft}. Finish the step you are on, then run `relaylead state set handover --note "<where the mission stands, in one line>"` and end your turn: a fresh lead takes over from the files. » ;
- contexte plein d'un équipier (courrier) : « Your context holds {tokens} tokens and is full. Commit what you have done on your branch, then run `relaylead task fail {id} --summary "context full: <what is done, what remains>"` and end your turn: the lead starts a fresh session on your branch. »

Les hooks préfixent chaque message du courrier par « Message from Relaylead: ».

---

### Task 1 : arrêt par identifiant pour le faux agent (#67)

Sections de référence appliquées : aucune.

**Files :** modifier `adapters/fake/index.js`, `test/fake-adapter.test.js`, `test/missions.test.js`, `test/deliveries.test.js`.

Constat de #67 : `relaylead remove` et le traitement d'un marqueur `stopping` de plus d'une heure n'arrêtent une session que si l'adaptateur sait le faire par son identifiant ; le faux agent n'a pas `stopById`, ces deux chemins sautent donc l'arrêt et ne sont pas éprouvés. Depuis #62, le faux agent s'arrête par un fichier témoin choisi au lancement, jamais par PID : rejouer `stop` est sans danger.

**Interfaces :**
- `adapters/fake/index.js` exporte `stopById: true`. `stop(session)` ne change pas : il écrit le fichier d'arrêt, puis le retire quand la session a fini (fichier de fin présent) ou n'a pas de processus.
- Les tests qui éprouvent la branche « adaptateur qui arrête par PID » mettent `fake.stopById = false` le temps du test et le **rétablissent à `true`** dans `t.after` : `stop on a stopped or done mission kills nothing`, la fin de `stop runs again for an adapter that stops by id…`, `an old stopping marker does not replay a stop by pid`, et, dans `test/deliveries.test.js`, `a stop with nothing to do still cleans` et `a skipped stop keeps the worktree of a session whose recorded process still runs`. Les lignes `fake.stopById = true` devenues inutiles sont retirées (`stop runs again…`, `stop of a done mission says it is done`), et **tous** les `delete fake.stopById` de `test/missions.test.js` (dans les `t.after` de ces deux tests et au milieu du premier) deviennent `fake.stopById = true` ou disparaissent : un `delete` retirerait l'export pour le reste du fichier.

- [ ] **Étape 1 : tests qui échouent** :
  - `the fake adapter stops by id, harmlessly on a session already ended` (`test/fake-adapter.test.js`) : `fake.stopById === true` ; une session lancée, arrêtée, puis arrêtée de nouveau : aucune erreur, et aucun fichier d'arrêt ne reste ;
  - `remove stops the fake sessions by id` : `writeMission('demo', dir)`, une session d'équipier du faux agent lancée et enregistrée, `state.json` écrit à `{state: 'done'}` par le test (la session survit), puis `relaylead remove demo` : la session finit (`waitFor(sessionEnded)`), le dossier de la mission a disparu ;
  - `an old stopping marker stops the fake sessions again by id` : état `{state: 'stopped', stopping: true, updatedAt: <il y a 2 h>}` et une session du faux agent vivante ; `relaylead stop demo` rend 0 avec `mission demo stopped`, la session finit, le marqueur est retiré.
- [ ] **Étape 2 :** `npm test` → échecs attendus (`stopById` absent, sessions non arrêtées).
- [ ] **Étape 3 :** implémenter ; ajuster les tests listés ci-dessus.
- [ ] **Étape 4 :** `npm test` → tout vert.
- [ ] **Étape 5 :** commit `fix(fake): arrêt par identifiant, pour remove et le marqueur ancien (#67)`.

### Task 2 : fin d'une session en deux temps, reaper lié à sa mission (#71)

Sections de référence appliquées : « Faits mesurés » (point 1), « Contrat d'adaptateur ».

**Files :** modifier `core/missions.js`, `core/sessions.js`, `core/cli.js` (`_reap`), `adapters/claude/index.js`, `test/missions.test.js`, `test/claude-adapter.test.js`.

Constat de #71 : `stopSessionsAndWait` (sondage toutes les 250 ms), l'attente de `wake` (60 s) et `launchRunning` jugent la fin d'un processus sur son seul PID ; sous Windows, un PID repris fait croire une session vivante. Mais le fait mesuré 1 interdit de passer au seul témoin de la liste : la ligne de Claude perd son PID 0,9 à 1,5 s **avant** la fin du processus. D'où la règle en deux temps. Second point de #71 : après `remove` puis un nouveau lancement du même nom, un ancien reaper encore vivant peut écrire `reaper-ended.json` dans la nouvelle mission et relire son `lead.json`.

**Interfaces :**
- `core/missions.js` :
  - `hasProcess(rows, session) -> boolean` : vrai si une ligne de `rows` porte `session.shortId` et un `pid` non nul.
  - `settleBoundMs(totalMs) -> number`, dans `core/sessions.js` à côté d'`isAlive` (chargé par `core/missions.js` et par l'adaptateur Claude ; le placer dans `core/missions.js` créerait le cycle `missions → adapters → claude → missions`) : `totalMs` sous POSIX ; sous `win32`, `min(totalMs, Number(process.env.RELAYLEAD_CLAUDE_WAKE_SETTLE_MS) || 5000)`.
  - `stopSessionsAndWait(mission, sessions)` : `pidAvant` = PID de la ligne lue avant les arrêts, `null` si la ligne manque ou n'en a pas ; celui du registre **seulement si cette lecture a échoué**, comme aujourd'hui (le test `a session the adapter no longer lists has no process to wait for` le fixe). Après les arrêts, chaque sondage (`STOP_POLL_MS`) relit `adapter.list(mission.name)` : une session a fini quand `!hasProcess(rows, session)` **et** `!isAlive(pidAvant)` ; une fois le premier temps atteint, le second ne dure pas plus que `settleBoundMs(stopWaitMs())` depuis ce moment, au-delà la session compte comme finie. Un sondage dont la liste échoue juge ce tour-là sur `isAlive(pidAvant)` seul. Délai total (`stopWaitMs`) et retour `{failed, alive, error}` inchangés. Les relances de tâche (`stopPreviousCrew`), l'arrêt et la fin de mission en héritent.
  - `LAUNCH_LOCK_MAX_MS = 15 * 60 * 1000`. Dans `isStale` (branche « pas de `mission.json` ») et dans `launchRunning`, un lancement ne tourne que si le PID du verrou est vivant **et** que le fichier de verrou a moins de 15 min (`ageOf`).
  - `spawnReaper(name, createdAt)` lance `relaylead _reap <name> <createdAt>`. `reapLead(name, createdAt)` rend aussitôt si `mission.json` manque ou porte un autre `createdAt`. `markReaperEnded(name, createdAt)` n'écrit `reaper-ended.json` que si `mission.json` porte ce `createdAt`. Sans `createdAt` (un assistant lancé avant ce lot), comportement d'aujourd'hui.
- `adapters/claude/index.js` : `wake` attend la même fin en deux temps, par `findRow` (premier temps : ligne absente ou sans `pid`) puis `isAlive(pidAvant)`, le tout borné par `wakeTimeoutMs()` (60 s, sinon `wake-timeout`), le second temps borné par `settleBoundMs(…)` sous Windows seulement. Sous macOS, la reprise ne part donc jamais avant la mort du processus (une reprise trop tôt crée une copie : essai jetable).
- `fixtures/claude/fake-claude.js` ne change pas : `stuck-stop` retire déjà le PID de la ligne et laisse le processus vivre, c'est le cas réel du fait mesuré 1.

- [ ] **Étape 1 : tests qui échouent** :
  - `a stop waits on the adapter list, not on a pid now used by another process` : PID du registre = un processus sans rapport, vivant ; `list` remplacée par une fonction qui rend la session avec ce PID avant l'arrêt, puis sans `pid` ; sous `win32` seulement (sauté ailleurs), `relaylead stop demo` rend 0 en moins de 8 s, le processus sans rapport vit toujours ;
  - `a stop is not over while the process from before lives, even once the list shows no pid` : même montage sous POSIX, `RELAYLEAD_STOP_WAIT_MS=600` → `session-still-alive` ; le processus tué, un second `stop` rend 0 ;
  - `a stop judges on the pid only when the list fails` : `list` qui lève après l'arrêt, PID du registre vivant, `RELAYLEAD_STOP_WAIT_MS=300` → `session-still-alive` ; même cas avec le PID 2147483646 (qui ne peut pas exister) → 0 ;
  - `wake gives up when the session process does not end` (existant, `stuck-stop`) reste vert sous POSIX et est sauté sous `win32` ; `wake waits at most the settle bound on Windows` (sous `win32` seulement) : `stuck-stop`, `RELAYLEAD_CLAUDE_WAKE_SETTLE_MS=400` → `wake` réussit sous le même id, en 0,4 à 5 s ;
  - `a launch lock older than 15 min does not hold a mission name, even with a live pid` : verrou `{pid: process.pid, mission: 'demo'}` dont le `mtime` est reculé de 20 min, `missions/demo/` sans `mission.json` ; `relaylead remove demo` rend 0 et le dossier disparaît ; `remove leaves a mission folder being launched` (existant, verrou neuf) reste vert ;
  - `an old reaper does nothing for a newer mission of the same name` : mission `demo` avec un lead du faux agent enregistré ; `relaylead _reap demo 2000-01-01T00:00:00.000Z` (processus à part) se termine en moins de 3 s, le lead vit toujours, `reaper-ended.json` absent ;
  - les tests existants du reaper passent le `createdAt` de leur mission.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(missions): fin d'une session jugée en deux temps, reaper lié à sa mission (#71)`.

### Task 3 : faux agent : fin de tour, mort brutale et réveil

Sections de référence appliquées : « Contrat d'adaptateur ».

**Files :** modifier `adapters/fake/index.js`, `adapters/fake/agent.js`, `fixtures/helpers.js`, `core/messages.js`, `test/fake-adapter.test.js`.

Le veilleur réveille et relance par `wake`, que le faux agent n'a pas. Il faut aussi qu'une session du faux agent puisse finir son tour en restant vivante (comme une session Claude `done`/`idle`) et mourir sans écrire sa fin (comme un `kill -9`), sans qu'aucun de ces cas se juge sur son PID (sous Windows, celui d'une session tuée est repris en quelques millisecondes, #62).

**Interfaces :**
- `agent.js` : `endTurn()` écrit le fichier `RELAYLEAD_FAKE_IDLE`, puis reste vivant comme `idle()`. Avec `RELAYLEAD_FAKE_END_FIRST_TURN=1`, une session finit son premier tour aussitôt (pour les tests), en gardant son rôle `lead` ou `crew` au registre. Au démarrage, si `RELAYLEAD_FAKE_WAKE_MESSAGE` est défini, l'agent écrit `woken: <message>` dans son journal.
- `index.js` :
  - `launch` ajoute au registre `idleFile` (`missions/<m>/fake-<shortId>.idle`), `killedFile` (`missions/<m>/fake-<shortId>.killed`), `logFile` (le `RELAYLEAD_FAKE_LOG` d'aujourd'hui) et `env` (le `spec.env` reçu), champs ignorés du cœur, et passe à l'agent `RELAYLEAD_FAKE_IDLE` et `RELAYLEAD_FAKE_SHORT_ID` ;
  - `list` : fichier `.killed` présent → `{state: 'failed', pid: null, idle: true}` ; fichier de fin présent → `{state: 'done', pid: null, idle: true}` ; sinon, processus mort (`!isAlive(pid)`, preuve sûre : seul un PID **vivant** peut tromper, #62) → `{state: 'failed', pid: null, idle: true}` ; sinon fichier `idle` présent → `{state: 'waiting', idle: true}` ; sinon `{state: 'working', idle: false}` ;
  - `wake(session, message) -> Promise<Session>` : appelle `module.exports.stop(session)` (remplaçable par les tests) ; attend au plus `RELAYLEAD_FAKE_WAKE_MS` (10000) que le fichier de fin ou le fichier `.killed` existe, sinon `wake-timeout` ; retire les fichiers de fin, `idle`, `.killed` et d'arrêt ; relance `agent.js` avec le même rôle, les mêmes `sessionId`, `shortId` et fichiers, l'env `{...process.env, RELAYLEAD_TASK: undefined, ...session.env, …fichiers, RELAYLEAD_FAKE_LOG: session.logFile, RELAYLEAD_FAKE_WAKE_MESSAGE: message}` ; rend `{...session, pid, state: 'working', idle: false}` : tous les champs du registre sont gardés, car le cœur réécrit l'enregistrement par `recordSession`. `capabilities` gagne `'wake'`.
- `fixtures/helpers.js` : `killSession(session)` : `process.kill(session.pid, 'SIGKILL')`, puis écrit `session.killedFile` (le témoin que la session tuée ne peut pas écrire).
- `wake-timeout` (en, fr) devient général : « the session {shortId} was stopped but its process was still running after {seconds} s; it was not woken » / « la session {shortId} a été arrêtée mais son processus tournait encore après {seconds} s ; elle n'a pas été réveillée ».

- [ ] **Étape 1 : tests qui échouent** :
  - `a fake session that ended its turn is listed waiting and idle` : rôle `lead`, `RELAYLEAD_FAKE_END_FIRST_TURN=1` → `{state: 'waiting', idle: true}` avec un `pid` ;
  - `wake restarts a fake session under the same ids, with the message` : même montage, `wake(session, 'hello')` → même `shortId` et `sessionId`, autre `pid`, mêmes `idleFile`, `killedFile`, `logFile` et `env` ; le journal de la session contient `woken: hello` ; la session finit de nouveau son tour (`waiting`) ;
  - `a killed fake session is listed failed without a process` : `killSession` → `{state: 'failed', pid: null}` ; une session enregistrée par le test avec le PID 2147483646 et sans témoin → même chose ;
  - `wake resumes a killed fake session` : après `killSession`, `wake` rend une session vivante sous le même id, le témoin `.killed` retiré ;
  - `wake gives up when the fake session does not end` : `fake.stop` remplacé par une fonction vide, `RELAYLEAD_FAKE_WAKE_MS=300` → `wake-timeout`, l'ancien processus vit toujours.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(fake): fin de tour, mort brutale et réveil du faux agent`.

### Task 4 : battement de cœur et mesure du contexte

Sections de référence appliquées : « Faits mesurés » (points 3 et 4), « Fichiers d'état du lot » (lignes `heartbeats/` et `context/`), « Réglages du lot » (seuils, `DEFAULTS.context`).

**Files :** créer `core/readings.js`, `core/hooks/posttool.js`, `core/hooks/statusline.js`, `fixtures/claude/transcript.jsonl`, `test/readings.test.js` ; modifier `core/config.js`, `adapters/claude/settings.js`, `adapters/fake/agent.js`, `test/hooks.test.js`, `test/claude-settings.test.js`, `test/fake-adapter.test.js`.

Deux sources, dans l'ordre de la spec : la barre d'état de mesure, exacte, appelée pendant le tour après chaque réponse, et seule à donner la fenêtre (fait mesuré 3) ; le transcript, lu par `PostToolUse` à chaque action, qui donne les mêmes jetons avec 1 à 3 s de retard et sert de repli. Le plus récent des deux l'emporte. Les relevés restent sous le même id court après un réveil ou une relance par le démon (fait mesuré 4).

**Interfaces :**
- `core/readings.js` :
  - `shortIdOf(sessionId) -> string|null` : les 8 premiers caractères s'ils valent `/^[0-9a-f]{8}$/`, sinon `null` ;
  - `contextFromTranscript(file) -> number|null` : lit les 262144 derniers octets, parcourt les lignes depuis la fin, saute les lignes illisibles et celles où `isSidechain` est vrai, et rend pour la première entrée `type: 'assistant'` qui a `message.usage` : `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (absents = 0) ; `null` si rien, fichier absent ou illisible ;
  - `recordHeartbeat(mission, shortId, {tool, contextTokens}) -> void` : écrit `heartbeats/<shortId>.json` = `{at, tool, contextTokens, baseTokens}` ; `contextTokens` `null` garde la valeur précédente ; `baseTokens` = celui du fichier précédent, sinon la première valeur non nulle ;
  - `recordStatusline(mission, shortId, input) -> void` : `windowTokens` = `input.context_window.context_window_size` ou `null` ; `contextTokens` = somme des trois champs d'entrée de `input.context_window.current_usage`, ou `null` quand `current_usage` vaut `null` (premier appel, avant toute réponse) ; un `null` garde la valeur précédente ; écrit `context/<shortId>.json` = `{at, contextTokens, windowTokens, baseTokens}` (même règle de base) ;
  - `readReadings(mission, shortId) -> {heartbeat, statusline, failure}` (chacun ou `null` ; `failure` vient à la Task 5) ;
  - `contextOf(readings, {role, config, now, active}) -> {tokens, windowTokens, baseTokens, at, soft, hard}|null` : `config.context` complété par `DEFAULTS.context` ; le relevé le plus récent (`at`) des deux qui a des `contextTokens` ; `null` sans relevé, ou si `active` et qu'il a plus de `READING_STALE_MS` (30 min) ; `windowTokens` = celui de la barre d'état ou `null` ; `baseTokens` = celui du battement, sinon de la barre d'état, sinon `tokens` ; seuils selon « Réglages du lot » (pas de plafond sans fenêtre). `role` vaut `'lead'` ou `'crew'`.
- `core/hooks/posttool.js` : mission par `RELAYLEAD_MISSION` (vérifiée par `/^[a-z0-9-]+$/`), session par `shortIdOf(input.session_id)` ; `recordHeartbeat(mission, shortId, {tool: input.tool_name, contextTokens: contextFromTranscript(input.transcript_path)})`. Sans mission, sans id ou sur une entrée illisible : rien, sortie 0.
- `core/hooks/statusline.js` : `recordStatusline` ; imprime une ligne vide (la session est invisible). Mêmes règles d'erreur.
- `adapters/claude/settings.js` : `hooks.PostToolUse = hookEntry(packageDir, 'posttool')` ; `statusLine = {type: 'command', command: '"<node>" "<…/core/hooks/statusline.js>"'}`.
- `core/config.js` : `DEFAULTS.context` (« Réglages du lot »).
- Faux agent : après chaque commande `relaylead`, `recordHeartbeat(mission, RELAYLEAD_FAKE_SHORT_ID, {tool: 'Bash', contextTokens})` avec `contextTokens` = précédent (sinon `RELAYLEAD_FAKE_BASE_TOKENS`, 40000) + `RELAYLEAD_FAKE_TOKENS_PER_COMMAND` (**0** par défaut : contexte plat, aucun test ne dépend du nombre de commandes ; seuls les tests de relève et de mesure le montent). `endTurn()` écrit `{tool: '(stop)'}`. Un lead repris continue son compte ; une session neuve repart de la base.
- `fixtures/claude/transcript.jsonl` : synthétique (aucune donnée réelle) : réponses du fil principal dont la dernière vaut 30000 + 12000 + 366 = 42366, suivie d'une réponse de sous-agent (`isSidechain: true`, 99999) et d'une ligne tronquée.

- [ ] **Étape 1 : tests qui échouent** :
  - `the context of a transcript is the input of its last main-thread answer` : la fixture → 42366 ;
  - `a transcript is read from its last 256 KiB only` : 2 Mio de lignes utilisateur puis une réponse à 50000 → 50000 ; une réponse seulement dans le premier Mio → `null` ;
  - `a missing or unreadable transcript gives no context` → `null` ;
  - `the posttool hook records a heartbeat and keeps the first reading as base` (`test/hooks.test.js`, hook lancé comme un processus) : deux appels avec deux transcripts (42366 puis 60000) → `{tool: 'Bash', contextTokens: 60000, baseTokens: 42366}` ;
  - `the posttool hook writes nothing without a mission or a session id` : sortie 0, aucun fichier ;
  - `the statusline records the window from the first call, then the context` : premier appel `{context_window: {context_window_size: 1000000, current_usage: null}}` → `{contextTokens: null, windowTokens: 1000000}` ; second appel avec `current_usage` `{input_tokens: 2, cache_creation_input_tokens: 9505, cache_read_input_tokens: 33240}` → `{contextTokens: 42747, windowTokens: 1000000, baseTokens: 42747}` ;
  - `contextOf takes the freshest reading and the window of the status line` ; `contextOf ignores a reading older than 30 min only for an active session` ; `contextOf fills a configuration without context from the defaults` ;
  - `thresholds follow base + budget, capped by a measured window, and the hard margin` : base 40000, lead, fenêtre 1000000 → `soft` 190000, `hard` 228000 ; fenêtre 200000 → 80000 et 96000 ; fenêtre inconnue → 190000 et 228000 ; équipier, fenêtre 1000000 → 290000 et 348000 ;
  - `the session settings add the heartbeat hook and the measuring status line` (`test/claude-settings.test.js`) ;
  - `a fake session writes a heartbeat at each relaylead command` : un lead du faux agent sur une mission sans tâche, `RELAYLEAD_FAKE_TOKENS_PER_COMMAND=1000` ; le battement passe de 41000 à 42000 au moins, base 41000.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(mesures): battement de cœur et contexte des sessions`.

### Task 5 : boîte aux lettres, hooks Stop et StopFailure

Sections de référence appliquées : « Fichiers d'état du lot » (lignes `failures/` et `mailbox/`), « Textes envoyés aux sessions » (dernière phrase : préfixe des messages).

**Files :** créer `core/mailbox.js`, `core/hooks/stop.js`, `core/hooks/stopfailure.js`, `fixtures/fake-429.js`, `test/mailbox.test.js` ; modifier `core/store.js`, `core/hooks/posttool.js`, `core/readings.js`, `adapters/claude/settings.js`, `adapters/fake/agent.js`, `test/store.test.js`, `test/hooks.test.js`, `test/claude-settings.test.js`, `test/fake-adapter.test.js`.

Aucune commande n'envoie un message à une session vivante : le veilleur passe par des fichiers. L'essai jetable a prouvé les deux voies (`PostToolUse` pour une session qui travaille, `Stop` pour celle qui allait finir son tour) et la détection d'une limite d'usage par `StopFailure`. La pause sur limite d'usage reste au lot 2b : ici, l'échec est seulement relevé.

**Interfaces :**
- `core/store.js` : `writeTextExclusive(file, text) -> boolean` (le principe de `writeJsonExclusive` : fichier temporaire, puis lien exclusif ; `false` si le fichier existe) ; `writeJsonExclusive` l'appelle.
- `core/mailbox.js` :
  - `sendMail(mission, shortId, text) -> string` : `n` = nombre de fichiers `.md` de `mailbox/<shortId>/` et de `mailbox/<shortId>/read/` plus 1 ; écrit `<n sur 6 chiffres>-<heure ISO dont : et . deviennent ->.md` par `writeTextExclusive` ; si le nom existe, `n + 1` et nouvel essai ; rend le chemin. Les noms sont strictement croissants, quel que soit l'horloge.
  - `readMail(mission, shortId) -> {file, text}[]` : les messages non lus, triés par nom ; ne déplace rien.
  - `markRead(mission, shortId, files)` : déplace chacun dans `read/` par `rename` (`withWindowsRetry`) ; un fichier déjà déplacé (`ENOENT`) est sauté.
  - `unreadCount(mission, shortId) -> number`.
- `core/hooks/posttool.js` : après le battement, `readMail` ; s'il y a du courrier, **imprime d'abord** `{hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: <messages préfixés par « Message from Relaylead: », séparés par une ligne vide>}}`, **puis** `markRead`. Un hook tué entre les deux relivre le message au suivant : un message relu est sans danger (consignes rejouables), un message perdu ne l'est pas. Commentaire dans le fichier : un `PostToolUse` déclenché dans un sous-agent prendrait le courrier de la session ; aucun profil n'a d'outil de sous-agent aujourd'hui.
- `core/hooks/stop.js` : battement `{tool: '(stop)', contextTokens: <transcript>}` (marque la fin du tour, lu par la règle 16), puis `readMail` ; s'il y a du courrier, imprime `{decision: 'block', reason: <mêmes messages>}` puis `markRead` ; sinon rien. Le courrier étant consommé, le hook ne retient pas deux fois de suite.
- `core/hooks/stopfailure.js` : `recordFailure(mission, shortId, input)` (dans `core/readings.js`) écrit `failures/<shortId>.json` = `{at, error: input.error || null, message: input.last_assistant_message || null}`.
- `adapters/claude/settings.js` : `hooks.Stop` et `hooks.StopFailure`.
- Faux agent : après chaque commande et son battement, `readMail` puis `markRead` ; chaque message est écrit dans son journal (`mail: <texte>`). Les réactions viennent à la Task 12.
- `fixtures/fake-429.js` (pour l'essai réel, Task 13) : `node fixtures/fake-429.js [port]` imprime son port et répond à toute requête 429 `rate_limit_error`, avec `retry-after: 3600`, `anthropic-ratelimit-unified-status: rejected` et `anthropic-ratelimit-unified-reset: <maintenant + 3600 s>` (recette de l'essai jetable).

- [ ] **Étape 1 : tests qui échouent** :
  - `writeTextExclusive refuses a file that exists` (`test/store.test.js`) ;
  - `mail is read in the order it was sent, then kept in read/` : deux envois d'affilée (même milliseconde possible) → `first` puis `second` ;
  - `the mail of one session is not taken by another` ;
  - `fifty mails sent in a row all arrive, in order` : 50 envois d'affilée → 50 fichiers aux noms distincts et croissants, 50 messages lus dans l'ordre ;
  - `the posttool hook passes the mail on as additional context` : deux messages `first`, `second` → sortie exacte `{hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: 'Message from Relaylead: first\n\nMessage from Relaylead: second'}}`, battement écrit, messages dans `read/` ;
  - `a mail read but not marked is passed on again` : `readMail` sans `markRead`, puis le hook → le message est transmis ;
  - `the stop hook keeps the turn going while mail waits` : avec un message → `{decision: 'block', reason: 'Message from Relaylead: …'}` ; sans courrier → rien ; battement `tool: '(stop)'` dans les deux cas ;
  - `the stopfailure hook records the error and its message` : `{session_id, error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 2:54am (Europe/Paris)"}` → `failures/<id>.json` ;
  - `the session settings add the Stop and StopFailure hooks` ;
  - `a fake session takes its mail after each command` : mission dont une tâche tourne (le faux lead boucle sur `wait --timeout 5`, donc lance des commandes) ; un message envoyé au lead finit dans `read/` et dans son journal ;
  - `the fake 429 server answers a rate limit with its reset headers` : statut 429 et les trois en-têtes.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(courrier): boîte aux lettres des sessions, hooks Stop et StopFailure`.

### Task 6 : le veilleur : un passage, son verrou, `STOP` et son journal

Sections de référence appliquées : « Contrat d'adaptateur » ; « Fichiers d'état du lot » (lignes `watch.json`, `watcher.lock`, `watcher.log`, `STOP`, et le paragraphe `watch.json`) ; « Règles du veilleur » › « États du lead », « Cumul » et « Table des règles » (règles 0 à 4, 6 et 7).

**Files :** créer `core/watcher.js`, `core/watcher-rules.js`, `core/watch-log.js`, `test/watcher-rules.test.js`, `test/watcher.test.js` ; modifier `core/cli.js`, `core/messages.js`.

Le squelette du veilleur et ses premières règles (0 à 4, 6 et 7 de « Règles du veilleur ») : rien n'est encore réveillé, relancé ni relevé. `test/watcher-rules.test.js` porte un test de table que chaque tâche suivante complète (`the rules table`) : une observation par ligne, l'action attendue.

**Interfaces :**
- `core/watcher-rules.js` : `decide(obs) -> {actions, watch}`, pure (aucune lecture, l'heure vient de `obs.now`). `obs` :
  `{now, mission /* contenu de mission.json : name, createdAt, config… */, record /* state.json */, lead /* lead.json ou null */, rows /* list, ou null si elle a échoué */, listError /* message ou null */, tasksError /* message ou null */, leadIdleConfirmed, registry, tasks /* ou null */, readings: {[shortId]: {heartbeat, statusline, failure}}, failures /* tout le dossier failures/ */, unseen /* Task 9 */, mail: {[shortId]: number}, config, watch}`.
  Actions : `{type: 'stop-session', session, log}` (exécutée par `stopSessionsAndWait(mission, [session])`, fin en deux temps ; un échec ou une session encore vivante lève l'action), `{type: 'log', text, journal /* aussi dans journal.log */}` ; les tâches suivantes ajoutent `mark-failed`, `wake-lead`, `relaunch-lead`, `hand-over`, `mail`, `trip-breaker`. `leadStatus(obs) -> 'active'|'idle'|'restarting'|'absent'` y est aussi exportée. Constantes : `SILENT_MS = 30 * 60 * 1000`, `restartGraceMs()` (`RELAYLEAD_RESTART_GRACE_MS`, 120000), qui sert aussi de fenêtre de battement de l'état « en relance ».
- `core/watcher.js` :
  - `observe(name) -> obs|null` : aucune écriture, aucune ligne de journal. `null` pour une mission finie, en arrêt (`stopping`, sauf `watch.tripped`) ou sans `lead.json` ; `rows` par `adapter.list` (`null` et `listError` si elle lève) ; si le lead est `working` et `idle` avec un processus, seconde lecture après `RELAYLEAD_IDLE_RECHECK_MS` → `leadIdleConfirmed` ; `tasks` par `listTasks` (`null` et `tasksError` s'il lève) ; `watch` relu dans `watch.json`.
  - `tendMission(name) -> action[]` : `module.exports.observe` (remplaçable par les tests) puis `decide` ; si rien à faire et `watch` inchangé, rien n'est verrouillé ni écrit. Sinon, sous `withMissionLock(name, 'watcher')` : relit `mission.json`, et ne fait rien si son `createdAt` diffère de `obs.mission.createdAt` ou si la mission est finie ; observe de nouveau (ce qui relit `watch.json`), décide de nouveau à partir de cette seule observation, exécute chaque action par `act(name, action, watch)`, puis écrit `watch.json`.
  - `act(name, action, watch) -> Promise<void>` : exécute une action ; peut modifier `watch` (l'objet rendu par le second `decide`) avant son écriture : les Tasks 9, 11 et 12 s'en servent pour les effets d'un échec. Une attente du verrou qui abandonne (`start-busy`, `start-stuck`, `mission-unknown`) laisse la mission au passage suivant, sans erreur. Une action qui lève est journalisée (`error <type>: <message>`) et n'empêche pas les suivantes. Les actions marquées « après le verrou » s'exécutent après sa sortie.
  - `runPass() -> {outcome: 'done'|'stop'|'busy', missions}` : `missions` vaut toujours un nombre (0 pour `'stop'` et `'busy'`). `STOP` présent → `'stop'` sans rien toucher ; `watcher.lock` créé par `'wx'` (`{pid, since}`), un verrou de plus de 15 min ou dont le processus est mort repris par `takeOverStaleLock` (`core/mission-lock.js`), sinon `'busy'` ; bascule `watcher.log` vers `watcher.log.1` au-delà de 1048576 octets ; `tendMission` pour chaque mission de `listMissions()`, chacune dans un `try/catch` (`error observe <mission>: <message>`) ; dans un `finally`, retire `watcher.lock` seulement s'il porte encore notre `pid` et notre `since`. `missions` = nombre de missions à veiller (ni finies ni en arrêt).
- `core/watch-log.js` : `watchLog(mission, action, detail)` : ajoute la ligne (`fs.appendFileSync` sous `withWindowsRetry`) ; ne lève jamais. Module à part, qui ne charge que `core/paths.js` et `core/store.js` : `core/missions.js` s'en sert (Task 8) sans dépendance circulaire avec `core/watcher.js`.
- `core/cli.js` : `relaylead watcher run [--mission <nom>]` (refusé dans une session : `refuseInSession('watcher', io)`) : sans `--mission`, `runPass()` ; avec, `STOP` vérifié puis `tendMission(nom)` seul, sans le verrou de passage. Imprime les lignes ajoutées au journal par ce passage. `--mission` inconnue → `mission-unknown`. Aide : `watcher   watch the missions: restart, wake and relieve their leads` / `watcher   veiller sur les missions : relancer, réveiller et relever leurs leads`.
- Messages (en / fr) :
  - `watcherStopPresent` : « STOP is present in {home}: the watcher does nothing until it is removed\n » / « STOP est présent dans {home} : le veilleur ne fait rien tant qu'il n'est pas retiré\n » ;
  - `watcherBusy` : « another watcher pass is running (process {pid}, since {since}); nothing done\n » / « un autre passage du veilleur est en cours (processus {pid}, depuis {since}) ; rien n'est fait\n ».

- [ ] **Étape 1 : tests qui échouent** :
  - règles (`test/watcher-rules.test.js`, observations construites à la main) :
    - `a lead waiting for an input is never stopped` : lead `waiting`, `done` ou `working` et `idle`, sur dix observations à 5 min d'écart → aucune action `stop-session` sur lui ;
    - `a second lead session with a process is stopped, not the current one` ;
    - `a crew session whose task no longer runs it is stopped` (tâche `done`, `delivered`, autre session, ou aucune tâche : `task -`) ; un équipier dont la tâche tourne ne l'est pas ;
    - `no crew is stopped when the tasks cannot be read` : `tasks: null` → aucune action sur les équipiers, une ligne `tasks-failed` ;
    - `a session failure is logged once, whether the session is registered or not` ;
    - `a silent working lead is logged once after 30 min, never stopped` ;
    - `a lead working without a process is restarting during the grace, then absent` ; même chose pour un lead absent de la liste ; `an unlisted lead with a recent heartbeat is restarting, not absent` ;
    - `a failed list applies no session rule` ;
  - intégration (`test/watcher.test.js`, faux agent) :
    - `watcher run does nothing while STOP is present` : un lead de trop reste vivant, la sortie dit `watcherStopPresent` ;
    - `a pass skips finished, stopping and launching missions` ;
    - `a pass stops an extra lead and logs it` : une session du faux agent enregistrée sous `demo/lead/9` finit, le journal porte `stop-extra-lead` ;
    - `a held pass lock is reported and nothing is done` : `watcher.lock` à notre PID → `watcherBusy`, code 0 ;
    - `a pass lock of a dead process or older than 15 min is taken over` (PID mort : 2147483646) ;
    - `a pass does not remove the lock of the pass that took it over` ;
    - `watcher.log moves to watcher.log.1 past 1 MiB` ;
    - `a mission that cannot be read does not hide the next ones` : `mission.json` invalide dans `bad`, lead de trop dans `good` → arrêté, ligne `error observe bad` ;
    - `a pass for a mission removed or replaced meanwhile does nothing` : `observe` remplacée par une fonction qui rend une observation avec un lead de trop et un `createdAt` ancien → aucune session arrêtée, aucun `watch.json` écrit ;
    - `the lead is read idle only on two idle reads` : `list` remplacée (`working` + `idle`, puis `working` occupé) → `leadIdleConfirmed` faux.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): passage, verrou, STOP et journal ; un seul lead`.

### Task 7 : boucle du veilleur, lancée par `launch`

Sections de référence appliquées : « Fichiers d'état du lot » (lignes `watcher-loop.json` et `watcher-loop.stop`), « Réglages du lot » (`watcher`).

**Files :** créer `core/detached.js`, `test/watcher-loop.test.js` ; modifier `core/watcher.js`, `core/missions.js` (`spawnReaper`, qui garde `createdAt` dans ses arguments), `core/cli.js`, `core/config.js`, `core/messages.js`, `fixtures/run-tests.js`, `fixtures/helpers.js`, `test/missions.test.js`, `README.md`.

Lancement explicite du veilleur, à la place de launchd jusqu'au lot 4 : une boucle détachée qui passe toutes les `watcher.everySeconds` secondes, lancée par `relaylead launch` et finie d'elle-même quand plus aucune mission n'a besoin d'elle. Elle vient avant les réveils (Task 9) : dès que le lead peut finir son tour, un réveil manqué doit être rattrapé.

**Interfaces :**
- `core/detached.js` : `spawnDetached(args) -> Promise<number>` : lance `node bin/relaylead.js …args`, détaché, `stdio: 'ignore'`, `windowsHide`, avec l'env courant **sans** `RELAYLEAD_MISSION`, `RELAYLEAD_TASK`, `RELAYLEAD_ATTEMPT`, `RELAYLEAD_ROLE`, `RELAYLEAD_SESSION` ; attend l'événement `spawn`, `unref`, rend le PID. `spawnReaper` l'utilise.
- `core/config.js` : `DEFAULTS.watcher = {autoStart: true, helpers: true, everySeconds: 300}` ; `watcherSettings() -> {autoStart, helpers, everySeconds}` lit la configuration machine et applique `RELAYLEAD_WATCHER=off` ; `everySeconds` entier d'au moins 1, sinon 300.
- `fixtures/run-tests.js` : `RELAYLEAD_WATCHER=off` dans l'env du lanceur ; `fixtures/helpers.js` la pose aussi à son chargement si elle n'est pas définie, pour qu'un fichier de test lancé seul (`node --test test/missions.test.js`) ne démarre aucune boucle.
- `core/watcher.js` :
  - `loop()` (`relaylead watcher loop`, interne, absent de l'aide) : écrit `watcher-loop.json` avec son jeton (`pid`, `startedAt`) et la `version` de `package.json` ; une minuterie indépendante des passages réécrit `beatAt` toutes les 30 s ; enchaîne `runPass()` (dans un `try/catch` : `error pass: <message>`), écrit `lastPassAt`, puis attend `everySeconds` par pas d'une seconde. À chaque pas, elle sort si `watcher-loop.json` nomme un autre jeton, si `watcher-loop.stop` existe (elle ne le retire pas), ou si la `version` de `package.json` a changé. Après un passage `outcome === 'done'` et `missions === 0`, elle retire `watcher-loop.json`, relit `listMissions()` : s'il reste une mission à veiller, elle réécrit son fichier et continue, sinon elle sort. En sortant, elle retire `watcher-loop.json` s'il porte son jeton.
  - `watcherRunning() -> {running, since, lastPassAt}` : en marche si `beatAt` a moins de 90 s. Jamais de jugement par PID.
  - `startWatcher({unlessStopped} = {}) -> 'started'|'already'|'nothing'|'stopped-by-user'` : avec `unlessStopped` (passages ciblés), `'stopped-by-user'` tant que `watcher-loop.stop` existe, sans rien lancer ; `'already'` si en marche ; `'nothing'` si aucune mission à veiller ; sinon retire `watcher-loop.stop`, `spawnDetached(['watcher', 'loop'])`, puis attend (5 s au plus) que `watcher-loop.json` paraisse. Deux démarrages simultanés laissent une boucle : la dernière écrite gagne, l'autre sort à son pas suivant.
  - `stopWatcher() -> 'stopped'|'requested'|'not-running'` : écrit `watcher-loop.stop`, attend 10 s au plus que `watcher-loop.json` disparaisse et rend `'stopped'`, sinon `'requested'` (un passage long est en cours : la boucle sort à la fin de ce passage). Dans les deux cas, `watcher-loop.stop` **reste** : un arrêt demandé tient jusqu'au prochain `watcher start` ou `launch`, et aucun passage ciblé ne relance la boucle d'ici là.
- `core/cli.js` : `relaylead watcher start|stop|status` (refusés dans une session) ; `relaylead launch`, après avoir imprimé le nom sur la sortie standard, appelle `startWatcher()` si `autoStart` et écrit `watcherStarted` (lancée) ou rien (déjà en marche) **sur la sortie d'erreur** ; un échec écrit `watcherNotStarted` sur la sortie d'erreur, le code reste 0.
- Messages (en / fr) :
  - `watcherStarted` : « watcher started: it checks the missions every {seconds} s and ends once none needs it\n » / « veilleur lancé : il passe sur les missions toutes les {seconds} s et s'arrête quand aucune n'en a besoin\n » ;
  - `watcherAlreadyRunning` : « the watcher is already running (since {since})\n » / « le veilleur tourne déjà (depuis {since})\n » ;
  - `watcherNothingToWatch` : « no mission to watch; the watcher was not started\n » / « aucune mission à veiller ; le veilleur n'a pas été lancé\n » ;
  - `watcherStopped` : « watcher stopped\n » / « veilleur arrêté\n » ;
  - `watcherStopRequested` : « the watcher stops once its current pass is over\n » / « le veilleur s'arrête à la fin de son passage en cours\n » ;
  - `watcherNotRunning` : « the watcher is not running\n » / « le veilleur ne tourne pas\n » ;
  - `watcherStatusRunning` : « watcher running since {since}; last pass {lastPass}\n » / « veilleur en marche depuis {since} ; dernier passage {lastPass}\n » ;
  - `watcherNotStarted` : « relaylead launch: the watcher could not be started ({detail}); start it with: relaylead watcher start\n » / « relaylead launch : le veilleur n'a pas pu être lancé ({detail}) ; lancez-le avec : relaylead watcher start\n ».
- README (en, fr) : section « Continuity » / « Continuité » : le veilleur, ses commandes, `STOP`, `watcher.log`, `watcher.autoStart`, `watcher.helpers`, `watcher.everySeconds` ; un `relaylead watcher stop` tient jusqu'au prochain `watcher start` ou `launch` ; la boucle ne survit pas au redémarrage de la machine tant que `relaylead install` (lot 4) ne l'a pas confiée à launchd.

- [ ] **Étape 1 : tests qui échouent** (`test/watcher-loop.test.js`, `RELAYLEAD_WATCHER` retirée le temps du test, `everySeconds: 1`) :
  - `watcher start runs passes until stopped, and status says so` : `lastPassAt` avance ; `stop` → `watcherStopped`, plus de `watcher-loop.json`, `watcher-loop.stop` présent ;
  - `a stop holds until the next start` : après `stop`, `startWatcher({unlessStopped: true})` rend `'stopped-by-user'` et ne lance rien ; `start` relance ;
  - `a second start finds the watcher running` ;
  - `two loops started at once leave one` : deux `relaylead watcher loop` lancés ensemble → au bout de 3 s, un seul processus de boucle (le jeton du fichier), l'autre sorti ;
  - `stop leaves no loop running` (`everySeconds: 1`) : après `watcherStopped`, `watcher-loop.json` absent, et ni `watcher.log` ni la date d'un passage ne changent pendant 3 s (une mission tenue avec un lead de trop fait écrire une ligne à chaque passage) ;
  - `a stale stop file does not kill a new loop` : `watcher-loop.stop` laissé, puis `start` → la boucle passe au moins deux fois ;
  - `the loop ends by itself once no mission needs watching` : la mission passe `stopped`, la boucle sort ;
  - `the loop keeps running while STOP is present` ;
  - `start with no mission to watch starts nothing` ;
  - `a loop beat older than 90 s is not a running watcher` ;
  - `the loop ends when the package version changes` : `version` de `watcher-loop.json` réécrite à `0.0.0` par le test → la boucle sort ;
  - `launch starts the watcher when autoStart is on, says so on stderr, and not otherwise` (`test/missions.test.js`) : la sortie standard ne porte que le nom de la mission ; `relaylead watcher stop` dans `t.after`, pour ne laisser aucune boucle.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): boucle détachée lancée par launch, commandes start, stop et status`.

### Task 8 : identité du lead : nom réservé, lead actuel

Sections de référence appliquées : « Fichiers d'état du lot » (ligne `lead-launch.json`), « Règles du veilleur » › « Cumul » (définition du nom du lead actuel), « Textes envoyés aux sessions » (place des sections « ## Restart » et « ## Handover »).

**Files :** modifier `core/missions.js`, `core/tasks.js`, `core/wait.js`, `core/cli.js`, `core/messages.js`, `fixtures/helpers.js`, `test/missions.test.js`, `test/cli.test.js`, `test/wait.test.js`.

Les relances (Task 11) et les relèves (Task 12) lancent un second lead. Avant elles, deux garanties : un nom de lead n'est jamais porté par deux sessions, et un lead remplacé ne pilote plus la mission.

**Interfaces :**
- Environnement des sessions : `launchLead` passe `RELAYLEAD_ROLE: 'lead'` et `RELAYLEAD_SESSION: <nom>` ; `launchCrew` passe `RELAYLEAD_ROLE: 'crew'` et `RELAYLEAD_SESSION: <nom>`.
- `core/missions.js` :
  - `launchLead(mission, {section} = {}) -> Promise<Session>`, sorti de `createMission` (qui l'appelle sans `section`) : `n` = max(plus grand numéro des sessions du registre nommées `<mission>/lead/<k>`, `n` de `lead-launch.json`) + 1 ; écrit `lead-launch.json` = `{n, name: '<mission>/lead/<n>', at}` **avant** `adapter.launch` (sous le verrou de mission ; au premier lancement, `createMission` tient le verrou du dossier) ; si `adapter.launch` lève, réécrit `lead-launch.json` avec `failed: true` avant de relancer l'erreur ; consigne = `leadPrompt(method, mission, section)` où `section` est insérée avant « ## This mission » ; écrit `lead.json` et le registre. Un `err.orphan` levé par le lancement est journalisé (`watchLog(mission, 'orphan-session', shortId)`, `core/watch-log.js`) avant d'être relancé.
  - `currentLeadError(name, env) -> Error|null` : si `env.RELAYLEAD_ROLE === 'lead'`, le lead actuel est celui de `lead.json`, **ou** celui de `lead-launch.json` tant que son lancement est en cours (`failed` absent, et `lead.json` absent ou `at` postérieur à son `startedAt`) : `adapter.launch` ne rend qu'après le premier tour et le PID de la ligne (jusqu'à 30 s, une lecture de `claude agents` prenant jusqu'à 2 s sous charge), alors que le lead neuf lance déjà `state set working`. Un `RELAYLEAD_SESSION` qui n'est aucun des deux → `codedError('not-current-lead', {session, mission, current})`, `current` = `sessionName` de `lead.json`.
  - `launchWhileOpen(name, launch, stop) -> Promise<Session>` : relit l'état ; `stopped` ou `stopping` → `mission-stopped`, `done` → `mission-done`, sans rien lancer ; sinon `session = await launch()` (qui enregistre la session) ; relit l'état : devenu `stopped` ou `stopping` → `await stop(session)` puis `mission-stopped` ; rend `session`. `launchCrew` s'en sert à la place de sa relecture d'aujourd'hui (`core/tasks.js`), et les actions `relaunch-lead` (Task 11) et `hand-over` (Task 12) aussi.
- `fixtures/helpers.js` : `userEnv()` retire aussi `RELAYLEAD_ROLE` et `RELAYLEAD_SESSION` (une suite lancée depuis une session lead recevrait sinon `not-current-lead`). Un lead lancé avant ce lot (sans ces variables) n'est pas contrôlé.
- Contrôles :
  - `core/cli.js` : `state set`, `task start|retry|deliver`, `question ask` et `wait` appellent `currentLeadError` à l'entrée ;
  - `core/tasks.js` : `startTask`, `retryTask` et `deliverTask` reçoivent l'env de l'appelant (`{env}`) et refont le contrôle **sous** le verrou de mission : une commande qui attendait le verrou pendant une relève est refusée une fois le lead remplacé ;
  - `core/wait.js` : `waitForChanges(name, timeout, report, {env})` refait le contrôle à chaque tour de boucle ; un `wait` dont l'appelant n'est plus le lead actuel rend `not-current-lead` sans écrire l'instantané ni arrêter d'équipier.
- Erreur `not-current-lead` (en / fr) : « this session ({session}) is no longer the lead of mission "{mission}": {current} took over; end your turn » / « cette session ({session}) n'est plus le lead de la mission « {mission} » : {current} a pris le relais ; terminez votre tour ».

- [ ] **Étape 1 : tests qui échouent** :
  - `a launch stops the session it started when the mission was stopped meanwhile` : `launch` remplacée par une fonction qui écrit `{state: 'stopped', stopping: true}` puis rend une session → `stop` appelé avec elle, `mission-stopped` levée ; état déjà `stopped` → `launch` jamais appelée ;
  - `a lead name is never given twice, even when a launch left no record` : `lead-launch.json` `{n: 3}`, registre jusqu'à `lead/1` → le lead suivant s'appelle `demo/lead/4` ;
  - `the restart and handover sections come before the mission` : la consigne d'un `launchLead` avec section contient la section avant « ## This mission » ;
  - `a replaced lead can no longer drive the mission` (`test/cli.test.js`) : env `RELAYLEAD_ROLE=lead`, `RELAYLEAD_SESSION=demo/lead/1`, `lead.json` sur `demo/lead/2` → `state set working`, `task start a`, `question ask …` et `wait --timeout 0` rendent 1 avec `not-current-lead`, rien ne change (état, tâches, `wait-snapshot.json`) ; avec `demo/lead/2`, les quatre passent ;
  - `a new lead that runs its first command before lead.json names it is accepted` : `fake.launch` retardé de 1 s après le démarrage de l'agent ; le lead neuf (`demo/lead/2`) lance `state set working` pendant ce retard → accepté ; au premier lancement (`lead.json` absent) → accepté ;
  - `the lead of a launch that failed is refused` : `lead-launch.json` `{n: 2, name: 'demo/lead/2', failed: true}`, `lead.json` sur `demo/lead/1` → `demo/lead/2` reçoit `not-current-lead` ;
  - `a start queued behind a handover is refused once the lead is replaced` : le test tient le verrou de mission, lance `task start a` comme `demo/lead/1`, réécrit `lead.json` sur `demo/lead/2`, rend le verrou → `not-current-lead`, aucune session lancée ;
  - `a wait left running by a replaced lead stops without touching anything` : `wait --timeout 5` comme `demo/lead/1`, `lead.json` passé à `demo/lead/2` pendant l'attente → `not-current-lead` en moins de 2 s, instantané inchangé.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(missions): numéro de lead réservé, lead actuel seul à piloter la mission`.

### Task 9 : règles de réveil et équipiers perdus

Sections de référence appliquées : « Fichiers d'état du lot » (paragraphe `watch.json`) ; « Règles du veilleur » › « États du lead », « Cumul », « Table des règles » (règles 5, 11, 14 à 16) et « Garde du réveil » ; « Textes envoyés aux sessions » (réveil).

**Files :** modifier `core/wait.js`, `core/watcher-rules.js`, `core/watcher.js`, `test/watcher-rules.test.js`, `test/watcher.test.js`, `test/wait.test.js`.

Règles 5, 11 et 14 à 16 et la garde du réveil, éprouvées dans le veilleur seul ; la conduite du lead qui finit son tour vient à la Task 10.

**Interfaces :**
- `core/wait.js` : `look` est séparé en une vue pure et son application :
  - `viewOf(name, sessions, lostSince, now) -> {view, toFail: [{id, shortId, summary}], lostSince}` : aucune écriture ; mêmes règles qu'aujourd'hui (états de fin, grâce de 60 s, tâche relancée sans session) ;
  - `waitForChanges` applique `toFail` par `markFailed`, comme aujourd'hui, puis écrit l'instantané ;
  - `unseenChanges(name, sessions, lostSince, now) -> {changes, viewKey, toFail, lostSince}` : ce que rendrait le prochain `relaylead wait`, la vue comparée à l'instantané, sans rien écrire ; `viewKey` = `JSON.stringify` des états et des `attempt` des tâches et des états des questions, clés triées. Le veilleur lui passe `watch.crewLostSince` et range le `lostSince` rendu dans `watch.crewLostSince`.
- `observe` remplit `unseen` quel que soit l'état du lead (`viewOf` est pur ; le passage patient de la Task 10 en a besoin pour un lead actif) et `mail` (`unreadCount` pour chaque session listée) ; les règles décident.
- Actions :
  - `{type: 'mark-failed', id, summary}` → `markFailed` dans `act`, sous le verrou ;
  - `{type: 'wake-lead', reasons}` → `adapter.wake(session du lead, texte de réveil)` puis `recordSession` ; `decide` pose `lastWakeAt`, `lastLeadActionAt`, et `lastWakeView` (règle 14) ou `interruptWakeFor` (règle 16) dans le `watch` rendu ; si `adapter.wake` lève, `act` applique les effets d'un réveil sans effet (« Garde du réveil ») au `watch` qu'il écrit.
- Constantes : `RELAYLEAD_LEAD_QUIET_MS` (10000), `INEFFECTIVE_AFTER_MS = 5 * 60 * 1000`, `WAKE_BACKOFF_MS = [15, 30, 60]` minutes, `RELAYLEAD_RATE_LIMIT_HOLD_MS` (5 h), `INTERRUPT_SILENCE_MS = 11 * 60 * 1000`.

- [ ] **Étape 1 : tests qui échouent** :
  - règles : `an idle lead is woken for changes it has not seen, once per view` ; `a view that comes back after a retry wakes the lead again` (`attempt` dans la clé ; `lastWakeView` remis à `null` sur une vue sans changement) ; `an idle lead is woken for its mail` ; `an idle lead whose turn ended while working is woken once per state` (état `{state: 'working', updatedAt}`, battement `(stop)`) ; `a lead without a state yet is keyed on its start` (`record` sans `updatedAt`, clé `lead.startedAt`) ; `a lead whose last heartbeat is recent and not a stop is not woken for an interrupted turn` ; `a lead that never beat is aged from its start` ; `an idle lead with nothing new is left alone pass after pass` (état `waiting`, vue déjà réveillée, dix observations → aucune action) ; `an absent lead of a waiting mission is left alone, then woken by a change` ; `a rate-limited idle lead is neither woken nor handed over, until the hold expires` (5 h, contexte au-dessus du seuil souple et changement non vu) ; `no wake within 10 s of a lead action` ; `no second wake while the first one is not judged` ; `a wake that throws is tried again` (après l'espacement, `lastWakeView` remis à `null`) ; `a wake for a change that had no effect is tried again after the backoff` ; `a heartbeat after lead-stuck allows wakes again` ; `wakes without effect back off, then the lead is reported stuck` (15 min, 30 min, 1 h, puis `lead-stuck` une fois, dans les deux journaux) ; `a heartbeat after a wake resets the backoff` ; `an active lead is never woken` ; `a crew lost while the lead is idle fails its task and wakes the lead` (règle 5 puis règle 14 au passage suivant) ; `the rules table` complétée ;
  - `viewOf writes nothing and unseenChanges reports what the next wait would` (`test/wait.test.js`) ;
  - `observe writes nothing` (`test/watcher.test.js`, déplacé ici depuis la Task 6, une fois `unseen` rempli) : après `observe` sur une mission avec un équipier perdu au-delà de la grâce et une liste qui échoue, aucun fichier de la mission ni `watcher.log` n'a changé (`mtime`) ; `wait still fails a lost crew after its grace` (existant, inchangé) ;
  - `two targeted passes at once wake the lead once` (`test/watcher.test.js`) : projet de `setupProject` plus une tâche `c` sans dépendance ; `state.json` = `{state: 'waiting'}` ; lead du faux agent inactif (rôle `lead`, `RELAYLEAD_FAKE_END_FIRST_TURN=1`, inscrit dans `lead.json`) ; `a` et `c` lancées par `startTask` (le test joue le lead) et finies par leurs équipiers ; deux `relaylead watcher run --mission demo` lancés ensemble → une seule ligne `woken:` dans le journal du lead, une seule ligne `wake-lead`, et `watch.json` montre que le second passage a vu le lead (`lastLeadActionAt` posé, aucune seconde action).
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): réveil du lead inactif et équipiers perdus`.

### Task 10 : le lead finit son tour, les passages ciblés le réveillent

Sections de référence appliquées : « Règles du veilleur » › « Garde du réveil » (silence) ; « Textes envoyés aux sessions » (réveil).

**Files :** créer `test/e2e/continuity.test.js` ; modifier `core/cli.js`, `core/watcher.js`, `catalog/profiles/lead.md`, `catalog/methods/code.md`, `adapters/fake/agent.js`, `test/e2e/fake-mission.test.js`, `test/cli.test.js`, `test/catalog.test.js`, `README.md`.

Aujourd'hui, le lead attend par `relaylead wait --timeout 540` en boucle, même pendant les heures où seule une réponse humaine peut faire avancer la mission : chaque retour de `wait` relit tout son contexte. Désormais il attend par `wait` tant qu'une tâche tourne, et finit son tour quand rien ne tourne. Le réveil part tout de suite après la fin d'un équipier ou une réponse, par un passage ciblé ; la boucle (Task 7) rattrape le reste.

**Interfaces :**
- **Passages ciblés** : quand `watcherSettings().helpers` est vrai, `relaylead task done|fail` (après l'écriture du résultat) et `relaylead answer` appellent `detached.spawnDetached(['watcher', 'run', '--mission', <mission>])`, par l'objet du module (remplaçable par les tests) ; un échec du lancement est ignoré.
- `tendMission(name, {patient})` : `watcher run --mission` passe `patient: true`. Un passage patient qui trouve le lead **actif** alors qu'il existe des changements non vus ou du courrier pour lui, **ou** un réveil retenu par le silence de la garde, ré-observe toutes les `RELAYLEAD_HELPER_RECHECK_MS` (5000) ms, pendant au plus `RELAYLEAD_HELPER_PATIENCE_MS` (60000) ms, sans tenir le verrou entre deux lectures : une réponse qui tombe pendant que le lead finit son tour le réveille dans les secondes qui suivent. Un passage ciblé appelle aussi `startWatcher({unlessStopped: true})` si `autoStart` : il relance une boucle morte, jamais une boucle que l'utilisateur a arrêtée.
- Consignes (anglais) :
  - `code.md`, étape 6 : « If no task is running and nothing can move until the user answers: run `relaylead state set waiting --note "<what you wait for>"`, then `relaylead wait --timeout 0`. If it lists changes, go back to step 2; otherwise end your turn: Relaylead wakes you when something changes. While a task is running, run `relaylead wait --timeout 540` instead (on an empty list, run it again). » ;
  - `lead.md` : section « Being woken » : Relaylead peut réveiller, reprendre ou remplacer la session ; un message « Relaylead woke you » ou « Relaylead restarted you » se suit tel quel ; rien de ce qui précède n'est sûr, les fichiers font foi : commencer par `relaylead task list` ; l'erreur `not-current-lead` veut dire : finir son tour sans autre commande. La commande `wait` documente `--timeout 0`.
- Faux lead : quand aucune tâche ne tourne et que tout n'est pas réglé → `state set waiting --note "fake: waiting for answers"`, `wait --timeout 0`, puis `endTurn()` si la liste est vide. Avec `RELAYLEAD_FAKE_LEAD_ENDS_TURN=1`, il fait de même au lieu de `wait --timeout 5` quand des tâches tournent (`--note "fake: waiting for crew"`). Une erreur `not-current-lead` le fait finir son tour.
- Faux équipier : avec `RELAYLEAD_FAKE_CREW_GATE` (un **dossier**), il attend que `<dossier>/<id de sa tâche>` existe avant de travailler, en lisant son courrier toutes les 50 ms.
- `test/e2e/fake-mission.test.js` : `RELAYLEAD_WATCHER` retirée le temps du test, configuration machine `watcher: {autoStart: false}` (sa question répondue réveille le lead par un passage ciblé) ; le test ne répond qu'une fois le lead lu `waiting` et `idle` par `fake.list`.
- README (en, fr) : le lead finit son tour quand il n'attend que vous ; une réponse le réveille ; débloquer à la main un lead signalé `lead-stuck` : `relaylead show <mission>` puis lui écrire.

- [ ] **Étape 1 : tests qui échouent** :
  - `task done and answer start a targeted pass only when helpers are on` (`test/cli.test.js`, `spawnDetached` remplacé ; avec `RELAYLEAD_WATCHER=off` → aucun appel) ;
  - `a targeted pass waits for a lead still finishing its turn` (`test/watcher.test.js`) : lead actif (`list` remplacée) avec une question répondue non vue, puis inactif 2 s plus tard, `RELAYLEAD_HELPER_RECHECK_MS=200` → un `wake-lead` ;
  - `a targeted pass waits out the quiet time` : `lastLeadActionAt` il y a 1 s, `RELAYLEAD_LEAD_QUIET_MS=3000`, lead inactif avec un changement non vu → le passage patient réveille une fois le silence passé ;
  - `a targeted pass does not restart a watcher the user stopped` ;
  - `the lead method ends the turn only when no task runs` (`test/catalog.test.js`) : `code.md` nomme `relaylead wait --timeout 0` et « end your turn » ; `lead.md` nomme `not-current-lead` ;
  - `an idle lead is woken when a crew member finishes` (`test/e2e/continuity.test.js`, dépôt jouet, `RELAYLEAD_WATCHER` retirée, `watcher: {autoStart: false}`, `RELAYLEAD_FAKE_LEAD_ENDS_TURN=1`, `RELAYLEAD_FAKE_CREW_GATE`, `RELAYLEAD_LEAD_QUIET_MS=300`, aucun passage complet) : le test crée `<barrière>/a` une fois le lead lu `waiting` + `idle` ; répond à la question de `b` une fois le lead de nouveau inactif ; puis crée `<barrière>/b` une fois le lead encore inactif ; la mission finit `done` ; le journal du lead compte exactement trois `woken:` (fin de `a`, réponse, fin de `b`) ; chaque tâche a `attempt` 1 et une seule session d'équipier ;
  - `fake mission delivers two tasks with one answered question` (existant) reste vert avec la nouvelle conduite du faux lead.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): le lead finit son tour, un passage ciblé le réveille`.

### Task 11 : relance du lead absent et disjoncteur

Sections de référence appliquées : « Réglages du lot » (seuil souple, pour choisir la reprise) ; « Règles du veilleur » › « États du lead », « Cumul », « Table des règles » (règles 1, 8 et 10) et « Décompte du disjoncteur » ; « Textes envoyés aux sessions » (reprise d'un lead absent, section « ## Restart »).

**Files :** modifier `core/missions.js`, `core/watcher-rules.js`, `core/watcher.js`, `test/watcher-rules.test.js`, `test/watcher.test.js`, `test/missions.test.js`, `test/e2e/continuity.test.js`, `README.md`.

Règles 8 et 10, et le décompte du disjoncteur. Le démon de Claude relance seul un lead tué (`kill -9`, fait mesuré 4) ; il ne relance ni une session arrêtée, ni rien après un redémarrage : c'est le veilleur qui le fait, en reprenant la même session si son contexte est bas, sinon par une session neuve. La relance par le démon rejoue la commande interrompue : les actions du lead restent idempotentes.

**Interfaces :**
- `core/missions.js` : `stopMission(name, {note} = {})` : `note` va dans l'état `stopped` écrit par le cœur.
- `relaunch-lead` (`act`) : `{type: 'relaunch-lead', resume}` ; pose `lastRelaunchAt` et `lastLeadActionAt` au début ; tout se fait dans `launchWhileOpen(name, launch, stop)` (Task 8), avec `stop` = `(session) => stopSessionsAndWait(mission, [session])` ; `launch` : `resume` vrai → `adapter.wake(ancienne session, texte de reprise)` puis `recordSession` ; s'il lève, ou `resume` faux → `launchLead(mission, {section: <section « Restart »>})`. `mission-stopped` ou `mission-done` levées par `launchWhileOpen` → rien de plus, sans compter pour le disjoncteur. Réussite : `leadLostSince` = `null`. Échec des deux : `failedRelaunches` + 1, `lastFailedRelaunchAt` = maintenant, `lastRelaunchAt` = `null`, ligne `error relaunch-lead: <message>`. `resume` vaut vrai quand `contextOf(…, {active: false})` est connu et sous `soft`.
- `trip-breaker` : après la sortie du verrou de mission (`stopMission` le prend lui-même) ; `decide` a posé `watch.tripped = true` ; `missions.stopMission(name, {note: 'stopped by the watcher: the lead could not be restarted 3 times in a row'})`, appelé par l'objet du module (remplaçable par le test `a breaker stop that fails is replayed`), `writeJournal(name, 'watcher', <même texte>)`, journal du veilleur. Si `stopMission` lève (`stop-pending`…), la règle 1 le rejoue au passage suivant tant que `tripped` et `stopping` tiennent. Les canaux d'alerte viennent au lot 3.

- [ ] **Étape 1 : tests qui échouent** :
  - règles : `an absent lead is resumed when its context is known and low` ; `an absent lead is relaunched as a new session when its context is high or unknown` ; `an old context of a dead lead still allows a resume` ; `a lead restarting by itself is not relaunched during the grace` ; `a lead that came back by itself gets a full grace the next time` ; `a relaunch counts as failed when the lead is absent again with no heartbeat since` ; `a heartbeat after the relaunch resets the count and the relaunch time` ; `two observations of one pass count once` ; `the breaker trips after 3 failed relaunches in a row, before a handover` ; `a lead back by itself clears the failed relaunches` (battement postérieur à `lastFailedRelaunchAt`) ; `the breaker never trips while the lead restarts` (compte à 3, lead `working` sans PID dans la grâce → aucune action) ; `a lead absent after a stale handover request is relaunched` (état `handover`, `by` = ancien lead) ; `the rules table` complétée ;
  - intégration (ces tests fixent `RELAYLEAD_RESTART_GRACE_MS=300` : un lead `working` sans processus ou absent de la liste reste sinon « en relance » 2 min ; un faux lead tué, listé `failed`, est absent tout de suite) :
    - `a failed resume falls back to a new lead session in the same pass` : `fake.wake` qui lève → `lead.json` nomme `demo/lead/2`, sa consigne porte « ## Restart » avant « ## This mission » ;
    - `a relaunch that throws counts once` : `fake.wake` et `fake.launch` qui lèvent → `failedRelaunches` 1 et `lastRelaunchAt` `null` ; un second passage → 2 ;
    - `the breaker stops the mission and says why` : `watch.json` à `failedRelaunches: 2`, `lastRelaunchAt` ancien, lead absent sans battement depuis → état `stopped` avec la note, ligne dans `journal.log` et `breaker-tripped` ;
    - `a breaker stop that fails is replayed` : `stopMission` remplacé une fois par une fonction qui lève `stop-pending` → au passage suivant, la mission finit `stopped` sans marqueur ;
    - `a lead restarted by its agent after the watcher relaunched it is stopped as an extra lead` : lead `working` sans processus au-delà de la grâce (`list` remplacée) → `demo/lead/2` lancé ; puis l'ancien listé avec un processus → passage suivant : `stop-extra-lead` ;
    - `a stop during a relaunch leaves no lead running` : `RELAYLEAD_START_LOCK_WAIT_MS=300`, `fake.launch` retardé de 1 s ; `relaylead stop` lancé pendant la relance (il abandonne en `stop-pending`) → la relance voit `stopping` après `recordSession` et arrête le lead lancé ; un second `relaylead stop` rend 0 ; aucune session de la mission vivante ;
  - `a lead killed in the middle of a mission is resumed and the mission ends without loss` (`test/e2e/continuity.test.js`) : dépôt jouet, `RELAYLEAD_WATCHER` retirée, `watcher: {autoStart: false}`, `RELAYLEAD_RESTART_GRACE_MS=300`, `RELAYLEAD_LEAD_QUIET_MS=300` ; dès que `a` tourne, `killSession(lead)` ; `relaylead watcher run` lancé toutes les secondes jusqu'à la relance ; répondre à `q-b` une fois le lead lu inactif, par l'assistant de `test/e2e/continuity.test.js` écrit à la Task 10 ; la mission finit `done` ; `lead.json` nomme toujours `…/lead/1` (reprise) ; chaque tâche a `attempt` 1, une seule session d'équipier par tâche, `a.txt` et `b.txt` livrés une fois.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): relance du lead absent et disjoncteur`.

### Task 12 : relève du lead, contexte plein d'un équipier

Sections de référence appliquées : « Réglages du lot » (seuils) ; « Règles du veilleur » › « Cumul », « Table des règles » (règles 9, 12, 13, 17 à 19) et « Décompte du disjoncteur » ; « Textes envoyés aux sessions » (section « ## Handover » et ses variantes, avis de relève, contexte plein d'un équipier).

**Files :** modifier `core/missions.js`, `core/cli.js`, `core/messages.js`, `core/watcher-rules.js`, `core/watcher.js`, `catalog/profiles/lead.md`, `catalog/profiles/developer.md`, `catalog/methods/code.md`, `adapters/fake/agent.js`, `test/watcher-rules.test.js`, `test/watcher.test.js`, `test/cli.test.js`, `test/catalog.test.js`, `test/e2e/continuity.test.js`, `README.md`.

Règles 9, 12, 13, 17 à 19, d'après la spec (« Cycle de vie », 3) : au seuil souple, le lead actif finit son étape, écrit `handover` et finit son tour ; le veilleur arrête l'ancien et lance le suivant dans le même passage. Au seuil dur pour un lead actif, ou pour un lead inactif au-dessus du seuil souple qui serait réveillé, la relève se fait sans lui ; un lead inactif sans motif de réveil reste en paix, même au seuil dur. Un équipier au seuil dur commite, échoue avec « context full » et le lead relance la tâche.

**Interfaces :**
- `core/missions.js` : `STATES` = `['starting', 'working', 'waiting', 'handover', 'done']` ; `setState(name, state, note, {by} = {})` écrit `by` dans `state.json` pour `handover` (`by` = `RELAYLEAD_SESSION` de l'appelant, sinon `'user'`) ; la note d'un `handover` est ramenée à une ligne de 500 caractères au plus.
- `core/cli.js` : `state set handover` lance un passage ciblé (`spawnDetached`, si `helpers`).
- `hand-over` (`act`) : `{type: 'hand-over', reason: 'asked'|'forced'|'idle', note, tokens}` ; pose `lastRelaunchAt` et `lastLeadActionAt` au début ; relit l'état (fini, `stopped` ou `stopping` → rien) ; `stopSessionsAndWait(mission, [ancien lead])` s'il a un processus (un échec : action levée) ; `writeState` `{state: 'starting', note: 'taken over from <ancien>: <note ou « forced at <tokens> tokens » ou « idle past the soft threshold »>'}` **avant** le lancement (le lead neuf agit avant que `launch` rende la main, Task 8 : écrit après, `starting` écraserait son `working`) ; puis `launchWhileOpen(name, () => launchLead(mission, {section: <section « Handover »>}), stop)` (Task 8), qui arrête le lead lancé si un arrêt est venu entre-temps ; `mission-stopped` levée → rien de plus, l'état d'arrêt reste ; `handoverNoticeFor` = `null`. Une relève qui lève autrement compte pour le disjoncteur : `failedRelaunches` + 1, `lastFailedRelaunchAt` = maintenant, `lastRelaunchAt` = `null`.
- `mail` (`act`) : `{type: 'mail', shortId, text, log}` → `sendMail`.
- `bad-state` liste `handover`.
- Consignes : `lead.md` : section « Handing over » (sur l'avis de relève : finir l'étape, `relaylead state set handover --note "…"`, finir son tour ; la note dit où en est la mission en une ligne). `developer.md` : sur le message « context full » : commiter ce qui est fait, `relaylead task fail <id> --summary "context full: …"`, finir son tour.
- Faux agent : un lead qui reçoit un message contenant `relaylead state set handover` lance `relaylead state set handover --note "fake handover"` puis `endTurn()` ; un équipier qui reçoit `relaylead task fail` (pendant son attente de la barrière, Task 10, ou après une commande) lance `relaylead task fail <id> --summary "context full: fake"` et s'arrête.
- README (en, fr) : relève, réglage `context` (budgets par rôle, plafond, marge dure), exemple de seuil forcé bas dans `.relaylead.json`.

- [ ] **Étape 1 : tests qui échouent** :
  - règles : `a handover asked by the current lead or the user hands over` ; `a handover asked by a replaced lead is ignored` ; `an active lead past the hard threshold is handed over without its note` ; `an idle lead past the hard threshold with nothing to wake for is left alone` ; `an idle lead past the soft threshold is handed over instead of woken` ; `an idle lead past the soft threshold with nothing to wake for is left alone` ; `an active lead past the soft threshold gets one notice` ; `a stale reading of an active lead triggers nothing` ; `a high base is logged once` ; `a crew member past the hard threshold gets one context-full mail, only with a measured window` ; `a hard handover and a wake never come in the same pass` ; `the rules table` complétée ;
  - intégration :
    - `a handover writes starting before the new lead runs` : le faux lead neuf lance `state set working` dès son démarrage → l'état final vaut `working`, pas `starting` ;
    - `a handover stops the old lead, starts the next one and writes starting` : `lead.json` → `demo/lead/2`, consigne avec « ## Handover » et la note avant « ## This mission », ancien lead fini ; `fake.launch` remplacé par une fonction qui relit `state.json` avant d'appeler l'original : il y lit `{state: 'starting', note: 'taken over from demo/lead/1: <note>'}` ;
    - `a failed handover counts towards the breaker` : `fake.launch` qui lève → `failedRelaunches` 1, état toujours `handover` ;
    - `a stop during a handover is not erased` : même montage que `a stop during a relaunch…` → état final `stopped`, jamais `starting`, aucun lead vivant après le second `stop` ;
    - `a crew told its context is full fails its task and the lead retries it` : faux équipier derrière la barrière ; deux appels à `recordStatusline` pour sa session, fenêtre 100000 (plafond 40000, `hard` 48000) : 30000 (la base), puis 50000 → `notify-context-full`, la tâche passe `failed` (« context full: fake »), puis `task retry` par le test : tentative 2 lancée ;
  - `state set handover records who asked and starts a targeted pass` (`test/cli.test.js`) ; `a handover note is cut to one line of 500 characters` ;
  - `the lead and developer profiles say how to hand over` (`test/catalog.test.js`) ;
  - `a lead past a low threshold hands over and the mission ends without loss` (`test/e2e/continuity.test.js`) : dépôt jouet, `.relaylead.json` `{"context": {"budgets": {"lead": 6000}}}`, `RELAYLEAD_FAKE_TOKENS_PER_COMMAND=1000`, `RELAYLEAD_LEAD_QUIET_MS=300`, `RELAYLEAD_RESTART_GRACE_MS=300`, `relaylead watcher run` toutes les secondes ; répondre à `q-b` une fois le lead lu inactif, par l'assistant de la Task 10 ; la mission finit `done` ; au moins `…/lead/2` dans le registre, chaque ancien lead fini ; chaque tâche a `attempt` 1 et une seule session d'équipier ; les deux tâches livrées une fois.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts ; `npm test` complet sur les trois systèmes par la CI.
- [ ] **Étape 5 :** commit `feat(veilleur): relève du lead au seuil de contexte, contexte plein d'un équipier`.

### Task 13 (humain) : la continuité essayée avec Claude Code sur macOS

Sections de référence appliquées : « Faits mesurés ».

**Files :** créer `docs/manual-checks/lot-2a-claude-macos.md` (procédure et relevé, même forme que ceux des lots 1 et 1.1).

Couvre le « Terminé quand » du lot sous macOS, à la place de Linux : lead tué en pleine mission, relève à seuil forcé bas, lead inactif réveillé à la fin d'un équipier ; survie d'un équipier, relance par le démon après `kill -9`, hooks `Stop` et `StopFailure`. Les mesures préalables (« Faits mesurés ») ont déjà levé les doutes sur la ligne après `stop`, le `status` pendant un tour, la barre d'état et l'id court ; restent ici les deux mesures qu'elles n'ont pas faites (survie d'un passage ciblé, durée de vie d'un lead inactif). Tout se fait dans un `RELAYLEAD_HOME` jetable ; missions et sessions sont nommées `rl-2a-…`, arrêtées et supprimées à la fin.

- [ ] **Étape 1 : préparation.** `npm link` depuis `main` après la Task 12 ; relever `claude --version` et `relaylead --version`. `export RELAYLEAD_HOME=<dossier temporaire neuf>/home` et y écrire `config.json` = `{"watcher": {"everySeconds": 60}}`. Noter l'empreinte (`shasum`) de `~/.claude/settings.json` et la liste de `~/.relaylead`. Pour chaque scénario, copier `fixtures/toy-repo/` dans un dossier temporaire neuf nommé comme la mission, `git init -b main`, tout commiter, lancer `claude` une fois et choisir « Yes, I trust this folder » (l'option par défaut est « No, exit »).
- [ ] **Étape 2 : lead tué (`rl-2a-kill`).** `relaylead launch --agent claude --name rl-2a-kill --request "Do the tasks in tasks/"` ; la sortie d'erreur dit `watcher started` ; `relaylead watcher status` → en marche. Dès que `a` tourne (`relaylead task list --mission rl-2a-kill`), `kill -9` du PID du lead (lu dans `claude agents --json`). Relever : relance par le démon (délai, même id, nouveau PID), ligne `lead-restarting` éventuelle, aucun lead de trop ; l'équipier de `a` continue (survie d'un équipier). Puis `claude stop <id court du lead>` : relever la ligne `relaunch-lead … resumed` ou `as …` au premier passage après la grâce (jusqu'à 2 min de grâce plus 60 s entre deux passages) et le texte de reprise (`claude logs`). Répondre à la question de `b` ; attendre `done`. Vérifier : chaque `tasks/<id>.json` à `attempt` 1, une session d'équipier par tâche, les deux tâches livrées une fois, `npm test` vert sur l'intégration.
- [ ] **Étape 3 : relève (`rl-2a-relay`).** Commiter `.relaylead.json` = `{"context": {"budgets": {"lead": 20000}}}` ; lancer. Relever : `context/<id>.json` (fenêtre, base) et `heartbeats/<id>.json` écrits ; ligne `notify-handover`, puis `state set handover` par le lead, ligne `hand-over … to rl-2a-relay/lead/2`, ancien lead arrêté, nouveau lead parti de « ## Handover » ; la mission finit `done` sans tâche refaite (mêmes vérifications qu'à l'étape 2).
- [ ] **Étape 4 : lead inactif réveillé (`rl-2a-wake`).** Lancer. Dès que `a` tourne, `claude respawn <id court du lead>` (comme après une mise à jour de Claude Code en pleine mission) : relever que le lead redevient `done`/`idle` (inactif) pendant que l'équipier travaille. À la fin de l'équipier, relever la ligne `wake-lead …: task a is now done`, la sortie « woke session <même id> », puis la livraison de `a`. **Mesure : survie d'un passage ciblé** : le lead étant inactif, le passage ciblé lancé par le `task done` de l'équipier doit écrire `stop-orphan-crew <cet équipier>` puis `wake-lead` : relever que la seconde ligne suit bien l'arrêt de l'équipier dont le Bash l'a lancé (heures comparées à celles de `claude agents`), et, si ce passage a relancé la boucle, qu'elle tourne encore après cet arrêt (`relaylead watcher status`). Quand le lead attend la réponse de `b` (état `waiting`, tour fini, battement `(stop)` = hook `Stop`), laisser passer deux passages sans réveil. **Mesure : durée de vie d'un lead inactif** : laisser le lead ainsi une heure, relever toutes les 5 min s'il garde son processus (`claude agents --json`) et si le veilleur reste silencieux. Jouer l'étape 5 à ce moment-là, puis répondre : relever le réveil et la fin `done`.
- [ ] **Étape 5 : `StopFailure`** (pendant que `rl-2a-wake` attend sa réponse). `node fixtures/fake-429.js` → port. Copier le fichier de réglages d'une session de `rl-2a-wake` (`missions/rl-2a-wake/settings/…json`) vers un fichier temporaire, y ajouter `"ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>"` dans `env`, puis, dans le dossier de `rl-2a-wake` : `claude --bg --name rl-2a-limit --settings <fichier> --setting-sources project,local --strict-mcp-config "Reply OK."`. Relever `failures/<id court>.json` (`error: rate_limit`, message avec l'heure de reprise) et la ligne `session-failure` du passage suivant (la règle 4 lit tout le dossier `failures/`). `claude stop` puis `claude rm` de `rl-2a-limit` ; arrêter le faux serveur.
- [ ] **Étape 6 : ménage.** `relaylead watcher stop` ; pour chaque mission, `relaylead stop`, puis `relaylead remove` ; `claude agents --json --all`, filtré sur les dossiers d'essai (une copie perd son nom `rl-`) : `claude stop` puis `claude rm` de tout reste ; supprimer les dossiers d'essai et le `RELAYLEAD_HOME` jetable. Vérifier que l'empreinte de `~/.claude/settings.json` et le contenu de `~/.relaylead` n'ont pas changé, et que `~/Library/LaunchAgents` ne contient rien de Relaylead.
- [ ] **Étape 7 :** relevé (tableau : durées, sessions lancées, lignes de `watcher.log`, délais de réveil et de relance, survie du passage ciblé, durée de vie du lead inactif, refus du garde-fou, restes) ; commit `docs(essai): continuité du lot 2a avec Claude Code sur macOS`. Chaque défaut trouvé devient une issue.

---

## Risques et questions tranchées

1. **Planificateur du système.** La feuille de route range « planificateur du système » au lot 2a, mais sa règle commune interdit toute écriture dans la configuration de l'utilisateur hors `relaylead install`, qui vient au lot 4 ; enregistrer launchd écrit un fichier dans `~/Library/LaunchAgents`. Tranché : le lot 2a livre le contrat que launchd appellera (`relaylead watcher run` : un passage, un verrou, rapide, idempotent) et un lancement explicite (`relaylead watcher start`, boucle détachée lancée aussi par `relaylead launch` et par les passages ciblés quand elle manque, finie d'elle-même) ; l'enregistrement launchd, l'erreur codée « plateforme non prise en charge » ailleurs et l'environnement minimal de launchd (`PATH` sans `claude`) passent au lot 4. La boucle est portable et testée par la CI sur les trois systèmes ; elle se dit sur la sortie d'erreur de `launch`.
2. **Comment le lead attend.** La boucle `relaylead wait --timeout 540` relit tout le contexte du lead à chaque retour, même la nuit. Tranché : `wait` tant qu'une tâche tourne, fin de tour quand rien ne tourne, réveil par Relaylead. `wait --timeout 0` juste avant la fin du tour rafraîchit l'instantané et attrape un changement de dernière seconde.
3. **Qui réveille.** Tranché : `task done|fail`, `answer` et `state set handover` lancent un passage ciblé détaché (la commande de l'équipier rend la main aussitôt) ; un passage ciblé patiente 60 s au plus un lead encore actif ; la boucle rattrape le reste.
4. **Fin d'une session arrêtée (#71 et fait mesuré 1).** La ligne de Claude perd son PID au moins 0,9 s avant la fin du processus : « plus de PID » ne veut pas dire « fini ». Tranché : deux temps partout ; second temps borné à 5 s sous Windows seulement (où le PID repris fait le défaut #71), jusqu'au délai de l'attente sous POSIX, où la reprise d'un PID en quelques secondes n'arrive pas. Le faux agent ne juge plus une session tuée sur son PID (témoin `.killed`).
5. **Réveils en boucle, lead figé.** Tranché : un réveil par vue (`attempt` compris), un par état interrompu (clé toujours définie), aucun dans les 10 s qui suivent une action sur le lead ni tant qu'un réveil attend son jugement, les réveils sans effet ou ratés espacés (15 min, 30 min, 1 h) avec leur motif rendu dû, puis signalés `lead-stuck`, sans arrêt ; tout battement remet la garde à zéro. Un passage ciblé attend la fin du silence plutôt que de laisser le réveil à la boucle. Un lead en limite d'usage n'est pas réveillé pendant 5 h (la pause et la reprise viennent au lot 2b).
6. **Tour fini pendant que la mission travaille** (`claude respawn` d'une mise à jour, tour abandonné). Tranché : règle 16, recoupée par le battement (`(stop)`, ou 11 min sans battement, une commande étant bornée à 10 min). Le fait mesuré 2 (`busy` pendant tout un tour) rend sûres les deux lectures `idle` à 2 s ; le battement ajoute une seconde preuve à peu de frais.
7. **Lead absent d'une mission en attente.** La spec ne relance un lead absent que si la mission n'est « ni en pause ni en attente ». Tranché : lead absent et état `waiting` → pas de relance, il compte comme inactif et se réveille au prochain changement (le réveil marche sur une session arrêtée).
8. **Source du contexte et fenêtre.** Tranché par le fait mesuré 3 : barre d'état (exacte, appelée pendant le tour, fenêtre dès le premier appel) puis transcript (mêmes jetons, 1 à 3 s de retard) ; plus de fenêtre par défaut (l'ancien repli à 200 000 aurait plafonné le seuil d'un équipier à 96 000 jetons et fait échouer ses tâches). Fenêtre inconnue : pas de plafond ; la règle 19 exige une fenêtre mesurée. Un relevé ne se périme (30 min) que pour un lead actif.
9. **Budgets de contexte par rôle, pas par profil.** Tranché : `context.budgets.lead` et `context.budgets.crew`, réglables aux trois niveaux ; un budget par profil viendra avec un second profil d'équipier.
10. **Qui calcule les seuils.** Tranché : le veilleur, pas les hooks. Les hooks restent rapides et ne font que relever ; toutes les règles vivent dans `decide`, testable sans processus.
11. **Lead inactif au-dessus du seuil souple.** Le réveiller pour lui demander la relève coûterait un tour au pire moment. Tranché : au prochain motif de réveil, relève directe (il est à une frontière d'étape, les fichiers font foi) ; sans motif, rien.
12. **Courrier.** Tranché : adressé à l'id court de la session (stable après réveil et relance, fait mesuré 4) ; noms strictement croissants créés par lien exclusif ; le hook transmet puis range (un message relu est sans danger, un message perdu ne l'est pas).
13. **Reprise ou session neuve.** Tranché : reprise si le dernier relevé de contexte est connu et sous le seuil souple, sinon session neuve ; une reprise ratée tombe sur une session neuve dans la même action.
14. **Disjoncteur.** Tranché : deux endroits comptent (le `decide` qui relance après une relance sans battement, l'action qui lève, relève comprise) ; tout battement postérieur à la dernière relance ou au dernier échec remet tout à zéro ; il ne vise qu'un lead absent, jamais un lead en relance par le démon ; trois d'affilée arrêtent la mission, arrêt rejoué tant qu'il n'a pas abouti. Les canaux d'alerte viennent au lot 3.
15. **Nom et identité du lead.** Tranché : numéro réservé dans `lead-launch.json` avant le lancement (jamais deux sessions du même nom, même après un lancement orphelin) ; `RELAYLEAD_ROLE` et `RELAYLEAD_SESSION` passés à chaque session ; contrôle du lead actuel à l'entrée des commandes, refait sous le verrou pour `task start|retry|deliver` et à chaque tour de `wait` ; le lead dont le lancement est en cours (`lead-launch.json` non marqué `failed`) compte comme actuel, car il agit avant que `launch` ait rendu la main.
16. **Arrêt contre relance ou relève.** Tranché : l'état est relu avant le lancement et après l'enregistrement ; un arrêt demandé entre-temps fait arrêter la session lancée et n'est jamais écrasé par `starting`.
17. **Équipier perdu pendant que le lead dort.** Tranché : `look` devient une vue pure ; le veilleur tient sa propre grâce (`crewLostSince`) et déclare la tâche perdue sous le verrou, ce qui réveille le lead.
18. **Relève d'un équipier.** Tranché : seulement au seuil dur et avec une fenêtre mesurée, par un courrier qui demande de commiter et d'échouer avec « context full: … » ; le lead relance la tâche sur la même branche. La tentative compte dans `maxAttempts`.
19. **Boucle lancée d'office.** Tranché : gardée (sans elle, jusqu'au lot 4, une mission ne survit que si un passage ciblé tombe bien), annoncée sur la sortie d'erreur, coupable par `watcher.autoStart` et, pour toute la suite de tests, par `RELAYLEAD_WATCHER=off`. Une boucle sort quand le paquet change de version, et le prochain `launch` ou passage ciblé la relance ; un `watcher stop` de l'utilisateur tient jusqu'au prochain `watcher start` ou `launch`.
20. **`StopFailure` au lot 2a.** Tranché : relevé et journalisé (tout le dossier `failures/`), réveils retenus 5 h ; le faux serveur 429 sert à l'essai réel, jamais au produit : Relaylead ne prend jamais `ANTHROPIC_BASE_URL` d'une configuration.
21. **Journal du veilleur.** Tranché : une ligne par action, en anglais, rien quand rien n'est fait ; bascule vers `watcher.log.1` au-delà de 1 Mio. Le `journal.md` court de la mission et son archive ne sont pas de ce lot.

## Hors périmètre

- **Limites d'usage, pause et reprise, priorités, jetons de travaux lourds** : lot 2b (le relevé `failures/` et la barre d'état de mesure, qui porte déjà `rate_limits`, leur servent de base).
- **Canaux d'alerte** (`system`, `ntfy`, `command`, `agent`) : lot 3 ; ici, `watcher.log` et `journal.log`.
- **Enregistrement launchd, `install`, `uninstall`, `doctor`, environnement minimal de launchd, invite d'approbation dont le défaut est « No, exit »** : lot 4.
- **Essais réels sous Linux et Windows** : supprimés par la décision macOS seulement ; la CI garde les trois systèmes avec le faux agent.
- **Budget de contexte par profil**, limite en nombre de tours ou en durée (troisième source de la spec, pour un agent sans transcript ni barre d'état) : pas d'agent qui en ait besoin.
- **`journal.md` de mission et archive quotidienne**, battement externe facultatif, résumé quotidien.
- **Commande pour créer ou retirer `STOP`** : un fichier suffit, la spec le nomme ainsi.
