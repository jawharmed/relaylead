# Relaylead

Relaylead runs a team of Claude Code sessions in the background on a mission: a lead splits the work, crew members do it, and you hear from them only when something cannot be undone.

> **macOS only for now.** The scheduler (`relaylead install`) uses launchd, and the project is tested on macOS alone.

## Why

- **Without Relaylead**, you watch your sessions by hand: you restart the one that died, nudge the one that stalled, and review each result as it lands.
- **With Relaylead**, a team moves on its own. A lead hands out the tasks, a developer session works on each one on its own branch, and a watcher (no AI) restarts or wakes what stops. The lead asks you a question only before something irreversible, such as a failed delivery or a task that must be confirmed first.

## Quick start

```sh
npm install -g relaylead     # the relaylead command
relaylead install            # launchd watcher and the Claude Code plugin
```

Then open Claude Code in your project and type `/relaylead` (or say "use relaylead to ..."). The conversation becomes the console: it sets the project up if needed, writes the mission with you, launches it, shows each question the lead asks as it comes (with the mission's name), sends your answers, and passes on what you tell the lead ("tell the lead of X to ..."). A new conversation starts by listing the open questions and the missions still running. Several missions can run at once.

Without Claude Code open, the command line does the same:

```sh
relaylead init               # machine settings, then this project's .relaylead.json
relaylead launch --request "Carry out the tasks"
relaylead list               # follow the missions
```

As the lead asks questions:

```sh
relaylead question list <mission>
relaylead answer <mission> <question id> <choice>
relaylead tell <mission> "Use the v2 API"   # tell the lead something
relaylead show <mission>     # open the lead's session
```

See everything at once: a panel and a status line inside Claude Code, or `relaylead dashboard` for a local web page (see the guide, "Displays").

`launch` prints the mission's name. The work lands on the mission's own branch, `relaylead/<mission>/integration`; your own checkout is never changed. Several missions can run in the same project at once, each with its own name and its own tasks: `relaylead launch --name backend --tasks tasks/backend`, then `relaylead launch --name frontend --tasks tasks/frontend`.

By default the tasks are the Markdown files of the `tasks/` folder, one per task, with a small header (`title`, and optionally `depends` and `ask`). They can also be GitHub issues delivered as pull requests: see the guide.

## Requirements

- macOS
- Node.js 18 or newer
- Claude Code (2.1.325 or newer), signed in. Run `claude` once in your project folder and trust it.
- `git`
- `gh` (the GitHub CLI), signed in, only for the GitHub issues source and pull request delivery

`relaylead doctor` checks all of this.

## Safety

- **Guardrails.** Sessions run with nobody watching, so some actions are refused whatever the permission mode: pushes to protected branches (`main` and `master` by default), forced pushes, commits on a protected branch, secret files (`.env` and friends) and the mission's own state folder. Crew sessions only get the commands their profile allows.
- **Questions before the irreversible.** The lead never decides alone on what cannot be undone: a delivery that failed, a task set to ask first, a failed task. It asks you, with options, and waits for your answer.
- **A project memory, kept short.** Leads read `.relaylead/memoire.md` at the start and compact it (200 lines at most) before finishing; it stays out of git unless you choose otherwise.
- **Your checkout stays yours.** Work happens in separate worktrees and branches; nothing is merged into your branch.
- **API key never shown.** With `relaylead init --api-key-env NAME`, the key is copied to a file readable by you alone; Relaylead never prints it, and it is not stored in the configuration, a log or a launchd file. The sessions get it through Claude Code's `apiKeyHelper` setting, and `relaylead doctor` checks that Claude Code picks it over your signed-in account.

## Documentation

- [User guide](docs/guide.md): concepts, configuration, every command, troubleshooting, uninstalling.
- [Design](docs/specs/2026-11-14-relaylead-design.md) (in French).

## Develop

`npm test` runs the test suite (Node.js 18 or newer, no dependency to install).

## License

MIT
