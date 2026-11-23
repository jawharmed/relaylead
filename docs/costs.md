<p align="right"><strong>English</strong> · <a href="fr/costs.md">Français</a></p>

# What Relaylead costs

Relaylead is free and open source. The Claude Code sessions it starts use your Claude plan or your API key, like any Claude Code session you start yourself. This page says which models run, what we measured, and how to spend less.

## Which models run

| Part | Model | Effort | Notes |
| --- | --- | --- | --- |
| Lead | Opus (`--model opus`) | medium | One per mission. Claude Code resolves the alias to its current Opus: Opus 5.5 in November 2026. |
| Crew member | Sonnet (`--model sonnet`) | medium | One per running task. Sonnet 5.5 in November 2026. |
| Watcher | none | | A Node.js loop. It never calls a model. |
| Console | the model of your conversation | | Only while you talk to it in Claude Code. |
| `brief`, dashboard, status line, `/pane` | none | | They read local files. |

The models are set by Relaylead's built-in profiles and cannot be changed by a setting in 0.4.

## What a mission costs

We measured a real mission on November 23, 2026 (Claude Code 2.1.330, macOS): a toy project with two very small tasks, one of which asked a question first. It went from launch to done in about a minute and a half.

| Session | Model | Messages | Cache written | Cache read | Output | Cost at API prices |
| --- | --- | --- | --- | --- | --- | --- |
| Lead | Opus 5.5 | 20 | 22,238 | 978,982 | 2,780 | about $0.43 |
| Crew member, task 1 | Sonnet 5.5 | 7 | 12,664 | 300,546 | 942 | about $0.09 |
| Crew member, task 2 | Sonnet 5.5 | 5 | 12,208 | 210,363 | 602 | about $0.08 |
| **Mission** | | | | | | **about $0.60** |

Prices used, per million tokens (Anthropic list prices, November 2026): Opus 5.5, $8 for a cache write (one-hour cache), $0.20 for a cache read, $20 for output; Sonnet 5.5, $4, $0.10 and $10. With five-minute cache writes the total would be a little lower.

What this tells you:

- **The lead is most of the bill.** It re-reads its context at every step (listing tasks, waiting, delivering), so its cost grows with the number of steps: more tasks, more questions, more waits.
- **A crew member's cost grows with its task**: the code it reads, the tests it runs, the changes it makes.
- **Two tiny tasks are the floor, not an average.** We have not yet published measurements of a large mission. Watch your first missions with `relaylead brief` and your usage before you launch big ones.

## The console versus brief and the web page

The `/relaylead` console is a Claude conversation: every exchange costs tokens. The other views read local files and cost nothing. Measured with Opus 5.5 at API prices, through `claude -p` (November 2026):

| What you do | Cost |
| --- | --- |
| Any new Claude Code conversation, without Relaylead ("Reply only: OK") | $0.19, Claude Code's own start-up |
| Open the console in a new conversation and ask where the missions stand | $0.30 to $0.35 |
| A newcomer's first question in an empty folder ("what do I do to launch my first mission?") | $0.46 |
| A follow-up in the same conversation ("where are my missions?") | $0.13 to $0.15 |
| Answer a question through the console | about $0.13 |
| Wait for events in the background between two events | $0 |
| `relaylead brief`, `relaylead dashboard`, the status line, `/pane` | $0 |

So: **use the console to decide, and `brief` or the web page to look.** Writing a mission with the console, answering a question in your own words, or resolving a merge conflict together is worth a few tens of cents. Asking it "where are we?" ten times a day is not: `relaylead brief` prints the same text for free.

## Subscription usage and the automatic pause

On a Claude subscription, these tokens count toward your 5-hour and 7-day usage instead of a bill. Relaylead reads that usage from what Claude Code reports and pauses a mission when it reaches the threshold of its priority:

| Priority | Pauses at, 7-day window | Pauses at, 5-hour window |
| --- | --- | --- |
| `low` | 70 % | 80 % |
| `normal` | 90 % | 85 % |
| `high` | 98 % | 85 % |

A paused mission stops its sessions and resumes by itself when the window resets. Change the thresholds with the [`usage`](guide.md#usage-limit-and-automatic-pause) setting, and a mission's priority with `relaylead priority <mission> low`.

With an API key there are no such windows: the sessions spend from your API credit. When the credit runs out, the watcher stops the mission at once and notifies you, rather than waking sessions that would fail the same way.

## Spending less

- **Look without the console:** `relaylead brief`, `relaylead dashboard`, the status line.
- **Group tiny changes** into one task: each task costs a session start and several lead steps.
- **Write precise tasks** with a clear way to check them. A vague task makes a crew member read more and try more.
- **Keep the project memory short.** Every lead reads it first. The default ceiling is 200 lines.
- **Use `low` priority** for missions that can wait: they pause earlier and leave room in your week.
- **Stop a mission that goes the wrong way** with `relaylead stop <mission>`, then fix the tasks and launch again. Delivered work stays on the integration branch.

## How these numbers were measured

- **Mission:** token counts read from the sessions' transcripts during an independent test of Relaylead 0.3.0 on November 23, 2026, then priced at the list prices above. Relaylead 0.4 changes neither the models nor the lead's method.
- **Console:** `claude -p "<text>" --output-format json`, cost read from `total_cost_usd`, in an isolated test environment with the plugin loaded, on November 22 and 23, 2026. For a resumed conversation, the cost of one exchange is the difference with the session it resumed. These calls resume a saved conversation, which writes its cache again; in a conversation that stays open, a follow-up probably costs less (not measured).
- **Environment:** a new Claude Code conversation carries about 35,000 tokens of system prompt, tools and plugins before you type anything. That part, $0.19 here, does not depend on Relaylead and varies with your own setup.

Prices change; check [Anthropic's pricing page](https://www.anthropic.com/pricing) for current numbers.
