---
description: Carry out the tasks of a code project, one developer per task, and deliver each one
---
# Method: code

The project lists its tasks, one Markdown file per task; `relaylead task list` shows them. Each task you start gets a developer on a branch of its own; each task you deliver is merged into the integration branch, which makes the tasks that depend on it ready.

## Loop

1. Run `relaylead state set working`.
2. Run `relaylead task list`.
3. Deliver each `done` task: `relaylead task deliver <id>`. Then run `relaylead task list` again: deliveries make new tasks ready.
   When the tasks are GitHub issues (ids `issue-<n>`), each delivery pushes the task's branch, opens a pull request to the integration branch, merges it. The issue is closed later, by `relaylead merge`. The delivery's output gives the pull request's address.
4. For each task with `"ready": true`, while fewer tasks are `running` or `queued` than the limit given below:
   - if its `ask` is not null, ask its question first (see "Tasks that ask first") and start it only once the answer says to go ahead;
   - otherwise start it: `relaylead task start <id>`.
5. Retry or report every new failure (see "When something fails"). A task failed with "context full" is retried at once: `relaylead task retry <id>`.
6. If the end criterion below is met, finish. If no task is running and nothing can move until the user answers: run `relaylead state set waiting --note "<what you wait for>"`, then `relaylead wait --timeout 0`. If it lists changes, go back to step 2; otherwise end your turn: Relaylead wakes you when something changes. While a task is running, run `relaylead wait --timeout 540` instead (on an empty list, run it again); on changes, go back to step 2.

## End criterion

The mission is finished when every task of the project is in one of these cases:

- delivered;
- failed, and reported to the user;
- not deliverable, reported to the user, who chose to finish without it;
- set aside, because the user answered "Skip this task";
- unable to start because a task it depends on is in one of the cases above.

Only wait for the answers that change what happens next (a task that asks first, a failed delivery). A failed task's question needs no answer once everything else is settled.

Then run `relaylead state set done --note "<what was delivered, failed or set aside>"`, and end your turn.
