const messages = {
  en: {
    help: [
      'Usage: relaylead <command> [options]',
      '',
      'Commands:',
      '  launch    start a mission with a lead and its crew',
      '  list      list missions and sessions',
      '  show      open the lead session of a mission',
      '  stop      stop a mission or a session',
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
    taskDelivered: 'task {id} delivered\n',
    taskAlreadyDelivered: 'task {id} already delivered\n',
    // Errors: the key is the error code (see codedError).
    usage: 'usage: {usage}',
    'dir-busy': 'the folder {dir} is busy with mission "{mission}"; stop it first with: relaylead stop {mission}',
    'mission-exists': 'a mission named "{mission}" already exists; choose another name with --name',
    'mission-unknown': 'no mission named "{mission}"',
    'mission-stopped': 'mission "{mission}" was stopped; its state can no longer change',
    'bad-state': 'unknown state "{state}"; use one of: {states}',
    'no-mission': 'no mission given; use --mission <name> or set RELAYLEAD_MISSION',
    'no-lead': 'mission "{mission}" has no lead session yet',
    'session-exists': 'mission "{mission}" already has another session with the short id {shortId}',
    'task-unknown': 'mission "{mission}" has no task "{id}"; see the tasks with: relaylead task list',
    'task-not-startable': 'task "{id}" is {state}; only a todo task can be started',
    'task-not-answered':
      'task "{id}" asks a question first; ask it with: relaylead question ask --key {id} …, and start the task once it is answered',
    'mission-done': 'mission "{mission}" is done; no task can start',
    'start-busy': 'another task of mission "{mission}" has been starting or delivering for a minute; try again',
    'task-not-deliverable': 'task "{id}" is {state}; only a done task can be delivered',
    'protected-branch':
      'the integration branch "{branch}" is protected; set another delivery.branch in .relaylead.json',
    'not-a-git-repo':
      '{dir} is not the root of a git repository; run the mission at the root, or set "delivery": {"type": "files"} in .relaylead.json',
    'merge-conflict':
      'task "{id}" conflicts with the integration branch; the merge was cancelled and the task stays done. Resolve it on branch {branch}, then deliver again',
    'empty-output': 'task "{id}" delivered nothing: its output folder {dir} is empty',
    'cleanup-failed':
      'task "{id}" is delivered, but its worktree or branch could not be cleaned up; the next "relaylead task deliver {id}" tries again ({detail})',
    'task-late-work':
      'task "{id}" is delivered, but its branch {branch} or its folder {dir} has work done since; they were kept: deliver that work as a new task',
    'integration-sync-conflict':
      'your current branch conflicts with the integration branch "{branch}"; the update was cancelled. Merge your branch into it by hand in {dir}, then launch again',
    'task-uncommitted': 'task "{id}" has work not committed in {dir}; commit it on its branch, then deliver again',
    'task-empty': 'task "{id}" has no commit on its branch {branch}; nothing to deliver',
    'task-branch-missing': 'cannot deliver task "{id}": its branch {branch} is missing',
    'worktree-mismatch':
      'the folder {dir} is on branch "{actual}", not "{branch}"; it was left by another mission: remove it with: git worktree remove "{dir}"',
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
  },
  fr: {
    help: [
      'Usage : relaylead <commande> [options]',
      '',
      'Commandes :',
      '  launch    lancer une mission avec un lead et son équipe',
      '  list      lister les missions et les sessions',
      '  show      ouvrir la session du lead d\'une mission',
      '  stop      arrêter une mission ou une session',
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
    taskDelivered: 'tâche {id} livrée\n',
    taskAlreadyDelivered: 'tâche {id} déjà livrée\n',
    usage: 'usage : {usage}',
    'dir-busy': 'le dossier {dir} est occupé par la mission « {mission} » ; arrêtez-la d\'abord avec : relaylead stop {mission}',
    'mission-exists': 'une mission nommée « {mission} » existe déjà ; choisissez un autre nom avec --name',
    'mission-unknown': 'aucune mission nommée « {mission} »',
    'mission-stopped': 'la mission « {mission} » a été arrêtée ; son état ne peut plus changer',
    'bad-state': 'état inconnu « {state} » ; utilisez l\'un de : {states}',
    'no-mission': 'aucune mission indiquée ; utilisez --mission <nom> ou RELAYLEAD_MISSION',
    'no-lead': 'la mission « {mission} » n\'a pas encore de session de lead',
    'session-exists': 'la mission « {mission} » a déjà une autre session d\'id court {shortId}',
    'task-unknown': 'la mission « {mission} » n\'a pas de tâche « {id} » ; voir les tâches avec : relaylead task list',
    'task-not-startable': 'la tâche « {id} » est {state} ; seule une tâche todo peut être lancée',
    'task-not-answered':
      'la tâche « {id} » pose d\'abord une question ; posez-la avec : relaylead question ask --key {id} …, puis lancez la tâche une fois la réponse donnée',
    'mission-done': 'la mission « {mission} » est terminée ; aucune tâche ne peut être lancée',
    'start-busy': 'une autre tâche de la mission « {mission} » est en lancement ou en livraison depuis une minute ; réessayez',
    'task-not-deliverable': 'la tâche « {id} » est {state} ; seule une tâche done peut être livrée',
    'protected-branch':
      'la branche d\'intégration « {branch} » est protégée ; indiquez une autre delivery.branch dans .relaylead.json',
    'not-a-git-repo':
      '{dir} n\'est pas la racine d\'un dépôt git ; lancez la mission à la racine, ou mettez "delivery": {"type": "files"} dans .relaylead.json',
    'merge-conflict':
      'la tâche « {id} » est en conflit avec la branche d\'intégration ; la fusion est annulée et la tâche reste done. Résolvez-le sur la branche {branch}, puis livrez de nouveau',
    'empty-output': 'la tâche « {id} » n\'a rien livré : son dossier de sortie {dir} est vide',
    'cleanup-failed':
      'la tâche « {id} » est livrée, mais son worktree ou sa branche n\'a pas pu être nettoyé ; le prochain « relaylead task deliver {id} » réessaie ({detail})',
    'task-late-work':
      'la tâche « {id} » est livrée, mais sa branche {branch} ou son dossier {dir} contient du travail fait depuis ; ils sont conservés : livrez ce travail dans une nouvelle tâche',
    'integration-sync-conflict':
      'votre branche courante est en conflit avec la branche d\'intégration « {branch} » ; la mise à jour est annulée. Fusionnez votre branche à la main dans {dir}, puis relancez',
    'task-uncommitted': 'la tâche « {id} » a du travail non commité dans {dir} ; commitez-le sur sa branche, puis livrez de nouveau',
    'task-empty': 'la tâche « {id} » n\'a aucun commit sur sa branche {branch} ; rien à livrer',
    'task-branch-missing': 'impossible de livrer la tâche « {id} » : sa branche {branch} n\'existe plus',
    'worktree-mismatch':
      'le dossier {dir} est sur la branche « {actual} », pas « {branch} » ; il vient d\'une autre mission : supprimez-le avec : git worktree remove "{dir}"',
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
