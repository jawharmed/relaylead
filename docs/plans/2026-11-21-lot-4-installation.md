# Lot 4 : installation (v1, macOS seul)

Périmètre de la feuille de route du 21 novembre 2026 : `install`, `uninstall`, `doctor`, launchd, plugin réduit aux commandes, `init`, une équipe type, textes en anglais, mode clé API. Hors v1 (v1.1) : `new-team`, français, grand catalogue, Linux/Windows.

## 1. But et périmètre

**Dans la v1**
- `relaylead install` : enregistre le planificateur launchd (`relaylead watcher run` toutes les 300 s) et le plugin Claude Code (commandes `/relaylead:*`). Seule commande qui écrit hors `~/.relaylead`.
- `relaylead uninstall` : retire exactement ce que `install` a ajouté, laisse `~/.relaylead` (sauf `--purge`).
- `relaylead doctor` : prérequis et état de l'installation, lecture seule.
- `relaylead init` : assistant (machine à la première fois, puis projet) qui écrit `~/.relaylead/config.json` et `.relaylead.json`.
- Une équipe type : `lead` + `developer` (profils déjà dans `catalog/profiles/`), méthode `code`.
- Mode clé API : la clé vient d'un fichier ou d'une variable d'environnement, jamais affichée ni journalisée.
- Textes anglais seulement : clés ajoutées dans `en` de `core/messages.js`. Ne pas toucher au bloc `fr`.

**Hors v1** : français, `new-team`, systemd/cron/Planificateur Windows, catalogue élargi, réglage des canaux d'alerte (le lot 3 n'en garde que la notification macOS ; `init` n'en demande aucun), mesures d'usage interactives.

**Plateforme** : `core/platform.js` expose `assertSupported()` : si `process.platform !== 'darwin'`, `codedError('platform-unsupported', { platform })`. `RELAYLEAD_PLATFORM` la remplace dans les tests. Seuls `install` et `uninstall` l'exigent ; `doctor` et `init` marchent partout (doctor signale la ligne « scheduler: unsupported platform ») pour que la CI macOS reste la seule vraie plateforme mais que les tests restent portables.

## 2. Tâches

