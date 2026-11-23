<p align="right"><strong>English</strong> · <a href="fr/faq.md">Français</a></p>

# Relaylead FAQ

Short answers to real questions, with links to the details. Problems come last, under [Troubleshooting](#troubleshooting).

## About Relaylead

### What is Relaylead?

Relaylead is an open-source command-line tool and Claude Code plugin for macOS. It runs a team of Claude Code sessions in the background on a mission: a lead session splits the work into tasks, crew sessions carry them out on their own git branches, and a watcher with no AI keeps them going. You are asked a question only before something irreversible, and the work reaches your branch only when you merge it.

### Who is it for?

Developers who already use Claude Code and have work that splits into clear tasks: a backlog of small features, fixes, tests to add, documentation to write. If you find yourself running several Claude Code sessions by hand and restarting the ones that stall, Relaylead does that part for you.

### How is it different from Claude Code subagents or agent teams?

Subagents live inside one conversation, and Claude Code's experimental agent teams end with their session: when it ends or its context fills up, the work stops with it. Relaylead's sessions are independent background sessions (`claude --bg`). A watcher outside Claude Code restarts them, hands over to a fresh lead when the context fills up, and pauses before your usage limits. Each crew member works in its own git worktree, and the state lives in files, so a crash or a restart of the Mac loses nothing.

### Does it work on Linux or Windows?

Not yet. The watcher relies on launchd and Relaylead is tested on macOS only. `relaylead install` refuses on other systems.

### Is it free?

Relaylead is free and MIT-licensed. The sessions it starts use your Claude plan or API key. See [How much does a mission cost?](#how-much-does-a-mission-cost)

### Can I use it in French?

Yes. Set `"language": "fr"` in `~/.relaylead/config.json`; `relaylead init` suggests it when your `LANG` starts with `fr`. Every message, the help and `doctor` are translated, and the [French documentation](fr/getting-started.md) is complete. Commands and options stay in English.

## Installing and setting up

### Which Claude plan do I need?

Any plan that includes Claude Code: Pro, Max, Team or Enterprise. You can also use an Anthropic API key: `relaylead init --api-key-env ANTHROPIC_API_KEY`. See [API key](guide.md#api-key).

### Why does Claude Code say the folder is not trusted?

Claude Code runs sessions only in folders you have trusted. Run `claude` once in the project folder and choose **Yes, I trust this folder**. The default answer, *No, exit*, refuses: pressing Enter without moving the selection is the usual cause.

### Do I have to use the console?

No. Every action has a command: `relaylead launch`, `brief`, `answer`, `tell`, `merge`. The console in Claude Code is a convenience for writing missions and answering questions in plain words. See [Getting started](getting-started.md#a-complete-mission-from-the-terminal).

### Should I commit `.relaylead.json`?

Commit it if the settings belong to the project and your team should share them. It never holds a secret: API keys stay in `~/.relaylead/`. Leave it untracked if the settings are yours alone. Relaylead works the same either way.

### How do I update Relaylead?

```sh
npm install -g relaylead@latest
relaylead uninstall    # while no mission is running; keeps ~/.relaylead
relaylead install      # registers the watcher and the plugin of the new version
```

`relaylead --version` prints the version you have. The [changelog](../CHANGELOG.md) says what changed and what to do when updating.

### How do I uninstall Relaylead completely?

```sh
relaylead uninstall --purge
npm uninstall -g relaylead
```

`--purge` refuses while a mission is running; stop it first or add `--force`. Branches and worktrees in your projects stay: [Uninstalling](guide.md#uninstalling) shows how to remove them.

## Running missions

### How do I write a task?

One Markdown file per task in `tasks/`, committed. A `title` in a small header, then the instructions:

```markdown
---
title: Add a health check endpoint
depends: [server]
ask: Should /health also report the database status?
---
Add GET /health that returns 200 and {"status":"ok"}. Cover it with a test.
```

`depends` and `ask` are optional. [Writing good tasks](getting-started.md#writing-good-tasks) has advice.

### Can I take tasks from GitHub issues?

Yes: set `"source": {"type": "github-issues"}` and `"delivery": {"type": "github-pr"}` in `.relaylead.json`, and add the `relaylead` label to the issues. You need `gh`, signed in. Read [Issues written by other people](safety.md#issues-written-by-other-people) first.

### Can I run several missions at once?

Yes, in one project or several. In one project, give each mission its own name and task folder:

```sh
relaylead launch --name backend --tasks tasks/backend --request "Build the API"
relaylead launch --name frontend --tasks tasks/frontend --request "Build the pages"
```

At most 4 crew members work at a time on the machine (`maxSessions`); the others wait in a queue, highest priority first.

### How do I tell the lead something while it works?

`relaylead tell <mission> "Use the v2 API"`, or "tell the lead of X to …" in the console. The lead is woken within seconds and follows it.

### What happens when a task fails?

The lead reads the crew member's summary. When another try can fix the cause, it starts a new crew member on the same branch, told how the first attempt failed (`maxAttempts` is 2 attempts in all). Otherwise it reports the failure to you as a question (*Go on without it* or *Stop the mission now*) and goes on with the other tasks. A failed delivery gets its own question (*I fixed it: deliver again* or *Finish without this task*).

### Can I close Claude Code, or my laptop, while a mission runs?

Closing Claude Code changes nothing: the sessions run in the background. When the Mac sleeps, everything pauses and goes on when it wakes. After a restart, launchd starts the watcher again, and it restarts the leads that stopped. Questions asked meanwhile stay open until you answer them.

### What if I never answer a question?

The lead waits, and works on what does not depend on the answer. After 7 days without activity (`abandonDays`) you get one reminder, and `relaylead list` marks the mission `abandoned`. Nothing is stopped or deleted. For the lead's own questions you can choose to apply the recommended option after a delay: see [Questions](guide.md#questions).

## Git and your repository

### Does Relaylead change my branch or my working copy?

Not while a mission runs. Work happens in separate worktrees under `.relaylead/worktrees/` and on `relaylead/<mission>/…` branches. Your branch changes only when you run `relaylead merge`, which needs your checkout to have no uncommitted change.

### What does Relaylead write in my repository?

`.relaylead.json` (written by `init`), the `.relaylead/` folder (worktrees and the project memory), local branches named `relaylead/<mission>/…`, and a line `.relaylead/` in `.git/info/exclude` so none of it shows in `git status`. Your `.gitignore` is never touched, and nothing is pushed unless you use the GitHub delivery. Full list: [Files and folders](guide.md#files-and-folders).

### How do I review the work before it reaches my branch?

```sh
git log --oneline main..relaylead/<mission>/integration
git diff main...relaylead/<mission>/integration
```

The integration worktree, `.relaylead/worktrees/<mission>/_integration/`, is a normal checkout where you can run the tests.

### What happens on a merge conflict?

`relaylead merge` cancels the merge and nothing is left half done. A crew member resolves the conflict on a branch of its own, runs the tests, and Relaylead merges again by itself. If the crew member cannot, you get a question: resolve it together in the console, relaunch with hints, or pause.

## Costs and limits

### How much does a mission cost?

A real mission with two small tasks cost about $0.60 at API list prices, three quarters of it for the lead (Opus); crew members run on Sonnet. Bigger missions cost more: the lead's share grows with the number of steps. On a subscription it counts toward your usage instead. See [Costs](costs.md).

### Will Relaylead use up my weekly limit?

It pauses a mission when your usage reaches its priority's threshold: 90 % of the week and 85 % of the 5-hour window for `normal`, 70 % and 80 % for `low`. The mission resumes by itself after the reset. See [Subscription usage](costs.md#subscription-usage-and-the-automatic-pause).

### Why is the console more expensive than `relaylead brief`?

The console is a Claude conversation; each exchange is a model call. `brief` reads local files. Use the console to decide and `brief`, the web page or the status line to look.

## Safety

### Is it safe to let sessions run with nobody watching?

For your own code and tasks, the guardrails catch the usual mistakes: writing outside the worktree, pushing to `main`, opening `.env`, destructive git commands. They are not a sandbox against an agent that has been hijacked. Read [Safety](safety.md).

### Is it safe to run on GitHub issues written by other people?

Only with precautions. An issue's text becomes a crew member's instructions, and a crew member can run `node` and `git`. Use a macOS account or a machine that holds no secrets, a `gh` token limited to that repository, and review the integration branch before merging. See [Issues written by other people](safety.md#issues-written-by-other-people).

### Does Relaylead send data anywhere?

No telemetry. Sessions talk to Anthropic like any Claude Code session; `gh` and `git push` reach GitHub only with the GitHub source or delivery. The web page listens on `127.0.0.1` only.

## Troubleshooting

Start with `relaylead doctor`: each `warn` or `fail` line says what to do.

### `launch` says the task folder is missing, empty, or not committed

Crew members start from commits, so the task folder must exist, hold at least one `.md` file, and be committed:

```sh
mkdir -p tasks
$EDITOR tasks/first-task.md
git add tasks && git commit -m "Add tasks"
```

With `--tasks <folder>`, the same applies to that folder.

### `launch` says another mission already takes its tasks from this source

Two missions on the same tasks would do the same work. If the other mission is still running, give the new one its own task folder (`--tasks tasks/other`) or wait. If it is done but not merged, merge it (`relaylead merge <mission>`) or remove it (`relaylead remove <mission>`); `--force` launches anyway.

### "a mission named … already exists"

Mission names are unique on the machine. Pass `--name`, or remove the finished mission with `relaylead remove <mission>`.

### A mission stopped with "billing error" or "authentication failed"

Waking the sessions again would fail the same way, so the watcher stopped the mission and notified you. Add API credit or fix the key or the sign-in (`relaylead doctor`), then launch again. Work already delivered is on the integration branch; run `relaylead remove <mission>` first to reuse the name.

### A mission stopped after 3 failed restarts

The lead could not be restarted. `relaylead list` and `~/.relaylead/missions/<mission>/journal.log` say why. Fix the cause, then launch again.

### The watcher does nothing

Run `relaylead watcher status`, and check that `~/.relaylead/STOP` does not exist. If `relaylead doctor` says the scheduler is not installed or not loaded, run `relaylead install`. After updating Node (with nvm, for example), run `relaylead install` again so launchd uses the new path.

### A lead does not answer

The watcher reports it as `lead-stuck` in `~/.relaylead/watcher.log` and never stops it on that ground alone. Open it with `relaylead show <mission>` and write to it.

### A delivery fails because of a git hook

Relaylead's commits run your hooks in the integration worktree, where `node_modules` is not installed, so hooks such as husky or commitlint fail. Set `"delivery": {"runHooks": false}` in `.relaylead.json`, or deliver that task yourself with `relaylead task deliver <id> --no-hooks --mission <mission>`.

### A crew member says a write was refused

Since 0.4, crew members can write only inside their own worktree. If a task really needs to change files elsewhere, change them yourself, or rewrite the task so the work stays in the repository.

### The panel or the status line does not appear

They need a Claude Code version that supports plugin mods, and the plugin installed (`relaylead doctor`, line `plugin`). Open the panel with `/pane`. The status line shows only while a mission runs or a question waits, and can be turned off with `display.statusLine`.

### `relaylead show` says the session is gone

The mission is finished and its sessions were removed from `claude agents`. Their conversations are still in `claude --resume`.

### GitHub errors

Check `gh auth status`. The `github-issues` source and the `github-pr` delivery need `gh` signed in, and a pushable integration branch.
