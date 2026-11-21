# Relaylead (codename)

Hand a mission to a lead agent that runs it in the background with its own team of specialist agents: it splits the work, launches disposable crew sessions, gets their work reviewed and delivered, asks you only when it must, hands over to a fresh session when its context fills up, and pauses before usage limits to resume on its own.

**Status: first skeleton.** The first adapter targets Claude Code; the core is agent-agnostic. MIT licensed, no telemetry, macOS, Linux and Windows.

## Install

Prerequisites:

- Node.js 18 or newer;
- Claude Code 2.1.325 or newer, signed in;
- a git repository whose tasks are committed in a `tasks/` folder, one Markdown file per task (`title`, and optionally `depends` and `ask`, in a front matter);
- the folder trusted once in Claude Code: run `claude` in it and accept.

From a clone of this repository, run `npm link`: the `relaylead` command is then on your PATH.

## Use

From the root of your repository:

- `relaylead launch --agent claude --request "Carry out the tasks"` starts a mission and prints its name;
- `relaylead list` lists the missions and their state;
- `relaylead question list <mission>` shows the questions the lead is waiting on;
- `relaylead answer <mission> <question id> <choice>` answers one (a number or the text of an option);
- `relaylead show <mission>` opens the lead's session;
- `relaylead stop <mission>` stops the mission and all its sessions;
- `relaylead remove <mission>` removes a finished (done or stopped) mission, so its name, by default the folder's, can be used again.

The work lands on the branch `relaylead/integration`; your own checkout is never changed.

A failed task can be tried again with `relaylead task retry <id> --mission <mission>`: a new session works on the same branch, told how the earlier attempt failed (the lead does it on its own when a new try can help). Each task gets at most `maxAttempts` attempts (`2` by default, in `.relaylead.json`); the earlier ones are kept in the mission's state folder, under `~/.relaylead/missions/<mission>/tasks/archive/<id>.<n>.json`.

Each task works in its own worktree, under `.relaylead/worktrees/`. When a mission is stopped or done, its clean task worktrees are removed, **ignored files included** (`node_modules`, build output); their branches stay, so no commit is lost. A worktree with changes not committed, or whose session is still running, is kept and reported: commit or remove those changes, or wait for the session to end, then run `relaylead stop <mission>` again to clean up.

Relaylead's own commits on the integration branch (the merge of each task, the merge of your current branch at launch, the commit of each task's state line) run your git hooks, with `LC_ALL=C`: Relaylead runs git in English to read its messages, and your hooks inherit it. When a hook refuses a task's merge, nothing is merged and the task stays done; the lead asks you what to do, with the hook's output. Fix the cause on the task's branch and answer "I fixed it: deliver again", or deliver it yourself without the hooks with `relaylead task deliver <id> --no-hooks --mission <mission>` (a mission session cannot). `"delivery": {"runHooks": false}` in `.relaylead.json` (`true` by default) makes every Relaylead commit skip the hooks, from the next launch on. These hooks run in the integration worktree `.relaylead/worktrees/_integration`, where no dependency is installed: a hook that calls a tool from `node_modules` (husky, commitlint, lint-staged) fails there, so such projects set `"delivery": {"runHooks": false}` in `.relaylead.json`, or deliver with `--no-hooks`.

`relaylead remove <mission>` deletes the mission's task worktrees, **ignored files included**, its task branches `relaylead/<mission>/…` and its state under `~/.relaylead/missions/`. It keeps the integration branch and its worktree, with the delivered work. It refuses, before deleting anything, a task branch with commits not merged into the integration branch, or a task worktree with changes not committed or locked (`git worktree lock`), and names them; and, even with `--force`, your own checkout on one of its task branches. `relaylead remove <mission> --force` deletes them anyway; it prints each deleted branch with its last commit, so it can be made again with `git branch <name> <commit>` while git keeps that commit.

### Dependencies

The `developer` profile may only run `npm ci --ignore-scripts` and `npm install --ignore-scripts`, exactly: install scripts run third-party code with your rights, and the guard only sees the `npm` command. This guards against an agent installing out of habit, not against a hostile session: `node *`, `npm test` and git aliases still run code. A project that needs install scripts adds, knowingly, `"guard": {"allow": ["Bash(npm ci)"]}` to `.relaylead.json`. The `all` mode stays an explicit choice that blocks nothing: `npm ci` is allowed there and **runs the install scripts**.

Design documents are in French for now:

- [Design](docs/specs/2026-11-14-relaylead-design.md)
- [Roadmap to v1](docs/plans/2026-11-15-feuille-de-route.md)
- [Spike results on Claude Code](docs/spike-results.md)

## Continuity

A watcher, without AI, looks after the missions that are not finished: it stops a second lead, or a crew session whose task no longer runs, and writes what it sees (a failed session, a silent lead) to its log.