### Tâche 1 : planificateur launchd (`core/scheduler.js`, `core/platform.js`)
Fichiers : nouveaux `core/platform.js`, `core/scheduler.js` ; `core/messages.js` (clés `platform-unsupported`, `scheduler-installed`, `scheduler-removed`, `scheduler-failed`) ; test `test/scheduler.test.js`.
- `plistPath()` = `<LaunchAgents>/dev.relaylead.watcher.plist`, dossier `RELAYLEAD_LAUNCHD_DIR` ou `~/Library/LaunchAgents`.
- `buildPlist({ node, bin, home, path })` : texte XML pur. Label `dev.relaylead.watcher` ; `ProgramArguments` = [`process.execPath`, `<paquet>/bin/relaylead.js`, `watcher`, `run`] ; `StartInterval` = `watcherSettings().everySeconds` ; `RunAtLoad` false ; `StandardOutPath`/`StandardErrorPath` = `<home>/launchd.log` ; `EnvironmentVariables` : `PATH` (celui de l'installateur, car launchd n'a presque rien) et `RELAYLEAD_HOME` seulement s'il est défini. Aucune clé API dans le plist (le veilleur la lit dans son fichier, tâche 4). Échapper `& < >` dans les valeurs.
- `installScheduler()` : écrit le plist (via `store.js`, atomique), puis `launchctl bootout` (ignorer l'échec : pas encore chargé) et `launchctl bootstrap gui/<uid> <plist>`. `uninstallScheduler()` : `bootout` puis suppression du plist ; sans plist, ne fait rien (idempotent). `schedulerStatus()` : `{ installed, loaded }` (plist présent ; `launchctl print gui/<uid>/dev.relaylead.watcher` code 0).
- `launchctl` se lance par `execFileSync` tableau d'arguments ; binaire `RELAYLEAD_LAUNCHCTL` ou `launchctl`. Échec : `codedError('scheduler-failed', { step, detail })`.
- Tests (faux `launchctl` = script Node dans `fixtures/` qui note ses arguments dans un fichier) : plist attendu ; installation puis seconde installation sans doublon ; désinstallation retire le plist ; plateforme `linux` → code `platform-unsupported` ; `&` dans un chemin bien échappé.

### Tâche 2 : plugin réduit aux commandes (`plugin/`, `core/plugin.js`)
Fichiers : nouveau dossier `plugin/` (ajouté à `files` de `package.json`) : `.claude-plugin/plugin.json` (name `relaylead`, version = celle du paquet), `.claude-plugin/marketplace.json` (marketplace locale `relaylead-local`, source `./`), `commands/{launch,list,show,stop,answer,init,doctor}.md`. Chaque commande : front matter `description`, `allowed-tools: Bash(relaylead <sous-commande> *)`, corps d'une ou deux phrases qui lance `relaylead <sous-commande> $ARGUMENTS` et résume la sortie. **Aucun hook, aucun agent, aucune barre d'état** (ils passent par `--settings`). Nouveau `core/plugin.js`.
- `installPlugin()` : `claude plugin marketplace add <paquet>/plugin` puis `claude plugin install relaylead@relaylead-local`. `uninstallPlugin()` : `claude plugin uninstall relaylead@relaylead-local` puis `claude plugin marketplace remove relaylead-local`. Binaire = celui de l'adaptateur (`RELAYLEAD_CLAUDE` ou `claude`). **Les sous-commandes `claude plugin …` sont à vérifier à la main** avec `claude plugin --help` avant d'écrire le code ; si elles diffèrent, ajuster ici seulement (tout le reste n'en dépend pas). Si `claude` est absent : `install` continue avec le planificateur et dit « plugin skipped: claude not found ».
- Tests (`test/plugin.test.js`) : `plugin.json` valide, version égale à `package.json`, chaque commande a un `allowed-tools` qui ne contient que `relaylead` ; `installPlugin` appelle le faux `claude` (`fixtures/claude/fake-claude.js`, à étendre : il note les arguments `plugin …`) avec les bons arguments dans l'ordre.

### Tâche 3 : `install`, `uninstall`, `doctor` (`core/cli.js`, `core/doctor.js`, `core/install.js`)
Fichiers : `core/cli.js` (trois entrées dans `commands`, `refuseInSession` pour les trois ; aide `help`) ; nouveaux `core/doctor.js`, `core/install.js` ; `core/messages.js` ; `test/install-cli.test.js`.
- `install` : `assertSupported()`, crée `~/.relaylead` si besoin, `installScheduler()`, `installPlugin()`, puis écrit `~/.relaylead/install.json` `{ installedAt, scheduler, plugin }` (ce que `uninstall` doit défaire). Idempotent. Termine par `doctor` abrégé.
- `uninstall [--purge]` : lit `install.json`, défait chaque élément qui y figure, supprime `install.json`. `--purge` supprime en plus `~/.relaylead` après contrôle que le chemin est bien `home()`. Ne touche jamais `~/.claude` autrement que par les commandes `claude plugin`.
- `doctor` : lecture seule ; une ligne `ok|warn|fail <nom>: <détail>` par contrôle, code de sortie 1 s'il y a au moins un `fail`. Contrôles : Node >= 18 ; `claude` présent et >= 2.1.325 (réutiliser `checkVersion` de l'adaptateur) ; `git` présent ; macOS (sinon `warn` scheduler) ; planificateur installé et chargé (`schedulerStatus`) ; plugin installé (via `claude plugin list`, `warn` si l'appel échoue) ; veilleur : date du dernier passage (`watcherRunning().lastPassAt`), `warn` s'il date de plus de 3 intervalles ; authentification (tâche 4) ; `STOP` présent → `warn`. `doctor` ne lance aucune session.
- Tests (RELAYLEAD_HOME temporaire, faux `launchctl`, faux `claude`, `RELAYLEAD_LAUNCHD_DIR` temporaire) : `install` puis `doctor` tout `ok` ; `uninstall` laisse `LaunchAgents` et la liste des plugins du faux `claude` identiques à l'état de départ (comparaison d'instantanés) ; `install` deux fois = un seul plist ; sous `RELAYLEAD_PLATFORM=linux`, `install` sort 1 avec le texte de `platform-unsupported`, `doctor` sort 0 sauf vrai échec ; `claude` trop ancien → `fail` ; `uninstall` sans `install.json` ne plante pas.

### Tâche 4 : mode clé API (`core/auth.js`, adaptateur Claude)
Fichiers : nouveau `core/auth.js` ; `adapters/claude/index.js` (fonction qui lance `claude`, au seul endroit d'`env`) ; `core/config.js` (`DEFAULTS.auth = { mode: 'login', keyFile: null }`) ; `core/messages.js` ; `test/auth.test.js`.
- `auth.mode` : `login` (défaut : compte Claude déjà connecté) ou `api-key`. En `api-key`, la clé est dans un fichier (`auth.keyFile`, défaut `<home>/api-key`, droits `0600`). Une variable d'environnement n'est qu'une source d'import : `init --api-key-env NAME` copie sa valeur dans le fichier ; `init --api-key-file <chemin>` enregistre le chemin tel quel. Le veilleur, lancé par launchd sans environnement, lit donc toujours le fichier.
- `apiKeyEnv(config)` retourne `{ ANTHROPIC_API_KEY: <clé> }` en mode `api-key`, `{}` sinon ; fichier absent ou vide → `codedError('api-key-missing', { file })`. L'adaptateur fusionne ce résultat dans l'`env` de chaque appel `claude` (launch, wake). **Un seul lecteur de la clé : `core/auth.js`.**
- Jamais affichée : aucun message, journal, `watcher.log`, plist, `session settings` ni erreur ne contient la clé ; `doctor` écrit `api-key: file found` ou `missing`, jamais la valeur ni sa longueur. Vérifier que `runClaude` ne recopie pas l'`env` dans ses erreurs.
- Tests : fichier lu et passé à l'`env` du faux `claude` (le faux la note dans un fichier) ; fichier absent → `api-key-missing` ; valeur sentinelle `sk-test-SENTINEL` absente de la sortie de `doctor`, de `init`, de `watcher.log` et des erreurs ; mode `login` ne définit pas `ANTHROPIC_API_KEY` ; fichier créé en `0600`. À vérifier à la main (essai final) : que `claude --bg` accepte la clé sans question d'approbation ; sinon `init` l'indique.

### Tâche 5 : assistant `init` et équipe type (`core/init.js`, `catalog/teams/code.json`)
Fichiers : nouveaux `core/init.js`, `catalog/teams/code.json` (`{ "name": "code", "profiles": ["lead", "developer"], "method": "code" }`, `catalog` déjà dans `files`) ; `core/cli.js` (`commands.init`) ; `core/messages.js` ; `test/init.test.js`.
- `relaylead init [--yes] [--api-key-env NAME | --api-key-file PATH]` : questions par `readline` si stdin est un terminal, sinon (ou avec `--yes`) valeurs par défaut sans poser de question, pour que les tests et le plugin l'appellent sans terminal.
- Machine (une fois, si `config.json` absent) : refuse en dessous de Node 18 ; vérifie `claude` (message `agent-missing` sinon) ; demande le mode d'authentification (`login` ou `api-key`) ; écrit `~/.relaylead/config.json` avec `{ agent, permissionMode: 'allowlist', auth }` en fusionnant sans écraser les clés existantes (`readJson`, `store.js`). Propose `relaylead install` (le lance après un « yes »).
- Projet (dossier courant, doit être un dépôt git, sinon `not-a-git-repo`) : écrit `.relaylead.json` avec `team: 'code'`, `method`, `source`, `delivery` par défaut, sans écraser un fichier existant (dit ce qu'il garde). Si Claude Code ne fait pas encore confiance au dossier, explique de lancer `claude` une fois dedans (le texte de `untrusted-dir` existe déjà ; ne pas écrire dans `~/.claude`).
- Textes : conseils d'accès (ne donner que le nécessaire, éviter les secrets) en trois lignes anglaises.
- Tests : `init --yes` dans un dépôt jouet crée les deux fichiers attendus ; relancé, ne modifie rien (contenu identique) ; clé importée d'une variable vers le fichier `0600` ; hors dépôt git → erreur codée ; `config.json` préexistant avec clé inconnue préservée.

## 3. Critère « terminé » (avec le faux agent, `npm test` vert, macOS)

1. Sous `RELAYLEAD_HOME`, `RELAYLEAD_LAUNCHD_DIR`, faux `launchctl` et faux `claude` : `init --yes` → `install` → `doctor` (tout `ok`) → lancement d'une mission avec le faux agent (`relaylead launch`) menée à la fin par `relaylead watcher run` lancé à la main, comme le ferait launchd.
2. `uninstall` : l'instantané de `LaunchAgents` et des plugins du faux `claude` est identique à celui d'avant `install`.
3. Mission en mode `api-key` terminée avec le faux agent, la clé sentinelle jamais présente dans les sorties ni les journaux.
4. Hors macOS simulé (`RELAYLEAD_PLATFORM=linux`) : `install` et `uninstall` échouent avec `platform-unsupported`.
5. À la main, une seule fois, à l'essai final avec le vrai Claude : `install` réel, commande `/relaylead:list` visible dans Claude Code, `uninstall` rend la machine intacte.

## 4. Fichiers partagés (risque de conflit)

- `core/cli.js` : ajout de `install`, `uninstall`, `doctor`, `init` dans `commands` et dans le texte d'aide ; lots 2b/3 y ajoutent aussi des commandes. Ajouter en bloc, ne pas reformater.
- `core/messages.js` : nouvelles clés en `en` uniquement, regroupées à la fin du bloc.
- `core/config.js` : une seule clé `auth` dans `DEFAULTS`.
- `adapters/claude/index.js` : seul point touché, la construction de l'`env` du lancement. Lots 2a/3 y touchent.
- `fixtures/claude/fake-claude.js` : extension (sous-commande `plugin`, note de l'`env`) ; garder les comportements existants.
- `package.json` : `files` gagne `plugin`.

## 5. Modèle conseillé

**sonnet** : le travail est mécanique et testé par des faux (plist, appels `launchctl`/`claude`, questions de l'assistant) ; la seule zone délicate, la non-divulgation de la clé, est couverte par un test à valeur sentinelle. Réserver une relecture par opus de `core/auth.js` et de l'`env` de l'adaptateur.
