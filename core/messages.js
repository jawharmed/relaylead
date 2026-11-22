const messages = {
  en: {
    help: [
      'Usage: relaylead <command> [options]',
      '',
      'Commands:',
      '  launch    start a mission with a lead and its crew',
      '  list      list the missions',
      '  show      open the lead session of a mission',
      '  stop      stop a mission',
      '  remove    remove a finished mission',
      '  priority  change the priority of a mission (high, normal, low)',
      '  task      manage the tasks of a mission',
      '  state     read or set the state declared by the lead',
      '  wait      wait for a mission to change (--all: for the console, every mission)',
      '  tell      tell a mission\'s lead something',
      '  decision  note a decision in the mission (for the lead)',
      '  memory    read or replace the project memory (for the lead)',
      '  question  ask the user a question',
      '  answer    answer a question',
      '  watcher   watch the missions: restart, wake and relieve their leads',
      '  init      set up relaylead on this machine and in this project',
      '  install   register the scheduler and the Claude Code plugin (macOS)',
      '  uninstall remove what install added (--purge also deletes ~/.relaylead)',
      '  doctor    check the prerequisites and the installation',
      '  brief     what the console shows first: problems, news, open questions, missions',
      '  overview  every mission, task and open question as JSON (--json)',
      '  config    set a display setting: config set <key> <value>',
      '  dashboard serve the local web page of the missions and open it',
      '',
      'Options:',
      '  --help, -h     show this help',
      '  --version, -v  show the version',
      '',
    ].join('\n'),
    unknownCommand: 'relaylead: unknown command "{command}"\n\n',
    noMissions: 'no missions\n',
    configSet: '{key} = {value}\n',
    dashboardRunning: 'dashboard on {url}\nanswering and stopping are allowed from this link only; Ctrl-C to stop the server\n',
    missionStopped: 'mission {mission} stopped\n',
    missionRemoved: 'mission {mission} removed\n',
    prioritySet: 'priority of {mission}: {priority}\n',
    branchDeleted: 'deleted branch {branch}\n',
    missionNothingToStop: 'mission {mission} is already {state}; nothing to do\n',
    missionDoneSessionsStopped: 'mission {mission} is done; its remaining sessions were stopped\n',
    waitOneShot: 'one-shot session: not waiting (use wait --all --timeout 0 for a look, or relaylead brief)\n',
    missionStopSkipped:
      'the sessions of mission {mission} were not stopped again: their process ids are more than an hour old\n',
    taskDelivered: 'task {id} delivered\n',
    taskAlreadyDelivered: 'task {id} already delivered\n',
    watcherStopPresent: 'STOP is present in {home}: the watcher does nothing until it is removed\n',
    watcherBusy: 'another watcher pass is running (process {pid}, since {since}); nothing done\n',
    watcherStarted: 'watcher started: it checks the missions every {seconds} s and ends once none needs it\n',
    watcherAlreadyRunning: 'the watcher is already running (since {since})\n',
    watcherNothingToWatch: 'no mission to watch; the watcher was not started\n',
    watcherStopped: 'watcher stopped\n',
    watcherStopRequested: 'the watcher stops once its current pass is over\n',
    watcherNotRunning: 'the watcher is not running\n',
    watcherStatusRunning: 'watcher running since {since}; last pass {lastPass}\n',
    watcherNotStarted:
      'relaylead launch: the watcher could not be started ({detail}); start it with: relaylead watcher start\n',
    // Subject of the commit of a task's state line, in the integration branch.
    deliveryCommit: 'chore(relaylead): deliver {id}',
    // Errors: the key is the error code (see codedError).
    usage: 'usage: {usage}',
    mergeDone: 'mission {mission} merged into {target} ({detail})\n',
    mergeAlready: 'mission {mission} is already in {target}; nothing to merge\n',
    mergeBehind: 'your local branch {target} is {count} commit(s) behind the remote one: run `git pull` there when you are ready (relaylead does not pull for you)\n',
    mergeIssuesOpen: 'these issues could not be closed, close them yourself: {issues}\n',
    mergeConflict: 'mission {mission} conflicts with {target} ({files}); the merge was cancelled and nothing changed. A crew member resolves the conflict in task {task}{queued}, then Relaylead merges again by itself and tells you; if the crew member fails, you get a question\n',
    mergeQueued: ' (queued: it starts once a place is free on the machine)',
    'merge-not-done': 'mission "{mission}" is {state}; only a done mission can be merged',
    'merge-resolving': 'a crew member is resolving the merge conflict of mission "{mission}" (task {task}); Relaylead merges again by itself once it is done',
    'merge-no-target': 'mission "{mission}" has no branch to merge into: neither the branch it was launched from, nor main, nor master exists',
    'merge-not-git': 'mission "{mission}" delivers with "{type}": there is no branch to merge',
    'merge-target-dirty': '{dir} is on branch {branch} and has changes not committed; commit them or put them aside (git stash), then merge again',
    'merge-hook-failed': 'a git hook (or git itself) refused the merge of mission "{mission}" into {branch}; nothing was merged. Output: {output}',
    'integration-missing': 'the integration branch {branch} of mission "{mission}" no longer exists: there is nothing to merge',
    'bad-priority': 'unknown priority "{priority}"; use one of: {priorities}',
    'places-busy': 'another crew start has held the places of the machine for too long ("relaylead {command}", process {pid}, since {since}); try again once it is over',
    'repo-busy':
      'the git repository of {dir} has been busy for too long with "relaylead {command}" (process {pid}, since {since}); try again once it is over',
    'worktrees-dir-taken':
      'the folder {dir}, where mission "{mission}" keeps its worktrees, is itself a git worktree, left by an earlier mission; save what it holds, remove it with: git worktree remove "{dir}", then launch again, or launch this mission under another name with --name',
    'old-integration-unmerged':
      'the branch {branch} of relaylead 0.1 has {count} commit(s) that your current branch does not have; this mission starts from your current branch, without that work, and may do its tasks again. To keep it, stop this mission, merge {branch} into your branch (or delete {branch} if that work is not wanted), then launch again',
    'source-taken':
      'mission "{mission}" of this project already takes its tasks from {source} and is not over: both would do the same tasks. Give this mission tasks of its own: another task folder with --tasks <folder> (for instance tasks/backend and tasks/frontend), or another source in .relaylead.json (another label for GitHub issues); or launch it once "{mission}" is over',
    'bad-tasks-folder': 'the task folder "{folder}" is not inside the project {dir}; give a folder of the project, such as --tasks tasks/backend',
    'old-mission-running':
      'mission "{mission}" was launched by relaylead 0.1 and still runs in {dir} ({state}); a new mission can start in this folder once it is over; if its lead is gone, stop it with: relaylead stop {mission}',
    'mission-exists':
      'a mission named "{mission}" already exists; choose another name with --name, or remove the finished one with: relaylead remove {mission}',
    'mission-running': 'mission "{mission}" is {state}; stop it first with: relaylead stop {mission}',
    'checkout-on-task-branch':
      'your checkout {dir} is on branch {branch} of this mission; switch to another branch, then remove again',
    'remove-unmerged-work':
      'mission "{mission}" has work not delivered: {items}; remove anyway with: relaylead remove {mission} --force; it deletes these branches and changes',
    'mission-unknown': 'no mission named "{mission}"',
    'watcher-not-started': 'the watcher loop gave no sign of life within {seconds} s',
    'mission-stopped': 'mission "{mission}" was stopped; its state can no longer change',
    'mission-over': 'mission "{mission}" is over (done or stopped): its lead can no longer read a message',
    'mission-question-over': 'mission "{mission}" is over (done or stopped): a question asked now would never be seen',
    'bad-tell': 'nothing to tell: give a text after the mission name',
    'mission-decision-over': 'mission "{mission}" is over (done or stopped): no decision can be added',
    'bad-decision': 'nothing to note: give the decision as a text',
    'mission-finished': 'mission "{mission}" is done; its state can no longer change',
    'bad-state': 'unknown state "{state}"; use one of: {states}',
    'no-mission': 'no mission given; use --mission <name>',
    'no-lead': 'mission "{mission}" has no lead session yet',
    'session-exists': 'mission "{mission}" already has another session with the short id {shortId}',
    'task-unknown': 'mission "{mission}" has no task "{id}"; see the tasks with: relaylead task list',
    'task-not-startable':
      'task "{id}" is {state}; only a todo task can be started; a failed task can be tried again with: relaylead task retry {id}',
    'task-not-retryable': 'task "{id}" is {state}; only a failed task can be retried',
    'task-retry-limit': 'task "{id}" has used its {max} attempts; it cannot be retried again: report its failure to the user',
    'crew-still-running':
      'the earlier crew session {shortId} of task "{id}" could not be stopped; nothing was changed; try again with: relaylead task retry {id}',
    'attempt-superseded':
      'task "{id}" was retried: this session ran attempt {attempt}, the task is now on attempt {current}; your result no longer counts, end your turn',
    'task-not-answered':
      'task "{id}" asks a question first; ask it with: relaylead question ask --key {id} …, and start the task once it is answered',
    'task-not-ready': 'task "{id}" depends on tasks not delivered yet ({missing}); deliver them first',
    'parallel-limit':
      'mission "{mission}" already runs {limit} tasks ({running}), its limit; start this one once a task finishes',
    'task-skipped': 'task "{id}" was set aside: the user chose "Skip this task"; leave it as it is',
    'mission-done': 'mission "{mission}" is done; no task can start',
    'start-busy':
      'another task of mission "{mission}" has been starting or delivering for a minute ("relaylead {command}", process {pid}, since {since}); try again',
    'start-stuck':
      '"relaylead {command}" (process {pid}) has held the start lock of mission "{mission}" since {since}, too long to be still working: it is probably stuck. End that process, then try again',
    'stop-pending':
      'mission "{mission}" is stopped, but its sessions are not stopped yet: "relaylead {holder}" still holds the mission; run relaylead stop {mission} again',
    'task-not-deliverable': 'task "{id}" is {state}; only a done task can be delivered',
    'protected-branch':
      'the integration branch "{branch}" is protected (guard.protectedBranches); launch the mission under another name with --name',
    'not-a-git-repo':
      '{dir} is not the root of a git repository; run the mission at the root, or set "delivery": {"type": "files"} in .relaylead.json',
    'merge-conflict':
      'task "{id}" conflicts with the integration branch; the merge was cancelled and the task stays done. Resolve it on branch {branch}, then deliver again',
    'hook-failed':
      'a git hook (or git itself) refused relaylead\'s {what} for task "{id}"; nothing was merged and the task stays done. Output: {output}. Fix the cause on branch {branch} and deliver again, or deliver without hooks yourself with: relaylead task deliver {id} --no-hooks --mission {mission}',
    'launch-hook-failed':
      'a git hook (or git itself) refused relaylead\'s {what}: the merge of your current branch into the integration branch {branch}; nothing was merged and the mission was not launched. Output: {output}. Fix the cause and launch again, or let relaylead\'s own commits skip the hooks with "delivery": {"runHooks": false} in .relaylead.json',
    'state-line-hook-failed':
      'task "{id}" is delivered, but a git hook (or git itself) refused relaylead\'s {what}; the line stays uncommitted in the integration worktree, and the next "relaylead task deliver {id}" commits it. Output: {output}',
    'launch-state-line-hook-failed':
      'a git hook (or git itself) refused relaylead\'s commit of task "{id}"\'s state line, left uncommitted in the integration worktree by an earlier delivery; the mission was not launched. Output: {output}. Fix the cause and launch again, or let relaylead\'s own commits skip the hooks with "delivery": {"runHooks": false} in .relaylead.json',
    'mark-failed':
      'task "{id}" is merged, but its state line could not be written ({detail}); run relaylead task deliver {id} again to finish',
    'integration-stuck':
      'the integration worktree {dir} is left in the middle of a merge that git could not cancel ({output}); there, run git merge --abort or git reset --merge, keep the changes under the task folder, then deliver again',
    'empty-output': 'task "{id}" delivered nothing: its output folder {dir} is empty',
    'cleanup-failed':
      'task "{id}" is delivered, but its worktree or branch could not be cleaned up; the next "relaylead task deliver {id}" tries again ({detail})',
    'worktree-kept':
      'the worktree {dir} (branch {branch}) has changes not committed, so it was kept; commit them on its branch or remove them, then run relaylead stop {mission} to clean up again, or delete them with the mission: relaylead remove {mission} --force',
    'worktree-busy':
      'the worktree {dir} (branch {branch}) was kept: its session may still be running; once it has ended, run relaylead stop {mission} to clean up again, or relaylead remove {mission} to remove the mission',
    'mission-cleanup-failed':
      'the task worktrees of mission "{mission}" could not all be cleaned up; run relaylead stop {mission} to try again ({detail})',
    'session-still-alive':
      'the session {shortId} of mission "{mission}" was asked to stop, but its process is still running; run relaylead stop {mission} again',
    'task-late-work':
      'task "{id}" is delivered, but its branch {branch} or its folder {dir} has work done since; they were kept: deliver that work as a new task',
    'integration-sync-conflict':
      'your current branch conflicts with the integration branch "{branch}"; the update was cancelled. Merge your branch into it by hand in {dir}, then launch again',
    'task-uncommitted':
      'task "{id}" has changes not committed in {dir} (see `git status` there); commit them on its branch, or remove what must not be kept, then try again',
    'task-empty': 'task "{id}" has no commit on its branch {branch}, so nothing to deliver; commit the work on that branch first',
    'task-branch-missing': 'cannot deliver task "{id}": its branch {branch} is missing',
    'worktree-mismatch':
      'the folder {dir} is on branch "{actual}", not "{branch}"',
    'integration-mismatch':
      'the integration worktree {dir} is on branch "{actual}", not "{branch}"; remove the worktree with: git worktree remove "{dir}", then launch again',
    'integration-dirty':
      'the integration worktree {dir} has changes nobody committed ({files}); commit them there, or remove the ones that are not under {tasksDir}, then launch again; files under {tasksDir} hold the state of delivered tasks: never remove them',
    'tasks-not-committed':
      'the task folder "{dir}" has changes not committed, or is missing from branch {branch}; commit it first: the crew works from commits',
    'question-unknown': 'mission "{mission}" has no question "{id}"; see the open ones with: relaylead question list {mission}',
    'question-answered': 'question "{id}" is already answered ("{choice}")',
    'bad-choice': 'answer "{choice}" is not one of the options; use a number or a text from: {options}',
    'question-key-clash': 'the key "{key}" makes the id "{id}", already used by the question with key "{storedKey}"; choose another key',
    'missing-value': 'the option --{name} needs a value',
    'config-unknown-key': 'cannot set "{key}"; the settings are: {keys}',
    'config-bad-value': '"{value}" is not a valid value for {key} (pane: always or never; statusLine: true or false; dashboardPort: 1 to 65535)',
    'dashboard-port-busy': 'port {port} is not free; choose another with: relaylead config set display.dashboardPort <port>',
    'not-from-a-session': '"relaylead {command}" belongs to the user; a mission session cannot run it',
    'not-your-task': 'this session works on task "{own}"; it cannot finish task "{id}"',
    'not-for-crew': 'a crew member cannot start, retry or deliver tasks; finish your own task with: relaylead task done {own}',
    'not-current-lead': 'this session ({session}) is no longer the lead of mission "{mission}": {current} took over; end your turn',
    questionAnswered: 'question {id} answered: {choice}\n',
    toldMessage: 'message {id} told to the lead of {mission}\n',
    'memory-disabled': 'the project memory is turned off (memory.enabled is false in .relaylead.json)',
    'bad-memory': 'nothing to write: give the memory as a text (--text) or a file (--file)',
    'memory-too-long': 'the memory has {lines} lines, over the ceiling of {max}: compact it (merge lessons, one line per past mission, drop what is out of date) and write it again',
    'memory-busy': 'another command is writing the memory of {dir}; try again in a moment',
    'memory-file-unreadable': 'cannot read the memory file {file}: {detail}',
    'memory-changed': 'the memory changed since you read it (another mission wrote it): read it again with `relaylead memory show`, merge its new content into yours, and write it again with the new fingerprint as --base',
    'memory-not-compacted': 'the mission cannot be declared done yet: compact the project memory first. Run `relaylead memory show`, then `relaylead memory write --base <fingerprint> --text "<compacted memory>"` (this mission as one line, lessons merged, what is out of date removed), then run `relaylead state set done` again. Outside a session, add `--mission <name>` to each of these commands. If the memory cannot be written, add --no-memory to `state set done`.',
    'memory-too-big': 'the memory is {bytes} bytes, over the ceiling of {max}: compact it (shorter lines, drop details) and write it again',
    memoryTooBig: 'WARNING: this memory is {bytes} bytes, over the ceiling of {max}, so only its start is shown below. Compact it before you start: merge the lessons, keep one line per past mission, drop what is out of date and what is long, then run: relaylead memory write --base <fingerprint> --text "<compacted memory>" (the part not shown is kept in the archive)\n\n',
    memoryTruncated: '[truncated: {hidden} lines not shown]\n',
    memoryFingerprint: 'Memory fingerprint (give it to `relaylead memory write` as --base): {fingerprint}\n',
    memoryDisabled: 'The project memory is turned off: there is nothing to read or write.\n',
    memoryEmpty: 'The project memory is empty: nothing to read yet.\n',
    memoryTooLong: 'WARNING: this memory has {lines} lines, over the ceiling of {max}. Compact it before you start: merge the lessons, keep one line per past mission, drop what is out of date, then run: relaylead memory write --base <fingerprint> --text "<compacted memory>"\n\n',
    memoryWritten: 'memory written ({lines} lines)\n',
    decisionNoted: 'decision noted\n',
    'bad-question': 'cannot ask the question: {detail}',
    'bad-task-id':
      'the task file {file} has a name unusable in a git branch; use letters, digits, ".", "_" and "-", not starting with "." or "-", not ending with "." (and not _integration or integration)',
    'claude-not-found': 'claude was not found; install Claude Code, or set RELAYLEAD_CLAUDE to its executable',
    'claude-cmd-unsupported':
      '{file} cannot be run without a shell; set RELAYLEAD_CLAUDE to the real claude.exe or to its JavaScript entry (.js)',
    'claude-too-old': 'Claude Code {min} or later is needed, found "{found}"; update it with: claude update',
    'untrusted-dir': 'Claude Code does not trust the folder {dir} yet; run `claude` once in {dir} and accept, then try again',
    'not-started': 'the claude session {shortId} did not start its first turn within {seconds} s',
    'wake-timeout': 'the session {shortId} was stopped but its process was still running after {seconds} s; it was not woken',
    'wake-copy': 'waking the claude session {shortId} started a copy ({copy}) instead; see the session with: claude attach {shortId}',
    'claude-unexpected-output': 'unexpected output from {command}: {output}',
    'claude-failed': '{command} failed: {output}',
    'claude-timeout': '{command} did not answer within {seconds} s',
    'bad-prompt': 'the {what} cannot start with "-": claude would read it as an option; reword it',
    // Added after another error's message: whether the session it left behind could be stopped.
    orphan: '; could not stop {shortId}: run `claude stop {shortId}`',
    'session-stopped': '; it was stopped',
    'copy-stopped': '; the copy was stopped',
    // Added after worktree-mismatch: how to free the folder.
    'worktree-of-mission':
      '; it was left by mission "{mission}": remove that mission with: relaylead remove {mission}, or only this folder with: git worktree remove "{dir}"',
    'worktree-not-relaylead': '; remove it with: git worktree remove "{dir}"',
    'gh-missing': 'gh, the GitHub CLI, was not found; install it from https://cli.github.com',
    'gh-not-authenticated': 'gh is not logged in to GitHub; log in with: gh auth login',
    'gh-failed': 'gh {args} failed: {detail}',
    'push-failed': 'git push {remote} {branch} failed: {detail}',
    'pr-changes-requested':
      'the pull request {url} of task "{id}" has changes requested; have them made on its branch, then deliver again',
    'pr-merge-conflict':
      'the pull request {url} of task "{id}" cannot be merged: it conflicts with the integration branch; have the conflict fixed on its branch, then deliver again',
    // Not an error: the address of a delivered task's pull request, shown with the delivery's warnings.
    'pr-merged': 'task "{id}": pull request {url} merged',
    // Lot 4: installation.
    'platform-unsupported': 'relaylead install works on macOS only for now (this system: {platform})',
    'scheduler-installed': 'scheduler installed ({file})\n',
    'scheduler-removed': 'scheduler removed\n',
    'scheduler-failed': 'scheduler step "{step}" failed: {detail}',
    'api-key-missing':
      'API key mode is on but the key file {file} is missing or empty; set it with: relaylead init --api-key-env NAME (or --api-key-file PATH)',
    'api-key-env-empty': 'the environment variable {name} is not set or empty',
    'plugin-installed': 'plugin installed: {id}\n',
    'plugin-skipped': 'plugin skipped: claude not found\n',
    'plugin-removed': 'plugin removed: {id}\n',
    'nothing-installed': 'nothing to uninstall: relaylead install was not run\n',
    purged: 'deleted {dir}\n',
    'purge-refused': 'refusing to delete {dir}: it does not look like a relaylead folder (no install.json nor install marker, and not named .relaylead)',
    'node-too-old': 'Node.js {min} or later is needed, found {found}',
    'agent-missing': 'the agent "{agent}" was not found; install Claude Code, then run relaylead init again',
    'api-key-stored': 'API key stored in {file}, readable by you only\n',
    'api-key-helper-hint':
      'the sessions get the key through Claude Code\'s apiKeyHelper setting, without any approval; relaylead doctor checks that claude picks it\n',
    'init-machine-written': 'machine settings written to {file}\n',
    'init-machine-kept': 'machine settings kept as they are ({file})\n',
    'init-project-written': 'project settings written to {file}\n',
    'init-project-kept': 'project settings kept as they are ({file})\n',
    'init-trust-hint':
      'if Claude Code has never run in {dir}, run `claude` once there and accept the trust question, so missions can start\n',
    'init-advice': [
      'Access tips: give the sessions only the access they need.',
      'Keep secrets (.env files, keys) out of the project folder when you can.',
      'Review what a mission delivered before you merge it.',
      '',
    ].join('\n'),
    'uninstall-warning': 'warning: could not remove the {step} ({detail}); do it by hand with: {command}\n',
    'init-next': 'next: relaylead install (scheduler and plugin), then relaylead doctor\n',
    'mission-usage-paused':
      'mission "{mission}" is paused by the usage limit until {resumeAt}; it resumes by itself then, and starts no session before',
    usagePausedState: 'usage-pause (resume {resumeAt})',
    queuedMark: ' ({n} queued)',
    abandonedMark: ' (abandoned)',
    briefInstall: 'Installation problems:\n',
    briefNew: 'New:\n',
    briefNothingNew: 'Nothing new.\n',
    briefQuestions: 'Open questions ({n}):\n',
    briefNoQuestion: 'No open question.\n',
    briefMissions: 'Missions not over:\n',
    briefNoMission: 'No mission running.\n',
    briefNewMark: 'new',
    briefRecommended: ' (recommended)',
    briefTasks: 'tasks {delivered}/{total} delivered',
    briefQueued: '{n} waiting for a place',
    briefPaused: 'paused until {at}',
    briefPriority: 'priority {priority}',
    eventTaskFailed: '[{mission}] task {id} failed (attempt {attempt}): {summary}\n',
    eventMission: '[{mission}] mission {state}\n',
    eventMerged: '[{mission}] merged into {target}\n',
  },
  fr: {
    help: [
      'Usage : relaylead <commande> [options]',
      '',
      'Commandes :',
      '  launch    lancer une mission avec un lead et son équipe',
      '  list      lister les missions',
      '  show      ouvrir la session du lead d\'une mission',
      '  stop      arrêter une mission',
      '  remove    supprimer une mission finie',
      '  priority  changer la priorité d\'une mission (high, normal, low)',
      '  task      gérer les tâches d\'une mission',
      '  state     lire ou écrire l\'état déclaré par le lead',
      '  wait      attendre qu\'une mission change (--all : pour la console, toutes les missions)',
      '  tell      dire quelque chose au lead d\'une mission',
      '  decision  noter une décision dans la mission (pour le lead)',
      '  memory    lire ou remplacer la mémoire de projet (pour le lead)',
      '  question  poser une question à l\'utilisateur',
      '  answer    répondre à une question',
      '  watcher   veiller sur les missions : relancer, réveiller et relever leurs leads',
      '  brief     ce que la console montre d\'abord : problèmes, nouveautés, questions ouvertes, missions',
      '  overview  toutes les missions, tâches et questions ouvertes en JSON (--json)',
      '  config    régler un affichage : config set <clé> <valeur>',
      '  dashboard servir la page web locale des missions et l\'ouvrir',
      '',
      'Options :',
      '  --help, -h     afficher cette aide',
      '  --version, -v  afficher la version',
      '',
    ].join('\n'),
    unknownCommand: 'relaylead : commande inconnue « {command} »\n\n',
    noMissions: 'aucune mission\n',
    configSet: '{key} = {value}\n',
    dashboardRunning: 'tableau de bord sur {url}\nrépondre et arrêter ne sont permis que depuis ce lien ; Ctrl-C pour arrêter le serveur\n',
    missionStopped: 'mission {mission} arrêtée\n',
    missionRemoved: 'mission {mission} supprimée\n',
    prioritySet: 'priorité de {mission} : {priority}\n',
    branchDeleted: 'branche supprimée {branch}\n',
    missionNothingToStop: 'la mission {mission} est déjà {state} ; rien à faire\n',
    missionDoneSessionsStopped: 'la mission {mission} est terminée ; ses sessions restantes ont été arrêtées\n',
    waitOneShot: 'session ponctuelle : pas d\'attente (wait --all --timeout 0 pour un coup d\'œil, ou relaylead brief)\n',
    missionStopSkipped:
      'les sessions de la mission {mission} n\'ont pas été arrêtées de nouveau : leurs numéros de processus ont plus d\'une heure\n',
    taskDelivered: 'tâche {id} livrée\n',
    taskAlreadyDelivered: 'tâche {id} déjà livrée\n',
    watcherStopPresent: 'STOP est présent dans {home} : le veilleur ne fait rien tant qu\'il n\'est pas retiré\n',
    watcherBusy: 'un autre passage du veilleur est en cours (processus {pid}, depuis {since}) ; rien n\'est fait\n',
    watcherStarted:
      'veilleur lancé : il passe sur les missions toutes les {seconds} s et s\'arrête quand aucune n\'en a besoin\n',
    watcherAlreadyRunning: 'le veilleur tourne déjà (depuis {since})\n',
    watcherNothingToWatch: 'aucune mission à veiller ; le veilleur n\'a pas été lancé\n',
    watcherStopped: 'veilleur arrêté\n',
    watcherStopRequested: 'le veilleur s\'arrête à la fin de son passage en cours\n',
    watcherNotRunning: 'le veilleur ne tourne pas\n',
    watcherStatusRunning: 'veilleur en marche depuis {since} ; dernier passage {lastPass}\n',
    watcherNotStarted:
      'relaylead launch : le veilleur n\'a pas pu être lancé ({detail}) ; lancez-le avec : relaylead watcher start\n',
    deliveryCommit: 'chore(relaylead): {id} livrée',
    usage: 'usage : {usage}',
    mergeDone: 'mission {mission} fusionnée dans {target} ({detail})\n',
    mergeAlready: 'la mission {mission} est déjà dans {target} ; rien à fusionner\n',
    mergeBehind: 'votre branche locale {target} a {count} commit(s) de retard sur la branche distante : lancez `git pull` quand vous voulez (relaylead ne tire pas à votre place)\n',
    mergeIssuesOpen: 'ces issues n’ont pas pu être fermées, fermez-les vous-même : {issues}\n',
    mergeConflict: 'la mission {mission} est en conflit avec {target} ({files}) ; la fusion a été annulée et rien n\'a changé. Un équipier résout le conflit dans la tâche {task}{queued}, puis Relaylead refait la fusion seul et vous prévient ; si l\'équipier échoue, une question vous est posée\n',
    mergeQueued: ' (en file : elle démarre dès qu\'une place se libère sur la machine)',
    'merge-not-done': 'la mission « {mission} » est {state} ; seule une mission terminée (done) peut être fusionnée',
    'merge-resolving': 'un équipier résout le conflit de fusion de la mission « {mission} » (tâche {task}) ; Relaylead refait la fusion seul une fois la tâche finie',
    'merge-no-target': 'la mission « {mission} » n\'a pas de branche où fusionner : ni la branche d\'où elle a été lancée, ni main, ni master n\'existent',
    'merge-not-git': 'la mission « {mission} » livre en « {type} » : il n\'y a pas de branche à fusionner',
    'merge-target-dirty': '{dir} est sur la branche {branch} et a des modifications non commitées ; commitez-les ou mettez-les de côté (git stash), puis fusionnez à nouveau',
    'merge-hook-failed': 'un hook git (ou git lui-même) a refusé la fusion de la mission « {mission} » dans {branch} ; rien n\'a été fusionné. Sortie : {output}',
    'integration-missing': 'la branche d\'intégration {branch} de la mission « {mission} » n\'existe plus : il n\'y a rien à fusionner',
    'bad-priority': 'priorité « {priority} » inconnue ; utilisez : {priorities}',
    'places-busy': 'un autre lancement d\'équipier occupe les places de la machine depuis trop longtemps (« relaylead {command} », processus {pid}, depuis {since}) ; réessayez une fois qu\'il a fini',
    'repo-busy':
      'le dépôt git de {dir} est occupé depuis trop longtemps par « relaylead {command} » (processus {pid}, depuis {since}) ; réessayez une fois qu\'il a fini',
    'worktrees-dir-taken':
      'le dossier {dir}, où la mission « {mission} » range ses worktrees, est lui-même un worktree git laissé par une mission précédente ; sauvegardez ce qu\'il contient, supprimez-le avec : git worktree remove "{dir}", puis relancez, ou lancez cette mission sous un autre nom avec --name',
    'old-integration-unmerged':
      'la branche {branch} de relaylead 0.1 a {count} commit(s) absent(s) de votre branche courante ; cette mission part de votre branche courante, sans ce travail, et risque de refaire ses tâches. Pour le garder, arrêtez cette mission, fusionnez {branch} dans votre branche (ou supprimez {branch} si ce travail n\'est pas voulu), puis relancez',
    'source-taken':
      'la mission « {mission} » de ce projet prend déjà ses tâches dans {source} et n\'est pas finie : les deux feraient les mêmes tâches. Donnez à cette mission ses propres tâches : un autre dossier de tâches avec --tasks <dossier> (par exemple tasks/backend et tasks/frontend), ou une autre source dans .relaylead.json (un autre libellé pour les issues GitHub) ; ou lancez-la une fois « {mission} » finie',
    'bad-tasks-folder': 'le dossier de tâches « {folder} » n\'est pas dans le projet {dir} ; indiquez un dossier du projet, par exemple --tasks tasks/backend',
    'old-mission-running':
      'la mission « {mission} » a été lancée par relaylead 0.1 et tourne encore dans {dir} ({state}) ; une nouvelle mission pourra démarrer dans ce dossier une fois celle-ci finie ; si son lead a disparu, arrêtez-la avec : relaylead stop {mission}',
    'mission-exists':
      'une mission nommée « {mission} » existe déjà ; choisissez un autre nom avec --name, ou supprimez celle qui est finie avec : relaylead remove {mission}',
    'mission-running': 'la mission « {mission} » est {state} ; arrêtez-la d\'abord avec : relaylead stop {mission}',
    'checkout-on-task-branch':
      'votre copie de travail {dir} est sur la branche {branch} de cette mission ; passez sur une autre branche, puis relancez la suppression',
    'remove-unmerged-work':
      'la mission « {mission} » a du travail non livré : {items} ; supprimez quand même avec : relaylead remove {mission} --force ; cela supprime ces branches et ces changements',
    'mission-unknown': 'aucune mission nommée « {mission} »',
    'watcher-not-started': 'la boucle du veilleur n\'a donné aucun signe de vie en {seconds} s',
    'mission-stopped': 'la mission « {mission} » a été arrêtée ; son état ne peut plus changer',
    'mission-over': 'la mission « {mission} » est terminée (finie ou arrêtée) : son lead ne peut plus lire de message',
    'mission-question-over': 'la mission « {mission} » est terminée (finie ou arrêtée) : une question posée maintenant ne serait jamais vue',
    'bad-tell': 'rien à transmettre : donnez un texte après le nom de la mission',
    'mission-decision-over': 'la mission « {mission} » est terminée (finie ou arrêtée) : aucune décision ne peut être ajoutée',
    'bad-decision': 'rien à noter : donnez la décision en texte',
    'mission-finished': 'la mission « {mission} » est terminée ; son état ne peut plus changer',
    'bad-state': 'état inconnu « {state} » ; utilisez l\'un de : {states}',
    'no-mission': 'aucune mission indiquée ; utilisez --mission <nom>',
    'no-lead': 'la mission « {mission} » n\'a pas encore de session de lead',
    'session-exists': 'la mission « {mission} » a déjà une autre session d\'id court {shortId}',
    'task-unknown': 'la mission « {mission} » n\'a pas de tâche « {id} » ; voir les tâches avec : relaylead task list',
    'task-not-startable':
      'la tâche « {id} » est {state} ; seule une tâche todo peut être lancée ; une tâche en échec peut être relancée avec : relaylead task retry {id}',
    'task-not-retryable': 'la tâche « {id} » est {state} ; seule une tâche en échec peut être relancée',
    'task-retry-limit':
      'la tâche « {id} » a épuisé ses {max} tentatives ; elle ne peut plus être relancée : signalez son échec à l\'utilisateur',
    'crew-still-running':
      'la session {shortId} de l\'équipier précédent de la tâche « {id} » n\'a pas pu être arrêtée ; rien n\'a changé ; réessayez avec : relaylead task retry {id}',
    'attempt-superseded':
      'la tâche « {id} » a été relancée : cette session menait la tentative {attempt}, la tâche en est à la tentative {current} ; votre résultat ne compte plus, terminez votre tour',
    'task-not-answered':
      'la tâche « {id} » pose d\'abord une question ; posez-la avec : relaylead question ask --key {id} …, puis lancez la tâche une fois la réponse donnée',
    'task-not-ready': 'la tâche « {id} » dépend de tâches pas encore livrées ({missing}) ; livrez-les d\'abord',
    'parallel-limit':
      'la mission « {mission} » mène déjà {limit} tâches ({running}), sa limite ; lancez celle-ci quand une tâche se termine',
    'task-skipped': 'la tâche « {id} » est mise de côté : l\'utilisateur a choisi « Skip this task » ; laissez-la telle quelle',
    'mission-done': 'la mission « {mission} » est terminée ; aucune tâche ne peut être lancée',
    'start-busy':
      'une autre tâche de la mission « {mission} » est en lancement ou en livraison depuis une minute (« relaylead {command} », processus {pid}, depuis {since}) ; réessayez',
    'start-stuck':
      '« relaylead {command} » (processus {pid}) tient le verrou de lancement de la mission « {mission} » depuis {since}, trop longtemps pour travailler encore : il est sans doute bloqué. Arrêtez ce processus, puis réessayez',
    'stop-pending':
      'la mission « {mission} » est arrêtée, mais ses sessions ne le sont pas encore : « relaylead {holder} » tient encore la mission ; relancez relaylead stop {mission}',
    'task-not-deliverable': 'la tâche « {id} » est {state} ; seule une tâche done peut être livrée',
    'protected-branch':
      'la branche d\'intégration « {branch} » est protégée (guard.protectedBranches) ; lancez la mission sous un autre nom avec --name',
    'not-a-git-repo':
      '{dir} n\'est pas la racine d\'un dépôt git ; lancez la mission à la racine, ou mettez "delivery": {"type": "files"} dans .relaylead.json',
    'merge-conflict':
      'la tâche « {id} » est en conflit avec la branche d\'intégration ; la fusion est annulée et la tâche reste done. Résolvez-le sur la branche {branch}, puis livrez de nouveau',
    'hook-failed':
      'un hook git (ou git lui-même) a refusé la fusion de la tâche « {id} » par relaylead ; rien n\'a été fusionné et la tâche reste done. Sortie : {output}. Corrigez la cause sur la branche {branch} et livrez de nouveau, ou livrez vous-même sans hooks avec : relaylead task deliver {id} --no-hooks --mission {mission}',
    'launch-hook-failed':
      'un hook git (ou git lui-même) a refusé la fusion de votre branche courante dans la branche d\'intégration {branch} par relaylead ; rien n\'a été fusionné et la mission n\'est pas lancée. Sortie : {output}. Corrigez la cause et relancez, ou faites passer les commits de relaylead sans hooks avec "delivery": {"runHooks": false} dans .relaylead.json',
    'state-line-hook-failed':
      'la tâche « {id} » est livrée, mais un hook git (ou git lui-même) a refusé le commit de sa ligne d\'état par relaylead ; la ligne reste non commitée dans le worktree d\'intégration, et le prochain « relaylead task deliver {id} » la commite. Sortie : {output}',
    'launch-state-line-hook-failed':
      'un hook git (ou git lui-même) a refusé le commit par relaylead de la ligne d\'état de la tâche « {id} », laissée non commitée dans le worktree d\'intégration par une livraison précédente ; la mission n\'est pas lancée. Sortie : {output}. Corrigez la cause et relancez, ou faites passer les commits de relaylead sans hooks avec "delivery": {"runHooks": false} dans .relaylead.json',
    'mark-failed':
      'la tâche « {id} » est fusionnée, mais sa ligne d\'état n\'a pas pu être écrite ({detail}) ; relancez relaylead task deliver {id} pour finir',
    'integration-stuck':
      'le worktree d\'intégration {dir} reste au milieu d\'une fusion que git n\'a pas pu annuler ({output}) ; dans ce dossier, lancez git merge --abort ou git reset --merge, gardez les changements du dossier des tâches, puis livrez de nouveau',
    'empty-output': 'la tâche « {id} » n\'a rien livré : son dossier de sortie {dir} est vide',
    'cleanup-failed':
      'la tâche « {id} » est livrée, mais son worktree ou sa branche n\'a pas pu être nettoyé ; le prochain « relaylead task deliver {id} » réessaie ({detail})',
    'worktree-kept':
      'le worktree {dir} (branche {branch}) a des changements non commités, il est donc conservé ; commitez-les sur sa branche ou retirez-les, puis lancez relaylead stop {mission} pour refaire le ménage, ou supprimez-les avec la mission : relaylead remove {mission} --force',
    'worktree-busy':
      'le worktree {dir} (branche {branch}) est conservé : sa session tourne peut-être encore ; une fois qu\'elle est finie, lancez relaylead stop {mission} pour refaire le ménage, ou relaylead remove {mission} pour supprimer la mission',
    'mission-cleanup-failed':
      'les worktrees de tâche de la mission « {mission} » n\'ont pas tous pu être retirés ; lancez relaylead stop {mission} pour réessayer ({detail})',
    'session-still-alive':
      'la session {shortId} de la mission « {mission} » a reçu l\'ordre de s\'arrêter, mais son processus tourne encore ; relancez relaylead stop {mission}',
    'task-late-work':
      'la tâche « {id} » est livrée, mais sa branche {branch} ou son dossier {dir} contient du travail fait depuis ; ils sont conservés : livrez ce travail dans une nouvelle tâche',
    'integration-sync-conflict':
      'votre branche courante est en conflit avec la branche d\'intégration « {branch} » ; la mise à jour est annulée. Fusionnez votre branche à la main dans {dir}, puis relancez',
    'task-uncommitted':
      'la tâche « {id} » a des changements non commités dans {dir} (voir `git status` dans ce dossier) ; commitez-les sur sa branche, ou supprimez ce qui ne doit pas rester, puis réessayez',
    'task-empty': 'la tâche « {id} » n\'a aucun commit sur sa branche {branch}, donc rien à livrer ; commitez d\'abord le travail sur cette branche',
    'task-branch-missing': 'impossible de livrer la tâche « {id} » : sa branche {branch} n\'existe plus',
    'worktree-mismatch':
      'le dossier {dir} est sur la branche « {actual} », pas « {branch} »',
    'integration-mismatch':
      'le worktree d\'intégration {dir} est sur la branche « {actual} », pas « {branch} » ; supprimez le worktree avec : git worktree remove "{dir}", puis relancez',
    'integration-dirty':
      'le worktree d\'intégration {dir} a des changements que personne n\'a commités ({files}) ; commitez-les dans ce dossier, ou retirez ceux qui ne sont pas sous {tasksDir}, puis relancez ; les fichiers sous {tasksDir} portent l\'état des tâches livrées : ne les retirez jamais',
    'tasks-not-committed':
      'le dossier des tâches « {dir} » a des changements non commités, ou manque dans la branche {branch} ; commitez-le d\'abord : les équipiers travaillent à partir des commits',
    'question-unknown': 'la mission « {mission} » n\'a pas de question « {id} » ; voir les questions ouvertes avec : relaylead question list {mission}',
    'question-answered': 'la question « {id} » a déjà une réponse (« {choice} »)',
    'bad-choice': 'la réponse « {choice} » n\'est pas une des options ; donnez un numéro ou un texte parmi : {options}',
    'question-key-clash': 'la clé « {key} » donne l\'id « {id} », déjà pris par la question de clé « {storedKey} » ; choisissez une autre clé',
    'missing-value': 'l\'option --{name} attend une valeur',
    'config-unknown-key': 'impossible de régler « {key} » ; les réglages sont : {keys}',
    'config-bad-value': '« {value} » n\'est pas une valeur valable pour {key} (pane : always ou never ; statusLine : true ou false ; dashboardPort : 1 à 65535)',
    'dashboard-port-busy': 'le port {port} n\'est pas libre ; choisissez-en un autre avec : relaylead config set display.dashboardPort <port>',
    'not-from-a-session': '« relaylead {command} » appartient à l\'utilisateur ; une session de mission ne peut pas le lancer',
    'not-your-task': 'cette session travaille sur la tâche « {own} » ; elle ne peut pas terminer la tâche « {id} »',
    'not-for-crew': 'un équipier ne peut ni lancer, ni relancer, ni livrer de tâche ; terminez votre propre tâche avec : relaylead task done {own}',
    'not-current-lead': 'cette session ({session}) n\'est plus le lead de la mission « {mission} » : {current} a pris le relais ; terminez votre tour',
    questionAnswered: 'question {id} répondue : {choice}\n',
    toldMessage: 'message {id} transmis au lead de {mission}\n',
    'memory-disabled': 'la mémoire de projet est désactivée (memory.enabled vaut false dans .relaylead.json)',
    'bad-memory': 'rien à écrire : donnez la mémoire en texte (--text) ou en fichier (--file)',
    'memory-too-long': 'la mémoire fait {lines} lignes, au-dessus du plafond de {max} : compactez-la (fusionnez les leçons, une ligne par mission passée, retirez le périmé) puis écrivez-la à nouveau',
    'memory-busy': 'une autre commande écrit la mémoire de {dir} ; réessayez dans un instant',
    'memory-file-unreadable': 'impossible de lire le fichier de mémoire {file} : {detail}',
    'memory-changed': 'la mémoire a changé depuis votre lecture (une autre mission l\'a écrite) : relisez-la avec `relaylead memory show`, fusionnez son nouveau contenu avec le vôtre, puis écrivez-la à nouveau avec la nouvelle empreinte en --base',
    'memory-not-compacted': 'la mission ne peut pas encore être déclarée terminée : compactez d\'abord la mémoire de projet. Lancez `relaylead memory show`, puis `relaylead memory write --base <empreinte> --text "<mémoire compactée>"` (cette mission en une ligne, leçons fusionnées, périmé retiré), puis relancez `relaylead state set done`. Hors session, ajoutez `--mission <nom>` à chacune de ces commandes. Si la mémoire ne peut pas être écrite, ajoutez --no-memory à `state set done`.',
    'memory-too-big': 'la mémoire fait {bytes} octets, au-dessus du plafond de {max} : compactez-la (lignes plus courtes, retirez les détails) puis écrivez-la à nouveau',
    memoryTooBig: 'ATTENTION : cette mémoire fait {bytes} octets, au-dessus du plafond de {max} : seul son début est montré ci-dessous. Compactez-la avant de commencer : fusionnez les leçons, gardez une ligne par mission passée, retirez le périmé et le long, puis lancez : relaylead memory write --base <empreinte> --text "<mémoire compactée>" (la partie non montrée reste dans l\'archive)\n\n',
    memoryTruncated: '[tronqué : {hidden} lignes non montrées]\n',
    memoryFingerprint: 'Empreinte de la mémoire (à donner à `relaylead memory write` en --base) : {fingerprint}\n',
    memoryDisabled: 'La mémoire de projet est désactivée : rien à lire ni à écrire.\n',
    memoryEmpty: 'La mémoire de projet est vide : rien à lire pour l\'instant.\n',
    memoryTooLong: 'ATTENTION : cette mémoire fait {lines} lignes, au-dessus du plafond de {max}. Compactez-la avant de commencer : fusionnez les leçons, gardez une ligne par mission passée, retirez le périmé, puis lancez : relaylead memory write --base <empreinte> --text "<mémoire compactée>"\n\n',
    memoryWritten: 'mémoire écrite ({lines} lignes)\n',
    decisionNoted: 'décision notée\n',
    'bad-question': 'impossible de poser la question : {detail}',
    'bad-task-id':
      'le fichier de tâche {file} a un nom inutilisable dans une branche git ; utilisez lettres, chiffres, « . », « _ » et « - », sans commencer par « . » ni « - », sans finir par « . » (et ni _integration ni integration)',
    'claude-not-found': 'claude est introuvable ; installez Claude Code, ou indiquez son exécutable dans RELAYLEAD_CLAUDE',
    'claude-cmd-unsupported':
      '{file} ne se lance pas sans shell ; indiquez dans RELAYLEAD_CLAUDE le vrai claude.exe ou son point d\'entrée JavaScript (.js)',
    'claude-too-old': 'Claude Code {min} ou plus récent est nécessaire, trouvé « {found} » ; mettez-le à jour avec : claude update',
    'untrusted-dir': 'Claude Code n\'approuve pas encore le dossier {dir} ; lancez `claude` une fois dans {dir} et acceptez, puis réessayez',
    'not-started': 'la session claude {shortId} n\'a pas commencé son premier tour en {seconds} s',
    'wake-timeout': 'la session {shortId} a été arrêtée mais son processus tournait encore après {seconds} s ; elle n\'a pas été réveillée',
    'wake-copy': 'le réveil de la session claude {shortId} a démarré une copie ({copy}) à la place ; voir la session avec : claude attach {shortId}',
    'claude-unexpected-output': 'sortie inattendue de {command} : {output}',
    'claude-failed': 'échec de {command} : {output}',
    'claude-timeout': '{command} n\'a pas répondu en {seconds} s',
    'bad-prompt': 'la consigne ne peut pas commencer par « - » : claude la prendrait pour une option ; reformulez-la',
    orphan: ' ; impossible d\'arrêter {shortId} : lancez `claude stop {shortId}`',
    'session-stopped': ' ; elle a été arrêtée',
    'copy-stopped': ' ; la copie a été arrêtée',
    'worktree-of-mission':
      ' ; il vient de la mission « {mission} » : supprimez cette mission avec : relaylead remove {mission}, ou seulement ce dossier avec : git worktree remove "{dir}"',
    'worktree-not-relaylead': ' ; supprimez-le avec : git worktree remove "{dir}"',
    'gh-missing': 'gh, la CLI de GitHub, est introuvable ; installez-la depuis https://cli.github.com',
    'gh-not-authenticated': 'gh n\'est pas connecté à GitHub ; connectez-vous avec : gh auth login',
    'gh-failed': 'échec de gh {args} : {detail}',
    'push-failed': 'échec de git push {remote} {branch} : {detail}',
    'pr-changes-requested':
      'la pull request {url} de la tâche « {id} » a des changements demandés ; faites-les faire sur sa branche, puis livrez à nouveau',
    'pr-merge-conflict':
      'la pull request {url} de la tâche « {id} » ne peut pas être fusionnée : elle est en conflit avec la branche d\'intégration ; faites corriger le conflit sur sa branche, puis livrez à nouveau',
    'pr-merged': 'tâche « {id} » : pull request {url} fusionnée',
    'mission-usage-paused':
      'la mission « {mission} » est en pause (limite d\'usage) jusqu\'à {resumeAt} ; elle reprendra seule à cette heure, et ne lance aucune session d\'ici là',
    usagePausedState: 'usage-pause (reprise {resumeAt})',
    queuedMark: ' ({n} en file)',
    abandonedMark: ' (abandonnée)',
    briefInstall: 'Problèmes d\'installation :\n',
    briefNew: 'Nouveau :\n',
    briefNothingNew: 'Rien de nouveau.\n',
    briefQuestions: 'Questions ouvertes ({n}) :\n',
    briefNoQuestion: 'Aucune question ouverte.\n',
    briefMissions: 'Missions en cours :\n',
    briefNoMission: 'Aucune mission en cours.\n',
    briefNewMark: 'nouvelle',
    briefRecommended: ' (recommandée)',
    briefTasks: 'tâches {delivered}/{total} livrées',
    briefQueued: '{n} en attente d\'une place',
    briefPaused: 'en pause jusqu\'à {at}',
    briefPriority: 'priorité {priority}',
    eventTaskFailed: '[{mission}] tâche {id} en échec (essai {attempt}) : {summary}\n',
    eventMission: '[{mission}] mission {state}\n',
    eventMerged: '[{mission}] fusionnée dans {target}\n',
  },
};

// Returns the message for `key` in `lang` (default English), replacing {name} by vars.name.
function t(key, vars, lang) {
  const table = messages[lang] || messages.en;
  // A text not translated yet (the v1 installation texts) is shown in English.
  const template = table[key] === undefined ? messages.en[key] : table[key];
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars && vars[name]));
}

// An expected error: its text comes from the messages, so the CLI can print it in the user's language.
function codedError(code, vars) {
  const err = new Error(t(code, vars));
  err.code = code;
  err.vars = vars;
  return err;
}

module.exports = { t, codedError };
