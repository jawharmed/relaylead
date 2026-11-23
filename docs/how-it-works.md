<p align="right"><strong>English</strong> · <a href="fr/how-it-works.md">Français</a></p>

# How Relaylead works

Relaylead is a command-line tool (`relaylead`) that starts and supervises Claude Code sessions running in the background (`claude --bg`). It keeps every piece of state in plain files under `~/.relaylead`, so a session, a conversation or the whole Mac can stop and start again without losing the mission. This page shows the moving parts as diagrams. The words are defined in the [glossary](guide.md#glossary).

## The big picture

```mermaid
flowchart LR
  you(["You"])
  subgraph mac["Your Mac"]
    console["Console<br/>/relaylead in Claude Code"]
    cli["Terminal<br/>relaylead brief, answer, merge"]
    state[("~/.relaylead<br/>missions, tasks, questions")]
    watcher{{"Watcher<br/>no AI, kept alive by launchd"}}
    lead["Lead<br/>Claude Code session, Opus"]
    crewA["Crew member<br/>task A, Sonnet"]
    crewB["Crew member<br/>task B, Sonnet"]
    repo[("Your git repository")]
  end
  you --> console
  you --> cli
  console --> state
  cli --> state
  lead <--> state
  lead -->|"task start"| crewA
  lead -->|"task start"| crewB
  crewA -->|"commits on its own branch"| repo
  crewB -->|"commits on its own branch"| repo
  lead -->|"delivers into the integration branch"| repo
  watcher -.->|"restarts, wakes, hands over"| lead
  watcher -.->|"starts queued tasks"| crewB
```

- **You** talk to Relaylead through the console (a Claude Code conversation) or the terminal. Both run the same `relaylead` commands.
- **The lead** is one Claude Code session per mission. It never edits code: it reads the tasks, starts crew members, delivers their work and asks you questions, only through `relaylead` commands.
- **Crew members** are short-lived Claude Code sessions, one per task, each in its own worktree and on its own branch.
- **The watcher** is a plain Node.js loop with no AI. It makes sure the lead is alive and awake when something is waiting for it.
- **The files** in `~/.relaylead` are the single source of truth. A fresh lead reads them and carries on where the previous one stopped.

## A mission from start to finish

The [example from Getting started](getting-started.md#a-complete-mission-from-the-terminal): two tasks, `health` and `license`, where `license` asks a question first.

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant R as relaylead
  participant L as Lead
  participant C1 as Crew member (health)
  participant C2 as Crew member (license)
  participant W as Watcher
  You->>R: relaylead launch
  R->>L: start the lead in the background
  R->>W: start the watcher
  L->>R: task list
  L->>C1: task start health
  L->>R: question ask (license asks first)
  R-->>You: Mac notification
  You->>R: relaylead answer hello-api q-license 1
  R->>W: targeted pass
  W->>L: wake the lead: an answer is waiting
  L->>C2: task start license
  C1->>R: task done
  L->>R: task deliver health
  C2->>R: task done
  L->>R: task deliver license
  L->>R: memory write, then state set done
  You->>R: relaylead merge hello-api
  W->>R: clean up the mission
```

Each crew member works on its own: it reads its task, changes the code, runs the project's tests, commits on its branch, and ends with `relaylead task done` (or `task fail` with the reason). The lead delivers a done task by merging its branch into the integration branch, which makes the tasks that depend on it ready.

## Mission and task states

A mission:

```mermaid
stateDiagram-v2
  [*] --> starting
  starting --> working
  working --> waiting: nothing can move until you answer
  waiting --> working: you answered
  working --> handover: the lead's context is full
  handover --> working: a fresh lead takes over
  working --> done: every task settled
  starting --> stopped
  working --> stopped
  waiting --> stopped: relaylead stop, or the watcher
  done --> [*]: relaylead merge, then cleanup
  stopped --> [*]
```

A task:

```mermaid
stateDiagram-v2
  [*] --> todo
  todo --> queued: no free place on the machine
  queued --> running: a place frees up
  todo --> running: task start
  running --> done: the crew member committed and reported
  running --> failed: task fail, or context full
  failed --> running: task retry (same branch)
  done --> delivered: merged into the integration branch
  delivered --> [*]
```

A task with `ask` stays `todo` until you answer its question. "Skip this task" sets it aside for good.

## Branches and worktrees

Every mission works on branches of its own, so your checkout is never touched while it runs. Here is what the example looks like in git (the real branch names are `relaylead/hello-api/integration`, `relaylead/hello-api/health` and `relaylead/hello-api/license`):

```mermaid
gitGraph
  commit id: "your work"
  commit id: "Add Relaylead tasks"
  branch integration
  checkout integration
  branch health
  checkout health
  commit id: "Add GET /health"
  checkout integration
  merge health id: "deliver health"
  branch license
  checkout license
  commit id: "Add MIT license"
  checkout integration
  merge license id: "deliver license"
  checkout main
  merge integration id: "relaylead merge"
```

- The integration branch starts from the branch you launched from, with its worktree in `.relaylead/worktrees/<mission>/_integration/`.
- Each task gets a branch from the integration branch and a worktree in `.relaylead/worktrees/<mission>/<task>/`. A crew member's file tools can only write there.
- Delivering a task merges its branch into the integration branch, then removes the task's worktree and branch.
- `relaylead merge` merges the integration branch into your branch. On a conflict, it cancels the merge, and a crew member resolves it on a branch of its own first.
- Git operations of different missions on the same repository take turns, under a lock.

## The watcher

The watcher is a loop of plain rules, with no model and no tokens spent. launchd keeps it alive across restarts of the Mac; `relaylead launch` also starts it. A pass runs every 5 minutes, and a short targeted pass runs right after an event (an answer, a finished task, a message).

| It sees | It does |
| --- | --- |
| A lead that stopped | Restarts it: the same session when its context is low, otherwise a fresh one that starts from the files. |
| A lead that ended its turn while an answer, a finished task or a message waits | Wakes it. |
| A lead whose context is full | Starts a fresh lead and stops the old one once it has written where things stand. |
| A second lead, or a crew session whose task no longer runs | Stops it. |
| A free place on the machine and queued tasks | Starts the queued task of the highest-priority mission. |
| Usage over the mission's threshold, or a usage limit | Pauses the mission and resumes it at the reset time. |
| 3 failed restarts in a row, or a billing or authentication error | Stops the mission, says why and notifies you. |
| A done mission whose integration branch was merged or deleted | Removes its state, task worktrees and task branches. |

Everything it does goes to `~/.relaylead/watcher.log`. An empty file `~/.relaylead/STOP` makes it do nothing until you remove it.

## The console and the terminal

The console and the terminal reach the same files. The difference is cost: the console is a Claude conversation, while `brief`, the web page and the status line only read files.

```mermaid
flowchart TB
  need{"What do you need?"}
  need -->|"look: progress, open questions"| look["relaylead brief<br/>relaylead dashboard<br/>status line and /pane"]
  need -->|"decide: write a mission, answer, merge"| decide["/relaylead console<br/>a Claude conversation"]
  look --> files[("~/.relaylead")]
  decide --> commands["relaylead launch, answer, tell, merge"]
  commands --> files
  look -.- free["no model call, no cost"]
  decide -.- tokens["uses tokens on every exchange"]
```

The console listens for events with `relaylead wait --all`, run as a background command: Claude Code wakes the conversation only when something happens, so a mission that runs for an hour costs nothing in the console while it runs. [Costs](costs.md#the-console-versus-brief-and-the-web-page) has the measured numbers.

## Where the state lives

| What | Where |
| --- | --- |
| Machine settings | `~/.relaylead/config.json` |
| A mission's state, tasks, questions, decisions, messages, journal | `~/.relaylead/missions/<mission>/` |
| The watcher's log | `~/.relaylead/watcher.log` |
| Project settings | `.relaylead.json` in the project |
| Project memory | `.relaylead/memory.md` in the project |
| Work in progress | `.relaylead/worktrees/<mission>/` and the `relaylead/<mission>/…` branches |

All writes are atomic and guarded by locks with the holder's process id, so two commands never corrupt a file, and a lock left by a dead process is taken over. The complete list is in [Files and folders](guide.md#files-and-folders).
