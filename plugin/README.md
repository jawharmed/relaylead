# Relaylead plugin for Claude Code

Relaylead runs a mission with a team of Claude Code sessions in the background on macOS: a lead splits the work into tasks, crew members carry them out on their own git branches, a watcher keeps everything moving, and you are asked a question only before something irreversible. This plugin is the front door inside Claude Code. It adds the `/relaylead` console and a few slash commands so you can start a mission, follow it and answer its questions without leaving your conversation.

The plugin does not run anything by itself. Every command calls the `relaylead` command line tool installed on your Mac, and shows you its output. The tool runs on macOS only and needs Node.js 18 or later.

## Install

```
npm install -g relaylead
relaylead install
```

`relaylead install` sets up the background watcher and adds this plugin to Claude Code. The marketplace it registers is called `relaylead-local`, so to add the plugin again by hand, run `/plugin install relaylead@relaylead-local` in Claude Code. To remove everything, run `relaylead uninstall`.

## The console

Open Claude Code in your project and type `/relaylead`, or say "use relaylead to ...". The conversation becomes the console. It sets the project up if needed, writes the mission with you, launches it, shows each question the lead asks exactly as it was asked, sends your answers, and passes on what you tell the lead. A new conversation starts by listing the open questions and the missions still running.

The console is a Claude conversation, so each exchange uses tokens. To simply look at your missions, `relaylead brief` in a terminal, `relaylead dashboard` or the status line show the same thing for free.

## Commands

| Command | What it does |
| --- | --- |
| `/relaylead` | Opens the console. |
| `/relaylead:launch` | Starts a mission (`--request`, optionally `--name` and `--dir`). |
| `/relaylead:list` | Lists the missions and their state. |
| `/relaylead:show` | Shows one mission in detail. |
| `/relaylead:answer` | Answers a question a mission asked. |
| `/relaylead:stop` | Stops a mission. |
| `/relaylead:init` | Sets Relaylead up on this machine and in this project. |
| `/relaylead:doctor` | Checks the installation. |
| `/pane` | Opens or closes the side panel with the missions, their tasks and their questions. |

## What it touches

The plugin only runs `relaylead` commands, each one allowed by name. It sends nothing over the network. Missions and their files live under `~/.relaylead` and in your project's own git repository.

## More

- [Getting started](https://github.com/jawharmed/relaylead/blob/main/docs/getting-started.md): a first mission, step by step.
- [Guide](https://github.com/jawharmed/relaylead/blob/main/docs/guide.md): every command and setting.
- [Safety](https://github.com/jawharmed/relaylead/blob/main/docs/safety.md): what the guardrails stop, and what they do not.
- [Costs](https://github.com/jawharmed/relaylead/blob/main/docs/costs.md): which models run and what a mission costs.
- [Documentation en français](https://github.com/jawharmed/relaylead/blob/main/README.fr.md).

Source and issues: https://github.com/jawharmed/relaylead. License: MIT.
