const messages = {
  en: {
    help: [
      'Usage: relaylead <command> [options]',
      '',
      'Commands:',
      '  launch    start a mission with a lead and its crew',
      '  list      list missions and sessions',
      '  show      show one mission',
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
    notImplemented: 'relaylead {command}: not implemented yet\n',
    unknownCommand: 'relaylead: unknown command "{command}"\n\n',
    noMissions: 'no missions\n',
    missionStopped: 'mission {mission} stopped\n',
    // Errors: the key is the error code (see codedError).
    usage: 'usage: {usage}',
    'dir-busy': 'the folder {dir} is busy with mission "{mission}"; stop it first with: relaylead stop {mission}',
    'mission-exists': 'a mission named "{mission}" already exists; choose another name with --name',
    'mission-unknown': 'no mission named "{mission}"',
    'mission-stopped': 'mission "{mission}" was stopped; its state can no longer change',
    'bad-state': 'unknown state "{state}"; use one of: {states}',
    'no-mission': 'no mission given; use --mission <name> or set RELAYLEAD_MISSION',
    'session-exists': 'mission "{mission}" already has another session with the short id {shortId}',
    'task-unknown': 'mission "{mission}" has no task "{id}"; see the tasks with: relaylead task list',
    'task-not-startable': 'task "{id}" is {state}; only a todo task can be started',
    'start-busy': 'another task of mission "{mission}" has been starting for a minute; try again',
  },
  fr: {
    help: [
      'Usage : relaylead <commande> [options]',
      '',
      'Commandes :',
      '  launch    lancer une mission avec un lead et son équipe',
      '  list      lister les missions et les sessions',
      '  show      afficher une mission',
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
    notImplemented: 'relaylead {command} : pas encore disponible\n',
    unknownCommand: 'relaylead : commande inconnue « {command} »\n\n',
    noMissions: 'aucune mission\n',
    missionStopped: 'mission {mission} arrêtée\n',
    usage: 'usage : {usage}',
    'dir-busy': 'le dossier {dir} est occupé par la mission « {mission} » ; arrêtez-la d\'abord avec : relaylead stop {mission}',
    'mission-exists': 'une mission nommée « {mission} » existe déjà ; choisissez un autre nom avec --name',
    'mission-unknown': 'aucune mission nommée « {mission} »',
    'mission-stopped': 'la mission « {mission} » a été arrêtée ; son état ne peut plus changer',
    'bad-state': 'état inconnu « {state} » ; utilisez l\'un de : {states}',
    'no-mission': 'aucune mission indiquée ; utilisez --mission <nom> ou RELAYLEAD_MISSION',
    'session-exists': 'la mission « {mission} » a déjà une autre session d\'id court {shortId}',
    'task-unknown': 'la mission « {mission} » n\'a pas de tâche « {id} » ; voir les tâches avec : relaylead task list',
    'task-not-startable': 'la tâche « {id} » est {state} ; seule une tâche todo peut être lancée',
    'start-busy': 'une autre tâche de la mission « {mission} » est en lancement depuis une minute ; réessayez',
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
