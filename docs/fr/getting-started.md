<p align="right"><a href="../getting-started.md">English</a> · <strong>Français</strong></p>

# Premiers pas avec Relaylead

Cette page vous mène de zéro à une première mission fusionnée dans votre branche. Comptez une dizaine de minutes, plus le temps de la mission (une minute ou deux pour le petit exemple ci-dessous).

Si un mot vous est inconnu (mission, lead, équipier, veilleur), le [glossaire](guide.md#glossaire) en donne une ligne chacun.

## Avant de commencer

Vérifiez chaque ligne dans un terminal. Chaque commande doit afficher une version.

| Il vous faut | Vérifier avec | S'il manque |
| --- | --- | --- |
| Un Mac | `sw_vers` | Relaylead ne tourne que sous macOS pour l'instant. |
| Node.js 18 ou plus | `node --version` | Installez-le depuis [nodejs.org](https://nodejs.org), ou avec `brew install node`. |
| git | `git --version` | macOS propose de l'installer la première fois que vous lancez `git`. |
| Claude Code 2.1.325 ou plus | `claude --version` | Installez-le depuis [la documentation de Claude Code](https://code.claude.com/docs/en/overview), puis `claude update`. |
| Claude Code connecté | lancez `claude` une fois | Connectez-vous avec un abonnement Claude qui inclut Claude Code (Pro, Max, Team ou Enterprise). Une clé API Anthropic convient aussi : voir [Clé API](guide.md#clé-api). |
| Un projet sous git | `git status` dans son dossier | Lancez `git init`, puis faites un premier commit. |

`gh`, la ligne de commande GitHub, ne sert que pour prendre les tâches dans des issues GitHub. Vous pouvez vous en passer pour l'instant.

## Étape 1 : installer Relaylead

```sh
npm install -g relaylead
relaylead install
```

`npm install -g` ajoute la commande `relaylead`. `relaylead install` fait ensuite deux choses sur votre Mac :

- il enregistre un agent launchd, `dev.relaylead.watcher`, pour que le veilleur continue de tourner après un redémarrage ;
- il ajoute le plugin Relaylead à Claude Code, qui apporte la console `/relaylead`, le panneau `/pane` et quelques commandes `/relaylead:*`.

Il se termine par `relaylead doctor`, qui affiche une ligne par vérification :

```text
ok node: 24.19.0
ok claude: 2.1.330 (Claude Code)
ok git: found
ok scheduler: installed and loaded
ok plugin: relaylead@relaylead-local
ok watcher: no pass recorded yet
ok auth: login (the connected Claude account)
```

Une ligne `warn` donne la commande à lancer ; une ligne `fail` dit ce qui manque. Vous pouvez relancer `relaylead doctor` à tout moment. Avec `"language": "fr"`, ces lignes s'affichent en français.

## Étape 2 : faire confiance à votre projet dans Claude Code

Claude Code refuse d'ouvrir une session dans un dossier auquel vous n'avez pas fait confiance, et les sessions de Relaylead n'y font pas exception. Placez-vous à la racine de votre projet (le dossier qui contient `.git`) et lancez Claude Code une fois :

```sh
cd ~/code/hello-api
claude
```

Claude Code vous demande si vous faites confiance aux fichiers de ce dossier. Sélectionnez **Yes, I trust this folder** avec les flèches, puis appuyez sur Entrée.

> [!IMPORTANT]
> La réponse sélectionnée par défaut est **No, exit**. Appuyer tout de suite sur Entrée refuse, et toute mission dans ce dossier échouera ensuite au démarrage avec un message disant que Claude Code ne fait pas confiance au dossier.

Gardez cette fenêtre de Claude Code ouverte pour l'étape 3.

## Étape 3 : lancer une mission depuis Claude Code

Dans la conversation Claude Code, tapez `/relaylead` suivi de ce que vous voulez :

```text
/relaylead ajoute une route GET /health avec un test, et un fichier LICENSE
```

Vous pouvez aussi demander en toutes lettres : « utilise relaylead pour ajouter une route de santé ». La conversation devient la **console**. La première fois dans un projet, elle :

1. lance `relaylead brief` et montre ce qu'il dit (problèmes d'installation, questions ouvertes, missions) ;
2. pose les questions de mise en place : votre compte Claude ou une clé API, combien d'équipiers peuvent travailler à la fois, s'il faut tenir une mémoire de projet et s'il faut la commiter ;
3. écrit `.relaylead.json` à la racine de votre projet.

Puis elle écrit le plan avec vous, un fichier Markdown par tâche dans `tasks/`. Relisez-les, demandez des changements, puis validez. La console commite les fichiers de tâches (les équipiers partent des commits : des tâches non commitées ne leur parviendraient pas), lance la mission, puis se met à l'écoute des événements en arrière-plan. Cette écoute ne coûte rien : Claude Code ne réveille la conversation que lorsqu'il se passe quelque chose.

Vous pouvez fermer la conversation à tout moment. La mission continue, et une nouvelle conversation commence par lister ce qui s'est passé entre-temps.

## Étape 4 : répondre aux questions, puis fusionner

Quand le lead a besoin de vous, la question apparaît dans la conversation exactement telle qu'il l'a posée, avec le nom de la mission et des options numérotées, et votre Mac affiche une notification :

```text
[hello-api] q-license (nouvelle): Quelle licence pour le projet, MIT ou Apache-2.0 ?
  1. MIT (recommandée)
  2. Apache-2.0
  3. Skip this task
```

Répondez par un numéro (« 1 ») ou avec vos propres mots (« MIT, au nom de Lilia Digital ») : la console l'envoie avec `relaylead answer`. Pour une question sur une commande risquée (son identifiant commence par `q-irr-` ou `q-perm-`), la console vous demande de confirmer avant d'envoyer « Allow once » ou « Always allow ».

Pendant que la mission tourne, vous pouvez dire :

- « où en est hello-api ? » pour ses tâches et la dernière note du lead ;
- « dis au lead de hello-api d'utiliser le port 8080 » pour transmettre une consigne ;
- « arrête hello-api » pour l'arrêter (la console vous demande de confirmer une fois).

Quand la mission est terminée, la console demande **« La fusionner dans main ? »** (ou dans la branche d'où vous l'avez lancée). Si vous dites oui, elle lance `relaylead merge hello-api`. Jusque-là, votre branche n'a pas bougé : le travail attend sur la branche `relaylead/hello-api/integration`, que vous pouvez relire avec `git diff main...relaylead/hello-api/integration`.

C'est toute la boucle. La section suivante refait la même mission depuis le terminal, pour voir chaque pièce.

## Une mission complète depuis le terminal

C'est la même mission, sans Claude Code ouvert. Le projet est une toute petite API Node.js, `hello-api`, déjà sous git.

**1. Préparer le projet.** Lancez `relaylead init` à la racine du dépôt.

```sh
cd ~/code/hello-api
relaylead init
```

La première fois sur un Mac, il pose quelques questions ; appuyez sur Entrée pour garder la valeur proposée entre crochets.

| Question | Par défaut | Ce qu'elle décide |
| --- | --- | --- |
| Langue des messages | `fr` si votre `LANG` commence par `fr`, sinon `en` | La langue de tout ce qu'affiche Relaylead. |
| Authentification | `login` | `login` utilise votre compte Claude connecté ; `api-key` copie une clé depuis une variable d'environnement. |
| Lancer `relaylead install` maintenant ? | `no` | Inutile si vous l'avez déjà lancé à l'étape 1. |
| Tenir une mémoire de projet pour les leads ? | `yes` | Un court fichier de conventions et de leçons que chaque lead lit en premier. |
| Versionner la mémoire de projet avec le code ? | `no` | `yes` vous laisse la commiter ; `no` la garde hors de git. |

Il écrit `~/.relaylead/config.json` (une fois par Mac) et `.relaylead.json` (une fois par projet), puis vous rappelle l'étape de confiance et quelques conseils d'accès. `relaylead init --yes` prend toutes les valeurs par défaut sans rien demander.

**2. Écrire les tâches.** Un fichier Markdown par tâche dans `tasks/`. Le nom du fichier est l'identifiant de la tâche.

`tasks/health.md` :

```markdown
---
title: Ajouter une route de santé
---
Ajoute GET /health dans server.js. Elle renvoie 200 et {"status":"ok"}.
Couvre-la par un test dans test/health.test.js, et garde `npm test` au vert.
```

`tasks/license.md` :

```markdown
---
title: Ajouter un fichier LICENSE
ask: Quelle licence pour le projet, MIT ou Apache-2.0 ?
---
Ajoute un fichier LICENSE à la racine avec la licence choisie, pour l'année 2026.
Mentionne-la dans la section « Licence » du README.md.
```

L'en-tête entre les deux lignes `---` accepte `title`, et en option `depends` (des tâches à livrer d'abord, par exemple `depends: [health]`) et `ask` (une question que le lead vous pose avant de lancer la tâche).

**3. Commiter les tâches.** Les équipiers partent des commits.

```sh
git add tasks
git commit -m "Ajoute les tâches Relaylead"
```

**4. Lancer.**

```text
$ relaylead launch --request "Ajoute une route de santé et une licence"
hello-api
veilleur lancé : il passe sur les missions toutes les 300 s et s'arrête quand aucune n'en a besoin
```

La première ligne est le nom de la mission : celui du dossier du projet, sauf si vous passez `--name`. La commande rend la main tout de suite ; la mission tourne en arrière-plan.

**5. Suivre.**

```text
$ relaylead list
hello-api  working  hello-api/lead/1  /Users/vous/code/hello-api
```

En coulisses, le lead a lu les tâches, lancé un équipier sur `health`, et vous a posé la question de `license`, puisque cette tâche demande d'abord. Votre Mac affiche une notification. `relaylead brief` montre tout d'un coup :

```text
$ relaylead brief
Questions ouvertes (1) :
[hello-api] q-license (nouvelle): Quelle licence pour le projet, MIT ou Apache-2.0 ?
  1. MIT (recommandée)
  2. Apache-2.0
  3. Skip this task
Missions en cours :
  hello-api: working · tâches 0/2 livrées (1 running)
```

Le lead rédige lui-même ses questions : les vôtres peuvent être formulées autrement. `relaylead dashboard` ouvre la même vue dans votre navigateur, et `relaylead show hello-api` ouvre la session du lead si vous voulez voir ce qu'il fait.

**6. Répondre.**

```text
$ relaylead answer hello-api q-license 1
question q-license répondue : MIT
```

Le lead est réveillé en quelques secondes et lance un équipier sur `license`. Une réponse libre marche aussi : `relaylead answer hello-api q-license --other "MIT, au nom de Lilia Digital"`.

**7. Attendre la fin.** Chaque équipier travaille dans son worktree, lance les tests, commite et rend compte. Le lead fusionne chaque tâche finie dans `relaylead/hello-api/integration`. Quand toutes les tâches sont réglées, le lead écrit la mémoire du projet et déclare la mission terminée. Lors de notre essai, deux petites tâches ont pris environ une minute et demie, du lancement à la fin.

```text
$ relaylead list
hello-api  done  hello-api/lead/1  /Users/vous/code/hello-api
```

**8. Relire, puis fusionner.**

```sh
git log --oneline main..relaylead/hello-api/integration
git diff main...relaylead/hello-api/integration
```

```text
$ relaylead merge hello-api
mission hello-api fusionnée dans main (3f2a9c1d8e0b4a6f9c2d7e5b1a8f3c0d9e6b2a71)
```

`merge` demande que votre copie de travail n'ait aucune modification non commitée sur cette branche. Si les deux côtés sont en conflit, rien ne reste à moitié fait : un équipier résout le conflit sur sa propre branche et Relaylead fusionne de nouveau tout seul, ou vous pose la question si l'équipier n'y arrive pas.

Une fois la fusion faite, le veilleur fait le ménage : l'état de la mission dans `~/.relaylead/missions/hello-api/`, ses worktrees et ses branches de tâches disparaissent. La branche `relaylead/hello-api/integration` reste jusqu'à ce que vous la supprimiez avec `git branch -d relaylead/hello-api/integration`.

## Bien écrire ses tâches

Le lead n'invente pas de travail : il réalise les tâches que vous lui donnez. De bonnes tâches font de bonnes missions.

- **Un résultat par tâche**, assez petit pour une session : « Ajouter GET /health avec un test », pas « Améliorer l'API ».
- **Dites comment vérifier.** « Garde `npm test` au vert », « la page doit s'afficher sans erreur dans la console ». Les équipiers lancent les tests du projet avant de commiter.
- **Utilisez `depends`** quand une tâche a besoin du code d'une autre : `depends: [schema]`. La tâche ne démarre qu'une fois `schema` livrée dans la branche d'intégration.
- **Utilisez `ask`** pour un choix que vous seul pouvez faire. Le lead le pose avant que la tâche démarre, et la réponse est transmise à l'équipier.
- **Laissez les secrets de côté.** Les équipiers ne peuvent pas ouvrir les fichiers `.env`, et ne devraient pas en avoir besoin.

## Et ensuite

- Faites tourner deux missions côte à côte : `relaylead launch --name backend --tasks tasks/backend`, puis `relaylead launch --name frontend --tasks tasks/frontend`. Voir [Commandes](guide.md#relaylead-launch).
- Prenez les tâches dans des issues GitHub et livrez par pull request : voir [Sources](guide.md#sources).
- Lisez [Sécurité](safety.md) avant de lancer Relaylead sur du code ou des issues que vous ne maîtrisez pas.
- Voyez où passe l'argent dans [Coûts](costs.md), et les réponses aux problèmes courants dans la [FAQ](faq.md).
