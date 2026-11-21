# Relaylead guide

macOS only for now. This guide goes from a first mission to the settings you will want once it runs every day. `relaylead --help` lists the commands; they are described one by one below.

## Contents

1. [Getting started](#getting-started)
2. [Concepts](#concepts)
3. [Configuration](#configuration)
4. [Commands](#commands)
5. [Troubleshooting](#troubleshooting)
6. [Uninstalling](#uninstalling)

## Getting started

You need macOS, Node.js 18 or newer, `git`, and Claude Code (2.1.325 or newer) signed in. For GitHub issues and pull requests you also need `gh`, signed in (`gh auth login`).

```sh
npm install -g relaylead
relaylead install       # launchd watcher + Claude Code plugin
relaylead init          # run it in your project's root folder
relaylead doctor        # everything should say ok
```

`init` writes the machine settings in `~/.relaylead/config.json` (once) and a `.relaylead.json` at the root of your project. The project must be a git repository, and `init` must run at its root. Run `claude` once in the folder and accept the trust question, so sessions can start there.

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

The command prints the mission's name and returns at once. Follow it with `relaylead list`. When the lead has a question, `relaylead question list <mission>` shows it and `relaylead answer <mission> <id> <choice>` answers it. When the mission is `done`, the work is on the branch `relaylead/integration`, in the worktree `.relaylead/worktrees/_integration` of your project. Your own checkout is never changed.

## Concepts

- **Mission.** One run of a team on a project, named after the project's folder unless you pass `--name`. A mission has a state (`starting`, `working`, `waiting`, `handover`, `done`, or `stopped`) and lives in `~/.relaylead/missions/<mission>/`.
- **Lead.** One Claude Code session that drives the mission. It never edits code: it reads the task list, starts crew members, delivers their work, asks you questions, and says when the mission is done. It only uses `relaylead` commands.
- **Crew (equipiers).** One short-lived developer session per task, in its own git worktree under `.relaylead/worktrees/` and on its own branch `relaylead/<mission>/<task>`. A crew member finishes with `relaylead task done` or `relaylead task fail`. At most `parallel` tasks run at a time (4 by default).
- **Task.** A unit of work with an id, a title, a body, a state (`todo`, `running`, `done`, `failed`, `delivered`) and optionally dependencies (`depends`) and a question to settle first (`ask`). Delivering a task merges it (or opens a pull request); that makes the tasks that depend on it ready.
- **Watcher.** A small loop with no AI. Every few minutes it looks at the unfinished missions: it restarts a lead that has stopped (the same session when its context is low, otherwise a fresh one that restarts from the files), wakes a lead that ended its turn when an answer or a finished task is waiting, stops a second lead or a crew session whose task no longer runs, and hands over to a fresh lead when the lead's context fills up. After 3 failed restarts in a row it stops the mission and says why. It writes what it does to `~/.relaylead/watcher.log`. `relaylead launch` starts it, and `relaylead install` hands it to launchd so it survives a restart of the machine.
- **Questions.** The lead asks you through `relaylead question`; you answer with `relaylead answer`. A question has a text, options and optionally a recommended option. The lead waits only for answers that change what happens next.
- **Delivery.** How finished tasks reach your repository: `local-merge` (default), `files`, or `github-pr`.

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
| `parallel` | `4` | Tasks running at the same time. |
| `maxAttempts` | `2` | Attempts per task; a failed task can be retried. |
| `permissionMode` | `allowlist` | `allowlist` lets sessions run only the commands of their profile; `all` blocks nothing except the guardrails. |
| `language` | `en` | Language of the messages (`en` or `fr`). |
| `source` | `{"type":"tasks-dir","dir":"tasks"}` | Where tasks come from. |
| `delivery` | `{"type":"local-merge","branch":"relaylead/integration","runHooks":true}` | How tasks are delivered. |
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

- **`local-merge`** (default): each finished task is merged into the integration branch (`relaylead/integration` by default, set with `delivery.branch`). Nothing leaves your machine.
- **`github-pr`**: meant for the `github-issues` source. A finished task's branch is pushed to the remote (`origin`, or `delivery.remote`), a pull request to the integration branch is opened and merged on GitHub, the local integration branch follows the remote one, and the issue is closed. The lead reviews the pull request first; a review that requests changes refuses the delivery. The integration branch must be pushable to the remote.
- **`files`**: no git needed; each task writes its output into `out/<task id>/` in the project folder.

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

When your Claude usage limit is reached, Relaylead can pause the mission and resume it by itself once the limit resets; this arrives in a coming release (it is not described further here).

### Context thresholds

Sessions have a limited context. The `context` setting says when to hand over: `budgets` (tokens a session may add to its first measured context, per role: `lead` 150000, `crew` 250000), `capPercent` (a ceiling, as a share of the measured window: 40) and `hardPercent` (the margin past which the hand-over is forced: 20). For example `{"context": {"budgets": {"lead": 60000}}}`. A lead past its threshold finishes its step, writes where the mission stands, and the watcher starts a fresh lead. A crew member whose context is full commits, fails its task with "context full", and the lead retries it on the same branch.

### The watcher

- `watcher.autoStart` (`true`): `relaylead launch` starts the loop.
- `watcher.helpers` (`true`): short targeted passes started right after an event of a mission (an answer, a finished task).
- `watcher.everySeconds` (`300`): time between two passes of the loop.
- An empty file `~/.relaylead/STOP` makes the watcher do nothing until you remove it.

### API key

By default Claude signs in with your connected account (`auth.mode` `login`). To use an API key, run `relaylead init --api-key-env NAME` (copies the variable `NAME` to `~/.relaylead/api-key`, readable by you alone) or `relaylead init --api-key-file PATH`. The key is never printed, and never written to the configuration, a log or a launchd file. If Claude Code asks you to approve the key, run `claude` once in a terminal and accept.

## Commands

Run them from the root of your project unless said otherwise. A mission name is the one `launch` printed (see `relaylead list`).

### `relaylead launch`

Starts a mission with a lead and its crew and prints its name.

- `--request <text>`: what you want done.
- `--name <name>`: the mission's name (the folder's name by default). One project folder runs one mission at a time.
- `--dir <path>`: the project folder (the current folder by default).
- `--team <name>` and `--agent <name>`: the team and the agent to use (the built-in team `code` and `claude`).
- `--priority <value>`: recorded with the mission (`normal` by default).

It also starts the watcher's loop unless `watcher.autoStart` is `false`.

### `relaylead list`

One line per mission: name, state, the lead's session, folder.

### `relaylead show <mission>`

Opens the lead's session so you can read it and write to it.

### `relaylead stop <mission>`

Stops the mission and all its sessions. The clean task worktrees are removed, ignored files included (`node_modules`, build output); their branches stay. A worktree with uncommitted changes, or whose session is still running, is kept and reported: commit or remove the changes, then stop again.

### `relaylead remove <mission> [--force]`

Removes a finished (done or stopped) mission: its task worktrees (ignored files included), its task branches `relaylead/<mission>/...` and its state under `~/.relaylead/missions/`. The integration branch and its worktree stay, with the delivered work. It refuses, before deleting anything, a task branch with commits not merged into the integration branch and a task worktree with uncommitted changes or locked, and names them. `--force` deletes them anyway and prints each deleted branch with its last commit, so it can be recreated with `git branch <name> <commit>`.

### `relaylead task`

Manages the tasks of a mission. Outside a session, add `--mission <name>`.

- `task list`: the tasks as JSON, with state, `ready`, `ask` and summary.
- `task start <id> [--profile p]`: starts a crew member on a ready task.
- `task retry <id> [--profile p]`: starts a new crew member on a failed task, on the same branch, told how the earlier attempt failed. Limited by `maxAttempts`.
- `task deliver <id> [--no-hooks]`: delivers a done task. `--no-hooks` skips your git hooks; only you can use it, not a session.
- `task done <id>` and `task fail <id> [--summary text]`: how a crew member reports its end. They are meant for crew sessions.

The lead and the crew use these themselves; you will mostly use `list`, `retry` and `deliver`.

### `relaylead state get|set <state> [--note text] [--mission name]`

Reads or sets the state declared by the lead (`working`, `waiting`, `done`, `handover`). It is the lead's own channel to tell you where the mission stands.

### `relaylead wait [--timeout seconds] [--mission name]`

Waits until a task or a question of the mission changes, then prints the changes as JSON. `--timeout 0` does not wait. The lead uses it.

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

Sets up the machine once (`~/.relaylead/config.json`), then the current project (`.relaylead.json`, never overwritten). In a terminal it asks a few questions; with `--yes`, or without a terminal, it takes the defaults. Existing files are kept. The project folder must be the root of a git repository.

### `relaylead install`

Registers the launchd agent that runs the watcher (`dev.relaylead.watcher`) and the Claude Code plugin, which adds slash commands (`/relaylead:launch`, `list`, `show`, `answer`, `stop`, `init`, `doctor`). Safe to run again. Without Claude Code, the plugin step is skipped. It finishes with `relaylead doctor`. macOS only.

### `relaylead uninstall [--purge]`

Removes what `install` added, and nothing else. `--purge` also deletes `~/.relaylead` (missions' state, logs, key file), after checking that the folder is Relaylead's.

### `relaylead doctor`

Checks Node, Claude Code, git, the scheduler, the plugin, the watcher, the authentication and a possible `STOP` file. One line per check: `ok`, `warn` or `fail`, then its name and detail. It exits with 1 if a check failed. It starts no session.

## Troubleshooting

- **Start with `relaylead doctor`.** A `fail` line says what is missing (an old Node, Claude Code not found, no `git`, a missing API key file); a `warn` line tells which command to run (`relaylead install`).
- **`~/.relaylead/watcher.log`**: one line per action of the watcher (restarts, wakes, hand-overs, failures, a lead reported `lead-stuck`). It is moved to `watcher.log.1` past 1 MiB. `relaylead watcher run` prints the lines a pass adds.
- **`~/.relaylead/missions/<mission>/journal.log`**: warnings and failures of one mission. The same folder holds its state, tasks and questions.
- **The watcher does nothing.** Check `relaylead watcher status`, and whether `~/.relaylead/STOP` exists. After a restart of the machine, `relaylead install` lets launchd keep it alive; without it run `relaylead watcher start`.
- **A lead does not answer.** It is reported `lead-stuck` and never stopped: `relaylead show <mission>` and write to it.
- **A mission stopped after 3 failed restarts.** Its state and `journal.log` say why. Fix the cause, then launch again.
- **"a mission named ... already exists".** Pass another `--name`, or remove the finished one with `relaylead remove <mission>`.
- **A delivery fails.** The lead asks you what to do. Fix the cause on the task's branch and answer "I fixed it: deliver again", or deliver it yourself.
- **Claude Code says the folder is not trusted.** Run `claude` once in the project folder and accept.
- **GitHub errors.** Check `gh auth status`; the source and the `github-pr` delivery need a signed-in `gh`.

## Uninstalling

```sh
relaylead uninstall            # scheduler and plugin
relaylead uninstall --purge    # also deletes ~/.relaylead
npm uninstall -g relaylead
```

Finish or remove your missions first (`relaylead stop`, `relaylead remove`): `--purge` deletes their state. The branches and worktrees inside your projects (`relaylead/...`, `.relaylead/worktrees/`) are not touched by `uninstall`; remove them with `relaylead remove <mission>` or with `git`. If a step of `uninstall` fails, it prints the command to run by hand.
