# Contributing to Relaylead

Thank you for helping. Bug reports, documentation fixes and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- what you did, what you expected, and what happened;
- `relaylead --version` and the output of `relaylead doctor`;
- the relevant lines of `~/.relaylead/watcher.log` or `~/.relaylead/missions/<mission>/journal.log`, if any.

Read them before you paste: remove paths, names or anything private. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setting up

You need macOS, Node.js 18 or newer, and git. There is nothing to install: Relaylead has no dependencies.

```sh
git clone https://github.com/jawharmed/relaylead.git
cd relaylead
npm test
```

The test suite uses a stand-in for Claude Code, so it needs no Claude account and makes no call to Claude. It takes a few minutes. To run one file: `node --test test/cli.test.js`.

To try your copy of the command without touching an installed one, run `node bin/relaylead.js <command>`, with `RELAYLEAD_HOME` pointing to a temporary folder.

## How the code is organized

| Folder | Contents |
| --- | --- |
| `bin/` | The `relaylead` entry point. |
| `core/` | Missions, tasks, questions, the watcher, the guardrails (`guard.js` and `hooks/`), the CLI (`cli.js`), the messages in English and French (`messages.js`). |
| `adapters/claude/` | How Relaylead starts and drives Claude Code sessions. |
| `sources/`, `deliveries/` | Where tasks come from (task folder, GitHub issues) and how they are delivered (local merge, pull request, files). |
| `catalog/` | The lead's method and the profiles of the lead and the developer. |
| `plugin/` | The Claude Code plugin: the `/relaylead` console skill, slash commands, the panel and status line. |
| `docs/` | The documentation, in English, with the French version in `docs/fr/`. |
| `test/`, `fixtures/` | The tests and their helpers. |

## Conventions

- **Node.js 18, CommonJS, no dependencies.** Code should stay readable by a beginner: no abstraction "just in case".
- **Every user-facing message** goes through `core/messages.js`, in English and in French.
- **Every change comes with tests.** `npm test` must pass on Node 18 and the latest Node; the CI runs both on macOS.
- **Documentation in both languages.** When you change a page in `docs/`, change its twin in `docs/fr/`. `test/docs-parity.test.js` checks that both have the same `##` sections, in the same order. Commands, options and function names stay in English in both.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(cli): …`, `fix(watcher): …`, `docs: …`.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests and documentation.
3. Run `npm test`.
4. Open a pull request that says what changes for the user and how you checked it.

Small, focused pull requests are reviewed fastest. For a larger change, open an issue first so we can agree on the approach.

## License

By contributing, you agree that your contributions are licensed under the [MIT license](LICENSE).
