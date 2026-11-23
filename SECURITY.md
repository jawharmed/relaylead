# Security policy

## Supported versions

Security fixes go into the latest minor version. Update with `npm install -g relaylead@latest`.

| Version | Supported |
| --- | --- |
| 0.4.x | Yes |
| 0.3.x and older | No |

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue:

1. Open the repository's **Security** tab on GitHub and choose **Report a vulnerability** (private vulnerability reporting).
2. Describe the problem, the version (`relaylead --version`), your macOS and Claude Code versions, and the steps to reproduce it.

You should get a first answer within a week. Once a fix is released, the report can be made public, with credit to you if you wish.

## What counts as a vulnerability

Relaylead's guardrails are meant to stop the mistakes of an agent acting in good faith. They are not a sandbox, and the [threat model](docs/safety.md) lists what they knowingly do not stop: a session that runs `node`, `git` tricks or a modified test script to get around a rule, or a local process that reads the web page's token.

Please do report, for example:

- a plain action that the guardrails should refuse and do not (a write outside the worktree with the `Write` tool, a push to a protected branch, opening `.env` with `Read`);
- a way for a website open in your browser to act on your missions through `relaylead dashboard`;
- an API key or another secret written to a log, the configuration, the launchd file or the terminal;
- a command that deletes work without the documented checks.

When in doubt, report it.
