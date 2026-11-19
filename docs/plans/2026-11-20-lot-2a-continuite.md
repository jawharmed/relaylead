# Lot 2a : continuité — plan

> **Pour les agents qui exécutent :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`). Les titres de tâche gardent le mot anglais « Task » pour l'outillage. La Task 1 ferme #67, la Task 2 ferme #71 ; les autres tâches n'ont pas d'issue, leur PR cite la tâche du plan. Presque toutes touchent `core/messages.js`, `core/cli.js`, `core/missions.js` ou `core/watcher*.js` : elles s'exécutent en série, dans l'ordre du plan.

**But :** une mission survit seule à ce qui arrête ou endort son lead. Un lead tué est relancé sans perte ; un lead dont le contexte se remplit passe la main à une session neuve ; un lead qui a fini son tour est réveillé quand un équipier finit, qu'une réponse arrive ou qu'un message l'attend ; jamais deux leads, jamais d'arrêt au seul motif qu'une session attend ; trois relances ratées arrêtent la mission.

**Architecture :** un **veilleur** sans IA (`core/watcher.js`) passe sur chaque mission non finie. Un passage observe la mission (`observe`), décide par des règles pures (`core/watcher-rules.js`, `decide`), puis agit sous le verrou de mission (`act`) : arrêter un lead de trop ou un équipier orphelin, réveiller, relancer, faire la relève, écrire au courrier, déclencher le disjoncteur. Les sessions écrivent leurs **relevés** par des hooks passés à chaque lancement (`core/hooks/posttool.js`, `stop.js`, `stopfailure.js`, `statusline.js`, logique dans `core/readings.js`) : battement de cœur, contexte, échec ; elles lisent leur **courrier** (`core/mailbox.js`). Le veilleur tourne de trois façons, toutes par le même code : un passage complet (`relaylead watcher run`), un passage ciblé lancé en arrière-plan juste après la fin d'un équipier, une réponse ou une demande de relève (`relaylead watcher run --mission <nom>`), et une boucle détachée toutes les 5 min (`relaylead watcher start`, lancée par `relaylead launch`). L'enregistrement dans launchd passe au lot 4 avec `install` (voir « Risques et questions tranchées », point 1).

**Outils :** Node.js 18 ou plus (CommonJS, aucune dépendance), `node --test`, git, GitHub Actions (ubuntu, macos, windows × Node 18, 24).

**Spec :** [`docs/specs/2026-11-14-relaylead-design.md`](../specs/2026-11-14-relaylead-design.md) (v6) : « Le veilleur », « Cycle de vie » (3. Relève), « Mesures », contrat d'adaptateur (`wake`, `inject`, `heartbeat`, `context`). Feuille de route : [`2026-11-15-feuille-de-route.md`](2026-11-15-feuille-de-route.md), ligne « 2a. Continuité ». Essai jetable : [`docs/spike-results.md`](../spike-results.md) (réveil, boîte aux lettres, relance par le démon, barre d'état, `StopFailure`). Plan précédent : [`2026-11-16-lot-1-1-robustesse.md`](2026-11-16-lot-1-1-robustesse.md) ; relevé réel : [`docs/manual-checks/lot-1-1-claude-macos.md`](../manual-checks/lot-1-1-claude-macos.md). Décisions de l'auteur du 19 nov. 2026 qui modifient la feuille de route : première version publique **macOS seulement** (essais réels sous macOS, la CI garde les trois systèmes avec le faux agent) ; planificateur du système **launchd seulement**, ailleurs une erreur codée (lot 4) ; lot 6 supprimé, le lot 7 suit le lot 5.

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
- Chaque nouvelle erreur attendue est un `codedError` dont le code a son texte en anglais **et** en français dans `core/messages.js`.
- Fichiers `tasks/archive/<id>.<n>.json` et `<id>.<n>.result.json` ; `state.json` peut porter `stopping: true`, écrit par le cœur seul.
- Avant toute suppression récursive sous `~/.relaylead/missions/`, le nom est vérifié par `/^[a-z0-9-]+$/`.

Ajouts du lot 2a :

- **Fichiers d'état nouveaux, chacun avec un seul rédacteur** (détail dans « Fichiers d'état du lot ») : relevés de session écrits par les hooks de la session elle-même, courrier créé par le cœur et rangé par la session destinataire, mémoire du veilleur (`watch.json`) écrite par le veilleur seul sous le verrou de mission, `state.json` qui reçoit `handover` (du lead) et `starting` après une relève (du cœur).
- **Aucune session n'est jugée vivante ou finie sur son seul PID** (#71) : la liste de l'adaptateur fait foi ; le PID ne sert qu'en repli quand la liste échoue, ou borné dans le temps.
- **Aucune session n'est arrêtée au seul motif qu'elle attend** (`waiting`, `blocked`, `idle`) ; un lead silencieux est signalé, jamais arrêté.
- **Aucune écriture dans la configuration de l'utilisateur** : ni `~/Library/LaunchAgents`, ni `~/.claude`, ni sa barre d'état. Les hooks et la barre d'état de mesure passent par `--settings` à chaque lancement.
- Hooks et barre d'état : rapides (aucun appel réseau ni à `claude`, lecture du transcript bornée à ses 256 derniers Kio), ne lèvent jamais (une erreur : rien n'est écrit, sortie 0), n'écrivent que sous `missions/<mission>/`.
- Le contrat d'adaptateur gagne : `stopById` (déjà lu par le cœur), `wake` obligatoire pour la continuité, `idle` dans les lignes de `list` (voir « Contrat d'adaptateur »).
- Textes adressés aux sessions (réveil, courrier, consignes) et lignes de `watcher.log` en anglais, comme les profils.
- Tests qui lancent des missions : la configuration machine du dossier temporaire porte `"watcher": {"autoStart": false, "helpers": false}`, sauf les tests qui éprouvent ces passages.
- Délais lus à l'appel et raccourcis par variable d'environnement dans les tests : `RELAYLEAD_RESTART_GRACE_MS`, `RELAYLEAD_IDLE_RECHECK_MS`, `RELAYLEAD_CLAUDE_WAKE_SETTLE_MS`, `RELAYLEAD_FAKE_WAKE_MS` ; ceux des lots précédents restent.
- Chaque capacité nouvelle de l'adaptateur Claude a son équivalent dans le faux agent, éprouvé par la CI sur les trois systèmes. Essais réels sous macOS seulement.

## Review Focus

1. **Lead qui attend une réponse humaine pendant des heures** (tour fini, `blocked` ou `done` avec processus, état `waiting`). Attendu : jamais arrêté, et réveillé une seule fois par changement réel, jamais à chaque passage. Tests : Task 6, `a lead waiting for an input is never stopped` ; Task 7, `an idle lead with nothing new is left alone pass after pass`.
2. **Le démon de Claude relance un lead tué pendant que le veilleur passe** (ligne `working` sans PID pendant une dizaine de secondes). Attendu : délai de grâce, pas de seconde session ; si le veilleur a relancé après la grâce et que l'ancien revient, il est arrêté comme lead de trop. Tests : Task 8, `a lead restarting by itself is not relaunched during the grace` et `a lead restarted by its agent after the watcher relaunched it is stopped as an extra lead`.
3. **Deux équipiers finissent au même instant**, chacun lance un passage ciblé, et la boucle passe aussi. Attendu : un seul réveil (verrou de mission, nouvelle observation sous le verrou, vue déjà réveillée retenue). Test : Task 7, `two targeted passes at once wake the lead once`.
4. **Lead remplacé qui continue** (relève, ou relance pendant que l'ancien finit une commande) : `state set`, `task start`, `question ask`. Attendu : refus `not-current-lead`, l'état et les tâches ne bougent pas. Test : Task 9, `a replaced lead can no longer drive the mission`.
5. **Mission arrêtée, supprimée ou relancée sous le même nom pendant un passage ou un assistant détaché**. Attendu : le passage ne fait rien (il compare `createdAt` sous le verrou), l'ancien reaper non plus, et un arrêt l'emporte sur une relance. Tests : Task 2, `an old reaper does nothing for a newer mission of the same name` ; Task 6, `a pass for a mission removed or replaced meanwhile does nothing` ; Task 8, `a stop during a relaunch leaves no lead running`.

Risques connus non couverts par un test : une réponse qui arrive pendant que le lead finit son tour attend le passage suivant (5 min au plus, point 4 des questions tranchées) ; la barre d'état pendant un tour très long n'a pas été observée (essai, Task 11) ; le repli sur le PID quand la liste échoue garde, sous Windows, le défaut de #62 pendant au plus 30 s ; la boucle du veilleur ne survit pas à un redémarrage de la machine (launchd au lot 4).

---

## Structure des fichiers

Seuls les fichiers touchés par ce lot :

```
core/
  readings.js        (nouveau) relevés des sessions : battement, contexte (transcript, barre d'état), échec ; seuils
  mailbox.js         (nouveau) sendMail, takeMail, unreadCount
  watcher.js         (nouveau) passage, verrou, STOP, journal, observe, act, boucle, start/stop/status
  watcher-rules.js   (nouveau) decide : règles pures du veilleur
  detached.js        (nouveau) spawnDetached : assistants détachés (reaper, passage ciblé, boucle)
  hooks/posttool.js  (nouveau) battement, contexte du transcript, courrier en contexte additionnel
  hooks/stop.js      (nouveau) battement de fin de tour, courrier qui retient la fin du tour
  hooks/stopfailure.js (nouveau) échec de la session (rate_limit…)
  hooks/statusline.js  (nouveau) barre d'état de mesure : contexte exact et taille de la fenêtre
  missions.js        attentes sur la liste (#71), reaper lié à sa mission, launchLead, handover, stopMission(note)
  wait.js            unseenChanges
  tasks.js           environnement des équipiers (rôle, nom de session)
  cli.js             watcher run|start|stop|status|loop, passages ciblés, lead actuel, handover
  config.js          DEFAULTS : context, watcher
  messages.js        nouveaux codes et textes (en, fr)
adapters/
  claude/index.js    attente du réveil sur la liste (#71)
  claude/settings.js hooks PostToolUse, Stop, StopFailure et statusLine de mesure
  fake/index.js      stopById (#67), wake, fin de tour, mort brutale
  fake/agent.js      relevés, courrier, fin de tour, réactions au courrier
catalog/profiles/lead.md, catalog/profiles/developer.md, catalog/methods/code.md
fixtures/
  claude/fake-claude.js  stuck-stop garde le PID ; scénario lingering-process
  claude/transcript.jsonl (nouveau) transcript synthétique
  fake-429.js        (nouveau) faux serveur de limite d'usage, pour l'essai réel
  helpers.js         killSession
  missions.js        configuration machine des tests : watcher coupé
README.md            veilleur, STOP, relève, réglages context et watcher (en, fr)
test/                readings, mailbox, watcher-rules, watcher, watcher-loop (nouveaux) ; missions, claude-adapter,
                     fake-adapter, hooks, claude-settings, wait, cli, catalog, e2e/continuity (nouveau), e2e/fake-mission
docs/manual-checks/lot-2a-claude-macos.md   (nouveau) relevé humain
```

## Contrat d'adaptateur (référence pour les Tasks 1 à 3, 6 à 9)

```js
// Ligne rendue par list(mission) : celle du lot 1, plus idle.
{ sessionId, shortId, name, role, state: 'working'|'waiting'|'done'|'stopped'|'failed', pid /* null : aucun processus */, cwd,
  idle /* true : aucun tour en cours */ }
// Adaptateur
{ name, capabilities: ['launch','list','stop','attach','wake'], stopById /* true : stop(session) sans danger sur une session déjà finie */,
  launch(spec), list(mission), stop(session), attach(session), wake(session, message) -> Promise<Session> }
```

Règles : un `pid` rendu par `list` veut dire « l'agent connaît un processus vivant » ; `pid: null` ou une session absente de la liste veut dire « aucun processus ». Le cœur ne relit le PID du registre qu'en repli, quand `list` échoue. Les deux adaptateurs ont `wake` et `stopById` ; le veilleur ne prévoit pas d'adaptateur sans eux (YAGNI).

## Fichiers d'état du lot

| Fichier | Contenu | Seul rédacteur | Tâche |
|---|---|---|---|
| `missions/<m>/heartbeats/<shortId>.json` | `{at, tool, contextTokens, baseTokens}` | hooks `PostToolUse` et `Stop` de la session (faux agent : la session elle-même) | 4, 5 |
| `missions/<m>/context/<shortId>.json` | `{at, contextTokens, windowTokens, baseTokens}` | barre d'état de mesure de la session | 4 |
| `missions/<m>/failures/<shortId>.json` | `{at, error, message}` | hook `StopFailure` de la session | 5 |
| `missions/<m>/mailbox/<shortId>/<horodatage>-<4 hex>.md` | un message | le cœur (veilleur) le crée ; le hook de la session destinataire le **déplace** dans `read/` par `rename`, jamais réécrit | 5 |
| `missions/<m>/watch.json` | mémoire du veilleur pour la mission (ci-dessous) | le veilleur, sous le verrou de mission | 6 |
| `missions/<m>/state.json` | peut valoir `handover` (avec `by`), écrit par le lead ; `starting` après une relève, écrit par le cœur | lead ; cœur pour `stopped`, `stopping` et `starting` | 9 |
| `~/.relaylead/watcher.lock` | `{pid, since}` : un passage complet à la fois | le passage complet | 6 |
| `~/.relaylead/watcher.log` (et `watcher.log.1`) | une ligne par action : `<heure ISO> <mission ou -> <action> <détail>` | ajouts du veilleur (passages et assistants) ; bascule vers `.1` au-delà de 1 Mio, par le passage complet seul | 6 |
| `~/.relaylead/STOP` | présent : le veilleur ne fait rien | l'utilisateur | 6 |
| `~/.relaylead/watcher-loop.json` | `{pid, startedAt, beatAt, lastPassAt, everySeconds}` | la boucle | 10 |
| `~/.relaylead/watcher-loop.stop` | demande d'arrêt de la boucle | `relaylead watcher stop` la crée, la boucle la retire | 10 |

`watch.json` : `{leadLostSince, failedRelaunches, lastRelaunchAt, lastWakeView, interruptWakeFor, rateLimitNoticeFor, handoverNoticeFor, contextFullNotices: [], baseAlerts: [], silentNoticeFor, failuresSeen: {}}` ; absent, chaque champ vaut `null`, `0`, `[]` ou `{}`.

## Réglages du lot (`core/config.js`, `DEFAULTS`)

```js
context: { budgets: { lead: 150000, crew: 250000 }, capPercent: 40, hardPercent: 20, windowTokens: 200000 },
watcher: { autoStart: true, helpers: true, everySeconds: 300 },
```

`context` se règle aux trois niveaux, comme le reste (`.relaylead.json` pour forcer un seuil bas). `watcher` est lu dans la configuration machine seule (`loadConfig()` sans dossier), au moment de l'appel : le veilleur est commun à toutes les missions. Seuils d'une session : `soft = min(base + budgets[role], floor(capPercent / 100 × window))`, `hard = floor(soft × (100 + hardPercent) / 100)`, où `base` est sa première mesure et `window` la taille de fenêtre de sa barre d'état, sinon `windowTokens`. Un relevé de plus de 30 min est inconnu : aucune règle de contexte ne s'applique.

## Règles du veilleur (référence pour les Tasks 6 à 9)

États du lead, lus sur la ligne de `list` qui porte le `shortId` de `lead.json` :

- **actif** : `working`, avec processus, pas inactif ;
- **inactif** : avec processus et `waiting` ou `done` ; ou `working` et `idle` sur deux lectures à `RELAYLEAD_IDLE_RECHECK_MS` (2000) d'écart (Claude peut laisser un lead `working` et `idle`, #63 ; une seule lecture `idle` peut être passagère) ;
- **en relance** : `working` sans processus, ou absent de la liste, depuis moins de `RELAYLEAD_RESTART_GRACE_MS` (120000), compté depuis la première observation (`watch.leadLostSince`) ;
- **absent** : `stopped` ou `failed` ; `waiting` ou `done` sans processus ; en relance depuis plus que la grâce.

Si `list` échoue, aucune règle de session ne s'applique à ce passage (`list-failed <message>` dans le journal). Ordre d'application ; « une fois » veut dire une fois par session, retenu dans `watch.json` :

| # | Condition | Action | Ligne de `watcher.log` | Task |
|---|---|---|---|---|
| 0 | `STOP` présent | aucun passage | — | 6 |
| 1 | état `done` ou `stopped`, marqueur `stopping`, ou pas de `lead.json` (lancement en cours) | rien | — | 6 |
| 2 | session du registre de rôle `lead`, autre que celle de `lead.json`, listée avec processus | `stop-session` | `stop-extra-lead <shortId>` | 6 |
| 3 | session d'équipier listée avec processus, dont la tâche ne la fait plus tourner (tâche finie, livrée, ou autre session) | `stop-session` | `stop-orphan-crew <shortId> task <id>` | 6 |
| 4 | `failures/<shortId>.json` plus récent que `failuresSeen[shortId]` | journal | `session-failure <shortId> <error>: <message>` | 6 |
| 5 | lead en relance, première observation | journal | `lead-restarting <shortId>` | 6 |
| 6 | lead actif, dernier battement de plus de 30 min, une fois | journal (jamais d'arrêt) | `lead-silent <shortId> <minutes> min` | 6 |
| 7 | `state.json` vaut `handover`, `by` = nom du lead actuel ou `user` | `hand-over` (arrête l'ancien s'il a un processus) | `hand-over <ancien> to <nouveau>: <note>` | 9 |
| 8 | lead absent, `failedRelaunches` ≥ 3 après décompte | `trip-breaker`, après le verrou | `breaker-tripped after 3 failed relaunches` | 8 |
| 9 | lead absent | `relaunch-lead` : reprise si son contexte est connu et sous le seuil souple, sinon session neuve ; reprise ratée → session neuve dans la même action | `relaunch-lead <shortId> resumed` ou `relaunch-lead <shortId> as <nom>` | 8 |
| 10 | lead actif ou inactif, contexte ≥ seuil dur | `hand-over` forcé | `hand-over <ancien> to <nouveau>: forced at <tokens> tokens` | 9 |
| 11 | contexte du lead ≥ seuil souple, une fois | `mail` au lead (avis de relève) | `notify-handover <shortId> <tokens>/<soft>` | 9 |
| 12 | base > moitié du seuil souple, une fois | journal | `base-high <shortId> <base>/<soft>` | 9 |
| 13 | équipier listé avec processus, sa tâche tourne, contexte ≥ seuil dur, une fois | `mail` à l'équipier (contexte plein) | `notify-context-full <shortId> task <id>` | 9 |
| 14 | lead inactif, dernier échec `rate_limit` postérieur à son dernier battement, une fois | journal, pas de réveil (pause et reprise au lot 2b) | `lead-rate-limited <shortId>` | 7 |
| 15 | lead inactif, changements non vus (`unseenChanges`) dont la vue diffère de `lastWakeView` | `wake-lead` | `wake-lead <shortId>: <changements>` | 7 |
| 16 | lead inactif, courrier non lu pour lui | `wake-lead` | `wake-lead <shortId>: mail` | 7 |
| 17 | lead inactif, état `working` ou `starting`, `interruptWakeFor` ≠ `updatedAt` de l'état | `wake-lead` | `wake-lead <shortId>: turn ended while working` | 7 |

Décompte du disjoncteur, à chaque observation : un battement du lead actuel daté d'après `lastRelaunchAt` remet `failedRelaunches` à 0 ; un lead absent sans tel battement alors que `lastRelaunchAt` est posé compte la relance précédente comme ratée (+1). Une relance qui lève compte +1 et remet `lastRelaunchAt` à `null` (pas de double compte au passage suivant). Une relance réussie pose `lastRelaunchAt`.

Textes envoyés aux sessions (anglais, exacts) :

- réveil : « Relaylead woke you: {reasons}. Carry on with the method: run `relaylead task list` first. » ; `{reasons}` joint par « ; » des éléments `task a is now done`, `question q-b is now answered`, `you have mail`, `your turn ended while the mission was working` ;
- reprise d'un lead absent : « Relaylead restarted you after your session ended. Carry on with the method: run `relaylead task list` first. » ;
- section ajoutée à la consigne d'un nouveau lead après relance : « ## Restart » puis « The previous lead session {old} ended unexpectedly. You take its place: you remember nothing, the files hold everything. Start with `relaylead task list`. » ;
- après relève : « ## Handover » puis « You take over from the lead session {old}, which handed over with this note: {note}. You remember nothing, the files hold everything. Start with `relaylead task list`. » (relève forcée : « which handed over when its context was full ») ;
- avis de relève (courrier) : « Your context holds {tokens} tokens, past the handover threshold of {soft}. Finish the step you are on, then run `relaylead state set handover --note "<where the mission stands, in one line>"` and end your turn: a fresh lead takes over from the files. » ;
- contexte plein d'un équipier (courrier) : « Your context holds {tokens} tokens and is full. Commit what you have done on your branch, then run `relaylead task fail {id} --summary "context full: <what is done, what remains>"` and end your turn: the lead starts a fresh session on your branch. »

Les hooks préfixent chaque message du courrier par « Message from Relaylead: ».

---

### Task 1 : arrêt par identifiant pour le faux agent (#67)

**Files :** modifier `adapters/fake/index.js`, `test/fake-adapter.test.js`, `test/missions.test.js`, `test/deliveries.test.js`.

Constat de #67 : `relaylead remove` et le traitement d'un marqueur `stopping` de plus d'une heure n'arrêtent une session que si l'adaptateur sait le faire par son identifiant ; le faux agent n'a pas `stopById`, ces deux chemins sautent donc l'arrêt et ne sont pas éprouvés. Depuis #62, le faux agent s'arrête par un fichier témoin choisi au lancement, jamais par PID : rejouer `stop` est sans danger.

**Interfaces :**
- `adapters/fake/index.js` exporte `stopById: true`. `stop(session)` ne change pas : il écrit le fichier d'arrêt, puis le retire quand la session a fini (fichier de fin présent) ou n'a pas de processus.
- Les tests qui éprouvent la branche « adaptateur qui arrête par PID » mettent `fake.stopById = false` le temps du test et le rétablissent dans `t.after` : `stop on a stopped or done mission kills nothing`, la fin de `stop runs again for an adapter that stops by id…`, `an old stopping marker does not replay a stop by pid`, et `a stop with nothing to do still cleans` (`test/deliveries.test.js`). Les lignes `fake.stopById = true` devenues inutiles sont retirées (`stop runs again…`, `stop of a done mission says it is done`).

- [ ] **Étape 1 : tests qui échouent** :
  - `the fake adapter stops by id, harmlessly on a session already ended` (`test/fake-adapter.test.js`) : `fake.stopById === true` ; une session lancée, arrêtée, puis arrêtée de nouveau : aucune erreur, et aucun fichier d'arrêt ne reste ;
  - `remove stops the fake sessions by id` : `writeMission('demo', dir)`, une session d'équipier du faux agent lancée et enregistrée, `state.json` écrit à `{state: 'done'}` par le test (la session survit), puis `relaylead remove demo` : la session finit (`waitFor(sessionEnded)`), le dossier de la mission a disparu ;
  - `an old stopping marker stops the fake sessions again by id` : état `{state: 'stopped', stopping: true, updatedAt: <il y a 2 h>}` et une session du faux agent vivante ; `relaylead stop demo` rend 0 avec `mission demo stopped`, la session finit, le marqueur est retiré.
- [ ] **Étape 2 :** `npm test` → échecs attendus (`stopById` absent, sessions non arrêtées).
- [ ] **Étape 3 :** implémenter ; ajuster les tests listés ci-dessus.
- [ ] **Étape 4 :** `npm test` → tout vert.
- [ ] **Étape 5 :** commit `fix(fake): arrêt par identifiant, pour remove et le marqueur ancien (#67)`.

### Task 2 : attentes jugées sur la liste de l'adaptateur, reaper lié à sa mission (#71)

**Files :** modifier `core/missions.js`, `core/cli.js` (`_reap`), `adapters/claude/index.js`, `fixtures/claude/fake-claude.js`, `test/missions.test.js`, `test/claude-adapter.test.js`.

Constat de #71 : `stopSessionsAndWait` (sondage toutes les 250 ms), l'attente de `wake` (60 s) et `launchRunning` jugent encore la fin d'un processus sur son PID. Sous Windows, un PID repris par un processus durable fait croire une session vivante : `relaylead stop` rend 1, `wake` finit en `wake-timeout`. Le veilleur reposera sur ces attentes. Second point : après `remove` puis un nouveau lancement du même nom, un ancien reaper encore vivant peut écrire `reaper-ended.json` dans la nouvelle mission et relire son `lead.json`.

**Interfaces :**
- `core/missions.js` :
  - `hasProcess(rows, session) -> boolean` : vrai si une ligne de `rows` porte `session.shortId` et un `pid` non nul.
  - `stopSessionsAndWait(mission, sessions)` : après les arrêts, chaque sondage (`STOP_POLL_MS`) relit `adapter.list(mission.name)` ; une session arrêtée a fini quand `!hasProcess(rows, session)`. Un sondage dont la liste échoue juge ce tour-là sur `isAlive(pid)`, le PID étant celui lu avant les arrêts (comme aujourd'hui). Délai (`stopWaitMs`) et retour `{failed, alive, error}` inchangés.
  - `LAUNCH_LOCK_MAX_MS = 15 * 60 * 1000`. Dans `isStale` (branche « pas de `mission.json` ») et dans `launchRunning`, un lancement ne tourne que si le PID du verrou est vivant **et** que le fichier de verrou a moins de 15 min (`ageOf`). Un lancement écrit `mission.json` en quelques git et un lancement d'agent, bien avant.
  - `spawnReaper(name, createdAt)` lance `relaylead _reap <name> <createdAt>`. `reapLead(name, createdAt)` rend aussitôt si `mission.json` manque ou porte un autre `createdAt`. `markReaperEnded(name, createdAt)` n'écrit `reaper-ended.json` que si `mission.json` porte ce `createdAt`. Sans `createdAt` (un assistant lancé avant ce lot), comportement d'aujourd'hui.
- `adapters/claude/index.js` : `wake` attend en deux temps, le tout borné par `wakeTimeoutMs()` (60 s, sinon `wake-timeout`) : (1) `findRow` jusqu'à une ligne absente ou sans `pid` ; un sondage dont la liste échoue juge sur `isAlive(pidAvant)` ; (2) puis `isAlive(pidAvant)` faux, pendant au plus `RELAYLEAD_CLAUDE_WAKE_SETTLE_MS` (5000) ; passé ce délai, la reprise part quand même : un PID repris sous Windows ne bloque plus le réveil, et une copie éventuelle est détectée et arrêtée (`wake-copy`) comme aujourd'hui. `pidAvant` est le PID de la ligne lue avant `stop`, sinon celui du registre.
- `fixtures/claude/fake-claude.js` : `stuck-stop` garde `pid` et `sleeper` sur la ligne (état `stopped`, processus encore vivant, comme le listerait Claude) ; nouveau scénario `lingering-process` : `stop` retire `pid` de la ligne mais le processus continue (un PID que Claude ne liste plus, comme un PID repris). Commentaire d'en-tête mis à jour.

- [ ] **Étape 1 : tests qui échouent** :
  - `a stop waits on the adapter list, not on a pid now used by another process` : PID du registre = un processus sans rapport, vivant ; `list` remplacée par une fonction qui rend la session avec ce PID avant l'arrêt et `pid: null` après ; `relaylead stop demo` rend 0 en moins de 5 s, le processus sans rapport vit toujours ;
  - `a stop judges on the pid only when the list fails` : `list` qui lève après l'arrêt, PID du registre vivant, `RELAYLEAD_STOP_WAIT_MS=300` → `session-still-alive` ; même cas avec un PID mort → 0 ;
  - `wake does not wait more than 5 s on a process claude no longer lists` : scénario `lingering-process`, `RELAYLEAD_CLAUDE_WAKE_MS=20000` ; `wake` réussit sous le même id, en 5 s au moins et 15 s au plus ;
  - `wake gives up when the session process does not end` (existant, `stuck-stop`) reste vert : la ligne garde son PID ;
  - `a launch lock older than 15 min does not hold a mission name, even with a live pid` : verrou `{pid: process.pid, mission: 'demo'}` dont le `mtime` est reculé de 20 min, `missions/demo/` sans `mission.json` ; `relaylead remove demo` rend 0 et le dossier disparaît ; `remove leaves a mission folder being launched` (existant, verrou neuf) reste vert ;
  - `an old reaper does nothing for a newer mission of the same name` : mission `demo` avec un lead du faux agent enregistré ; `relaylead _reap demo 2000-01-01T00:00:00.000Z` (processus à part) se termine en moins de 3 s, le lead vit toujours, `reaper-ended.json` absent ;
  - les tests existants du reaper passent le `createdAt` de leur mission.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `fix(missions): attentes jugées sur la liste de l'adaptateur, reaper lié à sa mission (#71)`.

### Task 3 : faux agent : fin de tour, mort brutale et réveil

**Files :** modifier `adapters/fake/index.js`, `adapters/fake/agent.js`, `fixtures/helpers.js`, `core/messages.js`, `test/fake-adapter.test.js`.

Le veilleur réveille et relance par `wake`, que le faux agent n'a pas. Il faut aussi qu'une session du faux agent puisse finir son tour en restant vivante (comme une session Claude `blocked` ou `done`) et mourir sans écrire sa fin (comme un `kill -9`).

**Interfaces :**
- `agent.js` : `endTurn()` écrit le fichier `RELAYLEAD_FAKE_IDLE`, puis reste vivant comme `idle()`. Nouveau rôle `waiting` : une session qui finit son premier tour aussitôt (pour les tests). Au démarrage, si `RELAYLEAD_FAKE_WAKE_MESSAGE` est défini, l'agent écrit `woken: <message>` dans son journal.
- `index.js` :
  - `launch` ajoute au registre `idleFile` (`missions/<m>/fake-<shortId>.idle`) et `env` (le `spec.env` reçu), champs ignorés du cœur, et passe à l'agent `RELAYLEAD_FAKE_IDLE` et `RELAYLEAD_FAKE_SHORT_ID` (`shortId`) ;
  - `list` : fichier de fin présent → `{state: 'done', pid: null, idle: true}` ; sinon processus vivant et fichier `idle` présent → `{state: 'waiting', idle: true}` ; processus vivant sans fichier `idle` → `{state: 'working', idle: false}` ; processus mort sans fichier de fin (tué) → `{state: 'failed', pid: null, idle: true}` ;
  - `wake(session, message) -> Promise<Session>` : appelle `module.exports.stop(session)` (remplaçable par les tests) ; attend au plus `RELAYLEAD_FAKE_WAKE_MS` (10000) que le fichier de fin existe ou que le processus soit mort, sinon `wake-timeout` ; retire les fichiers de fin, `idle` et d'arrêt ; relance `agent.js` avec le même rôle, les mêmes `sessionId`, `shortId` et fichiers, l'env `{...process.env, RELAYLEAD_TASK: undefined, ...session.env, …fichiers, RELAYLEAD_FAKE_WAKE_MESSAGE: message}` ; rend la session avec son nouveau `pid`, `state: 'working'`, `idle: false`. `capabilities` gagne `'wake'`.
- `fixtures/helpers.js` : `killSession(session)` = `process.kill(session.pid, 'SIGKILL')` (la session n'écrit pas sa fin).
- `wake-timeout` (en, fr) devient général : « the session {shortId} was stopped but its process was still running after {seconds} s; it was not woken » / « la session {shortId} a été arrêtée mais son processus tournait encore après {seconds} s ; elle n'a pas été réveillée ».

- [ ] **Étape 1 : tests qui échouent** :
  - `a fake session that ended its turn is listed waiting and idle` : rôle `waiting` → `{state: 'waiting', idle: true}` avec un `pid` ;
  - `wake restarts a fake session under the same ids, with the message` : rôle `waiting`, `wake(session, 'hello')` → même `shortId` et `sessionId`, autre `pid` ; le journal de la session contient `woken: hello` ; la session finit de nouveau son tour (`waiting`) ;
  - `a killed fake session is listed failed without a process` : `killSession` → `{state: 'failed', pid: null}` ;
  - `wake resumes a killed fake session` : après `killSession`, `wake` rend une session vivante sous le même id ;
  - `wake gives up when the fake session does not end` : `fake.stop` remplacé par une fonction vide, `RELAYLEAD_FAKE_WAKE_MS=300` → `wake-timeout`, l'ancien processus vit toujours.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(fake): fin de tour, mort brutale et réveil du faux agent`.

### Task 4 : battement de cœur et mesure du contexte

**Files :** créer `core/readings.js`, `core/hooks/posttool.js`, `core/hooks/statusline.js`, `fixtures/claude/transcript.jsonl`, `test/readings.test.js` ; modifier `core/config.js`, `adapters/claude/settings.js`, `adapters/fake/agent.js`, `test/hooks.test.js`, `test/claude-settings.test.js`, `test/fake-adapter.test.js`.

Deux sources, comme la spec (barre d'état exacte, puis transcript) : le hook `PostToolUse` lit le transcript à chaque action, ce qui marche même pendant un tour qui dure des heures (un lead dans `relaylead wait`) ; la barre d'état donne en plus la taille de la fenêtre, qu'aucun transcript ne porte. L'essai a montré que les deux concordent (écart maximal 0,028 % de la fenêtre).

**Interfaces :**
- `core/readings.js` :
  - `shortIdOf(sessionId) -> string|null` : les 8 premiers caractères s'ils valent `/^[0-9a-f]{8}$/`, sinon `null` (l'id court est le préfixe de l'id complet) ;
  - `contextFromTranscript(file) -> number|null` : lit les 262144 derniers octets, parcourt les lignes depuis la fin, saute les lignes illisibles et celles où `isSidechain` est vrai, et rend pour la première entrée `type: 'assistant'` qui a `message.usage` : `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (absents = 0) ; `null` si rien, fichier absent ou illisible ;
  - `recordHeartbeat(mission, shortId, {tool, contextTokens}) -> void` : écrit `heartbeats/<shortId>.json` = `{at, tool, contextTokens, baseTokens}` ; `contextTokens` `null` garde la valeur précédente ; `baseTokens` = celui du fichier précédent, sinon la première valeur non nulle ;
  - `recordStatusline(mission, shortId, input) -> void` : `contextTokens` = somme des trois champs de `input.context_window.current_usage` (`null` sans eux), `windowTokens` = `input.context_window.context_window_size` ou `null` ; écrit `context/<shortId>.json` = `{at, contextTokens, windowTokens, baseTokens}` (même règle de base) ;
  - `readReadings(mission, shortId) -> {heartbeat, statusline, failure}` (chacun ou `null` ; `failure` vient à la Task 5) ;
  - `contextOf(readings, {role, config, now}) -> {tokens, windowTokens, baseTokens, at, soft, hard}|null` : le relevé le plus récent (`at`) des deux ; `null` s'il a plus de `READING_STALE_MS` (30 min) ou pas de `contextTokens` ; `windowTokens` = celui de la barre d'état, sinon `config.context.windowTokens` ; `baseTokens` = celui du battement, sinon de la barre d'état, sinon `tokens` ; seuils selon la formule de « Réglages du lot ». `role` vaut `'lead'` ou `'crew'`.
- `core/hooks/posttool.js` : mission par `RELAYLEAD_MISSION` (vérifiée par `/^[a-z0-9-]+$/`), session par `shortIdOf(input.session_id)` ; `recordHeartbeat(mission, shortId, {tool: input.tool_name, contextTokens: contextFromTranscript(input.transcript_path)})`. Sans mission, sans id ou sur une entrée illisible : rien, sortie 0.
- `core/hooks/statusline.js` : `recordStatusline` ; imprime une ligne vide (la session est invisible). Mêmes règles d'erreur.
- `adapters/claude/settings.js` : `hooks.PostToolUse = hookEntry(packageDir, 'posttool')` ; `statusLine = {type: 'command', command: '"<node>" "<…/core/hooks/statusline.js>"'}`.
- `core/config.js` : `DEFAULTS.context` (voir « Réglages du lot »).
- Faux agent : après chaque commande `relaylead`, `recordHeartbeat(mission, RELAYLEAD_FAKE_SHORT_ID, {tool: 'Bash', contextTokens})` avec `contextTokens` = précédent (sinon `RELAYLEAD_FAKE_BASE_TOKENS`, 40000) + `RELAYLEAD_FAKE_TOKENS_PER_COMMAND` (1000). Un lead repris continue son compte ; une session neuve repart de la base.
- `fixtures/claude/transcript.jsonl` : synthétique (aucune donnée réelle) : réponses du fil principal dont la dernière vaut 30000 + 12000 + 366 = 42366, suivie d'une réponse de sous-agent (`isSidechain: true`, 99999) et d'une ligne tronquée.

- [ ] **Étape 1 : tests qui échouent** :
  - `the context of a transcript is the input of its last main-thread answer` : la fixture → 42366 ;
  - `a transcript is read from its last 256 KiB only` : 2 Mio de lignes utilisateur puis une réponse à 50000 → 50000 ; une réponse seulement dans le premier Mio → `null` ;
  - `a missing or unreadable transcript gives no context` → `null` ;
  - `the posttool hook records a heartbeat and keeps the first reading as base` (`test/hooks.test.js`, hook lancé comme un processus) : deux appels avec deux transcripts (42366 puis 60000) → `{tool: 'Bash', contextTokens: 60000, baseTokens: 42366}` ;
  - `the posttool hook writes nothing without a mission or a session id` : sortie 0, aucun fichier ;
  - `the statusline records the context and the window size` : `current_usage` `{input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 500}`, `context_window_size: 1000000` → `{contextTokens: 41500, windowTokens: 1000000, baseTokens: 41500}` ;
  - `contextOf takes the freshest reading and the window of the status line` ; `contextOf ignores a reading older than 30 min` ;
  - `thresholds follow min(base + budget, cap) and the hard margin` : base 40000, lead, fenêtre 1000000 → `soft` 190000, `hard` 228000 ; fenêtre 200000 → 80000 et 96000 ; équipier, fenêtre 1000000 → 290000 et 348000 ;
  - `the session settings add the heartbeat hook and the measuring status line` (`test/claude-settings.test.js`) ;
  - `a fake session writes a heartbeat at each relaylead command` : un lead du faux agent sur une mission sans tâche ; le battement passe de 41000 à 42000 au moins, base 41000.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(mesures): battement de cœur et contexte des sessions`.

### Task 5 : boîte aux lettres, hooks Stop et StopFailure

**Files :** créer `core/mailbox.js`, `core/hooks/stop.js`, `core/hooks/stopfailure.js`, `fixtures/fake-429.js`, `test/mailbox.test.js` ; modifier `core/hooks/posttool.js`, `core/readings.js`, `adapters/claude/settings.js`, `adapters/fake/agent.js`, `test/hooks.test.js`, `test/claude-settings.test.js`, `test/fake-adapter.test.js`.

Aucune commande n'envoie un message à une session vivante : le veilleur passe par des fichiers. L'essai a prouvé les deux voies (`PostToolUse` pour une session qui travaille, `Stop` pour celle qui allait finir son tour) et la détection d'une limite d'usage par `StopFailure`. La pause sur limite d'usage reste au lot 2b : ici, l'échec est seulement relevé.

**Interfaces :**
- `core/mailbox.js` :
  - `sendMail(mission, shortId, text) -> string` : écrit (par `writeText`) `mailbox/<shortId>/<horodatage>-<4 hex>.md`, où l'horodatage est l'heure ISO dont `:` et `.` deviennent `-` ; rend le chemin ;
  - `takeMail(mission, shortId) -> string[]` : les messages non lus, dans l'ordre des noms ; chacun est déplacé dans `mailbox/<shortId>/read/` par `rename` (`withWindowsRetry`) ; un message déjà déplacé par un autre lecteur (`ENOENT`) est sauté ;
  - `unreadCount(mission, shortId) -> number`.
- `core/hooks/posttool.js` : après le battement, `takeMail` ; s'il y a du courrier, imprime `{hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: <messages préfixés par « Message from Relaylead: », séparés par une ligne vide>}}`.
- `core/hooks/stop.js` : battement `{tool: '(stop)', contextTokens: <transcript>}` (marque la fin du tour), puis `takeMail` ; s'il y a du courrier, imprime `{decision: 'block', reason: <mêmes messages>}` ; sinon rien. Le courrier étant consommé, le hook ne retient pas deux fois de suite.
- `core/hooks/stopfailure.js` : `recordFailure(mission, shortId, input)` (dans `core/readings.js`) écrit `failures/<shortId>.json` = `{at, error: input.error || null, message: input.last_assistant_message || null}`.
- `adapters/claude/settings.js` : `hooks.Stop` et `hooks.StopFailure`.
- Faux agent : après chaque commande et son battement, `takeMail` ; chaque message est écrit dans son journal (`mail: <texte>`). Les réactions viennent à la Task 9.
- `fixtures/fake-429.js` (pour l'essai réel, Task 11) : `node fixtures/fake-429.js [port]` imprime son port et répond à toute requête 429 `rate_limit_error`, avec `retry-after: 3600`, `anthropic-ratelimit-unified-status: rejected` et `anthropic-ratelimit-unified-reset: <maintenant + 3600 s>` (recette de l'essai).

- [ ] **Étape 1 : tests qui échouent** :
  - `mail is taken once, in the order it was sent, and kept in read/` ;
  - `the mail of one session is not taken by another` ;
  - `mail sent in the same millisecond does not collide` : 50 envois d'affilée → 50 fichiers, 50 messages lus ;
  - `the posttool hook passes the mail on as additional context` : deux messages `first`, `second` → sortie exacte `{hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: 'Message from Relaylead: first\n\nMessage from Relaylead: second'}}`, battement écrit ;
  - `the stop hook keeps the turn going while mail waits` : avec un message → `{decision: 'block', reason: 'Message from Relaylead: …'}` ; sans courrier → rien ; battement `tool: '(stop)'` dans les deux cas ;
  - `the stopfailure hook records the error and its message` : `{session_id, error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 2:54am (Europe/Paris)"}` → `failures/<id>.json` ;
  - `the session settings add the Stop and StopFailure hooks` ;
  - `a fake session takes its mail after each command` : un message envoyé à un lead du faux agent finit dans `read/` et dans son journal ;
  - `the fake 429 server answers a rate limit with its reset headers` : statut 429 et les trois en-têtes.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(courrier): boîte aux lettres des sessions, hooks Stop et StopFailure`.

### Task 6 : le veilleur : un passage, son verrou, `STOP` et son journal

**Files :** créer `core/watcher.js`, `core/watcher-rules.js`, `test/watcher-rules.test.js`, `test/watcher.test.js` ; modifier `core/cli.js`, `core/messages.js`.

Le squelette du veilleur et ses premières règles (0 à 6 de « Règles du veilleur ») : rien n'est encore réveillé, relancé ni relevé.

**Interfaces :**
- `core/watcher-rules.js` : `decide(obs) -> {actions, watch}`, pure (aucune lecture, l'heure vient de `obs.now`). `obs` :
  `{now, mission, record /* state.json */, lead /* lead.json ou null */, rows /* list, ou null si elle a échoué */, leadIdleConfirmed, registry, tasks /* ou null */, readings: {[shortId]: {heartbeat, statusline, failure}}, unseen /* Task 7 */, mail: {[shortId]: number}, config, watch}`.
  Actions : `{type: 'stop-session', session, log}`, `{type: 'log', text}` ; les Tasks 7 à 9 ajoutent `wake-lead`, `relaunch-lead`, `hand-over`, `mail`, `trip-breaker`. `leadStatus(obs) -> 'active'|'idle'|'restarting'|'absent'` y est aussi exportée. Constantes : `SILENT_MS = 30 * 60 * 1000`, `restartGraceMs()` (`RELAYLEAD_RESTART_GRACE_MS`, 120000).
- `core/watcher.js` :
  - `observe(name) -> obs|null` : `null` pour une mission finie, en arrêt (`stopping`) ou sans `lead.json` ; `rows` par `adapter.list` (`null` et journal `list-failed` si elle lève) ; si le lead est `working` et `idle` avec un processus, seconde lecture après `RELAYLEAD_IDLE_RECHECK_MS` → `leadIdleConfirmed` ; `tasks` par `listTasks` (`null` s'il lève).
  - `tendMission(name) -> action[]` : `module.exports.observe` (remplaçable par les tests) puis `decide` ; si rien à faire et `watch` inchangé, rien n'est verrouillé ni écrit. Sinon, sous `withMissionLock(name, 'watcher')` : relit `mission.json`, et ne fait rien si son `createdAt` diffère de celui observé ou si la mission est finie ; observe et décide de nouveau, exécute chaque action (`act`), écrit `watch.json`. Une attente du verrou qui abandonne (`start-busy`, `start-stuck`, `mission-unknown`) laisse la mission au passage suivant, sans erreur. Une action qui lève est journalisée (`error <type>: <message>`) et n'empêche pas les suivantes.
  - `runPass() -> {outcome: 'done'|'stop'|'busy', missions}` : `STOP` présent → `'stop'` sans rien toucher ; prend `watcher.lock` par `'wx'` (`{pid, since}`), repris s'il a plus de 15 min ou si son processus est mort, sinon `'busy'` ; bascule `watcher.log` vers `watcher.log.1` au-delà de 1048576 octets ; `tendMission` pour chaque mission de `listMissions()` ; rend le verrou dans un `finally`. `missions` = nombre de missions à veiller (ni finies ni en arrêt).
  - `watchLog(mission, action, detail)` : ajoute la ligne (`fs.appendFileSync` sous `withWindowsRetry`) ; ne lève jamais.
- `core/cli.js` : `relaylead watcher run [--mission <nom>]` (refusé dans une session : `refuseInSession('watcher', io)`) : sans `--mission`, `runPass()` ; avec, `STOP` vérifié puis `tendMission(nom)` seul, sans le verrou de passage. Imprime les lignes ajoutées au journal par ce passage. `--mission` inconnue → `mission-unknown`. Aide : `watcher   watch the missions: restart, wake and relieve their leads` / `watcher   veiller sur les missions : relancer, réveiller et relever leurs leads`.
- Messages (en / fr) :
  - `watcherStopPresent` : « STOP is present in {home}: the watcher does nothing until it is removed\n » / « STOP est présent dans {home} : le veilleur ne fait rien tant qu'il n'est pas retiré\n » ;
  - `watcherBusy` : « another watcher pass is running (process {pid}, since {since}); nothing done\n » / « un autre passage du veilleur est en cours (processus {pid}, depuis {since}) ; rien n'est fait\n ».

- [ ] **Étape 1 : tests qui échouent** :
  - règles (`test/watcher-rules.test.js`, observations construites à la main) :
    - `a lead waiting for an input is never stopped` : lead `waiting`, `done` ou `working` et `idle`, sur dix observations à 5 min d'écart → aucune action `stop-session` sur lui ;
    - `a second lead session with a process is stopped, not the current one` ;
    - `a crew session whose task no longer runs it is stopped` (tâche `done`, `delivered`, ou autre session) ; un équipier dont la tâche tourne ne l'est pas ;
    - `a session failure is logged once` ;
    - `a silent working lead is logged once after 30 min, never stopped` ;
    - `a lead working without a process is restarting during the grace, then absent` ; même chose pour un lead absent de la liste ;
    - `a failed list applies no session rule` ;
  - intégration (`test/watcher.test.js`, faux agent) :
    - `watcher run does nothing while STOP is present` : un lead de trop reste vivant, la sortie dit `watcherStopPresent` ;
    - `a pass skips finished, stopping and launching missions` ;
    - `a pass stops an extra lead and logs it` : une session du faux agent enregistrée sous `demo/lead/9` finit, le journal porte `stop-extra-lead` ;
    - `a held pass lock is reported and nothing is done` : `watcher.lock` à notre PID → `watcherBusy`, code 0 ;
    - `a pass lock of a dead process or older than 15 min is taken over` ;
    - `watcher.log moves to watcher.log.1 past 1 MiB` ;
    - `a pass for a mission removed or replaced meanwhile does nothing` : `observe` remplacée par une fonction qui rend une observation avec un lead de trop et un `createdAt` ancien → aucune session arrêtée, aucun `watch.json` écrit ;
    - `the lead is read idle only on two idle reads` : `list` remplacée (`working` + `idle`, puis `working` occupé) → `leadIdleConfirmed` faux.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): passage, verrou, STOP et journal ; un seul lead`.

### Task 7 : réveil du lead

**Files :** créer `core/detached.js`, `test/e2e/continuity.test.js` ; modifier `core/wait.js`, `core/watcher-rules.js`, `core/watcher.js`, `core/missions.js`, `core/cli.js`, `core/config.js`, `catalog/profiles/lead.md`, `catalog/methods/code.md`, `adapters/fake/agent.js`, `fixtures/missions.js`, `test/e2e/fake-mission.test.js`, `test/watcher-rules.test.js`, `test/watcher.test.js`, `test/wait.test.js`, `test/cli.test.js`, `test/catalog.test.js`, `README.md`.

Aujourd'hui, le lead attend par `relaylead wait --timeout 540` en boucle, même pendant les heures où seule une réponse humaine peut faire avancer la mission : chaque retour de `wait` relit tout son contexte. Désormais le lead attend par `wait` tant qu'une tâche tourne, et finit son tour quand rien ne tourne ; Relaylead le réveille (règles 14 à 17). Le réveil part tout de suite après la fin d'un équipier ou une réponse, par un passage ciblé détaché ; la boucle rattrape le reste.

**Interfaces :**
- `core/detached.js` : `spawnDetached(args) -> Promise<number>` : lance `node bin/relaylead.js …args`, détaché, `stdio: 'ignore'`, `windowsHide`, avec l'env courant **sans** `RELAYLEAD_MISSION`, `RELAYLEAD_TASK`, `RELAYLEAD_ATTEMPT`, `RELAYLEAD_ROLE`, `RELAYLEAD_SESSION` ; attend l'événement `spawn`, `unref`, rend le PID. `spawnReaper` l'utilise.
- `core/wait.js` : `unseenChanges(name, sessions) -> {changes, viewKey}` : ce que rendrait le prochain `relaylead wait` (même `look`, avec le `lostSince` de l'instantané), sans écrire l'instantané ; `viewKey` = `JSON.stringify` des états des tâches et des questions, clés triées.
- Règles 14 à 17 dans `decide` ; `observe` remplit `unseen` (pour un lead inactif seulement) et `mail`. L'action `{type: 'wake-lead', reasons}` : `act` appelle `adapter.wake(session du lead, texte de réveil)` puis `recordSession` ; `decide` met à jour `lastWakeView` (règle 15) ou `interruptWakeFor` (règle 17) dans le `watch` rendu.
- `core/config.js` : `DEFAULTS.watcher = {autoStart: true, helpers: true, everySeconds: 300}` (`autoStart` et `everySeconds` servent à la Task 10).
- **Passages ciblés** : quand `loadConfig().watcher.helpers` est vrai, `relaylead task done|fail` (après l'écriture du résultat) et `relaylead answer` appellent `detached.spawnDetached(['watcher', 'run', '--mission', <mission>])`, par l'objet du module (remplaçable par les tests) ; un échec du lancement est ignoré (la boucle rattrape).
- Consignes (anglais) :
  - `code.md`, étape 6 : « If no task is running and nothing can move until the user answers: run `relaylead state set waiting --note "<what you wait for>"`, then `relaylead wait --timeout 0`. If it lists changes, go back to step 2; otherwise end your turn: Relaylead wakes you when something changes. While a task is running, run `relaylead wait --timeout 540` instead (on an empty list, run it again). » ;
  - `lead.md` : nouvelle section « Being woken » : Relaylead peut réveiller, reprendre ou remplacer la session ; un message « Relaylead woke you » ou « Relaylead restarted you » se suit tel quel ; rien de ce qui précède n'est sûr, les fichiers font foi : commencer par `relaylead task list`. La commande `wait` documente `--timeout 0`.
- Faux lead : quand aucune tâche ne tourne et que tout n'est pas réglé → `state set waiting --note "fake: waiting for answers"`, `wait --timeout 0`, puis `endTurn()` si la liste est vide. Avec `RELAYLEAD_FAKE_LEAD_ENDS_TURN=1`, il fait de même au lieu de `wait --timeout 5` quand des tâches tournent (`--note "fake: waiting for crew"`).
- `fixtures/missions.js` : la configuration machine de `setupProject` et `freshHome` porte `watcher: {autoStart: false, helpers: false}`. `test/e2e/fake-mission.test.js` : `{autoStart: false, helpers: true}` (sa question répondue réveille le lead).
- README (en, fr) : le lead finit son tour quand il n'attend que vous ; une réponse le réveille.

- [ ] **Étape 1 : tests qui échouent** :
  - règles : `an idle lead is woken for changes it has not seen, once per view` ; `an idle lead is woken for its mail` ; `an idle lead whose turn ended while working is woken once per state` ; `an idle lead with nothing new is left alone pass after pass` (état `waiting`, aucun changement non vu ou vue déjà réveillée, dix observations → aucune action) ; `a rate-limited idle lead is logged once and not woken` ; `an active lead is never woken` ;
  - `unseenChanges reports what the next wait would, and writes no snapshot` (`test/wait.test.js`) ;
  - `two targeted passes at once wake the lead once` (`test/watcher.test.js`) : projet de `setupProject` plus une tâche `c` sans dépendance ; lead du faux agent inactif (rôle `waiting`, inscrit dans `lead.json`) ; `a` et `c` lancées par `startTask` (le test joue le lead) et finies par leurs équipiers ; puis deux `relaylead watcher run --mission demo` lancés ensemble → une seule ligne `woken:` dans le journal du lead, une seule ligne `wake-lead` ;
  - `task done and answer start a targeted pass only when helpers are on` (`test/cli.test.js`, `spawnDetached` remplacé) ;
  - `the lead method ends the turn only when no task runs` (`test/catalog.test.js`) : `code.md` nomme `relaylead wait --timeout 0` et « end your turn » ;
  - `an idle lead is woken when a crew member finishes` (`test/e2e/continuity.test.js`, dont la configuration machine porte `"context": {"windowTokens": 1000000}` pour qu'aucune relève ne vienne, sauf au scénario de relève de la Task 9 ; dépôt jouet, `RELAYLEAD_FAKE_LEAD_ENDS_TURN=1`, `helpers: true`, aucun passage complet) : la mission finit `done`, la question répondue ; le journal du lead compte au moins deux `woken:` ; chaque tâche a `attempt` 1 et une seule session d'équipier ;
  - `fake mission delivers two tasks with one answered question` (existant) reste vert avec la nouvelle conduite du faux lead.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): réveil du lead à la fin d'un équipier, à une réponse ou au courrier`.

### Task 8 : relance du lead absent et disjoncteur

**Files :** modifier `core/missions.js`, `core/watcher-rules.js`, `core/watcher.js`, `test/watcher-rules.test.js`, `test/watcher.test.js`, `test/missions.test.js`, `test/e2e/continuity.test.js`, `README.md`.

Règles 8 et 9. Le démon de Claude relance seul un lead tué (`kill -9`) ; il ne relance ni une session arrêtée, ni rien après un redémarrage : c'est le veilleur qui le fait, en reprenant la même session si son contexte est bas, sinon par une session neuve. Les actions du lead passent par `relaylead` et sont idempotentes : un lead relancé qui rejoue une commande ne refait rien.

**Interfaces :**
- `core/missions.js` :
  - `launchLead(mission, {section} = {}) -> Promise<Session>`, sorti de `createMission` (qui l'appelle sans `section`) : nom `<mission>/lead/<n>`, `n` = nombre de sessions du registre dont le nom commence par `<mission>/lead/`, plus 1 ; consigne = `leadPrompt(method, mission)` suivie de `section` ; écrit `lead.json` et le registre. Une `section` ne commence jamais par « - ».
  - `stopMission(name, {note} = {})` : `note` va dans l'état `stopped` écrit par le cœur.
- `relaunch-lead` (`act`) : `{type: 'relaunch-lead', resume}` ; `resume` vrai → `adapter.wake(ancienne session, texte de reprise)` et `recordSession` ; s'il lève, ou `resume` faux → `launchLead(mission, {section: <section « Restart »>})`. Réussite : `lastRelaunchAt` = maintenant, `leadLostSince` = `null`. Échec des deux : `failedRelaunches` + 1, `lastRelaunchAt` = `null`, journal `error relaunch-lead: <message>`.
- `trip-breaker` : exécutée **après** la sortie du verrou de mission (`stopMission` le prend lui-même) : `stopMission(name, {note: 'stopped by the watcher: the lead could not be restarted 3 times in a row'})`, `writeJournal(name, 'watcher', <même texte>)`, journal du veilleur. Les canaux d'alerte viennent au lot 3.

- [ ] **Étape 1 : tests qui échouent** :
  - règles : `an absent lead is resumed when its context is known and low` ; `an absent lead is relaunched as a new session when its context is high or unknown` ; `a lead restarting by itself is not relaunched during the grace` ; `a relaunch counts as failed when the lead is absent again with no heartbeat since` ; `a heartbeat after the relaunch resets the count` ; `the breaker trips after 3 failed relaunches in a row` ;
  - intégration :
    - `a failed resume falls back to a new lead session in the same pass` : `fake.wake` qui lève → `lead.json` nomme `demo/lead/2`, sa consigne porte « ## Restart » ;
    - `a relaunch that throws counts once` : `fake.wake` et `fake.launch` qui lèvent → `failedRelaunches` 1 et `lastRelaunchAt` `null` ; un second passage → 2 ;
    - `the breaker stops the mission and says why` : `watch.json` à `failedRelaunches: 2`, `lastRelaunchAt` ancien, lead absent sans battement depuis → état `stopped` avec la note, ligne dans `journal.log` et `breaker-tripped` ;
    - `a lead restarted by its agent after the watcher relaunched it is stopped as an extra lead` : lead `working` sans processus au-delà de la grâce (`list` remplacée) → `demo/lead/2` lancé ; puis l'ancien listé avec un processus → passage suivant : `stop-extra-lead` ;
    - `a stop during a relaunch leaves no lead running` : `relaylead stop` lancé pendant que `launchLead` attend (`fake.launch` retardé de 1 s) → à la fin, aucune session de la mission vivante, état `stopped` ;
  - `a lead killed in the middle of a mission is resumed and the mission ends without loss` (`test/e2e/continuity.test.js`) : dépôt jouet, `helpers: true` ; dès que `a` tourne, `killSession(lead)` ; `relaylead watcher run` lancé toutes les secondes jusqu'à la relance ; la mission finit `done` ; `lead.json` nomme toujours `…/lead/1` (reprise) ; chaque tâche a `attempt` 1, une seule session d'équipier par tâche, `a.txt` et `b.txt` livrés une fois.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): relance du lead absent et disjoncteur`.

### Task 9 : relève du lead, contexte plein d'un équipier

**Files :** modifier `core/missions.js`, `core/tasks.js`, `core/cli.js`, `core/messages.js`, `core/watcher-rules.js`, `core/watcher.js`, `catalog/profiles/lead.md`, `catalog/profiles/developer.md`, `catalog/methods/code.md`, `adapters/fake/agent.js`, `test/watcher-rules.test.js`, `test/watcher.test.js`, `test/cli.test.js`, `test/catalog.test.js`, `test/e2e/continuity.test.js`, `README.md`.

Règles 7 et 10 à 13 du tableau, d'après la spec (« Cycle de vie », 3) : au seuil souple, le lead finit son étape, écrit `handover` et finit son tour ; le veilleur arrête l'ancien et lance le suivant dans le même passage. Au seuil dur, la relève se fait sans lui. Un équipier au seuil dur commite, échoue avec « context full » et le lead relance la tâche.

**Interfaces :**
- Environnement des sessions : `launchLead` ajoute `RELAYLEAD_ROLE: 'lead'` et `RELAYLEAD_SESSION: <nom>` ; `launchCrew` ajoute `RELAYLEAD_ROLE: 'crew'` et `RELAYLEAD_SESSION: <nom>`.
- `core/missions.js` : `STATES` = `['starting', 'working', 'waiting', 'handover', 'done']` ; `setState(name, state, note, {by} = {})` écrit `by` dans `state.json` pour `handover` (`by` = `RELAYLEAD_SESSION` de l'appelant, sinon `'user'`).
- `core/cli.js` :
  - `checkCurrentLead(mission, env)` : si `env.RELAYLEAD_ROLE === 'lead'` et que `env.RELAYLEAD_SESSION` diffère du `sessionName` de `lead.json` → `not-current-lead` `{session, mission, current}`. Appelé par `state set`, `task start|retry|deliver` et `question ask`. Un lead lancé avant ce lot (sans ces variables) n'est pas contrôlé.
  - `state set handover` lance un passage ciblé (`spawnDetached`, si `helpers`).
- `hand-over` (`act`) : `{type: 'hand-over', forced, note, tokens}` : `stopSessionsAndWait(mission, [ancien lead])` s'il a un processus (un échec : action levée, rien d'autre ne change) ; `launchLead(mission, {section: <section « Handover »>})` ; `writeState` `{state: 'starting', note: 'taken over from <ancien>: <note ou « forced at <tokens> tokens »>'}` ; `handoverNoticeFor` = `null`.
- `mail` (`act`) : `{type: 'mail', shortId, text, log}` → `sendMail`.
- Erreur `not-current-lead` (en / fr) : « this session ({session}) is no longer the lead of mission "{mission}": {current} took over; end your turn » / « cette session ({session}) n'est plus le lead de la mission « {mission} » : {current} a pris le relais ; terminez votre tour ».
- Consignes : `lead.md` : section « Handing over » (sur l'avis de relève : finir l'étape, `relaylead state set handover --note "…"`, finir son tour ; la note dit où en est la mission en une ligne) ; `bad-state` liste `handover`. `developer.md` : sur le message « context full » : commiter ce qui est fait, `relaylead task fail <id> --summary "context full: …"`, finir son tour.
- Faux agent : un lead qui reçoit un message contenant `relaylead state set handover` lance `relaylead state set handover --note "fake handover"` puis `endTurn()` ; un équipier qui reçoit `relaylead task fail` lance `relaylead task fail <id> --summary "context full: fake"` et s'arrête.
- README (en, fr) : relève, réglage `context` (budgets par rôle, plafond, marge dure, fenêtre par défaut), exemple de seuil forcé bas dans `.relaylead.json`.

- [ ] **Étape 1 : tests qui échouent** :
  - règles : `a handover asked by the current lead or the user hands over` ; `a handover asked by a replaced lead is ignored` ; `a lead past the hard threshold is handed over without its note` ; `a lead past the soft threshold gets one notice` ; `a high base is logged once` ; `a crew member past the hard threshold gets one context-full mail` ; `an unknown or stale context triggers nothing` ; `an absent lead with a handover asked is handed over, not resumed` ;
  - intégration : `a handover stops the old lead, starts the next one and writes starting` : `lead.json` → `demo/lead/2`, consigne avec « ## Handover » et la note, ancien lead fini, `state.json` = `{state: 'starting', note: 'taken over from demo/lead/1: <note>'}` ;
  - `a replaced lead can no longer drive the mission` (`test/cli.test.js`) : env `RELAYLEAD_ROLE=lead`, `RELAYLEAD_SESSION=demo/lead/1`, `lead.json` sur `demo/lead/2` → `state set working`, `task start a`, `question ask …` rendent 1 avec `not-current-lead`, rien ne change ; avec `demo/lead/2`, les trois passent ;
  - `state set handover records who asked and starts a targeted pass` ;
  - `the lead and developer profiles say how to hand over` (`test/catalog.test.js`) ;
  - `a lead past a low threshold hands over and the mission ends without loss` (`test/e2e/continuity.test.js`) : dépôt jouet, `.relaylead.json` `{"context": {"budgets": {"lead": 6000}}}`, `helpers: true`, `relaylead watcher run` toutes les secondes ; la mission finit `done` ; au moins `…/lead/2` dans le registre, chaque ancien lead fini ; chaque tâche a `attempt` 1 et une seule session d'équipier ; les deux tâches livrées une fois.
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts.
- [ ] **Étape 5 :** commit `feat(veilleur): relève du lead au seuil de contexte, contexte plein d'un équipier`.

### Task 10 : boucle du veilleur, lancée par `launch`

**Files :** modifier `core/watcher.js`, `core/cli.js`, `core/messages.js`, `test/watcher-loop.test.js` (nouveau), `test/missions.test.js`, `README.md`.

Lancement explicite du veilleur, à la place de launchd jusqu'au lot 4 : une boucle détachée qui passe toutes les `watcher.everySeconds` secondes, lancée par `relaylead launch` et finie d'elle-même quand plus aucune mission n'a besoin d'elle.

**Interfaces :**
- `core/watcher.js` :
  - `loop()` (`relaylead watcher loop`, interne, absent de l'aide) : écrit `watcher-loop.json` ; enchaîne `runPass()`, puis une attente découpée en pas d'une seconde jusqu'à `everySeconds` ; réécrit `beatAt` toutes les 30 s et `lastPassAt` après chaque passage ; à chaque pas, si `watcher-loop.stop` existe, le retire, retire `watcher-loop.json` et sort ; après un passage qui rend `missions: 0`, retire `watcher-loop.json` et sort. `STOP` présent : les passages ne font rien, la boucle continue.
  - `watcherRunning() -> {running, since, lastPassAt}` : en marche si `beatAt` a moins de 90 s. Jamais de jugement par PID.
  - `startWatcher() -> 'started'|'already'|'nothing'` : `'already'` si en marche ; `'nothing'` si aucune mission à veiller ; sinon `spawnDetached(['watcher', 'loop'])`, puis attente (5 s au plus) de `watcher-loop.json`. Deux boucles lancées en même temps sont sans danger : `watcher.lock` sérialise leurs passages.
  - `stopWatcher() -> 'stopped'|'requested'|'not-running'` : écrit `watcher-loop.stop`, attend 10 s au plus que `watcher-loop.json` disparaisse ; sinon `'requested'` (un passage long est en cours).
- `core/cli.js` : `relaylead watcher start|stop|status` (refusés dans une session) ; `relaylead launch`, après avoir imprimé le nom, appelle `startWatcher()` si `loadConfig().watcher.autoStart` ; un échec imprime `watcherNotStarted` sur la sortie d'erreur, le code reste 0.
- `everySeconds` : entier d'au moins 1, sinon 300.
- Messages (en / fr) :
  - `watcherStarted` : « watcher started: it checks the missions every {seconds} s and ends once none needs it\n » / « veilleur lancé : il passe sur les missions toutes les {seconds} s et s'arrête quand aucune n'en a besoin\n » ;
  - `watcherAlreadyRunning` : « the watcher is already running (since {since})\n » / « le veilleur tourne déjà (depuis {since})\n » ;
  - `watcherNothingToWatch` : « no mission to watch; the watcher was not started\n » / « aucune mission à veiller ; le veilleur n'a pas été lancé\n » ;
  - `watcherStopped` : « watcher stopped\n » / « veilleur arrêté\n » ;
  - `watcherStopRequested` : « the watcher stops once its current pass is over\n » / « le veilleur s'arrête à la fin de son passage en cours\n » ;
  - `watcherNotRunning` : « the watcher is not running\n » / « le veilleur ne tourne pas\n » ;
  - `watcherStatusRunning` : « watcher running since {since}; last pass {lastPass}\n » / « veilleur en marche depuis {since} ; dernier passage {lastPass}\n » ;
  - `watcherNotStarted` : « relaylead launch: the watcher could not be started ({detail}); start it with: relaylead watcher start\n » / « relaylead launch : le veilleur n'a pas pu être lancé ({detail}) ; lancez-le avec : relaylead watcher start\n ».
- README (en, fr) : section « Continuity » / « Continuité » : le veilleur, ses commandes, `STOP`, `watcher.log`, `watcher.autoStart`, `watcher.helpers`, `watcher.everySeconds` ; la boucle ne survit pas au redémarrage de la machine tant que `relaylead install` (lot 4) ne l'a pas confiée à launchd.

- [ ] **Étape 1 : tests qui échouent** (`test/watcher-loop.test.js`, `everySeconds: 1`) :
  - `watcher start runs passes until stopped, and status says so` : `lastPassAt` avance ; `stop` → `watcherStopped`, `watcher-loop.json` absent ;
  - `a second start finds the watcher running` ;
  - `the loop ends by itself once no mission needs watching` : la mission passe `stopped`, la boucle sort ;
  - `start with no mission to watch starts nothing` ;
  - `a loop beat older than 90 s is not a running watcher` ;
  - `launch starts the watcher when autoStart is on, and not otherwise` (`test/missions.test.js`).
- [ ] **Étape 2 :** échecs attendus.
- [ ] **Étape 3 :** implémenter.
- [ ] **Étape 4 :** tests verts ; `npm test` complet sur les trois systèmes par la CI.
- [ ] **Étape 5 :** commit `feat(veilleur): boucle détachée lancée par launch, commandes start, stop et status`.

### Task 11 (humain) : la continuité essayée avec Claude Code sur macOS

**Files :** créer `docs/manual-checks/lot-2a-claude-macos.md` (procédure et relevé, même forme que ceux des lots 1 et 1.1).

Couvre le « Terminé quand » du lot sous macOS, à la place de Linux : lead tué en pleine mission, relève à seuil forcé bas, lead inactif réveillé à la fin d'un équipier ; survie d'un équipier, relance par le démon après `kill -9`, hooks `Stop` et `StopFailure`. Tout se fait dans un `RELAYLEAD_HOME` jetable ; missions et sessions sont nommées `rl-2a-…`, arrêtées et supprimées à la fin.

- [ ] **Étape 1 : préparation.** `npm link` depuis `main` après la Task 10 ; relever `claude --version` et `relaylead --version`. `export RELAYLEAD_HOME=<dossier temporaire neuf>/home` et y écrire `config.json` = `{"watcher": {"everySeconds": 60}}`. Noter l'empreinte (`shasum`) de `~/.claude/settings.json` et la liste de `~/.relaylead`. Pour chaque scénario, copier `fixtures/toy-repo/` dans un dossier temporaire neuf nommé comme la mission, `git init -b main`, tout commiter, lancer `claude` une fois et accepter « Yes, I trust this folder ».
- [ ] **Étape 2 : lead tué (`rl-2a-kill`).** `relaylead launch --agent claude --name rl-2a-kill --request "Do the tasks in tasks/"` ; `relaylead watcher status` → en marche. Dès que `a` tourne (`relaylead task list --mission rl-2a-kill`), `kill -9` du PID du lead (lu dans `claude agents --json`). Relever : relance par le démon (délai, même id, nouveau PID), ligne `lead-restarting` éventuelle, aucun lead de trop ; l'équipier de `a` continue (survie d'un équipier). Puis `claude stop <id court du lead>` : relever la ligne `relaunch-lead … resumed` ou `as …` au passage suivant (60 s au plus) et le texte de reprise dans la session (`claude attach`, lecture seule). Répondre à la question de `b` ; attendre `done`. Vérifier : chaque `tasks/<id>.json` à `attempt` 1, une session d'équipier par tâche, les deux tâches livrées une fois, `npm test` vert sur l'intégration.
- [ ] **Étape 3 : relève (`rl-2a-relay`).** Commiter `.relaylead.json` = `{"context": {"budgets": {"lead": 20000}}}` ; lancer. Relever : `context/<id>.json` (fenêtre, base) et `heartbeats/<id>.json` écrits ; **si la barre d'état est réécrite pendant un long tour** (comparer son `at` à celui du battement pendant un `wait`) ; ligne `notify-handover`, puis `state set handover` par le lead, ligne `hand-over … to rl-2a-relay/lead/2`, ancien lead arrêté ; la mission finit `done` sans tâche refaite (mêmes vérifications qu'à l'étape 2).
- [ ] **Étape 4 : lead inactif réveillé (`rl-2a-wake`).** Lancer. Dès que `a` tourne, `claude respawn <id court du lead>` : relever que le lead redevient `blocked`/`idle` (inactif) pendant que l'équipier travaille. À la fin de l'équipier, relever la ligne `wake-lead …: task a is now done`, la sortie « woke session <même id> » (journal du passage ciblé), puis la livraison de `a`. Quand le lead attend la réponse de `b` (état `waiting`, tour fini, battement `(stop)` = hook `Stop`), attendre deux passages sans réveil, puis répondre : relever le réveil et la fin `done`.
- [ ] **Étape 5 : `StopFailure`.** `node fixtures/fake-429.js` → port. Copier le fichier de réglages d'une session de `rl-2a-wake` (`missions/rl-2a-wake/settings/…json`) vers un fichier temporaire, y ajouter `"ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>"` dans `env`, puis, dans le dossier de `rl-2a-wake` : `claude --bg --name rl-2a-limit --settings <fichier> --setting-sources project,local --strict-mcp-config "Reply OK."`. Relever `failures/<id court>.json` (`error: rate_limit`, message avec l'heure de reprise) et la ligne `session-failure` du passage suivant. `claude stop` puis `claude rm` de `rl-2a-limit` ; arrêter le faux serveur.
- [ ] **Étape 6 : ménage.** `relaylead watcher stop` ; pour chaque mission, `relaylead stop`, puis `relaylead remove` ; `claude agents --json --all`, filtré sur les dossiers d'essai (une copie perd son nom `rl-`) : `claude stop` puis `claude rm` de tout reste ; supprimer les dossiers d'essai et le `RELAYLEAD_HOME` jetable. Vérifier que l'empreinte de `~/.claude/settings.json` et le contenu de `~/.relaylead` n'ont pas changé, et que `~/Library/LaunchAgents` ne contient rien de Relaylead.
- [ ] **Étape 7 :** relevé (tableau : durées, sessions lancées, lignes de `watcher.log`, délais de réveil et de relance, barre d'état pendant un tour long, refus du garde-fou, restes) ; commit `docs(essai): continuité du lot 2a avec Claude Code sur macOS`. Chaque défaut trouvé devient une issue.

---

## Risques et questions tranchées

1. **Planificateur du système.** La feuille de route range « planificateur du système » au lot 2a, mais sa règle commune interdit toute écriture dans la configuration de l'utilisateur hors `relaylead install`, qui vient au lot 4 ; enregistrer launchd écrit un fichier dans `~/Library/LaunchAgents`. Tranché : le lot 2a livre le contrat que launchd appellera (`relaylead watcher run` : un passage, un verrou, rapide, idempotent) et un lancement explicite (`relaylead watcher start`, boucle détachée lancée aussi par `relaylead launch`, finie d'elle-même) ; l'enregistrement launchd, l'erreur codée « plateforme non prise en charge » ailleurs et la question de l'environnement minimal de launchd (`PATH` sans `claude`) passent au lot 4. La boucle est portable et testée par la CI sur les trois systèmes.
2. **Comment le lead attend.** La boucle `relaylead wait --timeout 540` relit tout le contexte du lead à chaque retour, même la nuit quand seule une réponse humaine peut débloquer. Tranché : `wait` tant qu'une tâche tourne (les équipiers finissent en minutes), fin de tour quand rien ne tourne, réveil par Relaylead. `wait --timeout 0` juste avant la fin du tour rafraîchit l'instantané et attrape un changement de dernière seconde.
3. **Qui réveille.** La spec dit « le veilleur (ou l'outil, appelé par l'équipier en fin de tâche) ». Tranché : `task done|fail`, `answer` et `state set handover` lancent un passage ciblé détaché (la commande de l'équipier rend la main aussitôt, le réveil survit à l'arrêt de l'équipier) ; la boucle rattrape ce qu'un passage ciblé a manqué. Un réglage machine `watcher.helpers` les coupe (tests).
4. **Réponse pendant la fin du tour.** Une réponse qui arrive entre le dernier regard du lead et la fin de son tour voit un lead encore actif : son passage ciblé ne réveille pas. Tranché : accepté, le passage suivant de la boucle (5 min au plus) réveille ; le `wait --timeout 0` réduit la fenêtre à une réponse du modèle.
5. **Réveils en boucle.** Un lead réveillé qui ne fait rien et finit son tour ne doit pas être réveillé à chaque passage. Tranché : réveil pour des changements non vus une seule fois par vue (`lastWakeView`), pour un tour interrompu une seule fois par état (`interruptWakeFor`), pas de réveil sur limite d'usage (lot 2b). Un lead qui réécrit `working` à chaque réveil puis s'arrête coûte au plus un tour par passage ; accepté, le relevé réel le dira.
6. **Tour fini pendant que la mission travaille** (`claude respawn` d'une mise à jour, tour abandonné, fin de tour par erreur). Tranché : lead inactif dont l'état vaut `working` ou `starting` → réveil « turn ended while working » (règle 17), qui couvre l'exigence de la spec après `respawn`.
7. **Source du contexte.** Tranché : transcript lu par `PostToolUse` à chaque action (frais même dans un tour de plusieurs heures) et barre d'état de mesure (exacte, et seule à donner la fenêtre) ; le plus récent des deux ; fenêtre par défaut 200 000 sans barre d'état : une relève trop tôt ne perd rien, une relève trop tard tombe sur la compaction automatique. La barre d'état servira aussi les limites d'usage au lot 2b.
8. **Budgets de contexte par rôle, pas par profil.** La spec dit « budget par profil » ; un seul profil d'équipier existe. Tranché : `context.budgets.lead` et `context.budgets.crew`, réglables aux trois niveaux ; un budget par profil viendra avec un second profil d'équipier.
9. **Qui calcule les seuils.** Tranché : le veilleur, pas les hooks. Les hooks restent rapides et ne font que relever ; toutes les règles vivent dans `decide`, testable sans processus. Le retard (5 min au plus, moins avec un passage ciblé) tient dans la marge du seuil dur (+20 %).
10. **Adresse du courrier.** Tranché : l'id court de la session, pas le rôle. Après une relève, le courrier de l'ancien lead n'a plus d'objet : le nouveau lit les fichiers. Le hook n'a besoin d'aucune règle de rôle.
11. **Reprise ou session neuve.** Tranché : reprise (`wake`) si le dernier relevé de contexte est connu et sous le seuil souple, sinon session neuve ; une reprise ratée tombe sur une session neuve dans la même relance. Un contexte inconnu donne une session neuve, qui ne peut pas échouer sur le contexte.
12. **Disjoncteur.** Une relance « ratée » : elle lève, ou le lead relancé est de nouveau absent sans aucun battement depuis. Trois d'affilée arrêtent la mission (`stopMission`, note, `journal.log`, `watcher.log`). Les canaux d'alerte (`system`, `ntfy`…) viennent au lot 3.
13. **Bloqué ou en attente.** Tranché : jamais d'arrêt ; un lead actif sans battement depuis 30 min est signalé une fois (`lead-silent`). Une commande Bash est bornée à 10 min (`BASH_DEFAULT_TIMEOUT_MS`), et `wait` à 9 min : 30 min de silence sont anormales sans être une raison d'arrêter.
14. **Relève d'un équipier.** Tranché : seulement au seuil dur, par un courrier qui demande de commiter et d'échouer avec « context full: … » ; le lead relance la tâche, sur la même branche, avec ce résumé. La tentative compte dans `maxAttempts` : une tâche trop grande pour deux contextes échoue pour de bon et le lead le signale. Le seuil souple d'un équipier ne fait rien.
15. **#71 et l'état de Claude après `stop`.** L'essai a montré qu'une reprise lancée avant la fin du processus crée une copie. Tranché : la liste fait foi, puis au plus 5 s d'attente du PID d'avant l'arrêt (sous POSIX un PID n'est pas repris en quelques secondes ; sous Windows le délai borne le défaut), puis la détection de copie existante. L'essai réel relève si la ligne garde son PID jusqu'à la fin du processus.
16. **Lead actuel.** Tranché : `RELAYLEAD_ROLE` et `RELAYLEAD_SESSION` passés à chaque session ; les commandes de pilotage d'un lead qui n'est plus celui de `lead.json` sont refusées (`not-current-lead`). Un lead lancé avant ce lot n'est pas contrôlé.
17. **État après une relève.** Le cœur écrit `starting` avec une note, comme il écrit déjà `stopped` : le nouveau lead déclare `working` lui-même. Une relève ratée laisse `handover`, rejouée au passage suivant et comptée par le disjoncteur.
18. **`StopFailure` au lot 2a.** Tranché : relevé et journalisé, et un lead arrêté sur `rate_limit` n'est pas réveillé ; la pause, l'heure de reprise et la reprise relèvent du lot 2b. Le faux serveur 429 sert à l'essai réel, jamais au produit : Relaylead ne prend jamais `ANTHROPIC_BASE_URL` d'une configuration.
19. **Journal du veilleur.** Tranché : une ligne par action, en anglais, rien quand rien n'est fait ; bascule vers `watcher.log.1` au-delà de 1 Mio (une seule génération). Le `journal.md` court de la mission et son archive (spec, « Où vivent les choses ») ne sont pas de ce lot.
20. **Tests.** Toute mission de test a le veilleur coupé, sauf les tests qui l'éprouvent ; les passages des tests e2e sont lancés à la main (`relaylead watcher run`), jamais par la boucle, pour rester déterministes et ne laisser aucun processus.

## Hors périmètre

- **Limites d'usage, pause et reprise, priorités, jetons de travaux lourds** : lot 2b (le relevé `failures/` et la barre d'état de mesure leur servent de base).
- **Canaux d'alerte** (`system`, `ntfy`, `command`, `agent`) : lot 3 ; ici, `watcher.log` et `journal.log`.
- **Enregistrement launchd, `install`, `uninstall`, `doctor`, environnement minimal de launchd** : lot 4.
- **Essais réels sous Linux et Windows** : supprimés par la décision macOS seulement ; la CI garde les trois systèmes avec le faux agent.
- **Budget de contexte par profil**, limite en nombre de tours ou en durée (troisième source de la spec, pour un agent sans transcript ni barre d'état) : pas d'agent qui en ait besoin.
- **`journal.md` de mission et archive quotidienne**, battement externe facultatif, résumé quotidien.
- **Commande pour créer ou retirer `STOP`** : un fichier suffit, la spec le nomme ainsi.
