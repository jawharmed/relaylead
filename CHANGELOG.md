# Changelog

All notable changes to Relaylead. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (before 1.0, a minor version may change behavior).

## [0.4.0] - 2026-11-23

Safety, a clearer command line, complete French, and documentation in English and French. Version 0.3.0 was published on GitHub only, never on npm: if you update from npm's 0.2.0, read the 0.3.0 notes below too.

### Security

- **Writes are confined.** Claude Code's `Write`, `Edit`, `MultiEdit` and `NotebookEdit` tools are refused outside the session's folder (the task's worktree, or `out/<mission>/<id>/` with the `files` delivery), judged on the real path with symbolic links resolved, in both permission modes. The session's own temporary folder (`/private/tmp/claude-<uid>/<project>/<session>/`) is the only exception; Relaylead's folder is always refused; the lead writes no file. A refused session is told to finish what it can and say what it could not write.
- **Sensitive files are off limits to the file tools.** `Read`, `Grep` and `Glob` are refused on `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.config/anthropic`, `~/.config/gcloud`, `~/Library/Keychains`, `~/.claude.json`, `~/.claude/.credentials.json`, `~/.npmrc`, `~/.git-credentials`, `~/.docker/config.json`, `~/.kube`, Relaylead's `config.json`, `api-key` and `missions/`, the key file given with `--api-key-file`, and the tokens of `$CLAUDE_CONFIG_DIR`. `Grep` and `Glob` also refuse to search a folder that holds one of these places, such as your home folder.
- The protection of a mission's state folder now resolves real paths, so an equivalent path or a symbolic link no longer gets around it.
- `~/.relaylead` is private to your account: folders 700, files 600. `relaylead install` and `relaylead doctor` put an existing folder back to 700, and `doctor` reports it on a `permissions` line.
- `relaylead uninstall --purge` refuses while a mission may still have sessions running (not finished, a merge conflict being resolved, or unreadable), and names it. `--purge --force` stops those sessions first; if one cannot be stopped, nothing is deleted and the command exits with 1. The purge does not stop a running `relaylead dashboard`: close it with Ctrl-C.
- The documentation now states the threat model plainly: the guardrails stop the mistakes of an agent acting in good faith, not a hijacked agent. See [Safety](docs/safety.md).

### Added

- Help for each command: `relaylead help [command]` and `relaylead <command> --help`. `merge` is listed in the general help.
- After a mission is done, `relaylead wait --all` names the next command, `relaylead merge <mission>`, when the mission can be merged, and `relaylead brief` lists it under *Done, not merged yet*.
- `relaylead init` asks for the language of the messages, suggesting `fr` when `LANG` starts with `fr`, and writes it to the machine settings when they have none, also with `--yes`.
- `relaylead launch --force`, to launch even though a finished, unmerged mission of the project took its tasks from the same source.
- `relaylead doctor` checks the configuration (unknown settings, `language`, `permissionMode`, `parallel`, `maxSessions`), and that the Node and the script saved in the launchd agent still exist and that `claude` is on the `PATH` it saved.
- `relaylead install` updates the Claude Code plugin when the one installed is from another version.
- A usage pause is announced: a macOS notification when the watcher pauses a mission, and an event in `relaylead wait --all` and `relaylead brief` ("mission paused until 14:05 (usage 90 %)"), with another when the mission resumes.
- `relaylead uninstall` without `--purge` warns, naming the missions still running: nothing will watch them, and a paused one will not resume.
- Documentation in English and French: getting started, guide, how it works, safety, costs, FAQ. `SECURITY.md`, `CONTRIBUTING.md`, this changelog and `llms.txt`.

### Changed

- **The project memory is now `.relaylead/memory.md`**, and its archive `.relaylead/memory-archive/`. Existing `memoire.md` files are not renamed: Relaylead keeps using `memoire.md` as long as `memory.md` does not exist, and the git exclusion rules cover both names.
- **The panel command is `/pane`** (it was `/panneau`).
- The messages, the help and `doctor` are complete in French.
- `launch` refuses when a finished mission of the same project, not merged yet, took its tasks from the same source, instead of doing the same tasks again. The message offers `relaylead merge`, `relaylead remove` or `--force`. It also waits while such a mission's merge is not over. Neither applies to the `files` delivery.
- `launch` gives three distinct messages for a missing task folder, a folder without `.md` files, and uncommitted changes, each with an example task. The last line of `init` mentions the task folder.
- The console asks you to confirm before it sends *Allow once* or *Always allow* for a risky command, and points to `relaylead brief` or the web page for simply looking.
- `list`, `brief`, `overview`, the web page and `doctor` show a mission whose state files cannot be read as `unreadable`, with its path, instead of failing for every mission.

### Fixed

- Mission names lose their accents instead of their letters: `Équipe-essai` gives `equipe-essai` (it gave `quipe-essai`). A folder name with no usable letter or digit gives an error that proposes `--name`.
- The questions of the hooks (options and context), the states in `brief` and `list` (`working`, `done`...) and the priorities are shown in French when the language is French; they are still typed in English.
- The last line of `uninstall --purge` is in the user's language.
- The console confirms a risky command by repeating the action, and the number or the label of the option is enough; it no longer promises to require exact words.
- `relaylead init` names the choice to make in Claude Code's trust question, *Yes, I trust this folder*, and warns that the default, *No, exit*, refuses.
- `uninstall --purge` accepts a custom `RELAYLEAD_HOME` that holds a `config.json` or a `missions` folder, even if `install` never ran; a folder that looks like nothing known is still refused.
- Wording of the French documentation, and absolute image URLs in the French README, as in the English one.
- A failed launch removes the integration branch and worktree it created.
- `relaylead show` on a finished mission prints a clear message instead of Claude Code's raw error.
- `relaylead brief` no longer prints "Nothing new." above a question marked new.
- `relaylead question list <unknown mission>` is an error, like `show`.
- Two timing tests no longer fail on a loaded machine (git's time limit in those tests goes from 1 s to 4 s).

### Updating to 0.4

- After `npm install -g relaylead`, run `relaylead install` again: it updates the Claude Code plugin and the watcher's launchd agent, and makes `~/.relaylead` private.
- Use `/pane` instead of `/panneau`.
- A task that wrote files outside its worktree will now see those writes refused. Keep tasks inside the repository.
- `relaylead uninstall --purge` now refuses while a mission may still have sessions running: stop it first, or add `--force`.
- `relaylead doctor` may now warn about settings it does not know: they were always ignored, and are usually typos.

## [0.3.0] - 2026-11-23

Published as a GitHub release only.

### Changed

- **Lighter console.** `relaylead brief` opens it in one command: installation problems, new events, every open question as it is, missions not over. The console skill is half its former size. Measured: the marginal cost of opening the console is down 29 %.
- Compact outputs for the console: `wait --all` prints text (`--json` keeps the former format), and `task list --short` prints one line per task.
- Under `claude -p`, `wait --all` returns at once instead of keeping the call open.
- `github-pr`: the issue is closed when the mission is merged (`relaylead merge`), not when the task is delivered; the remote integration branch is deleted after the merge, and a local branch behind its remote is reported.
- `state set done` outside a session is refused until the project memory is written; `state set` confirms in one line.

### Added

- A free answer ("Other") in the web page and the panel, except for irreversible-action and permission questions.
- The plugin's author, homepage, README, icon and keywords; `claude plugin validate` passes without warnings.

## [0.2.0] - 2026-11-22

Relaylead is now driven from Claude Code.

### Added

- **The console in Claude Code:** `/relaylead`, or "use relaylead to …", launches and follows missions, shows each question as it is, passes on your instructions (`relaylead tell`), and catches up when a conversation reopens.
- **Several missions per project:** one task source and one integration branch per mission, a git lock per repository, a ceiling of crew sessions on the machine with a queue by priority (`relaylead priority`).
- **`relaylead merge`**, with conflicts resolved by a crew member, then a question if needed.
- **A project memory**, capped and compacted at the end of each mission.
- **Displays:** a status line entry and a panel in Claude Code, and a local web page, `relaylead dashboard`.
- Automatic cleanup at the end of a mission; abandoned missions are reported.

### Updating from 0.1

Relaylead 0.1 ran one mission per folder, delivered on the shared branch `relaylead/integration`, and kept its worktrees directly under `.relaylead/worktrees/`. Since 0.2, each mission has its own branch `relaylead/<mission>/integration` and its own folder `.relaylead/worktrees/<mission>/`.

- **A 0.1 mission still running** finishes with the names of then. Until it is over, `launch` is refused in its folder; stop it with `relaylead stop <mission>` if its lead is gone.
- **Work delivered by 0.1 and not merged into your branch** stays on `relaylead/integration`. A new mission starts from your current branch, so it does not see that work and may do its tasks again: `launch` warns about it and goes on. Before launching, merge `relaylead/integration` into your branch (`git merge relaylead/integration`), or delete that branch if the work is not wanted.
- **`delivery.branch`** in `.relaylead.json` is no longer read.
- **Output of the `files` delivery** now goes to `out/<mission>/<task id>/`.

## [0.1.0] - 2026-11-22

First public release, macOS only.

- `npm install -g relaylead`, then `relaylead install`.
- A mission starts a lead and crew members, Claude Code sessions in the background; a watcher with no AI restarts, wakes and stops what needs it.
- Questions before any irreversible action, with a macOS notification.
- Automatic pause based on your Claude usage (5-hour and 7-day windows).
- GitHub source and delivery (issues and pull requests through `gh`).
- Sign-in with your Claude account or an API key.

[0.4.0]: https://github.com/jawharmed/relaylead/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jawharmed/relaylead/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jawharmed/relaylead/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jawharmed/relaylead/releases/tag/v0.1.0
