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
  },
};

// Returns the message for `key` in `lang` (default English), replacing {name} by vars.name.
function t(key, vars, lang) {
  const table = messages[lang] || messages.en;
  const template = table[key];
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars && vars[name]));
}

module.exports = { t };
