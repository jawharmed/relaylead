# Relaylead plugin for Claude Code

Relaylead runs a mission with a team of Claude Code sessions in the background: a lead plans the work, teammates do it in their own branches, a watcher keeps everything moving, and you are asked a question only before something irreversible. This plugin is the front door inside Claude Code. It adds the `/relaylead` console and a few slash commands so you can start a mission, follow it and answer its questions without leaving your conversation.

The plugin does not run anything by itself. Every command calls the `relaylead` command line tool installed on your Mac, and shows you its output. The tool runs on macOS only and needs Node.js 18 or later.

## Install

```
npm install -g relaylead
relaylead install
```

`relaylead install` sets up the background watcher and adds this plugin to Claude Code. To remove everything, run `relaylead uninstall`.

## The console

Open Claude Code in your project and type `/relaylead`, or say "use relaylead to ...". The conversation becomes the console. It sets the project up if needed, writes the mission with you, launches it, shows each question the lead asks exactly as it was asked, sends your answers, and passes on what you tell the lead. A new conversation starts by listing the open questions and the missions still running.

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
| `/panneau` | Opens the side panel with the missions and their questions. |

## What it touches

The plugin only runs `relaylead` commands, each one allowed by name. It sends nothing over the network. Missions and their files live under `~/.relaylead` and in your project's own git repository.

## More

The full guide, with the mission lifecycle, the guardrails and every setting, is in [docs/guide.md](https://github.com/jawharmed/relaylead/blob/main/docs/guide.md). Source and issues: https://github.com/jawharmed/relaylead. Licence: MIT.
