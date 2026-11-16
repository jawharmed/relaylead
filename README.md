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

Each task works in its own worktree, under `.relaylead/worktrees/`. When a mission is stopped or done, its clean task worktrees are removed, **ignored files included** (`node_modules`, build output); their branches stay, so no commit is lost. A worktree with changes not committed, or whose session is still running, is kept and reported: commit or remove those changes, or wait for the session to end, then run `relaylead stop <mission>` again to clean up.

`relaylead remove <mission>` deletes the mission's task worktrees, **ignored files included**, its task branches `relaylead/<mission>/…` and its state under `~/.relaylead/missions/`. It keeps the integration branch and its worktree, with the delivered work. It refuses, before deleting anything, a task branch with commits not merged into the integration branch, or a task worktree with changes not committed or locked (`git worktree lock`), and names them; and, even with `--force`, your own checkout on one of its task branches. `relaylead remove <mission> --force` deletes them anyway; it prints each deleted branch with its last commit, so it can be made again with `git branch <name> <commit>` while git keeps that commit.

Design documents are in French for now:

- [Design](docs/specs/2026-11-14-relaylead-design.md)
- [Roadmap to v1](docs/plans/2026-11-15-feuille-de-route.md)
- [Spike results on Claude Code](docs/spike-results.md)

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

Chaque tâche travaille dans son propre worktree, sous `.relaylead/worktrees/`. À l'arrêt ou à la fin d'une mission, ses worktrees de tâche propres sont retirés, **fichiers ignorés compris** (`node_modules`, sorties de build) ; leurs branches restent, aucun commit n'est perdu. Un worktree avec des modifications non commitées, ou dont la session tourne encore, est gardé et signalé : committez ou retirez ces modifications, ou attendez la fin de la session, puis relancez `relaylead stop <mission>` pour refaire le ménage.

`relaylead remove <mission>` supprime les worktrees de tâche de la mission, **fichiers ignorés compris**, ses branches de tâche `relaylead/<mission>/…` et son état sous `~/.relaylead/missions/`. Il garde la branche d'intégration et son worktree, avec le travail livré. Il refuse, avant de rien supprimer, une branche de tâche dont des commits ne sont pas fusionnés dans la branche d'intégration, ou un worktree de tâche avec des modifications non commitées ou verrouillé (`git worktree lock`), et les nomme ; et, même avec `--force`, votre propre copie de travail sur une de ses branches de tâche. `relaylead remove <mission> --force` les supprime quand même ; il affiche chaque branche supprimée avec son dernier commit, pour la recréer avec `git branch <nom> <commit>` tant que git garde ce commit.

## Développer

Lancez les tests avec `npm test` (Node.js 18 ou plus, aucune dépendance à installer).

`RELAYLEAD_WRITE_RETRY_MS` règle la durée (en ms) pendant laquelle une écriture de fichier d'état est retentée sous Windows quand un autre processus tient le fichier (2000 par défaut).
