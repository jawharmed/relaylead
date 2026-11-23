<p align="right"><strong>English</strong> · <a href="fr/guide.md">Français</a></p>

# Relaylead guide

The reference for Relaylead 0.4: the words it uses, every command and option, every setting. New to Relaylead? Start with [Getting started](getting-started.md), then come back here when you need a detail.

Relaylead runs on macOS only for now. `relaylead help` lists the commands, and `relaylead help <command>` (or `relaylead <command> --help`) explains one.

## Contents

1. [Glossary](#glossary)
2. [How a mission runs](#how-a-mission-runs)
3. [The console in Claude Code](#the-console-in-claude-code)
4. [Configuration](#configuration)
5. [Displays](#displays)
6. [Commands](#commands)
7. [Files and folders](#files-and-folders)
8. [Logs and diagnostics](#logs-and-diagnostics)
9. [Uninstalling](#uninstalling)

## Glossary

These are the only terms Relaylead uses. The French documentation uses the words in brackets.

| Term | Meaning |
| --- | --- |
| **Mission** (*mission*) | One run of a team on a project, with a name (the project folder's name unless you pass `--name`). Its state lives in `~/.relaylead/missions/<mission>/`. |
| **Lead** (*lead*) | The Claude Code session that drives a mission. It reads the tasks, starts crew members, delivers their work, asks you questions and declares the mission done. It never edits code and only runs `relaylead` commands. |
| **Crew member** (*équipier*) | A short-lived Claude Code session that carries out one task, in its own git worktree and on its own branch, then reports with `relaylead task done` or `task fail`. |
| **Watcher** (*veilleur*) | A small loop with no AI. It restarts a lead that stopped, wakes one that has news, hands over to a fresh lead when the context fills up, and starts queued tasks. launchd keeps it alive. |
| **Task** (*tâche*) | One unit of work: a Markdown file in `tasks/`, or a GitHub issue. It has an id, a title, a body, a state, and optionally dependencies (`depends`) and a question to settle first (`ask`). |
| **Integration branch** (*branche d'intégration*) | `relaylead/<mission>/integration`: the mission's own branch, where each finished task is merged. Your branch gets the work only when you run `relaylead merge`. |
| **Console** (*console*) | A Claude Code conversation opened with `/relaylead`, used to write, launch, follow and answer missions. |
| **Question** (*question*) | Something the lead or a guardrail asks you, with numbered options. It waits for your answer. |
| **Delivery** (*livraison*) | How a finished task reaches the integration branch: a local merge (default), a GitHub pull request, or files in a folder. |
| **Project memory** (*mémoire de projet*) | `.relaylead/memory.md`: a short file of conventions and lessons that every lead reads first and compacts before finishing. |

## How a mission runs

[How it works](how-it-works.md) shows the same story as diagrams.

1. **Launch.** `relaylead launch` (or the console) creates the mission, its integration branch and worktree, starts the lead in the background, and starts the watcher.
2. **Plan.** The lead lists the tasks. A task is *ready* when it is to do and every task it depends on is delivered.
3. **Work.** For each ready task the lead starts a crew member, at most `parallel` per mission (4) and `maxSessions` on the machine (4, leads not counted). A task that finds no free place is *queued* and starts as soon as one frees up, highest priority first.
4. **Ask.** A task with `ask` waits until you answer its question. "Skip this task" sets it aside.
5. **Deliver.** A crew member commits on its branch and reports `done`. The lead delivers the task: it is merged into the integration branch, and the tasks that depend on it become ready. A failed task can be retried, on the same branch, up to `maxAttempts` (2).
6. **Finish.** When every task is delivered, failed and reported, or set aside, the lead compacts the project memory and declares the mission `done`. Its sessions are stopped.
7. **Merge.** You run `relaylead merge <mission>` (or say yes in the console). The watcher then removes the mission's state, task worktrees and task branches.

**Mission states:** `starting`, `working`, `waiting` (for you), `handover` (a fresh lead is taking over), `done`, `stopped`. `relaylead list` may add `(n queued)`, `usage-pause (resume …)` or `(abandoned)`.

**Task states:** `todo`, `queued`, `running`, `done` (finished, not delivered yet), `failed`, `delivered`.

### End of a mission

A mission ends when its lead declares it done or when you stop it. Closing Claude Code changes nothing. Once it ends, its sessions are stopped and taken out of the `claude agents` list, and the work stays on `relaylead/<mission>/integration` until you merge it.

- **`relaylead merge <mission>`** merges the integration branch into the branch the mission was launched from (or `main`, or `master`). It works where that branch is checked out (your checkout, which must have no uncommitted change), or else in a worktree of its own, removed afterwards. With `github-pr`, it opens a pull request from the integration branch and merges it on GitHub, closes the issues of the delivered tasks, and deletes the remote integration branch. If your local branch is then behind the remote one, it says so. It never pulls for you.
- **On a conflict** the merge is cancelled and nothing is left half done. A crew member gets the task `merge-into-<branch>`: on a branch of the integration branch, it merges your branch in (so it sees both sides), resolves the conflicts, runs the tests and commits. The watcher then delivers it and merges again by itself. If the crew member fails, you get a question: *Resolve it here with me* (the console walks you through it in the integration worktree, then runs `relaylead merge` again), *Relaunch a crew member with hints* (send the hints with `relaylead tell` first), or *Pause the mission* (run `relaylead merge` again whenever you want).
- **Cleanup.** Once the integration branch is merged into its branch (by `relaylead merge` or by you) or deleted, the watcher removes the mission as `relaylead remove` would: its state, its task worktrees and branches, and its integration worktree when clean. The integration branch itself stays: delete it with `git branch -d`. A mission that delivered nothing is kept: remove it yourself.
- **Abandoned missions.** A mission waiting for an answer while nothing has moved for `abandonDays` days (7) gets one notification, and `relaylead list` and `relaylead doctor` point to it. Nothing is stopped or deleted.

### Questions

Relaylead asks before anything irreversible and before a command outside a session's allowlist. Each new question shows a macOS notification. These questions always wait for you: nothing answers them in your place.

A question the lead asks for itself (a task with `ask`, a failed delivery) follows `questions.onTimeout`: `wait` (the default) waits for you, `recommended` picks the recommended option and `skip` picks "Skip this task", after `questions.timeoutMinutes` (60).

Answer with an option's number (options are numbered from 1, the recommended one first), with its text, or with a free text (`--other`), except for the questions about an irreversible action or a permission (ids `q-irr-…` and `q-perm-…`), which take an option only. Only you can answer: the commands that answer refuse to run inside a mission's session. [Safety](safety.md#what-the-guardrails-do-not-stop) explains the limit of that rule.

### Usage limit and automatic pause

Relaylead reads your Claude usage (5-hour and 7-day windows) from what Claude Code reports to the sessions. When a mission reaches the threshold of its priority, or when Claude reports a usage limit, the watcher pauses the mission: its sessions are stopped and nothing is relaunched. It resumes by itself at the reset time (or after 15, 30, then 60 minutes when no time is given). `relaylead list` and `show` display `usage-pause (resume …)`, and `task start` and `task retry` are refused meanwhile. Questions still notify you during a pause.

Thresholds are in percent, per priority:

| Priority | 7-day window | 5-hour window |
| --- | --- | --- |
| `low` | 70 | 80 |
| `normal` | 90 | 85 |
| `high` | 98 | 85 |

### Context and hand-over

Sessions have a limited context. A lead past its threshold finishes its step, writes where the mission stands, and the watcher starts a fresh lead that picks up from the files. A crew member whose context is full commits, fails its task with "context full", and the lead retries it on the same branch. The thresholds are in the [`context`](#context-thresholds) setting.

## The console in Claude Code

After `relaylead install`, type `/relaylead` in Claude Code, or ask for it ("use relaylead to add a health check"). The plugin's `relaylead` skill turns the conversation into a console:

- it opens with `relaylead brief`: installation problems, news, every open question as it was asked, the missions not over;
- without a `.relaylead.json`, it asks the questions of `init` in the conversation and writes the files; later you can ask for changes in plain words ("limit to 2 crew members here");
- it writes the tasks with you, commits them, launches the mission, then waits for events in the background (`relaylead wait --all`): Claude Code wakes the conversation when something happens, and nothing is spent in between;
- each question is shown as it is, with the mission's name and numbered options; your choice goes back with `relaylead answer`, and it asks you to confirm before sending "Allow once" or "Always allow" for a risky command;
- "tell the lead of X to …" becomes `relaylead tell`; "where is X?" reads the state of the mission;
- when another mission is already running on the machine, it asks the new mission's priority, and warns when two missions touch the same files;
- when a mission is done, it asks "Merge it into main?" and runs `relaylead merge` only on a yes;
- a new conversation first lists every open question and the missions not over, including what happened while no console was open. Questions asked meanwhile are never lost: the watcher still sends the Mac notification, and the questions stay open until answered.

The console is a Claude conversation, so each exchange uses tokens. Use it to decide (write a mission, answer, merge), and `relaylead brief`, the web page or the status line to look. See [Costs](costs.md#the-console-versus-brief-and-the-web-page).

The plugin also adds `/pane` and these slash commands, each of which runs one `relaylead` command: `/relaylead:launch`, `/relaylead:list`, `/relaylead:show`, `/relaylead:answer`, `/relaylead:stop`, `/relaylead:init`, `/relaylead:doctor`.

## Configuration

Settings come from three levels, each overriding the one before:

1. built-in defaults;
2. the machine file `~/.relaylead/config.json` (or `$RELAYLEAD_HOME/config.json`);
3. the project file `.relaylead.json` at the root of the project.

Objects are merged key by key; lists and plain values are replaced. `maxSessions`, `watcher` and `auth` are read from the machine file only. A mission freezes its configuration at launch: a change applies from the next launch. `relaylead doctor` warns about unknown keys and wrong values.

| Setting | Default | Meaning |
| --- | --- | --- |
| `language` | `en` | Language of the messages: `en` or `fr`. `init` suggests `fr` when your `LANG` starts with `fr`. |
| `parallel` | `4` | Tasks of one mission running at the same time. |
| `maxSessions` | `4` | Crew members working at the same time on the machine, every mission included; leads do not count. Machine file only. |
| `priority` | `normal` | Default priority of a mission (`high`, `normal`, `low`): its usage thresholds and its rank in the queue. |
| `maxAttempts` | `2` | Attempts per task. |
| `abandonDays` | `7` | Days without activity, a question open, before a mission is reported abandoned. |
| `permissionMode` | `allowlist` | `allowlist`: sessions run only the commands of their profile, and anything else becomes a question. `all`: nothing is blocked except the guardrails. |
| `source` | `{"type":"tasks-dir","dir":"tasks"}` | Where tasks come from. See [Sources](#sources). |
| `delivery` | `{"type":"local-merge","runHooks":true}` | How tasks are delivered. See [Deliveries](#deliveries). |
| `guard` | see [Guardrails](#guardrails) | Protected branches, secret files, extra allowed commands. |
| `questions` | `{"onTimeout":"wait","timeoutMinutes":60}` | What happens to the lead's own questions left unanswered. See [Questions](#questions). |
| `usage` | see [above](#usage-limit-and-automatic-pause) | Pause thresholds per priority, and `retryMinutes` (`[15, 30, 60]`). |
| `context` | see [Context thresholds](#context-thresholds) | When a session hands over. |
| `memory` | `{"enabled":true,"maxLines":200,"maxBytes":16384,"versioned":false}` | The project memory. See [Memory](#memory). |
| `display` | `{"pane":null,"statusLine":true,"dashboardPort":4317}` | The panel, the status line, the web page's port. See [Displays](#displays). |
| `watcher` | `{"autoStart":true,"helpers":true,"everySeconds":300}` | The watcher. Machine file only. See [The watcher](#the-watcher). |
| `auth` | `{"mode":"login","keyFile":null}` | How sessions sign in. Machine file only. See [API key](#api-key). |
| `attribution` | `null` | Passed as Claude Code's `attribution` setting to every session (what Claude Code adds to its commits). `null` keeps Claude Code's default. |
| `agent`, `method`, `team` | `claude`, `code`, `code` | The agent, the lead's method and the team. Only these built-in values exist today. |

A typical `.relaylead.json`, written by `init` and then edited:

```json
{
  "team": "code",
  "method": "code",
  "source": { "type": "tasks-dir", "dir": "tasks" },
  "delivery": { "type": "local-merge", "runHooks": true },
  "memory": { "enabled": true, "versioned": false },
  "parallel": 2
}
```

**Should you commit `.relaylead.json`?** It holds no secret (the API key, if any, lives in `~/.relaylead/`). Commit it when the settings belong to the project and your team should share them. Leave it untracked when they are yours alone; Relaylead works the same either way.

### Sources

**`tasks-dir`** (default): every `*.md` file of the folder is a task, and its file name, without `.md`, is its id. The task folder must be committed: crew members start from commits. The optional header, between two `---` lines, understands:

- `title`: the task's title (the id when missing);
- `depends`: ids of other tasks, for example `depends: [schema, api]`; the task is ready once all of them are delivered;
- `ask`: a question to settle before the task starts. The lead asks it, offers the choices it names plus "Skip this task", and starts the task once you have answered. Your answer goes to the crew member.

When a task is delivered, a `state: done` line is written in its file on the integration branch (commit `chore(relaylead): deliver <id>`).

Task ids go into branch names: use letters, digits, `.`, `_` and `-`.

**`github-issues`**: each issue with the label (`relaylead` by default) is a task named `issue-<n>`. An open issue is to do, a closed one is done. Issues have no dependencies and ask nothing. `repo` (`owner/name`) is optional: without it, `gh` uses the repository of your folder. Needs `gh`, signed in.

```json
{
  "source": { "type": "github-issues", "label": "relaylead" },
  "delivery": { "type": "github-pr" }
}
```

> [!WARNING]
> The text of an issue becomes the instructions of a crew member. Anyone who can open or edit a labelled issue can steer a session on your Mac. Read [Safety](safety.md#issues-written-by-other-people) first.

### Deliveries

- **`local-merge`** (default): each finished task is merged into the mission's integration branch, `relaylead/<mission>/integration`. Nothing leaves your machine.
- **`github-pr`**: meant for the `github-issues` source. A finished task's branch is pushed to the remote (`origin`, or `delivery.remote`), a pull request to the integration branch is opened and merged at once, the task's branch is deleted on the remote, and the local integration branch follows. No review is waited for: review the integration branch before you merge it into yours. The issue is closed by `relaylead merge` (or by the cleanup of a mission you merged by hand), not at delivery; until then, a second mission with the same label would take it again. The integration branch must be pushable.
- **`files`**: no git needed. Each task writes its output into `out/<mission>/<task id>/` in the project folder, and that folder is the crew member's only place to write.

Relaylead's own commits run your git hooks (with `LC_ALL=C`), in the integration worktree, where no dependencies are installed: a hook that needs `node_modules` (husky, commitlint, lint-staged) fails there. Such projects set `"delivery": {"runHooks": false}`, or deliver one task with `relaylead task deliver <id> --no-hooks --mission <mission>`.

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

- `protectedBranches` cannot be pushed to or committed on by a session.
- `secrets` (patterns, `*` matches any characters) cannot be read or written, except `secretExceptions`.
- `allow` adds commands to the crew's allowlist, in Claude Code's permission syntax, for example `["Bash(npm ci)"]`.

On top of these settings, every session is confined: Claude Code's `Write`, `Edit` and `NotebookEdit` tools are refused outside the session's folder (its worktree, or `out/<mission>/<id>/` with the `files` delivery; Claude Code's own temporary folder is the one exception), and `Read`, `Grep` and `Glob` are refused on credential folders such as `~/.ssh`, `~/.aws`, `~/.config/gh` and the Keychains, on Relaylead's configuration and key file, and on other missions. Paths are resolved first, so a symbolic link does not get around the rule. [Safety](safety.md) lists every path, and what the guardrails do not cover.

In `allowlist` mode the developer profile may install dependencies only with `npm ci --ignore-scripts` or `npm install --ignore-scripts`, because install scripts run third-party code. A project that needs them adds, knowingly, `"guard": {"allow": ["Bash(npm ci)"]}`. Mode `all` allows `npm ci` and runs those scripts.

### Memory

Each project has a memory shared by its missions: `.relaylead/memory.md` at the root of the main repository (never in a worktree). It holds the project's conventions, one line per past mission and the lessons learned. Every lead reads it when it starts (`relaylead memory show`), and compacts it before declaring its mission done: the mission becomes one line, the lessons are merged, what is out of date goes. `state set done` is refused until the memory is written (`--no-memory` is the way out when it cannot be). The previous version is kept in `.relaylead/memory-archive/`, which is never read again. Writes are done under a lock, so two missions never overwrite each other.

Projects set up before 0.4 have `.relaylead/memoire.md` and `.relaylead/memoire-archive/`. Relaylead keeps using them as long as `memory.md` does not exist; nothing is renamed for you. To switch, rename the file yourself while no mission of the project runs (with `git mv` if you version it).

- `memory.enabled` (`true`): `false` turns the memory off.
- `memory.maxLines` (`200`, from 1 to 1000) and `memory.maxBytes` (`16384`, from 1024 to 65536): the ceilings. A memory over either is flagged when a lead starts (it must compact first), `relaylead doctor` warns about it, `memory show` prints only the start that fits, and a compaction over the ceiling is refused.
- `memory.versioned` (`false`): by default the memory stays out of git through `.git/info/exclude` (your `.gitignore` is not touched). With `true` it stays visible to git and you commit it with the code; its archive stays excluded.

`relaylead init` asks both questions (keep a memory; version it). `--yes` takes the defaults, `--no-memory` and `--versioned-memory` answer them.

The memory of one mission (its decisions and the messages you told it) lives in the mission's folder and is deleted with it.

### Context thresholds

`context.budgets` sets how many tokens a session may add to its first measured context, per role (`lead`: 150000, `crew`: 250000). `context.capPercent` (40) caps that at a share of the measured window, and `context.hardPercent` (20) is the margin past which the hand-over is forced. For example `{"context": {"budgets": {"lead": 60000}}}` hands the lead over sooner.

### The watcher

- `watcher.autoStart` (`true`): `relaylead launch` starts the loop.
- `watcher.helpers` (`true`): short targeted passes right after an event of a mission (an answer, a finished task), so the lead is woken within seconds.
- `watcher.everySeconds` (`300`): time between two passes of the loop.
- An empty file `~/.relaylead/STOP` makes the watcher do nothing until you remove it.

After 3 failed restarts of a lead in a row, or at once when a session reports a billing or authentication error, the watcher stops the mission, says why and notifies you.

### API key

By default sessions sign in with your connected Claude account (`auth.mode`: `login`). To use an Anthropic API key instead:

```sh
relaylead init --api-key-env ANTHROPIC_API_KEY   # copies that variable's value to ~/.relaylead/api-key
relaylead init --api-key-file ~/keys/anthropic   # or points to a file you keep yourself
```

The key file is readable by you alone. The key is never printed, and never written to the configuration, a log or the launchd file. Each session gets it through Claude Code's `apiKeyHelper` setting, in the settings Relaylead passes to that session only: a small command reads the file when Claude Code asks, and nothing needs approving. Claude Code then prefers this key to your signed-in account, and an `ANTHROPIC_API_KEY` of your shell is not passed to the sessions.

`relaylead doctor` asks Claude Code which credential it would use (`ok api-key-use`). To check a running session, open it with `relaylead show <mission>` and run `/status`: it must name `apiKeyHelper`, not your Claude account.

### Environment variables

- `RELAYLEAD_HOME`: where Relaylead keeps its state, `~/.relaylead` by default.
- `RELAYLEAD_CLAUDE`: the path of the `claude` executable, when it is not on your `PATH`.

## Displays

Three views show the same thing, read from the files of `~/.relaylead`: every mission on the machine with its state and priority, its tasks, the questions waiting for you (with their options) and the 5-hour and 7-day usage of your account. None of them calls a model.

- **Status line entry.** Inside Claude Code, the plugin adds a line such as `relaylead · 2 missions · ❓1 · quota 5 h 62 %`. It shows only while a mission runs or a question waits. Your own `statusLine` setting is never touched. Turn it off with `relaylead config set display.statusLine false`.
- **Panel.** A panel next to the conversation: one card per mission (questions first, then tasks), a button per option, a text field for a free answer (except for permission and irreversible-action questions), and the usage. It refreshes every 5 seconds. The first time a mission runs, Claude Code asks *Always / This time / Never*; the choice is kept as `display.pane`, or set it with `relaylead config set display.pane always`. **`/pane`** opens or closes it at any time. In a terminal, an automatic opening needs a window about 144 columns wide; `/pane` opens it at any width.
- **Local web page.** `relaylead dashboard` serves a page on `127.0.0.1` only (port `display.dashboardPort`, 4317; `--port` for one launch, `--no-open` to keep the browser closed), opens it, and refreshes it on its own. It works with Claude Code closed. You can answer a question (an option, or a free text) and stop a mission from it. Each launch makes a random token that the page carries, and requests with another Host or Origin are refused, so no other website open in your browser can act on your missions. Any program running on your Mac can still read the page, token included: see [Safety](safety.md#the-local-web-page). Stop the server with Ctrl-C.

The panel and the status line need a Claude Code that supports plugin mods; without it, Relaylead works the same and these two are simply missing. `relaylead overview --json` prints what they read, for your own scripts.

## Commands

Run them from the root of your project unless said otherwise. A mission's name is the one `launch` printed (see `relaylead list`). Commands marked *for sessions* are used by the lead and the crew; you rarely need them.

### `relaylead help [command]`

Lists the commands, or explains one: `relaylead help merge`. `relaylead <command> --help` does the same. `relaylead --version` prints the version.

### `relaylead launch`

Starts a mission with a lead and its crew, prints its name, and returns at once.

- `--request <text>`: what you want done, in one line.
- `--name <name>`: the mission's name (the folder's name by default). Names are unique on the machine: give a second mission in the same folder another name.
- `--tasks <folder>`: the mission's task folder, inside the project (`source.dir`, `tasks` by default).
- `--priority <value>`: `high`, `normal` (default) or `low`. Change it later with `relaylead priority`.
- `--dir <path>`: the project folder (the current folder by default).
- `--force`: launch even though a finished mission of this project, not merged yet, took its tasks from the same source (see below).

Several missions of one project run side by side, each with its own integration branch and worktrees; their git operations on the repository take turns. Each mission needs tasks of its own:

```sh
relaylead launch --name backend --tasks tasks/backend --request "Build the API"
relaylead launch --name frontend --tasks tasks/frontend --request "Build the pages"
```

`launch` refuses:

- when the task folder is missing, holds no `.md` file, or has uncommitted changes; the message says which, with an example task;
- while a mission of the same project that is not over takes its tasks from the same source (the same folder, or the same GitHub label);
- when a mission of the same project that is done but not merged had the same source, since the new one would do the same tasks again: merge it (`relaylead merge <m>`), remove it (`relaylead remove <m>`), or pass `--force`.

A launch that fails removes the integration branch and worktree it created. `launch` also starts the watcher's loop unless `watcher.autoStart` is `false`.

### `relaylead list`

One line per mission: name, state, the lead's session, folder. The state may say `(n queued)`, `usage-pause (resume …)` or `(abandoned)`. A mission whose files cannot be read shows as `unreadable`, with its path, and the others still show.

### `relaylead brief`

What the console shows when a conversation opens, as a short text: installation problems (only when there are some), what happened since the last look, every open question in full (finished missions included), and one line per mission not over. After a mission is done, it names the next command, `relaylead merge <mission>`. Reads local files only; no model is called.

### `relaylead answer <mission> <id> <choice>`

Answers a question with an option's number or text. `--other "<text>"` gives a free answer instead (not for `q-irr-…` and `q-perm-…` questions). The lead is woken within seconds.

```sh
relaylead answer hello-api q-license 1
relaylead answer hello-api q-license --other "MIT, holder Lilia Digital"
```

### `relaylead question list [<mission>] [--all]`

The open questions as JSON (every question with `--all`), each with its id, text, numbered options and the recommended one. An unknown mission is an error. `question ask` is *for sessions*: it is how the lead asks you something.

### `relaylead tell <mission> <text>`

Tells the lead something: a change of plan, a constraint. The message is kept in the mission and the lead is woken within seconds; it reads the message in the output of its next `relaylead wait`. Refused for a mission that is done or stopped.

```sh
relaylead tell hello-api "Use port 8080, not 3000"
```

### `relaylead merge <mission>`

Merges a done mission into the branch it was launched from. Never run by Relaylead on its own. It prints the merge commit (or the pull request), or the conflict and the task that resolves it. See [End of a mission](#end-of-a-mission).

### `relaylead priority <mission> <high|normal|low>`

Changes a mission's priority, even while it runs: its usage thresholds and its rank in the queue.

### `relaylead show <mission>`

Opens the lead's session in Claude Code so you can read it and write to it. For a finished mission, whose session is gone, it says so and how to read the conversation again (`claude --resume`).

### `relaylead stop <mission>`

Stops the mission and all its sessions. Clean task worktrees are removed (ignored files included, such as `node_modules`); their branches stay. A worktree with uncommitted changes, or whose session is still running, is kept and reported.

### `relaylead remove <mission> [--force]`

Removes a finished (done or stopped) mission: its task worktrees, its task branches `relaylead/<mission>/…` and its state. Its sessions are taken out of the `claude agents` list (their conversations stay in `claude --resume`). The integration branch and its worktree stay, with the delivered work. It refuses, before deleting anything, a task branch with commits not delivered and a task worktree with uncommitted changes, and names them. `--force` deletes them anyway and prints each deleted branch with its last commit, so you can recreate it with `git branch <name> <commit>`.

### `relaylead dashboard [--port n] [--no-open]`

Serves the local web page described in [Displays](#displays) until Ctrl-C.

### `relaylead overview --json`

Every mission on the machine as JSON: name, folder, priority, state, pause, tasks, open questions with their options, the account's usage and the display settings. Writes nothing and uses no network.

### `relaylead config set <key> <value>`

Writes one display setting in `~/.relaylead/config.json`: `display.pane` (`always` or `never`), `display.statusLine` (`true` or `false`), `display.dashboardPort` (1 to 65535). Edit the other settings in the files.

### `relaylead init [--yes] [--api-key-env NAME] [--api-key-file PATH] [--no-memory] [--versioned-memory]`

Sets up the machine once (`~/.relaylead/config.json`), then the current project (`.relaylead.json`, never overwritten). It must run at the root of a git repository. In a terminal it asks a few questions: the language (suggested from `LANG`), your Claude account or an API key, whether to run `install`, whether to keep a project memory and whether to version it. With `--yes`, or without a terminal, it takes the defaults. It ends with the next steps, among them the task folder to fill.

### `relaylead install`

Registers the launchd agent of the watcher (`dev.relaylead.watcher`) and the Claude Code plugin, which brings the `/relaylead` console, the `/pane` panel and the `/relaylead:*` commands. It also makes `~/.relaylead` private to your account (folder 700, files 600). Safe to run again. Without Claude Code, the plugin step is skipped. It finishes with `relaylead doctor`.

### `relaylead uninstall [--purge] [--force]`

Stops the watcher and waits for its end, then removes what `install` added, and nothing else. `--purge` also deletes `~/.relaylead` (missions' state, logs, key file), after checking that the folder is Relaylead's. `--purge` refuses while a mission is not finished, and names it; `--purge --force` first stops those missions' sessions, then deletes. See [Uninstalling](#uninstalling).

### `relaylead doctor`

Checks Node, Claude Code, git, the scheduler (and that the Node and `PATH` it was installed with still exist), the plugin, the watcher, the authentication, the configuration (unknown keys, `language`, `permissionMode`, `parallel`, `maxSessions`), the permissions of `~/.relaylead`, the project memory, abandoned missions and a `STOP` file. One line per check: `ok`, `warn` or `fail`, its name and detail. It exits with 1 when a check failed, and starts no session.

### `relaylead watcher start|stop|status|run`

- `watcher start`: starts the loop (nothing changes if it already runs).
- `watcher stop`: stops it, until the next `watcher start` or `launch`.
- `watcher status`: whether it runs, and when it last passed.
- `watcher run [--mission <name>]`: makes one pass now, over every mission or one, and prints what it did.

### `relaylead wait`

- `wait --all [--timeout seconds] [--json]`: for the console. Waits until something you must know happens in any mission (a question, a failed task, a mission done or stopped, a merge), then prints one line per event, named by its mission. `--timeout 0` looks once. Each event is given once.
- `wait [--timeout seconds] [--mission name]`: *for sessions*. The lead waits until a task, a question or a message of its mission changes.

### `relaylead task`

Manages the tasks of a mission. Outside a session, add `--mission <name>`.

- `task list [--short]`: the tasks as JSON, with state, `ready`, `ask` and summary; `--short` prints one line per task.
- `task retry <id> [--profile p]`: starts a new crew member on a failed task, on the same branch, told how the earlier attempt failed. Limited by `maxAttempts`.
- `task deliver <id> [--no-hooks]`: delivers a done task. `--no-hooks` skips your git hooks; only you can use it.
- `task start <id>`, `task done <id>`, `task fail <id> [--summary text]`: *for sessions*.

### `relaylead state`, `decision`, `memory`

*For sessions.* `state get|set <state> [--note text]` reads or sets the state declared by the lead. `decision <text>` notes a decision taken with you; `decision --list` prints them, with every message told by `tell`. `memory show` and `memory write --base <fingerprint> --file <file> | --text <text>` read and replace the project memory.

## Files and folders

What Relaylead writes, and where.

**In your project:**

| Path | Written by | Notes |
| --- | --- | --- |
| `.relaylead.json` | `init` | Project settings, never overwritten by `init`. Commit it or not: see [Configuration](#configuration). |
| `tasks/*.md` | you, or the console | Your tasks. They must be committed before a launch. |
| `.relaylead/worktrees/<mission>/<task>/` | missions | One git worktree per running task, removed once the task is delivered. |
| `.relaylead/worktrees/<mission>/_integration/` | missions | The worktree of the integration branch. |
| `.relaylead/memory.md`, `.relaylead/memory-archive/` | leads | The project memory (`memoire.md` in projects set up before 0.4). |
| `.git/info/exclude` | `init`, missions | Gets `.relaylead/` (or rules that leave only the memory visible, if versioned), so none of this shows in `git status`. Your `.gitignore` is not touched. |
| branches `relaylead/<mission>/<task>` | missions | One per task, deleted once delivered. |
| branch `relaylead/<mission>/integration` | missions | The delivered work. Stays after the merge, until you delete it. |
| `out/<mission>/<task>/` | `files` delivery | Only with that delivery. |

**On your Mac:**

| Path | Contents |
| --- | --- |
| `~/.relaylead/config.json` | Machine settings. |
| `~/.relaylead/missions/<mission>/` | A mission's state, tasks, questions, decisions, messages and `journal.log`. Removed after the merge. |
| `~/.relaylead/watcher.log` | One line per action of the watcher. |
| `~/.relaylead/api-key` | The API key, only with `--api-key-env`. |
| `~/Library/LaunchAgents/dev.relaylead.watcher.plist` | The watcher's launchd agent. |
| Claude Code's plugin list | The `relaylead` plugin from the `relaylead-local` marketplace. Nothing is written in your Claude Code settings directly. |

`~/.relaylead` is private to your account (700 for folders, 600 for files); `install` and `doctor` fix older folders.

## Logs and diagnostics

- **`relaylead doctor`** comes first. A `fail` line says what is missing; a `warn` line says which command to run.
- **`~/.relaylead/watcher.log`**: one line per action of the watcher (restarts, wakes, hand-overs, failures, a lead reported `lead-stuck`). Moved to `watcher.log.1` past 1 MiB. `relaylead watcher run` prints the lines a pass adds.
- **`~/.relaylead/missions/<mission>/journal.log`**: warnings and failures of one mission, including actions the guardrails refused.
- **`relaylead show <mission>`** opens the lead's conversation, to see what it is doing.

The [FAQ](faq.md#troubleshooting) answers the common problems one by one.

## Uninstalling

```sh
relaylead uninstall --purge    # watcher, plugin and ~/.relaylead
npm uninstall -g relaylead
```

`--purge` refuses while a mission is not finished, and names it. Stop it first (`relaylead stop <mission>`), or add `--force` to stop the sessions of every unfinished mission before deleting. Without `--purge`, `~/.relaylead` stays, with your settings and missions.

`uninstall` does not touch your projects. In each project where you ran missions, you can then remove:

```sh
git worktree list                              # the worktrees under .relaylead/worktrees/
git worktree remove .relaylead/worktrees/<mission>/_integration
git branch --list 'relaylead/*'                # the branches Relaylead created
git branch -D relaylead/<mission>/integration  # once you no longer need the work
rm -rf .relaylead .relaylead.json
```

Then remove the `.relaylead/` lines from `.git/info/exclude`. If a step of `uninstall` fails, it prints the command to run by hand.