- `relaylead launch` starts the watcher's loop, and says so on stderr: it passes over the missions every `watcher.everySeconds` seconds (`300` by default) and ends by itself once no mission needs it. `"watcher": {"autoStart": false}` turns this off.
- `relaylead watcher start` starts the loop; `relaylead watcher stop` stops it, and that stop holds until the next `relaylead watcher start` or `relaylead launch`; `relaylead watcher status` says whether it runs, and when it last passed.
- `relaylead watcher run` makes one pass now, `--mission <mission>` for that mission alone.
- `watcher.helpers` (`true` by default): the short passes Relaylead starts on its own right after an event of a mission; `false` turns them off.
- An empty file `~/.relaylead/STOP` makes the watcher do nothing until you remove it; its loop keeps running.
- Each action of the watcher is a line of `~/.relaylead/watcher.log`, moved to `watcher.log.1` past 1 MiB.

The lead waits with `relaylead wait` while a task runs, and ends its turn when it only waits for you: your answer (`relaylead answer`), or the end of a crew member's task, wakes it within seconds. A lead that does not respond to its wakes is reported `lead-stuck` in the log, never stopped: run `relaylead show <mission>` and write to it.

A lead whose session ends while the mission works (killed, or after a restart of the machine) is restarted by the watcher: the same session when its context is still low, otherwise a new lead session that starts again from the files. After 3 restarts in a row that fail, the watcher stops the mission and says why in its state and in `journal.log`.

The `watcher` settings are read from `~/.relaylead/config.json` only. The loop does not survive a restart of the machine until `relaylead install` (to come) hands it to launchd: after a restart, run `relaylead watcher start`.

## Develop

Run the tests with `npm test` (Node.js 18 or newer, no dependencies to install).

`RELAYLEAD_WRITE_RETRY_MS` sets how long (in ms) a state file write is retried on Windows when another process holds the file (2000 by default).

---

Confiez une mission à un lead qui la mène en arrière-plan avec son équipe d'agents spécialisés. Premier squelette ; la documentation de conception est en français.

## Installer

Prérequis :

- Node.js 18 ou plus ;
- Claude Code 2.1.325 ou plus, connecté ;
- un dépôt git dont les tâches sont commitées dans un dossier `tasks/`, un fichier Markdown par tâche (`title`, et au besoin `depends` et `ask`, dans un en-tête) ;
- le dossier approuvé une fois dans Claude Code : lancez `claude` dedans et acceptez.

Depuis un clone de ce dépôt, lancez `npm link` : la commande `relaylead` est alors sur votre PATH.

## Utiliser

À la racine de votre dépôt :

- `relaylead launch --agent claude --request "Réalise les tâches"` lance une mission et affiche son nom ;
- `relaylead list` liste les missions et leur état ;
- `relaylead question list <mission>` montre les questions qu'attend le lead ;
- `relaylead answer <mission> <id de la question> <choix>` y répond (un numéro ou le texte d'une option) ;
- `relaylead show <mission>` ouvre la session du lead ;
- `relaylead stop <mission>` arrête la mission et toutes ses sessions ;
- `relaylead remove <mission>` supprime une mission finie (terminée ou arrêtée), pour que son nom, par défaut celui du dossier, serve de nouveau.

Le travail arrive sur la branche `relaylead/integration` ; votre propre copie de travail ne change jamais.

Une tâche en échec peut être relancée avec `relaylead task retry <id> --mission <mission>` : une nouvelle session travaille sur la même branche, en sachant comment la tentative précédente a échoué (le lead le fait de lui-même quand un nouvel essai peut aider). Chaque tâche a au plus `maxAttempts` tentatives (`2` par défaut, dans `.relaylead.json`) ; les précédentes sont gardées dans le dossier d'état de la mission, sous `~/.relaylead/missions/<mission>/tasks/archive/<id>.<n>.json`.

Chaque tâche travaille dans son propre worktree, sous `.relaylead/worktrees/`. À l'arrêt ou à la fin d'une mission, ses worktrees de tâche propres sont retirés, **fichiers ignorés compris** (`node_modules`, sorties de build) ; leurs branches restent, aucun commit n'est perdu. Un worktree avec des modifications non commitées, ou dont la session tourne encore, est gardé et signalé : committez ou retirez ces modifications, ou attendez la fin de la session, puis relancez `relaylead stop <mission>` pour refaire le ménage.

Les commits propres à Relaylead sur la branche d'intégration (la fusion de chaque tâche, la fusion de votre branche courante au lancement, le commit de la ligne d'état de chaque tâche) jouent vos hooks git, avec `LC_ALL=C` : Relaylead lance git en anglais pour lire ses messages, et vos hooks en héritent. Quand un hook refuse la fusion d'une tâche, rien n'est fusionné et la tâche reste faite ; le lead vous demande quoi faire, avec la sortie du hook. Corrigez la cause sur la branche de la tâche et répondez « I fixed it: deliver again », ou livrez-la vous-même sans les hooks avec `relaylead task deliver <id> --no-hooks --mission <mission>` (une session de mission ne le peut pas). `"delivery": {"runHooks": false}` dans `.relaylead.json` (`true` par défaut) fait passer tous les commits de Relaylead sans les hooks, à partir du lancement suivant. Ces hooks tournent dans le worktree d'intégration `.relaylead/worktrees/_integration`, où aucune dépendance n'est installée : un hook qui appelle un outil de `node_modules` (husky, commitlint, lint-staged) y échoue ; ces projets mettent donc `"delivery": {"runHooks": false}` dans `.relaylead.json`, ou livrent avec `--no-hooks`.

