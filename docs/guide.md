# Relaylead guide

macOS only for now. This guide goes from a first mission to the settings you will want once it runs every day. `relaylead --help` lists the commands; they are described one by one below.

## Contents

1. [Getting started](#getting-started)
2. [Concepts](#concepts)
3. [Configuration](#configuration)
4. [Displays](#displays)
5. [Commands](#commands)
6. [Troubleshooting](#troubleshooting)
7. [Updating from 0.1](#updating-from-01)
8. [Uninstalling](#uninstalling)

## Getting started

You need macOS, Node.js 18 or newer, `git`, and Claude Code (2.1.325 or newer) signed in. For GitHub issues and pull requests you also need `gh`, signed in (`gh auth login`).

```sh
npm install -g relaylead
relaylead install       # launchd watcher + Claude Code plugin
relaylead init          # run it in your project's root folder
relaylead doctor        # everything should say ok
```

`init` writes the machine settings in `~/.relaylead/config.json` (once) and a `.relaylead.json` at the root of your project. The project must be a git repository, and `init` must run at its root. Run `claude` once in the folder and accept the trust question, so sessions can start there.

### From Claude Code: the console

After `relaylead install`, open Claude Code in your project and type `/relaylead`, or ask for it ("use relaylead to add a health check"). The `relaylead` skill of the plugin turns the conversation into a console:

- it opens with `relaylead brief` (installation problems, news, open questions, missions) and, without a `.relaylead.json`, asks the questions of `init` in the conversation and writes the files; later you can ask for changes in plain words ("limit to 2 developers here");
- it writes the mission's tasks with you, launches it, then waits for events in the background (`relaylead wait --all` as a background command: Claude Code wakes the conversation when it ends, and nothing is spent in between);
- each question the lead asks is shown as it is, with the mission's name and numbered options; your choice goes back with `relaylead answer`;
- "tell the lead of X to ..." becomes `relaylead tell`; "where is X?" reads the state of the missions;
- it wakes you only for a question, a failed task, or a mission that is done or stopped;
- when another mission is already active on the machine, it asks the new mission's priority (and may change the others' with `relaylead priority`) and warns when two missions touch the same files;
- when a mission is done, it asks "Merge it into main?" and, on a yes, runs `relaylead merge` (see [End of a mission](#end-of-a-mission));
- a new conversation first lists every open question and the missions that are not finished, including what happened while no console was open. Questions asked while the console was closed are never lost: the watcher still sends the Mac notification, and the questions stay open until answered.

The plugin's `/relaylead:*` commands remain.

### From the command line

Add one Markdown file per task in `tasks/`:

```markdown
---
title: Add a health check endpoint
---
Add GET /health that returns 200 and {"status":"ok"}. Cover it with a test.
```

Then launch:

```sh
relaylead launch --request "Carry out the tasks"
```

The command prints the mission's name and returns at once. Follow it with `relaylead list`. When the lead has a question, `relaylead question list <mission>` shows it and `relaylead answer <mission> <id> <choice>` answers it. When the mission is `done`, the work is on the branch `relaylead/<mission>/integration`, in the worktree `.relaylead/worktrees/<mission>/_integration` of your project. Your own checkout is never changed. Merge it into your branch with `relaylead merge <mission>` when you are ready.

## Concepts

- **Mission.** One run of a team on a project, named after the project's folder unless you pass `--name`. A mission has a state (`starting`, `working`, `waiting`, `handover`, `done`, or `stopped`) and lives in `~/.relaylead/missions/<mission>/`.
- **Lead.** One Claude Code session that drives the mission. It never edits code: it reads the task list, starts crew members, delivers their work, asks you questions, and says when the mission is done. It only uses `relaylead` commands.
- **Crew (equipiers).** One short-lived developer session per task, in its own git worktree `.relaylead/worktrees/<mission>/<task>` and on its own branch `relaylead/<mission>/<task>`. A crew member finishes with `relaylead task done` or `relaylead task fail`. At most `parallel` tasks of a mission run at a time (4 by default), and at most `maxSessions` crew members on the machine, every mission included (4 by default; the leads do not count).
- **Queue.** A task started while the machine has no free place is `queued`: nothing runs for it, nothing else is stopped, and the watcher starts it as soon as a place frees up, the mission of highest priority first (`high`, `normal`, `low`), then the task queued first. `relaylead list` shows `(n queued)` next to the state.
- **Task.** A unit of work with an id, a title, a body, a state (`todo`, `queued`, `running`, `done`, `failed`, `delivered`) and optionally dependencies (`depends`) and a question to settle first (`ask`). Delivering a task merges it (or opens a pull request); that makes the tasks that depend on it ready.
- **Watcher.** A small loop with no AI. Every few minutes it looks at the unfinished missions: it restarts a lead that has stopped (the same session when its context is low, otherwise a fresh one that restarts from the files), wakes a lead that ended its turn when an answer or a finished task is waiting, stops a second lead or a crew session whose task no longer runs, and hands over to a fresh lead when the lead's context fills up. After 3 failed restarts in a row, or at once when a session reports a billing or authentication error, it stops the mission, says why and notifies you. It writes what it does to `~/.relaylead/watcher.log`. `relaylead launch` starts it, and `relaylead install` hands it to launchd so it survives a restart of the machine.
- **Questions.** The lead asks you through `relaylead question`; you answer with `relaylead answer`. A question has a text, options and optionally a recommended option. The lead waits only for answers that change what happens next.
- **Delivery.** How finished tasks reach your repository: `local-merge` (default), `files`, or `github-pr`.

### End of a mission

A mission ends when its lead declares it done (every task settled) or when you stop it. Its sessions are then stopped and taken out of the `claude agents` list. Its work stays on `relaylead/<mission>/integration` until you merge it:

- **`relaylead merge <mission>`** merges the integration branch into the branch the mission was launched from (or `main`, or `master`). It works where that branch is checked out (your checkout, which must have no uncommitted change), or else in a worktree of its own, removed after. With `github-pr`, it opens a pull request from the integration branch and merges it on GitHub.
- **On a conflict** the merge is cancelled, nothing is left half done, and a crew member gets the task `merge-into-<branch>`: on a branch of the integration branch, it merges your branch into it (so it sees both sides), resolves the conflicts, runs the tests and commits. The watcher then delivers it into the integration branch and merges again, by itself, with no lead. If the crew member fails, you get a question: *Resolve it here with me* (the console walks you through it in the integration worktree, then runs `relaylead merge` again), *Relaunch a crew member with hints* (send the hints with `relaylead tell` first), or *Pause the mission* (`relaylead merge` tries again whenever you want). With `github-pr`, the same task works on the branch of the pull request.
- **Cleanup.** Once the integration branch is merged into its branch (by `relaylead merge`, or by you) or deleted, the watcher removes the mission as `relaylead remove` would: its state under `~/.relaylead/missions/<mission>/`, its task worktrees and branches, and its integration worktree when clean. The integration branch itself stays (delete it with `git branch -d`). A mission that delivered nothing is kept: remove it yourself.
- **Abandoned missions.** A mission waiting for an answer while nothing has moved for `abandonDays` days (7) gets one notification, and `relaylead list` (`abandoned`) and `relaylead doctor` point to it. Nothing is stopped or deleted.

## Configuration

Settings come from three levels; each one overrides the one before:

1. built-in defaults;
2. the machine file `~/.relaylead/config.json` (or `$RELAYLEAD_HOME/config.json`);
3. the project file `.relaylead.json` at the root of the project.

Objects are merged key by key; lists and values are replaced. The `watcher` and `auth` settings are read from the machine file only. A mission freezes its configuration at launch: a change applies from the next launch.

Main settings, with their defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `agent` | `claude` | The agent that runs the sessions. |
| `method` | `code` | The method the lead follows (`catalog/methods`). |
| `parallel` | `4` | Tasks of a mission running at the same time. |
| `maxSessions` | `4` | Crew members working at the same time on the machine, every mission included; the leads do not count (machine file only). |
| `priority` | `normal` | The default priority of a mission (`high`, `normal`, `low`): its usage thresholds and its rank in the queue. |
| `abandonDays` | `7` | Days without activity, a question open, after which a mission is reported abandoned. |
| `maxAttempts` | `2` | Attempts per task; a failed task can be retried. |
| `permissionMode` | `allowlist` | `allowlist` lets sessions run only the commands of their profile; `all` blocks nothing except the guardrails. |
| `language` | `en` | Language of the messages (`en` or `fr`). |
| `source` | `{"type":"tasks-dir","dir":"tasks"}` | Where tasks come from. |
| `delivery` | `{"type":"local-merge","runHooks":true}` | How tasks are delivered. |
| `guard` | see below | Guardrails. |
| `context` | see the watcher section | Context thresholds. |
| `watcher` | `{"autoStart":true,"helpers":true,"everySeconds":300}` | The watcher (machine file only). |
| `auth` | `{"mode":"login","keyFile":null}` | How Claude signs in (machine file only). |

### Sources

**`tasks-dir`** (default): every `*.md` file of the folder is a task, with the file name (without `.md`) as its id. The optional header, between two `---` lines, understands:

- `title`: the task's title (the id when missing);
- `depends`: ids of other tasks, for example `depends: [schema, api]`; the task is ready once all of them are delivered;
- `ask`: a question to settle before the task starts; the lead asks it and starts the task only once you have answered. Answering "Skip this task" sets the task aside.

When a task is delivered, its `state:` line becomes `done` in the integration branch.

**`github-issues`**: each issue that has the label (`relaylead` by default) is a task named `issue-<n>`. An open issue is to do, a closed one is done. Issues have no dependencies and ask nothing. `repo` (`owner/name`) is optional: without it `gh` uses the repository of your folder.

```json
{
  "source": { "type": "github-issues", "label": "relaylead" },
  "delivery": { "type": "github-pr" }
}
```

### Deliveries

- **`local-merge`** (default): each finished task is merged into the mission's integration branch, `relaylead/<mission>/integration`. Nothing leaves your machine. (`delivery.branch` is no longer read: each mission has its own branch.)
- **`github-pr`**: meant for the `github-issues` source. A finished task's branch is pushed to the remote (`origin`, or `delivery.remote`), a pull request to the integration branch is opened and merged on GitHub in the same step, the task's branch is deleted on the remote, the local integration branch follows the remote one, and the issue is closed. No review is waited for: the lead delivers a task it has found finished, so its pull request is opened, then merged at once. If you want to review the work, do it on the integration branch before you merge it into your own. The integration branch must be pushable to the remote.
- **`files`**: no git needed; each task writes its output into `out/<mission>/<task id>/` in the project folder.

Relaylead's own commits run your git hooks (with `LC_ALL=C`). These run in the integration worktree, where no dependencies are installed: a hook that needs `node_modules` (husky, commitlint, lint-staged) fails there. Such projects set `"delivery": {"runHooks": false}`, or deliver with `relaylead task deliver <id> --no-hooks --mission <mission>`.

### Guardrails

```json
{
  "guard": {
    "protectedBranches": ["main", "master"],
    "secrets": [".env", ".env.*"],
    "secretExceptions": [".env.example", ".env.sample", ".env.template"],
    "allow": []
  }
}
```

`protectedBranches` cannot be pushed to or committed on by a session; `secrets` (patterns, `*` matches any characters) cannot be read or written, except `secretExceptions`. In `allowlist` mode the developer profile may only install dependencies with `npm ci --ignore-scripts` or `npm install --ignore-scripts`, because install scripts run third-party code. A project that needs them adds, knowingly, `"guard": {"allow": ["Bash(npm ci)"]}`. Mode `all` allows `npm ci` and runs those scripts.

### Questions

Relaylead asks you before anything irreversible, and before a command outside the allowlist; you get a macOS notification for each new question. Those questions always wait for you: nothing answers them in your place. A question the lead asks itself follows the setting `questions.onTimeout`: `wait` (the default) waits for you, `recommended` picks the recommended option and `skip` picks the option that skips, after `questions.timeoutMinutes` (60 by default). Answer with a number (the options are numbered from 1; the recommended one is first) or with the text of an option. Questions are answered from outside a mission only: a session cannot answer for you.

### Usage limit and automatic pause

Relaylead reads your Claude usage (5-hour and 7-day windows) from the status line. When a mission reaches the threshold of its priority, or when Claude reports a usage limit, the watcher pauses the mission: its sessions are stopped and nothing is relaunched. It resumes by itself at the reset time (or after 15, 30, then 60 minutes when no time is given). `relaylead list` and `show` display `usage-pause (resume …)`, and `task start` / `task retry` are refused meanwhile. Questions still notify you during a pause.

The thresholds are in percent, per priority, in the `usage` setting:

```json
{ "usage": { "thresholds": { "low": { "week": 70, "fiveHour": 80 }, "normal": { "week": 90, "fiveHour": 85 }, "high": { "week": 98, "fiveHour": 85 } }, "retryMinutes": [15, 30, 60] } }
```

### Context thresholds

Sessions have a limited context. The `context` setting says when to hand over: `budgets` (tokens a session may add to its first measured context, per role: `lead` 150000, `crew` 250000), `capPercent` (a ceiling, as a share of the measured window: 40) and `hardPercent` (the margin past which the hand-over is forced: 20). For example `{"context": {"budgets": {"lead": 60000}}}`. A lead past its threshold finishes its step, writes where the mission stands, and the watcher starts a fresh lead. A crew member whose context is full commits, fails its task with "context full", and the lead retries it on the same branch.

### The watcher

- `watcher.autoStart` (`true`): `relaylead launch` starts the loop.
- `watcher.helpers` (`true`): short targeted passes started right after an event of a mission (an answer, a finished task).
- `watcher.everySeconds` (`300`): time between two passes of the loop.
- An empty file `~/.relaylead/STOP` makes the watcher do nothing until you remove it.

### Memory

Each project has a memory shared by its missions: `.relaylead/memoire.md` in the project folder (never in a worktree), in the main repository. It holds the conventions of the project, one line per past mission and the lessons learned. Every lead reads it when it starts (`relaylead memory show`), and compacts it before declaring its mission done (a lead's `state set done` is refused until the mission has written the memory; `--no-memory` is the way out when it cannot): the mission becomes one line, the lessons are merged, what is out of date goes. The previous version is kept in `.relaylead/memoire-archive/`, which is never read again. Writes are done under a lock, so two missions never overwrite each other.

- `memory.enabled` (`true`): turns the memory off with `false`.
- `memory.maxLines` (`200`): the ceiling. A memory over it is flagged when a lead starts (the lead must compact it before anything else, with no AI involved in the check), `relaylead doctor` warns about it in the folder you run it in, and a compaction over the ceiling is refused.
- `memory.maxBytes` (`16384`): the ceiling in bytes (1024 to 65536; `maxLines` is 1 to 1000, a value out of range is ignored). Over either ceiling, `memory show` prints only the start of the memory that fits, says how many lines it left out, and the lead must compact before anything else; a text over either is refused.
- `memory.versioned` (`false`): by default the memory stays out of git: `relaylead init` adds it and its archive to `.git/info/exclude` (your `.gitignore` is not touched). With `true`, the memory is left visible to git (the exclusion of `.relaylead/` becomes `.relaylead/*` plus `!.relaylead/memoire.md`, also after a delivery) and you commit it with the code; its archive stays excluded.

`relaylead init` asks the two questions (turn it on; version it), with these defaults; `--yes` takes them, `--no-memory` and `--versioned-memory` answer them. The memory of one mission (its decisions and the messages you told it) lives in the mission's folder and is deleted with it.

### API key

By default Claude signs in with your connected account (`auth.mode` `login`). To use an API key, run `relaylead init --api-key-env NAME` (copies the variable `NAME` to `~/.relaylead/api-key`, readable by you alone) or `relaylead init --api-key-file PATH`. The key is never printed, and never written to the configuration, a log or a launchd file. Each session gets it through Claude Code's `apiKeyHelper` setting, in the settings Relaylead passes to the session: a small command reads the key file when Claude Code asks for it, and nothing needs approving. Claude Code prefers this key to the account you are signed in with, and an `ANTHROPIC_API_KEY` of your shell is not passed to the sessions. `relaylead doctor` asks Claude Code which credential it would use (`ok api-key-use`). To check a running session, open it with `relaylead show <mission>` and run `/status`: it must name `apiKeyHelper`, not your Claude account.

## Displays

Three views show the same thing, read from the files of `~/.relaylead`: every mission of the machine with its state and priority, its tasks, the questions waiting for you (with their options) and the 5-hour and 7-day usage of your account.

- **Status line entry.** Inside Claude Code, the plugin adds a line such as `relaylead · 2 missions · ❓1 · quota 5 h 62 %`. It shows only while a mission runs or a question waits, and disappears with the plugin. Your own `statusLine` setting is never touched. Turn it off with `relaylead config set display.statusLine false`.
- **Panel.** The plugin also draws a panel next to the conversation: one card per mission (questions first, then the tasks), a button per option to answer, and the usage. It refreshes every 5 seconds. The first time a mission runs, Claude Code asks `Always / This time / Never`; the choice is kept as `display.pane` (`always` or `never`), or set it yourself with `relaylead config set display.pane always`. `/panneau` opens or closes the panel at any time. In a terminal, an automatic opening needs a window about 144 columns wide; the command opens it at any width.
- **Local web page.** `relaylead dashboard` serves a page on `127.0.0.1` only (port `display.dashboardPort`, 4317 by default; `--port` for one launch, `--no-open` to keep the browser closed), opens it, and refreshes it on its own. It works with Claude Code closed. Answering and stopping a mission work from this page only: each launch makes a random token that only the page carries, and requests with another Host or Origin are refused, so no other site open in your browser can trigger them. Stop the server with Ctrl-C.

The panel and the status line need a Claude Code that supports mods; without it, Relaylead works the same and these two are simply missing. `relaylead overview --json` prints what they read, for your own scripts.

## Commands

Run them from the root of your project unless said otherwise. A mission name is the one `launch` printed (see `relaylead list`).

### `relaylead launch`

Starts a mission with a lead and its crew and prints its name.

- `--request <text>`: what you want done.
- `--name <name>`: the mission's name (the folder's name by default). Names are unique on the machine: to run a second mission in the same folder, give it another name.
- `--tasks <folder>`: the mission's task folder, inside the project (`source.dir`, `tasks` by default).

Several missions of one project run side by side, each with its own integration branch and worktrees; their git operations on the repository (worktrees, branches, merges) take turns. Each mission needs tasks of its own: `launch` is refused while a mission of the same project that is not over takes its tasks from the same source (the same task folder, or the same GitHub label). For instance, a backend mission and a frontend mission:

```sh
relaylead launch --name backend --tasks tasks/backend --request "Build the API"
relaylead launch --name frontend --tasks tasks/frontend --request "Build the pages"
```

A mission launched by Relaylead 0.1 that is still running keeps its folder to itself: `launch` is refused there until it is over (or stopped).
- `--dir <path>`: the project folder (the current folder by default).
- `--team <name>` and `--agent <name>`: the team and the agent to use (the built-in team `code` and `claude`).
- `--priority <value>`: `high`, `normal` (the default) or `low`; it sets the usage thresholds of the mission and its rank in the queue. Change it later with `relaylead priority`.

It also starts the watcher's loop unless `watcher.autoStart` is `false`.

### `relaylead list`

One line per mission: name, state, the lead's session, folder. The state may say `(n queued)` (tasks waiting for a place on the machine) and `(abandoned)`.

### `relaylead priority <mission> <high|normal|low>`

Changes the priority of a mission, even while it runs: its usage thresholds, and its rank in the queue of the tasks waiting for a place.

### `relaylead merge <mission>`

Merges a done mission into the branch it was launched from (see [End of a mission](#end-of-a-mission)). Never run by Relaylead on its own. It prints the merge commit (or the pull request), or the conflict and the task that resolves it.

### `relaylead show <mission>`

Opens the lead's session so you can read it and write to it.

### `relaylead stop <mission>`

Stops the mission and all its sessions. The clean task worktrees are removed, ignored files included (`node_modules`, build output); their branches stay. A worktree with uncommitted changes, or whose session is still running, is kept and reported: commit or remove the changes, then stop again.

### `relaylead remove <mission> [--force]`

Removes a finished (done or stopped) mission: its task worktrees (ignored files included), its task branches `relaylead/<mission>/...` and its state under `~/.relaylead/missions/`. The mission's sessions are also taken out of the `claude agents` list (`claude rm`; their conversations stay in `claude --resume`). The integration branch and its worktree stay, with the delivered work. It refuses, before deleting anything, a task branch with commits not merged into the integration branch and a task worktree with uncommitted changes or locked, and names them. `--force` deletes them anyway and prints each deleted branch with its last commit, so it can be recreated with `git branch <name> <commit>`.

### `relaylead task`

Manages the tasks of a mission. Outside a session, add `--mission <name>`.

- `task list [--short]`: the tasks as JSON, with state, `ready`, `ask` and summary; `--short` prints one line per task (id, state and attempt, title, summary), for the console.
- `task start <id> [--profile p]`: starts a crew member on a ready task.
- `task retry <id> [--profile p]`: starts a new crew member on a failed task, on the same branch, told how the earlier attempt failed. Limited by `maxAttempts`.
- `task deliver <id> [--no-hooks]`: delivers a done task. `--no-hooks` skips your git hooks; only you can use it, not a session.
- `task done <id>` and `task fail <id> [--summary text]`: how a crew member reports its end. They are meant for crew sessions.

The lead and the crew use these themselves; you will mostly use `list`, `retry` and `deliver`.

### `relaylead state get|set <state> [--note text] [--mission name]`

Reads or sets the state declared by the lead (`working`, `waiting`, `done`, `handover`). It is the lead's own channel to tell you where the mission stands.

### `relaylead wait [--timeout seconds] [--mission name]`

Waits until a task or a question of the mission changes, then prints the changes as JSON; a message from `relaylead tell` is a change of kind `message`, with its text. `--timeout 0` does not wait. The lead uses it.

### `relaylead wait --all [--timeout seconds] [--json]`

For the console: waits until something the user must know about happens in any mission of the machine, then prints one short line per event, named by its mission: a question opened (in full: text, context, numbered options, the recommended one marked), a task failed (with its summary), a mission done or stopped, a merge done. With `--json` it prints `{"events": [...]}` instead; every event has a `mission` and a `kind` (`question`, `task`, `mission` or `merge`). Without `--timeout` it waits as long as needed; `--timeout 0` looks once. What it has reported is remembered in `~/.relaylead/console-snapshot.json`, so each event is given once; it never touches what the leads see. It cannot be run from a session.

### `relaylead tell <mission> <text>`

Tells the lead of a mission something (a change of plan, a constraint). The message is recorded in the mission (`missions/<mission>/told/`, one file per message, kept as its memory) and the lead is woken within seconds; it reads the message, with its text, in the output of its next `relaylead wait`. Refused for a mission that is done or stopped. It cannot be run from a session.

### `relaylead decision <text>` and `decision --list`

For the lead: notes a decision taken with the user as a line of `decisions.md` in the mission's folder. `decision --list` prints them, then every message told with `tell`: a new lead (after a relaunch or a handover) reads it before going on.

### `relaylead memory show` and `memory write --base <fingerprint> --file <file> | --text <text>`

For the lead: `show` prints a fingerprint of the memory, then the memory (and a warning when it is over its ceiling); `write` replaces it, if the memory is still the one `--base` names (otherwise the error says to read it again and merge: another mission wrote it meanwhile), with the text of a file or with `--text`, where `\n` stands for a line break, after archiving the previous version. A text over `memory.maxLines` is refused.

### `relaylead question ask|list`

- `question list [<mission>] [--all]`: the open questions as JSON (all of them with `--all`). Each has an id, a text, numbered options and the recommended one.
- `question ask --key k --text t --option o --option o [--context c] [--recommended n]`: what the lead uses to ask you something. Asking again with the same key returns the same question.

### `relaylead answer <mission> <id> <choice>`

Answers a question with an option number or text. This also wakes the lead within seconds. It cannot be run from a session.

### `relaylead watcher`

- `watcher start`: starts the loop (no output change if it already runs).
- `watcher stop`: stops it; the stop holds until the next `watcher start` or `launch`.
- `watcher status`: whether it runs, and when it last passed.
- `watcher run [--mission <name>]`: makes one pass now, over every mission or over one.

### `relaylead init [--yes] [--api-key-env NAME] [--api-key-file PATH]`

Sets up the machine once (`~/.relaylead/config.json`), then the current project (`.relaylead.json`, never overwritten). In a terminal it asks a few questions, among them whether to keep a project memory and whether to version it; with `--yes`, or without a terminal, it takes the defaults. Existing files are kept. The project folder must be the root of a git repository.

### `relaylead install`

Registers the launchd agent that runs the watcher (`dev.relaylead.watcher`) and the Claude Code plugin, which adds slash commands (`/relaylead:launch`, `list`, `show`, `answer`, `stop`, `init`, `doctor`). Safe to run again. Without Claude Code, the plugin step is skipped. It finishes with `relaylead doctor`. macOS only.

### `relaylead uninstall [--purge]`

Stops the watcher's loop first and waits for its end, then removes what `install` added, and nothing else. `--purge` also deletes `~/.relaylead` (missions' state, logs, key file), after checking that the folder is Relaylead's.

### `relaylead brief`

What the console shows when a conversation opens, as a short text: the problems of the installation (the `warn` and `fail` lines of `doctor`, only when there are some), what happened since the console last looked (the same catch-up as `relaylead wait --all --timeout 0`, so the next wait does not give it again), every open question of every mission as it is (finished missions included), and one line per mission not over (state, tasks delivered, queue, pause, priority). It cannot be run from a session.

### `relaylead overview --json`

Prints every mission of the machine as JSON: name, folder, priority, state, pause, tasks, open questions with their options, the usage of the account and the display settings. Writes nothing and calls no network.

### `relaylead config set <key> <value>`

Writes one display setting in `~/.relaylead/config.json`: `display.pane` (`always` or `never`), `display.statusLine` (`true` or `false`), `display.dashboardPort` (1 to 65535). Other settings are edited in the file.

### `relaylead dashboard [--port n] [--no-open]`

Serves the local web page described in [Displays](#displays) until Ctrl-C.

### `relaylead doctor`

Checks Node, Claude Code, git, the scheduler, the plugin, the watcher, the authentication, abandoned missions and a possible `STOP` file. One line per check: `ok`, `warn` or `fail`, then its name and detail. It exits with 1 if a check failed. It starts no session.

## Troubleshooting

- **Start with `relaylead doctor`.** A `fail` line says what is missing (an old Node, Claude Code not found, no `git`, a missing API key file); a `warn` line tells which command to run (`relaylead install`).
- **`~/.relaylead/watcher.log`**: one line per action of the watcher (restarts, wakes, hand-overs, failures, a lead reported `lead-stuck`). It is moved to `watcher.log.1` past 1 MiB. `relaylead watcher run` prints the lines a pass adds.
- **`~/.relaylead/missions/<mission>/journal.log`**: warnings and failures of one mission. The same folder holds its state, tasks and questions.
- **The watcher does nothing.** Check `relaylead watcher status`, and whether `~/.relaylead/STOP` exists. After a restart of the machine, `relaylead install` lets launchd keep it alive; without it run `relaylead watcher start`.
- **A lead does not answer.** It is reported `lead-stuck` and never stopped: `relaylead show <mission>` and write to it.
- **A mission stopped after 3 failed restarts.** Its state and `journal.log` say why. Fix the cause, then launch again.
- **A mission stopped for billing or authentication.** When a session reports `billing_error` (API credit used up) or `authentication_failed`, waking it again would fail the same way: the watcher stops the mission at once, notifies you, and `relaylead list` and `show` display `stopped by the watcher: billing error …` or `authentication failed …`. Add credit or fix the key (`relaylead doctor`), then launch again: the work already delivered is on the integration branch (`relaylead remove <mission>` first to reuse the name).
- **"a mission named ... already exists".** Pass another `--name`, or remove the finished one with `relaylead remove <mission>`.
- **A delivery fails.** The lead asks you what to do. Fix the cause on the task's branch and answer "I fixed it: deliver again", or deliver it yourself.
- **Claude Code says the folder is not trusted.** Run `claude` once in the project folder and accept.
- **GitHub errors.** Check `gh auth status`; the source and the `github-pr` delivery need a signed-in `gh`.

## Updating from 0.1

Relaylead 0.1 ran one mission per folder, delivered on the shared branch `relaylead/integration` and kept its worktrees directly under `.relaylead/worktrees/`. Since 0.2, each mission has its own branch `relaylead/<mission>/integration` and its own folder `.relaylead/worktrees/<mission>/`.

- **A 0.1 mission still running** finishes with the names of then. Until it is over, `launch` is refused in its folder; stop it with `relaylead stop <mission>` if its lead is gone.
- **Work delivered by 0.1 and not merged into your branch** stays on `relaylead/integration`. A new mission starts from your current branch, so it does not see that work and may do its tasks again: `launch` warns about it, and goes on. Before launching, merge `relaylead/integration` into your branch (`git merge relaylead/integration`), or delete the branch if that work is not wanted.
- **`delivery.branch`** in `.relaylead.json` is no longer read.
- **Output of the `files` delivery** now goes to `out/<mission>/<task id>/`.

## Uninstalling

```sh
relaylead uninstall            # scheduler and plugin
relaylead uninstall --purge    # also deletes ~/.relaylead
npm uninstall -g relaylead
```

Finish or remove your missions first (`relaylead stop`, `relaylead remove`): `--purge` deletes their state. The branches and worktrees inside your projects (`relaylead/...`, `.relaylead/worktrees/`) are not touched by `uninstall`; remove them with `relaylead remove <mission>` or with `git`. If a step of `uninstall` fails, it prints the command to run by hand.
