// The help of each command: `relaylead <command> --help` and `relaylead help [command]`. One text per
// command and per language; a language without a text falls back to English.
const HELP = {
  launch: {
    en: [
      'relaylead launch --request "<one line>" [--name <slug>] [--tasks <folder>] [--priority <p>] [--team <name>] [--agent <name>] [--dir <folder>] [--force]',
      '',
      'Starts a mission: a lead session and its crew work in the background on the tasks of the folder',
      '(tasks/<id>.md, committed). Run it at the root of a git repository.',
      '',
      '  --request   what the lead is asked to do, in one line',
      '  --name      name of the mission (a slug: letters, digits, dashes); the folder name by default',
      '  --tasks     task folder of the project, for a second mission (for instance tasks/frontend)',
      '  --priority  high, normal or low',
      '  --team      the team to use (code by default)',
      '  --agent     the agent to use (claude by default)',
      '  --dir       project folder (the current one by default)',
      '  --force     launch even when a finished mission not merged yet has the same tasks',
      '',
      'Then: relaylead list, relaylead brief, relaylead merge <mission> once it is done.',
    ],
    fr: [
      'relaylead launch --request "<une ligne>" [--name <slug>] [--tasks <dossier>] [--priority <p>] [--team <nom>] [--agent <nom>] [--dir <dossier>] [--force]',
      '',
      'Lance une mission : un lead et son équipe travaillent en tâche de fond sur les tâches du dossier',
      '(tasks/<id>.md, commitées). À lancer à la racine d\'un dépôt git.',
      '',
      '  --request   ce que le lead doit faire, en une ligne',
      '  --name      nom de la mission (un slug : lettres, chiffres, tirets) ; le nom du dossier par défaut',
      '  --tasks     dossier de tâches du projet, pour une deuxième mission (par exemple tasks/frontend)',
      '  --priority  high, normal ou low',
      '  --team      l\'équipe à utiliser (code par défaut)',
      '  --agent     l\'agent à utiliser (claude par défaut)',
      '  --dir       dossier du projet (le dossier courant par défaut)',
      '  --force     lancer même si une mission terminée et pas encore fusionnée a les mêmes tâches',
      '',
      'Ensuite : relaylead list, relaylead brief, relaylead merge <mission> quand elle est terminée.',
    ],
  },
  list: {
    en: ['relaylead list', '', 'Lists the missions: name, state, lead session and project folder.'],
    fr: ['relaylead list', '', 'Liste les missions : nom, état, session du lead et dossier du projet.'],
  },
  show: {
    en: ['relaylead show <mission>', '', 'Opens the lead session of a running mission. A finished mission has no session left.'],
    fr: ['relaylead show <mission>', '', 'Ouvre la session du lead d\'une mission en cours. Une mission terminée n\'a plus de session.'],
  },
  stop: {
    en: ['relaylead stop <mission>', '', 'Stops the mission and all its sessions. Its branches stay until relaylead remove; the task worktrees with no uncommitted work are removed.'],
    fr: ['relaylead stop <mission>', '', 'Arrête la mission et toutes ses sessions. Ses branches restent jusqu\'à relaylead remove ; les worktrees de tâche sans travail non commité sont retirés.'],
  },
  remove: {
    en: [
      'relaylead remove <mission> [--force]',
      '',
      'Removes a finished mission: its state, worktrees and branches. Refused while work is not delivered;',
      '--force deletes that work too.',
    ],
    fr: [
      'relaylead remove <mission> [--force]',
      '',
      'Supprime une mission terminée : son état, ses worktrees et ses branches. Refusé tant que du travail n\'est pas livré ;',
      '--force supprime aussi ce travail.',
    ],
  },
  priority: {
    en: ['relaylead priority <mission> <high|normal|low>', '', 'Changes the priority of a mission while it runs.'],
    fr: ['relaylead priority <mission> <high|normal|low>', '', 'Change la priorité d\'une mission pendant qu\'elle tourne.'],
  },
  merge: {
    en: [
      'relaylead merge <mission>',
      '',
      'Brings the work of a done mission into the branch it was launched from (never automatic).',
      'On a conflict, nothing changes: a crew member resolves it, then Relaylead merges again by itself.',
    ],
    fr: [
      'relaylead merge <mission>',
      '',
      'Ramène le travail d\'une mission terminée dans la branche d\'où elle a été lancée (jamais automatique).',
      'En cas de conflit, rien ne change : un équipier le résout, puis Relaylead fusionne de nouveau seul.',
    ],
  },
  task: {
    en: [
      'relaylead task list [--short] | start <id> [--profile <p>] | retry <id> [--profile <p>] | deliver <id> [--no-hooks] | done <id> | fail <id> [--summary text] [--mission <name>]',
      '',
      'Manages the tasks of a mission. Mostly for the lead and the crew; --mission names the mission outside a session.',
    ],
    fr: [
      'relaylead task list [--short] | start <id> [--profile <p>] | retry <id> [--profile <p>] | deliver <id> [--no-hooks] | done <id> | fail <id> [--summary texte] [--mission <nom>]',
      '',
      'Gère les tâches d\'une mission. Surtout pour le lead et l\'équipe ; --mission nomme la mission hors d\'une session.',
    ],
  },
  state: {
    en: [
      'relaylead state get | set <state> [--note text] [--no-memory] [--mission <name>]',
      '',
      'Reads or sets the state declared by the lead: starting, working, waiting, handover, done.',
    ],
    fr: [
      'relaylead state get | set <état> [--note texte] [--no-memory] [--mission <nom>]',
      '',
      'Lit ou change l\'état déclaré par le lead : starting, working, waiting, handover, done.',
    ],
  },
  wait: {
    en: [
      'relaylead wait [--timeout <seconds>] [--mission <name>]',
      'relaylead wait --all [--timeout <seconds>] [--json]',
      '',
      'Waits for a mission to change. --all is for the console: it waits for news in every mission of the machine.',
    ],
    fr: [
      'relaylead wait [--timeout <secondes>] [--mission <nom>]',
      'relaylead wait --all [--timeout <secondes>] [--json]',
      '',
      'Attend qu\'une mission change. --all est pour la console : elle attend du nouveau dans toutes les missions de la machine.',
    ],
  },
  tell: {
    en: ['relaylead tell <mission> <text>', '', 'Tells the lead of a mission something; the lead is woken to read it.'],
    fr: ['relaylead tell <mission> <texte>', '', 'Dit quelque chose au lead d\'une mission ; le lead est réveillé pour le lire.'],
  },
  decision: {
    en: ['relaylead decision <text> | decision --list [--mission <name>]', '', 'Notes a decision taken with the user in the mission (for the lead), or lists them.'],
    fr: ['relaylead decision <texte> | decision --list [--mission <nom>]', '', 'Note une décision prise avec l\'utilisateur dans la mission (pour le lead), ou les liste.'],
  },
  memory: {
    en: [
      'relaylead memory show | write --base <fingerprint> --file <file> | write --base <fingerprint> --text "<text>"',
      '',
      'Reads or replaces the project memory (.relaylead/memory.md), kept by the lead.',
    ],
    fr: [
      'relaylead memory show | write --base <empreinte> --file <fichier> | write --base <empreinte> --text "<texte>"',
      '',
      'Lit ou remplace la mémoire du projet (.relaylead/memory.md), tenue par le lead.',
    ],
  },
  question: {
    en: [
      'relaylead question ask --key k --text t [--context c] --option o --option o [--recommended n]',
      'relaylead question list [<mission>] [--all]',
      '',
      'Asks the user a question (for the lead), or lists the open ones of a mission.',
    ],
    fr: [
      'relaylead question ask --key k --text t [--context c] --option o --option o [--recommended n]',
      'relaylead question list [<mission>] [--all]',
      '',
      'Pose une question à l\'utilisateur (pour le lead), ou liste les questions ouvertes d\'une mission.',
    ],
  },
  answer: {
    en: ['relaylead answer <mission> <id> <number>', 'relaylead answer <mission> <id> --other "<text>"', '', 'Answers a question by the number of its option, or in your own words.'],
    fr: ['relaylead answer <mission> <id> <numéro>', 'relaylead answer <mission> <id> --other "<texte>"', '', 'Répond à une question par le numéro de son option, ou avec vos propres mots.'],
  },
  watcher: {
    en: ['relaylead watcher run [--mission <name>] | start | stop | status', '', 'The watcher restarts, wakes and relieves the leads of the missions. It starts by itself at launch.'],
    fr: ['relaylead watcher run [--mission <nom>] | start | stop | status', '', 'Le veilleur relance, réveille et relève les leads des missions. Il démarre seul au lancement.'],
  },
  init: {
    en: [
      'relaylead init [--yes] [--api-key-env <NAME>] [--no-memory] [--versioned-memory]',
      '',
      'Sets up Relaylead on this machine (language, authentication), then in the current git project',
      '(.relaylead.json). Asks its questions in a terminal; --yes takes the defaults.',
    ],
    fr: [
      'relaylead init [--yes] [--api-key-env <NOM>] [--no-memory] [--versioned-memory]',
      '',
      'Prépare Relaylead sur cette machine (langue, authentification), puis dans le projet git courant',
      '(.relaylead.json). Pose ses questions dans un terminal ; --yes prend les valeurs par défaut.',
    ],
  },
  install: {
    en: ['relaylead install', '', 'Registers the scheduler and the Claude Code plugin (macOS), then runs doctor.'],
    fr: ['relaylead install', '', 'Enregistre le planificateur et le plugin Claude Code (macOS), puis lance doctor.'],
  },
  uninstall: {
    en: ['relaylead uninstall [--purge]', '', 'Removes what install added. --purge also deletes ~/.relaylead.'],
    fr: ['relaylead uninstall [--purge]', '', 'Retire ce que install a ajouté. --purge supprime aussi ~/.relaylead.'],
  },
  doctor: {
    en: ['relaylead doctor', '', 'Checks the prerequisites and the installation. Starts no session.'],
    fr: ['relaylead doctor', '', 'Vérifie les prérequis et l\'installation. Ne lance aucune session.'],
  },
  brief: {
    en: ['relaylead brief', '', 'What the console shows first: problems, news, open questions, missions, and what to run next.'],
    fr: ['relaylead brief', '', 'Ce que la console montre d\'abord : problèmes, nouveautés, questions ouvertes, missions, et la commande suivante.'],
  },
  overview: {
    en: ['relaylead overview --json', '', 'Every mission, task and open question as JSON.'],
    fr: ['relaylead overview --json', '', 'Toutes les missions, tâches et questions ouvertes en JSON.'],
  },
  config: {
    en: ['relaylead config set <key> <value>', '', 'Sets a display setting, for instance: relaylead config set display.pane always'],
    fr: ['relaylead config set <clé> <valeur>', '', 'Change un réglage d\'affichage, par exemple : relaylead config set display.pane always'],
  },
  dashboard: {
    en: ['relaylead dashboard [--port <n>] [--no-open]', '', 'Serves the local web page of the missions and opens it; Ctrl-C stops it.'],
    fr: ['relaylead dashboard [--port <n>] [--no-open]', '', 'Sert la page web locale des missions et l\'ouvre ; Ctrl-C l\'arrête.'],
  },
  help: {
    en: ['relaylead help [command]', '', 'Shows the list of commands, or the help of one command (also: relaylead <command> --help).'],
    fr: ['relaylead help [commande]', '', 'Montre la liste des commandes, ou l\'aide d\'une commande (aussi : relaylead <commande> --help).'],
  },
};

// The help of `name` in `lang`, or null when there is none.
function commandHelp(name, lang) {
  if (!Object.prototype.hasOwnProperty.call(HELP, name)) return null;
  return (HELP[name][lang] || HELP[name].en).join('\n') + '\n';
}

module.exports = { commandHelp, helpCommands: Object.keys(HELP) };