`relaylead remove <mission>` supprime les worktrees de tâche de la mission, **fichiers ignorés compris**, ses branches de tâche `relaylead/<mission>/…` et son état sous `~/.relaylead/missions/`. Il garde la branche d'intégration et son worktree, avec le travail livré. Il refuse, avant de rien supprimer, une branche de tâche dont des commits ne sont pas fusionnés dans la branche d'intégration, ou un worktree de tâche avec des modifications non commitées ou verrouillé (`git worktree lock`), et les nomme ; et, même avec `--force`, votre propre copie de travail sur une de ses branches de tâche. `relaylead remove <mission> --force` les supprime quand même ; il affiche chaque branche supprimée avec son dernier commit, pour la recréer avec `git branch <nom> <commit>` tant que git garde ce commit.

### Dépendances

Le profil `developer` n'a droit qu'à `npm ci --ignore-scripts` et `npm install --ignore-scripts`, tels quels : les scripts d'installation exécutent le code de paquets tiers avec vos droits, et le garde-fou ne voit que la commande `npm`. C'est un garde-fou contre l'habitude d'un agent qui installe « comme d'habitude », pas contre une session hostile : `node *`, `npm test` et les alias git exécutent toujours du code. Un projet qui a besoin des scripts ajoute, en connaissance de cause, `"guard": {"allow": ["Bash(npm ci)"]}` à `.relaylead.json`. Le mode `all` reste un choix explicite qui ne bloque rien : `npm ci` y est permis et **lance les scripts d'installation**.

## Continuité

Un veilleur, sans IA, veille sur les missions qui ne sont pas finies : il arrête un second lead, ou une session d'équipier dont la tâche ne tourne plus, et écrit dans son journal ce qu'il voit (une session en échec, un lead silencieux).

- `relaylead launch` lance la boucle du veilleur, et le dit sur la sortie d'erreur : elle passe sur les missions toutes les `watcher.everySeconds` secondes (`300` par défaut) et s'arrête d'elle-même quand aucune mission n'en a besoin. `"watcher": {"autoStart": false}` coupe ce lancement.
- `relaylead watcher start` lance la boucle ; `relaylead watcher stop` l'arrête, et cet arrêt tient jusqu'au prochain `relaylead watcher start` ou `relaylead launch` ; `relaylead watcher status` dit si elle tourne, et quand elle est passée pour la dernière fois.
- `relaylead watcher run` fait un passage tout de suite, `--mission <mission>` pour cette seule mission.
- `watcher.helpers` (`true` par défaut) : les courts passages que Relaylead lance de lui-même juste après un événement d'une mission ; `false` les coupe.
- Un fichier vide `~/.relaylead/STOP` fait que le veilleur ne fait rien tant que vous ne l'avez pas retiré ; sa boucle continue de tourner.
- Chaque action du veilleur est une ligne de `~/.relaylead/watcher.log`, déplacé vers `watcher.log.1` au-delà de 1 Mio.

Le lead attend par `relaylead wait` tant qu'une tâche tourne, et finit son tour quand il n'attend plus que vous : votre réponse (`relaylead answer`), ou la fin de la tâche d'un équipier, le réveille dans les secondes qui suivent. Un lead qui ne répond pas à ses réveils est signalé `lead-stuck` dans le journal, jamais arrêté : lancez `relaylead show <mission>` et écrivez-lui.

Un lead dont la session s'arrête pendant que la mission travaille (tuée, ou après un redémarrage de la machine) est relancé par le veilleur : la même session si son contexte est encore bas, sinon une nouvelle session de lead qui repart des fichiers. Après 3 relances ratées d'affilée, le veilleur arrête la mission et dit pourquoi dans son état et dans `journal.log`.

Les réglages `watcher` se lisent dans `~/.relaylead/config.json` seulement. La boucle ne survit pas au redémarrage de la machine tant que `relaylead install` (à venir) ne l'a pas confiée à launchd : après un redémarrage, lancez `relaylead watcher start`.

## Développer

Lancez les tests avec `npm test` (Node.js 18 ou plus, aucune dépendance à installer).

`RELAYLEAD_WRITE_RETRY_MS` règle la durée (en ms) pendant laquelle une écriture de fichier d'état est retentée sous Windows quand un autre processus tient le fichier (2000 par défaut).
