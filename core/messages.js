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
      '  task      manage the tasks of a mission',
      '  state     read or set the state declared by the lead',
      '  wait      wait for a mission to change',
      '  question  ask the user a question',
      '  answer    answer a question',
      '',
      'Options:',
      '  --help, -h     show this help',
      '  --version, -v  show the version',
      '',
    ].join('\n'),
    unknownCommand: 'relaylead: unknown command "{command}"\n\n',
    noMissions: 'no missions\n',
    missionStopped: 'mission {mission} stopped\n',
    missionRemoved: 'mission {mission} removed\n',
    branchDeleted: 'deleted branch {branch}\n',
    missionNothingToStop: 'mission {mission} is already {state}; nothing to do\n',
    missionDoneSessionsStopped: 'mission {mission} is done; its remaining sessions were stopped\n',
    missionStopSkipped:
      'the sessions of mission {mission} were not stopped again: their process ids are more than an hour old\n',
    taskDelivered: 'task {id} delivered\n',
    taskAlreadyDelivered: 'task {id} already delivered\n',
    // Subject of the commit of a task's state line, in the integration branch.
    deliveryCommit: 'chore(relaylead): deliver {id}',
    // Errors: the key is the error code (see codedError).
    usage: 'usage: {usage}',
    'dir-busy':
      'the folder {dir} is busy with mission "{mission}" ({state}); if its lead is gone, stop it first with: relaylead stop {mission}',
    'mission-exists':
      'a mission named "{mission}" already exists; choose another name with --name, or remove the finished one with: relaylead remove {mission}',
    'mission-running': 'mission "{mission}" is {state}; stop it first with: relaylead stop {mission}',
    'checkout-on-task-branch':
      'your checkout {dir} is on branch {branch} of this mission; switch to another branch, then remove again',
    'remove-unmerged-work':
      'mission "{mission}" has work not delivered: {items}; remove anyway with: relaylead remove {mission} --force; it deletes these branches and changes',
    'mission-unknown': 'no mission named "{mission}"',
    'mission-stopped': 'mission "{mission}" was stopped; its state can no longer change',
    'mission-finished': 'mission "{mission}" is done; its state can no longer change',
    'bad-state': 'unknown state "{state}"; use one of: {states}',
    'no-mission': 'no mission given; use --mission <name> or set RELAYLEAD_MISSION',
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
      'the integration branch "{branch}" is protected; set another delivery.branch in .relaylead.json',
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
    'branch-clash':
      'the integration branch "{branch}" clashes with the task branches relaylead/{mission}/<id>; choose another mission name or delivery.branch',
    'integration-mismatch':
      'the integration worktree {dir} is on branch "{actual}", not "{branch}"; set delivery.branch back to "{actual}", or remove the worktree with: git worktree remove "{dir}"',
    'tasks-not-committed':
      'the task folder "{dir}" has changes not committed, or is missing from branch {branch}; commit it first: the crew works from commits',
    'question-unknown': 'mission "{mission}" has no question "{id}"; see the open ones with: relaylead question list {mission}',
    'question-answered': 'question "{id}" is already answered ("{choice}")',
    'bad-choice': 'answer "{choice}" is not one of the options; use a number or a text from: {options}',
    'question-key-clash': 'the key "{key}" makes the id "{id}", already used by the question with key "{storedKey}"; choose another key',
    'missing-value': 'the option --{name} needs a value',
    'not-from-a-session': '"relaylead {command}" belongs to the user; a mission session cannot run it',
    'not-your-task': 'this session works on task "{own}"; it cannot finish task "{id}"',
    'not-for-crew': 'a crew member cannot start, retry or deliver tasks; finish your own task with: relaylead task done {own}',
    questionAnswered: 'question {id} answered: {choice}\n',
    'bad-question': 'cannot ask the question: {detail}',
    'bad-task-id':
      'the task file {file} has a name unusable in a git branch; use letters, digits, ".", "_" and "-", not starting with "." or "-", not ending with "." (and not _integration)',
    'claude-not-found': 'claude was not found; install Claude Code, or set RELAYLEAD_CLAUDE to its executable',
    'claude-cmd-unsupported':
      '{file} cannot be run without a shell; set RELAYLEAD_CLAUDE to the real claude.exe or to its JavaScript entry (.js)',
    'claude-too-old': 'Claude Code {min} or later is needed, found "{found}"; update it with: claude update',
    'untrusted-dir': 'Claude Code does not trust the folder {dir} yet; run `claude` once in {dir} and accept, then try again',
    'not-started': 'the claude session {shortId} did not start its first turn within {seconds} s',
    'wake-timeout': 'the claude session {shortId} was stopped but its process was still running after {seconds} s; it was not woken',
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
      '  task      gérer les tâches d\'une mission',
      '  state     lire ou écrire l\'état déclaré par le lead',
      '  wait      attendre qu\'une mission change',
      '  question  poser une question à l\'utilisateur',
      '  answer    répondre à une question',
      '',
      'Options :',
      '  --help, -h     afficher cette aide',
      '  --version, -v  afficher la version',
      '',
    ].join('\n'),
    unknownCommand: 'relaylead : commande inconnue « {command} »\n\n',
    noMissions: 'aucune mission\n',
    missionStopped: 'mission {mission} arrêtée\n',
    missionRemoved: 'mission {mission} supprimée\n',
    branchDeleted: 'branche supprimée {branch}\n',
    missionNothingToStop: 'la mission {mission} est déjà {state} ; rien à faire\n',
    missionDoneSessionsStopped: 'la mission {mission} est terminée ; ses sessions restantes ont été arrêtées\n',
    missionStopSkipped:
      'les sessions de la mission {mission} n\'ont pas été arrêtées de nouveau : leurs numéros de processus ont plus d\'une heure\n',
    taskDelivered: 'tâche {id} livrée\n',
    taskAlreadyDelivered: 'tâche {id} déjà livrée\n',
    deliveryCommit: 'chore(relaylead): {id} livrée',
    usage: 'usage : {usage}',
    'dir-busy':
      'le dossier {dir} est occupé par la mission « {mission} » ({state}) ; si son lead a disparu, arrêtez-la d\'abord avec : relaylead stop {mission}',
    'mission-exists':
      'une mission nommée « {mission} » existe déjà ; choisissez un autre nom avec --name, ou supprimez celle qui est finie avec : relaylead remove {mission}',
    'mission-running': 'la mission « {mission} » est {state} ; arrêtez-la d\'abord avec : relaylead stop {mission}',
    'checkout-on-task-branch':
      'votre copie de travail {dir} est sur la branche {branch} de cette mission ; passez sur une autre branche, puis relancez la suppression',
    'remove-unmerged-work':
      'la mission « {mission} » a du travail non livré : {items} ; supprimez quand même avec : relaylead remove {mission} --force ; cela supprime ces branches et ces changements',
    'mission-unknown': 'aucune mission nommée « {mission} »',
    'mission-stopped': 'la mission « {mission} » a été arrêtée ; son état ne peut plus changer',
    'mission-finished': 'la mission « {mission} » est terminée ; son état ne peut plus changer',
    'bad-state': 'état inconnu « {state} » ; utilisez l\'un de : {states}',
    'no-mission': 'aucune mission indiquée ; utilisez --mission <nom> ou RELAYLEAD_MISSION',
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
      'la branche d\'intégration « {branch} » est protégée ; indiquez une autre delivery.branch dans .relaylead.json',
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
    'branch-clash':
      'la branche d\'intégration « {branch} » entre en conflit avec les branches des tâches relaylead/{mission}/<id> ; choisissez un autre nom de mission ou une autre delivery.branch',
    'integration-mismatch':
      'le worktree d\'intégration {dir} est sur la branche « {actual} », pas « {branch} » ; remettez delivery.branch à « {actual} », ou supprimez le worktree avec : git worktree remove "{dir}"',
    'tasks-not-committed':
      'le dossier des tâches « {dir} » a des changements non commités, ou manque dans la branche {branch} ; commitez-le d\'abord : les équipiers travaillent à partir des commits',
    'question-unknown': 'la mission « {mission} » n\'a pas de question « {id} » ; voir les questions ouvertes avec : relaylead question list {mission}',
    'question-answered': 'la question « {id} » a déjà une réponse (« {choice} »)',
    'bad-choice': 'la réponse « {choice} » n\'est pas une des options ; donnez un numéro ou un texte parmi : {options}',
    'question-key-clash': 'la clé « {key} » donne l\'id « {id} », déjà pris par la question de clé « {storedKey} » ; choisissez une autre clé',
    'missing-value': 'l\'option --{name} attend une valeur',
    'not-from-a-session': '« relaylead {command} » appartient à l\'utilisateur ; une session de mission ne peut pas le lancer',
    'not-your-task': 'cette session travaille sur la tâche « {own} » ; elle ne peut pas terminer la tâche « {id} »',
    'not-for-crew': 'un équipier ne peut ni lancer, ni relancer, ni livrer de tâche ; terminez votre propre tâche avec : relaylead task done {own}',
    questionAnswered: 'question {id} répondue : {choice}\n',
    'bad-question': 'impossible de poser la question : {detail}',
    'bad-task-id':
      'le fichier de tâche {file} a un nom inutilisable dans une branche git ; utilisez lettres, chiffres, « . », « _ » et « - », sans commencer par « . » ni « - », sans finir par « . » (et pas _integration)',
    'claude-not-found': 'claude est introuvable ; installez Claude Code, ou indiquez son exécutable dans RELAYLEAD_CLAUDE',
    'claude-cmd-unsupported':
      '{file} ne se lance pas sans shell ; indiquez dans RELAYLEAD_CLAUDE le vrai claude.exe ou son point d\'entrée JavaScript (.js)',
    'claude-too-old': 'Claude Code {min} ou plus récent est nécessaire, trouvé « {found} » ; mettez-le à jour avec : claude update',
    'untrusted-dir': 'Claude Code n\'approuve pas encore le dossier {dir} ; lancez `claude` une fois dans {dir} et acceptez, puis réessayez',
    'not-started': 'la session claude {shortId} n\'a pas commencé son premier tour en {seconds} s',
    'wake-timeout': 'la session claude {shortId} a été arrêtée mais son processus tournait encore après {seconds} s ; elle n\'a pas été réveillée',
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
  },
};

// Returns the message for `key` in `lang` (default English), replacing {name} by vars.name.
function t(key, vars, lang) {
  const table = messages[lang] || messages.en;
  const template = table[key];
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
