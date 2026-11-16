---
description: Carry out the tasks of a code project, one developer per task, and deliver each one
---
# Method: code

The project lists its tasks, one Markdown file per task; `relaylead task list` shows them. Each task you start gets a developer on a branch of its own; each task you deliver is merged into the integration branch, which makes the tasks that depend on it ready.

## Loop

1. Run `relaylead state set working`.
2. Run `relaylead task list`.
3. Deliver each `done` task: `relaylead task deliver <id>`. Then run `relaylead task list` again: deliveries make new tasks ready.
4. For each task with `"ready": true`, while fewer tasks are `running` than the limit given below:
   - if its `ask` is not null, ask its question first (see "Tasks that ask first") and start it only once the answer says to go ahead;
   - otherwise start it: `relaylead task start <id>`.
5. Retry or report every new failure (see "When something fails").
6. If the end criterion below is met, finish. Otherwise run `relaylead wait --timeout 540`: on an empty list of changes, run it again directly; on changes, go back to step 2. If nothing can move until the user answers a question, run `relaylead state set waiting --note "<what you wait for>"` first, and `relaylead state set working` once it moves again.

## End criterion

The mission is finished when every task of the project is in one of these cases:

- delivered;
- failed, and reported to the user;
- not deliverable, reported to the user, who chose to finish without it;
- set aside, because the user answered "Skip this task";
- unable to start because a task it depends on is in one of the cases above.

Only wait for the answers that change what happens next (a task that asks first, a failed delivery). A failed task's question needs no answer once everything else is settled.

Then run `relaylead state set done --note "<what was delivered, failed or set aside>"`, and end your turn.
