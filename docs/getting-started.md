<p align="right"><strong>English</strong> · <a href="fr/getting-started.md">Français</a></p>

# Getting started with Relaylead

This page takes you from nothing installed to a first mission merged into your branch. It takes about ten minutes, plus the time the mission runs (a minute or two for the small example below).

If a word is new to you (mission, lead, crew member, watcher), the [glossary](guide.md#glossary) has one line for each.

## Before you start

Check each line in a terminal. Every command should print a version.

| You need | Check with | If it is missing |
| --- | --- | --- |
| A Mac | `sw_vers` | Relaylead runs on macOS only for now. |
| Node.js 18 or newer | `node --version` | Install it from [nodejs.org](https://nodejs.org), or with `brew install node`. |
| git | `git --version` | macOS offers to install it the first time you run `git`. |
| Claude Code 2.1.325 or newer | `claude --version` | Install it from [the Claude Code docs](https://docs.claude.com/en/docs/claude-code/overview), then `claude update`. |
| Claude Code signed in | run `claude` once | Sign in with a Claude plan that includes Claude Code (Pro, Max, Team or Enterprise). An Anthropic API key works too: see [API key](guide.md#api-key). |
| A project in git | `git status` in its folder | Run `git init`, then make a first commit. |

`gh`, the GitHub CLI, is needed only to take tasks from GitHub issues. You can skip it for now.

## Step 1: Install Relaylead

```sh
npm install -g relaylead
relaylead install
```

`npm install -g` adds the `relaylead` command. `relaylead install` then does two things on your Mac:

- it registers a launchd agent, `dev.relaylead.watcher`, so the watcher keeps running after a restart;
- it adds the Relaylead plugin to Claude Code, which brings the `/relaylead` console, the `/pane` panel and a few `/relaylead:*` commands.

It ends by running `relaylead doctor`, which prints one line per check:

```text
ok node: 24.19.0
ok claude: 2.1.330 (Claude Code)
ok git: found
ok scheduler: installed and loaded
ok plugin: relaylead@relaylead-local
ok watcher: no pass recorded yet
ok auth: login (the connected Claude account)
```

A `warn` line names the command to run; a `fail` line says what is missing. You can run `relaylead doctor` again at any time.

## Step 2: Trust your project in Claude Code

Claude Code refuses to start a session in a folder you have not trusted, and Relaylead's sessions are no exception. Go to the root of your project (the folder that holds `.git`) and start Claude Code once:

```sh
cd ~/code/hello-api
claude
```

Claude Code asks whether you trust the files in this folder. Use the arrow keys to select **Yes, I trust this folder**, then press Enter.

> [!IMPORTANT]
> The answer selected by default is **No, exit**. Pressing Enter right away refuses, and every mission in that folder will then fail to start with "Claude Code does not trust the folder".

Keep this Claude Code window open for step 3.

## Step 3: Start a mission from Claude Code

In the Claude Code conversation, type `/relaylead` followed by what you want done:

```text
/relaylead add a GET /health endpoint with a test, and a LICENSE file
```

You can also just ask in plain words: "use relaylead to add a health check". The conversation becomes the **console**. The first time in a project, it:

1. runs `relaylead brief` and shows what it says (installation problems, open questions, missions);
2. asks the setup questions: your Claude account or an API key, how many crew members may work at once, whether to keep a project memory and whether to commit it;
3. writes `.relaylead.json` at the root of your project.

Then it writes the plan with you, one Markdown file per task under `tasks/`. Read them, ask for changes, and approve. The console commits the task files (crew members work from commits, so uncommitted tasks would not reach them), launches the mission, and starts listening for events in the background. Listening costs nothing: Claude Code wakes the conversation only when something happens.

You can close the conversation at any time. The mission keeps running, and a new conversation starts by listing what happened meanwhile.

## Step 4: Answer the questions, then merge

When the lead needs you, the question appears in the conversation exactly as it was asked, with the mission's name and numbered options, and your Mac shows a notification:

```text
[hello-api] q-license (new): Which license should the project use, MIT or Apache-2.0?
  1. MIT (recommended)
  2. Apache-2.0
  3. Skip this task
```

Reply with a number ("1"), or in your own words ("MIT, with Lilia Digital as the holder"): the console sends it with `relaylead answer`. For a question about a risky command (its id starts with `q-irr-` or `q-perm-`), the console asks you to confirm before it sends "Allow once" or "Always allow".

While the mission runs you can say:

- "where is hello-api?" for its tasks and the lead's last note;
- "tell the lead of hello-api to use port 8080" to pass on an instruction;
- "stop hello-api" to stop it (the console asks you to confirm once).

When the mission is done, the console asks **"Merge it into main?"** (or the branch you launched it from). On a yes it runs `relaylead merge hello-api`. Until then your branch has not changed: the work waits on the branch `relaylead/hello-api/integration`, where you can review it with `git diff main...relaylead/hello-api/integration`.

That is the whole loop. The next section runs the same mission from the terminal, so you can see each piece.

## A complete mission from the terminal

This is the same mission without Claude Code open. The project is a tiny Node.js API, `hello-api`, already in git.

**1. Set up the project.** Run `relaylead init` at the root of the repository.

```sh
cd ~/code/hello-api
relaylead init
```

The first time on a Mac, it asks a few questions; press Enter to take the default shown in brackets.

| Question | Default | What it decides |
| --- | --- | --- |
| Language of the messages | `fr` when your `LANG` starts with `fr`, otherwise `en` | The language of everything Relaylead prints. |
| Authentication | `login` | `login` uses your signed-in Claude account; `api-key` copies a key from an environment variable. |
| Run `relaylead install` now? | `no` | Skip it if you already ran it in step 1. |
| Keep a project memory for the leads? | `yes` | A short file of conventions and lessons that every lead reads first. |
| Version the project memory with the code? | `no` | `yes` lets you commit it; `no` keeps it out of git. |

It writes `~/.relaylead/config.json` (once per Mac) and `.relaylead.json` (once per project), then reminds you of the trust step and of a few access tips. `relaylead init --yes` takes every default without asking.

**2. Write the tasks.** One Markdown file per task in `tasks/`. The file name is the task's id.

`tasks/health.md`:

```markdown
---
title: Add a health check endpoint
---
Add GET /health to server.js. It returns 200 and {"status":"ok"}.
Cover it with a test in test/health.test.js, and keep `npm test` green.
```

`tasks/license.md`:

```markdown
---
title: Add a LICENSE file
ask: Which license should the project use, MIT or Apache-2.0?
---
Add a LICENSE file at the root with the license chosen, for the year 2026.
Mention it in the "License" section of README.md.
```

The header between the two `---` lines takes `title`, and optionally `depends` (tasks that must be delivered first, such as `depends: [health]`) and `ask` (a question the lead asks you before starting the task).

**3. Commit the tasks.** Crew members start from commits.

```sh
git add tasks
git commit -m "Add Relaylead tasks"
```

**4. Launch.**

```text
$ relaylead launch --request "Add a health check and a license"
hello-api
watcher started: it checks the missions every 300 s and ends once none needs it
```

The first line is the mission's name: the project folder's name, unless you pass `--name`. The command returns at once; the mission runs in the background.

**5. Follow it.**

```text
$ relaylead list
hello-api  working  hello-api/lead/1  /Users/you/code/hello-api
```

Behind the scenes, the lead read the tasks, started a crew member on `health`, and asked you about `license`, since that task asks first. Your Mac shows a notification for the question. `relaylead brief` shows everything at once:

```text
$ relaylead brief
Open questions (1):
[hello-api] q-license (new): Which license should the project use, MIT or Apache-2.0?
  1. MIT (recommended)
  2. Apache-2.0
  3. Skip this task
Missions not over:
  hello-api: working · tasks 0/2 delivered (1 running)
```

The lead writes its own questions, so yours may be worded differently. `relaylead dashboard` opens the same view in your browser, and `relaylead show hello-api` opens the lead's session if you want to read what it is doing.

**6. Answer.**

```text
$ relaylead answer hello-api q-license 1
question q-license answered: MIT
```

The lead is woken within seconds and starts a crew member on `license`. A free answer works too: `relaylead answer hello-api q-license --other "MIT, holder Lilia Digital"`.

**7. Wait for the end.** Each crew member works in its own worktree, runs the tests, commits, and reports. The lead merges each finished task into `relaylead/hello-api/integration`. When every task is settled, the lead writes the project memory and declares the mission done. In our test, two small tasks took about a minute and a half from launch to done.

```text
$ relaylead list
hello-api  done  hello-api/lead/1  /Users/you/code/hello-api
```

**8. Review, then merge.**

```sh
git log --oneline main..relaylead/hello-api/integration
git diff main...relaylead/hello-api/integration
```

```text
$ relaylead merge hello-api
mission hello-api merged into main (3f2a9c1d8e0b4a6f9c2d7e5b1a8f3c0d9e6b2a71)
```

`merge` needs your checkout to have no uncommitted change on that branch. If the two sides conflict, nothing is left half done: a crew member resolves the conflict on its own branch and Relaylead merges again by itself, or asks you if the crew member cannot.

Once merged, the watcher cleans up: the mission's state in `~/.relaylead/missions/hello-api/`, its task worktrees and its task branches go. The branch `relaylead/hello-api/integration` stays until you delete it with `git branch -d relaylead/hello-api/integration`.

## Writing good tasks

The lead does not invent work: it carries out the tasks you give it. Good tasks make good missions.

- **One outcome per task**, small enough for one session: "Add GET /health with a test", not "Improve the API".
- **Say how to check it.** "Keep `npm test` green", "the page must render without console errors". Crew members run the project's tests before they commit.
- **Use `depends`** when a task needs another one's code: `depends: [schema]`. The task starts only once `schema` is delivered into the integration branch.
- **Use `ask`** for a choice only you can make. The lead asks it before the task starts, and the answer goes to the crew member.
- **Keep secrets out.** Crew members cannot open `.env` files, and should not need to.

## Next steps

- Run two missions side by side: `relaylead launch --name backend --tasks tasks/backend`, then `relaylead launch --name frontend --tasks tasks/frontend`. See [Commands](guide.md#relaylead-launch).
- Take tasks from GitHub issues and deliver pull requests: see [Sources](guide.md#sources).
- Read [Safety](safety.md) before you point Relaylead at code or issues you do not control.
- See where the money goes in [Costs](costs.md), and the answers to common problems in the [FAQ](faq.md).
