<p align="right"><a href="../guide.md">English</a> · <strong>Français</strong></p>

# Guide de Relaylead

La référence de Relaylead 0.4 : son vocabulaire, chaque commande et chaque option, chaque réglage. Vous découvrez Relaylead ? Commencez par [Premiers pas](getting-started.md), puis revenez ici quand vous avez besoin d'un détail.

Relaylead ne tourne que sous macOS pour l'instant. `relaylead help` liste les commandes, et `relaylead help <commande>` (ou `relaylead <commande> --help`) en explique une. Les commandes et les options restent en anglais ; avec `"language": "fr"`, tout ce qu'elles affichent est en français.

## Sommaire

1. [Glossaire](#glossaire)
2. [Déroulement d'une mission](#déroulement-dune-mission)
3. [La console dans Claude Code](#la-console-dans-claude-code)
4. [Configuration](#configuration)
5. [Affichages](#affichages)
6. [Commandes](#commandes)
7. [Fichiers et dossiers](#fichiers-et-dossiers)
8. [Journaux et diagnostic](#journaux-et-diagnostic)
9. [Désinstaller](#désinstaller)

## Glossaire

Relaylead n'emploie que ces termes. Le nom anglais, utilisé dans les commandes et la documentation anglaise, est entre parenthèses.

| Terme | Sens |
| --- | --- |
| **Mission** (*mission*) | Un travail confié à une équipe sur un projet, avec un nom (celui du dossier du projet, sauf si vous passez `--name`). Son état est rangé dans `~/.relaylead/missions/<mission>/`. |
| **Lead** (*lead*) | La session Claude Code qui mène une mission. Elle lit les tâches, lance les équipiers, livre leur travail, vous pose des questions et déclare la mission terminée. Elle ne touche jamais au code et ne lance que des commandes `relaylead`. |
| **Équipier** (*crew member*) | Une session Claude Code éphémère qui réalise une tâche, dans son propre worktree git et sur sa propre branche, puis rend compte avec `relaylead task done` ou `task fail`. |
| **Veilleur** (*watcher*) | Une petite boucle sans IA. Elle relance un lead arrêté, réveille celui qui a du nouveau, passe la main à un lead neuf quand le contexte se remplit, et lance les tâches en file d'attente. launchd la maintient en vie. |
| **Tâche** (*task*) | Une unité de travail : un fichier Markdown dans `tasks/`, ou une issue GitHub. Elle a un identifiant, un titre, un corps, un état, et en option des dépendances (`depends`) et une question à régler d'abord (`ask`). |
| **Branche d'intégration** (*integration branch*) | `relaylead/<mission>/integration` : la branche propre à la mission, où chaque tâche finie est fusionnée. Votre branche ne reçoit le travail que lorsque vous lancez `relaylead merge`. |
| **Console** (*console*) | Une conversation Claude Code ouverte avec `/relaylead`, qui sert à écrire, lancer, suivre et piloter les missions. |
| **Question** (*question*) | Ce que le lead ou un garde-fou vous demande, avec des options numérotées. Elle attend votre réponse. |
| **Livraison** (*delivery*) | La façon dont une tâche finie rejoint la branche d'intégration : une fusion locale (par défaut), une pull request GitHub, ou des fichiers dans un dossier. |
| **Mémoire de projet** (*project memory*) | `.relaylead/memory.md` : un court fichier de conventions et de leçons que chaque lead lit en premier et compacte avant de finir. |

## Déroulement d'une mission

[Fonctionnement](how-it-works.md) raconte la même histoire en schémas.

1. **Lancement.** `relaylead launch` (ou la console) crée la mission, sa branche d'intégration et son worktree, lance le lead en arrière-plan, et lance le veilleur.
2. **Plan.** Le lead liste les tâches. Une tâche est *prête* quand elle est à faire et que toutes celles dont elle dépend sont livrées.
3. **Travail.** Pour chaque tâche prête, le lead lance un équipier, dans la limite de `parallel` par mission (4) et de `maxSessions` sur la machine (4, leads non compris). Une tâche qui ne trouve pas de place libre est mise *en file d'attente* et démarre dès qu'une place se libère, la plus prioritaire d'abord.
4. **Question.** Une tâche avec `ask` attend que vous ayez répondu à sa question. « Skip this task » la met de côté.
5. **Livraison.** Un équipier commite sur sa branche et rend compte `done`. Le lead livre la tâche : elle est fusionnée dans la branche d'intégration, et les tâches qui en dépendent deviennent prêtes. Une tâche en échec peut être relancée, sur la même branche, jusqu'à `maxAttempts` essais (2).
6. **Fin.** Quand chaque tâche est livrée, en échec et signalée, ou mise de côté, le lead compacte la mémoire du projet et déclare la mission `done`. Ses sessions sont arrêtées.
7. **Fusion.** Vous lancez `relaylead merge <mission>` (ou dites oui dans la console). Le veilleur retire ensuite l'état de la mission, ses worktrees et ses branches de tâches.

**États d'une mission :** `starting`, `working`, `waiting` (elle vous attend), `handover` (un lead neuf prend le relais), `done`, `stopped`. `relaylead list` peut ajouter `(n queued)`, `usage-pause (resume …)` ou `(abandoned)`.

**États d'une tâche :** `todo`, `queued`, `running`, `done` (finie, pas encore livrée), `failed`, `delivered`.

### Fin d'une mission

Une mission se termine quand son lead la déclare finie ou quand vous l'arrêtez. Fermer Claude Code ne change rien. Une fois terminée, ses sessions sont arrêtées et retirées de la liste `claude agents`, et le travail reste sur `relaylead/<mission>/integration` jusqu'à ce que vous le fusionniez.

- **`relaylead merge <mission>`** fusionne la branche d'intégration dans la branche d'où la mission a été lancée (ou `main`, ou `master`). La fusion se fait là où cette branche est extraite (votre copie de travail, qui ne doit avoir aucune modification non commitée), ou sinon dans un worktree à part, retiré ensuite. Avec `github-pr`, elle ouvre une pull request depuis la branche d'intégration et la fusionne sur GitHub, ferme les issues des tâches livrées, et supprime la branche d'intégration distante. Si votre branche locale est ensuite en retard sur la distante, elle vous le dit. Elle ne fait jamais de pull à votre place.
- **En cas de conflit**, la fusion est annulée et rien ne reste à moitié fait. Un équipier reçoit la tâche `merge-into-<branche>` : sur une branche issue de la branche d'intégration, il y fusionne votre branche (il voit ainsi les deux côtés), résout les conflits, lance les tests et commite. Le veilleur la livre puis relance la fusion tout seul. Si l'équipier échoue, vous recevez une question : *Resolve it here with me* (la console vous guide dans le worktree d'intégration, puis relance `relaylead merge`), *Relaunch a crew member with hints* (envoyez d'abord vos indications avec `relaylead tell`), ou *Pause the mission* (relancez `relaylead merge` quand vous voulez).
- **Ménage.** Une fois la branche d'intégration fusionnée dans sa branche (par `relaylead merge` ou par vous) ou supprimée, le veilleur retire la mission comme le ferait `relaylead remove` : son état, ses worktrees et branches de tâches, et son worktree d'intégration s'il est propre. La branche d'intégration elle-même reste : supprimez-la avec `git branch -d`. Une mission qui n'a rien livré est gardée : retirez-la vous-même.
- **Missions abandonnées.** Une mission qui attend une réponse alors que rien n'a bougé depuis `abandonDays` jours (7) reçoit une notification, et `relaylead list` et `relaylead doctor` la signalent. Rien n'est arrêté ni supprimé.

### Questions

Relaylead vous demande avant tout geste irréversible et avant toute commande hors de la liste autorisée d'une session. Chaque nouvelle question affiche une notification macOS. Ces questions vous attendent toujours : personne n'y répond à votre place.

Une question que le lead pose de lui-même (une tâche avec `ask`, une livraison ratée) suit le réglage `questions.onTimeout` : `wait` (par défaut) vous attend, `recommended` choisit l'option recommandée et `skip` choisit « Skip this task », au bout de `questions.timeoutMinutes` (60).

Répondez par le numéro d'une option (les options sont numérotées à partir de 1, la recommandée en premier), par son texte, ou par un texte libre (`--other`), sauf pour les questions sur un geste irréversible ou une permission (identifiants `q-irr-…` et `q-perm-…`), qui n'acceptent qu'une option. Vous seul pouvez répondre : les commandes qui répondent refusent de tourner dans une session de mission. [Sécurité](safety.md#ce-que-les-garde-fous-narrêtent-pas) explique la limite de cette règle.

### Limite d'usage et pause automatique

Relaylead lit votre usage Claude (fenêtres de 5 heures et de 7 jours) dans ce que Claude Code transmet aux sessions. Quand une mission atteint le seuil de sa priorité, ou quand Claude signale une limite d'usage, le veilleur met la mission en pause : ses sessions sont arrêtées et rien n'est relancé. Elle reprend toute seule à l'heure de réinitialisation (ou au bout de 15, 30, puis 60 minutes si aucune heure n'est donnée). `relaylead list` et `show` affichent `usage-pause (resume …)`, et `task start` et `task retry` sont refusés en attendant. Les questions vous sont toujours notifiées pendant une pause.

Seuils en pourcentage, par priorité :

| Priorité | Fenêtre de 7 jours | Fenêtre de 5 heures |
| --- | --- | --- |
| `low` | 70 | 80 |
| `normal` | 90 | 85 |
| `high` | 98 | 85 |

### Contexte et relève

Les sessions ont un contexte limité. Un lead qui dépasse son seuil finit son étape, écrit où en est la mission, et le veilleur lance un lead neuf qui repart des fichiers. Un équipier dont le contexte est plein commite, met sa tâche en échec avec « context full », et le lead la relance sur la même branche. Les seuils sont dans le réglage [`context`](#seuils-de-contexte).

## La console dans Claude Code

Après `relaylead install`, tapez `/relaylead` dans Claude Code, ou demandez-le (« utilise relaylead pour ajouter une route de santé »). Le skill `relaylead` du plugin transforme la conversation en console :

- elle s'ouvre sur `relaylead brief` : problèmes d'installation, nouveautés, chaque question ouverte telle qu'elle a été posée, les missions en cours ;
- sans `.relaylead.json`, elle pose les questions d'`init` dans la conversation et écrit les fichiers ; ensuite, vous pouvez demander des changements en clair (« limite à 2 équipiers ici ») ;
- elle écrit les tâches avec vous, les commite, lance la mission, puis attend les événements en arrière-plan (`relaylead wait --all`) : Claude Code réveille la conversation quand il se passe quelque chose, et rien n'est dépensé entre-temps ;
- chaque question est montrée telle quelle, avec le nom de la mission et les options numérotées ; votre choix repart avec `relaylead answer`, et elle vous demande de confirmer avant d'envoyer « Allow once » ou « Always allow » pour une commande risquée ;
- « dis au lead de X de … » devient `relaylead tell` ; « où en est X ? » lit l'état de la mission ;
- quand une autre mission tourne déjà sur la machine, elle demande la priorité de la nouvelle, et prévient quand deux missions touchent les mêmes fichiers ;
- quand une mission est terminée, elle demande « La fusionner dans main ? » et ne lance `relaylead merge` que si vous dites oui ;
- une nouvelle conversation commence par lister chaque question ouverte et les missions en cours, y compris ce qui s'est passé pendant qu'aucune console n'était ouverte. Les questions posées entre-temps ne sont jamais perdues : le veilleur envoie toujours la notification Mac, et les questions restent ouvertes jusqu'à votre réponse.

La console est une conversation Claude : chaque échange consomme des jetons. Servez-vous-en pour décider (écrire une mission, répondre, fusionner), et de `relaylead brief`, de la page web ou de la ligne d'état pour regarder. Voir [Coûts](costs.md#la-console-face-à-brief-et-à-la-page-web).

Le plugin ajoute aussi `/pane` et ces commandes, qui lancent chacune une commande `relaylead` : `/relaylead:launch`, `/relaylead:list`, `/relaylead:show`, `/relaylead:answer`, `/relaylead:stop`, `/relaylead:init`, `/relaylead:doctor`.

## Configuration

Les réglages viennent de trois niveaux, chacun l'emportant sur le précédent :

1. les valeurs par défaut ;
2. le fichier de la machine `~/.relaylead/config.json` (ou `$RELAYLEAD_HOME/config.json`) ;
3. le fichier du projet `.relaylead.json`, à la racine du projet.

Les objets sont fusionnés clé par clé ; les listes et les valeurs simples sont remplacées. `maxSessions`, `watcher` et `auth` ne sont lus que dans le fichier de la machine. Une mission fige sa configuration au lancement : un changement s'applique au lancement suivant. `relaylead doctor` signale les clés inconnues et les valeurs fausses.

| Réglage | Par défaut | Sens |
| --- | --- | --- |
| `language` | `en` | Langue des messages : `en` ou `fr`. `init` propose `fr` quand votre `LANG` commence par `fr`. |
| `parallel` | `4` | Tâches d'une même mission en cours en même temps. |
| `maxSessions` | `4` | Équipiers au travail en même temps sur la machine, toutes missions confondues ; les leads ne comptent pas. Fichier de la machine seulement. |
| `priority` | `normal` | Priorité par défaut d'une mission (`high`, `normal`, `low`) : ses seuils d'usage et son rang dans la file d'attente. |
| `maxAttempts` | `2` | Essais par tâche. |
| `abandonDays` | `7` | Jours sans activité, une question ouverte, avant qu'une mission soit signalée abandonnée. |
| `permissionMode` | `allowlist` | `allowlist` : les sessions ne lancent que les commandes de leur profil, et le reste devient une question. `all` : rien n'est bloqué, sauf par les garde-fous. |
| `source` | `{"type":"tasks-dir","dir":"tasks"}` | D'où viennent les tâches. Voir [Sources](#sources). |
| `delivery` | `{"type":"local-merge","runHooks":true}` | Comment les tâches sont livrées. Voir [Livraisons](#livraisons). |
| `guard` | voir [Garde-fous](#garde-fous) | Branches protégées, fichiers secrets, commandes autorisées en plus. |
| `questions` | `{"onTimeout":"wait","timeoutMinutes":60}` | Ce que deviennent les questions du lead restées sans réponse. Voir [Questions](#questions). |
| `usage` | voir [plus haut](#limite-dusage-et-pause-automatique) | Seuils de pause par priorité, et `retryMinutes` (`[15, 30, 60]`). |
| `context` | voir [Seuils de contexte](#seuils-de-contexte) | Quand une session passe la main. |
| `memory` | `{"enabled":true,"maxLines":200,"maxBytes":16384,"versioned":false}` | La mémoire de projet. Voir [Mémoire](#mémoire). |
| `display` | `{"pane":null,"statusLine":true,"dashboardPort":4317}` | Le panneau, la ligne d'état, le port de la page web. Voir [Affichages](#affichages). |
| `watcher` | `{"autoStart":true,"helpers":true,"everySeconds":300}` | Le veilleur. Fichier de la machine seulement. Voir [Le veilleur](#le-veilleur). |
| `auth` | `{"mode":"login","keyFile":null}` | Comment les sessions se connectent. Fichier de la machine seulement. Voir [Clé API](#clé-api). |
| `attribution` | `null` | Transmis tel quel au réglage `attribution` de Claude Code pour chaque session (ce que Claude Code ajoute à ses commits). `null` garde le comportement par défaut de Claude Code. |
| `agent`, `method`, `team` | `claude`, `code`, `code` | L'agent, la méthode du lead et l'équipe. Seules ces valeurs intégrées existent aujourd'hui. |

Un `.relaylead.json` typique, écrit par `init` puis retouché :

```json
{
  "team": "code",
  "method": "code",
  "source": { "type": "tasks-dir", "dir": "tasks" },
  "delivery": { "type": "local-merge", "runHooks": true },
  "memory": { "enabled": true, "versioned": false },
  "parallel": 2
}
```

**Faut-il commiter `.relaylead.json` ?** Il ne contient aucun secret (la clé API, s'il y en a une, est rangée dans `~/.relaylead/`). Commitez-le quand les réglages appartiennent au projet et que votre équipe doit les partager. Laissez-le hors de git quand ils ne concernent que vous ; Relaylead fonctionne de la même façon dans les deux cas.

### Sources

**`tasks-dir`** (par défaut) : chaque fichier `*.md` du dossier est une tâche, et son nom sans `.md` est son identifiant. Le dossier de tâches doit être commité : les équipiers partent des commits. L'en-tête facultatif, entre deux lignes `---`, comprend :

- `title` : le titre de la tâche (l'identifiant s'il manque) ;
- `depends` : les identifiants d'autres tâches, par exemple `depends: [schema, api]` ; la tâche est prête une fois toutes livrées ;
- `ask` : une question à régler avant que la tâche démarre. Le lead la pose, propose les choix qu'elle nomme plus « Skip this task », et lance la tâche une fois votre réponse reçue. Votre réponse est transmise à l'équipier.

Quand une tâche est livrée, une ligne `state: done` est écrite dans son fichier sur la branche d'intégration (commit `chore(relaylead): deliver <id>`).

Les identifiants de tâches entrent dans des noms de branches : utilisez des lettres, des chiffres, `.`, `_` et `-`.

**`github-issues`** : chaque issue qui porte le label (`relaylead` par défaut) est une tâche nommée `issue-<n>`. Une issue ouverte est à faire, une issue fermée est faite. Les issues n'ont pas de dépendances et ne posent pas de question. `repo` (`propriétaire/nom`) est facultatif : sans lui, `gh` prend le dépôt de votre dossier. Il faut `gh`, connecté.

```json
{
  "source": { "type": "github-issues", "label": "relaylead" },
  "delivery": { "type": "github-pr" }
}
```

> [!WARNING]
> Le texte d'une issue devient la consigne d'un équipier. Quiconque peut ouvrir ou modifier une issue portant le label peut orienter une session sur votre Mac. Lisez d'abord [Sécurité](safety.md#les-issues-écrites-par-dautres).

### Livraisons

- **`local-merge`** (par défaut) : chaque tâche finie est fusionnée dans la branche d'intégration de la mission, `relaylead/<mission>/integration`. Rien ne quitte votre machine.
- **`github-pr`** : prévue pour la source `github-issues`. La branche d'une tâche finie est poussée sur le dépôt distant (`origin`, ou `delivery.remote`), une pull request vers la branche d'intégration est ouverte et fusionnée aussitôt, la branche de la tâche est supprimée sur le distant, et la branche d'intégration locale suit. Aucune relecture n'est attendue : relisez la branche d'intégration avant de la fusionner dans la vôtre. L'issue est fermée par `relaylead merge` (ou par le ménage d'une mission que vous avez fusionnée à la main), pas à la livraison ; d'ici là, une seconde mission avec le même label la reprendrait. La branche d'intégration doit pouvoir être poussée.
- **`files`** : pas besoin de git. Chaque tâche écrit son résultat dans `out/<mission>/<id de la tâche>/` dans le dossier du projet, et c'est le seul endroit où l'équipier peut écrire.

Les commits de Relaylead lancent vos hooks git (avec `LC_ALL=C`), dans le worktree d'intégration, où aucune dépendance n'est installée : un hook qui a besoin de `node_modules` (husky, commitlint, lint-staged) y échoue. Ces projets règlent `"delivery": {"runHooks": false}`, ou livrent une tâche avec `relaylead task deliver <id> --no-hooks --mission <mission>`.

### Garde-fous

```json
{
  "guard": {
    "protectedBranches": ["main", "master"],
    "secrets": [".env", ".env.*"],
    "secretExceptions": [".env.example", ".env.sample", ".env.template"],
    "allow": []
  }
}
```

- `protectedBranches` : une session ne peut ni pousser vers ces branches ni y commiter.
- `secrets` (des motifs, `*` remplace n'importe quels caractères) : ces fichiers ne peuvent être ni lus ni écrits, sauf `secretExceptions`.
- `allow` ajoute des commandes à la liste autorisée des équipiers, dans la syntaxe de permission de Claude Code, par exemple `["Bash(npm ci)"]`.

En plus de ces réglages, chaque session est confinée : les outils `Write`, `Edit` et `NotebookEdit` de Claude Code sont refusés hors du dossier de la session (son worktree, ou `out/<mission>/<id>/` avec la livraison `files` ; le dossier temporaire de Claude Code est la seule exception), et `Read`, `Grep` et `Glob` sont refusés sur les dossiers d'identifiants comme `~/.ssh`, `~/.aws`, `~/.config/gh` et les trousseaux, sur la configuration et le fichier de clé de Relaylead, et sur les autres missions. Les chemins sont résolus d'abord : un lien symbolique ne contourne pas la règle. [Sécurité](safety.md) donne la liste complète, et ce que les garde-fous ne couvrent pas.

En mode `allowlist`, le profil développeur ne peut installer les dépendances qu'avec `npm ci --ignore-scripts` ou `npm install --ignore-scripts`, parce que les scripts d'installation exécutent du code tiers. Un projet qui en a besoin ajoute, en connaissance de cause, `"guard": {"allow": ["Bash(npm ci)"]}`. Le mode `all` autorise `npm ci` et lance ces scripts.

### Mémoire

Chaque projet a une mémoire partagée par ses missions : `.relaylead/memory.md` à la racine du dépôt principal (jamais dans un worktree). Elle contient les conventions du projet, une ligne par mission passée et les leçons apprises. Chaque lead la lit au démarrage (`relaylead memory show`), et la compacte avant de déclarer sa mission terminée : la mission devient une ligne, les leçons sont fusionnées, ce qui est périmé disparaît. `state set done` est refusé tant que la mémoire n'est pas écrite (`--no-memory` est l'échappatoire quand elle ne peut pas l'être). La version précédente est gardée dans `.relaylead/memory-archive/`, qui n'est jamais relu. Les écritures se font sous verrou : deux missions ne s'écrasent jamais.

Les projets préparés avant la 0.4 ont `.relaylead/memoire.md` et `.relaylead/memoire-archive/`. Relaylead continue de s'en servir tant que `memory.md` n'existe pas (si les deux existent, `memory.md` l'emporte) ; rien n'est renommé à votre place, et les règles d'exclusion de git couvrent les deux noms. Pour changer, renommez le fichier vous-même quand aucune mission du projet ne tourne (avec `git mv` si vous la versionnez).

- `memory.enabled` (`true`) : `false` désactive la mémoire.
- `memory.maxLines` (`200`, de 1 à 1000) et `memory.maxBytes` (`16384`, de 1024 à 65536) : les plafonds. Une mémoire qui dépasse l'un d'eux est signalée au démarrage d'un lead (il doit la compacter d'abord), `relaylead doctor` le signale, `memory show` n'affiche que le début qui tient, et une compaction au-dessus du plafond est refusée.
- `memory.versioned` (`false`) : par défaut, la mémoire reste hors de git grâce à `.git/info/exclude` (votre `.gitignore` n'est pas touché). Avec `true`, elle reste visible de git et vous la commitez avec le code : l'exclusion devient `.relaylead/*`, `!.relaylead/memory.md` et `!.relaylead/memoire.md`, et l'archive reste exclue.

`relaylead init` pose les deux questions (tenir une mémoire ; la versionner). `--yes` prend les valeurs par défaut, `--no-memory` et `--versioned-memory` y répondent.

La mémoire d'une mission (ses décisions et les messages que vous lui avez transmis) est rangée dans le dossier de la mission et supprimée avec lui.

### Seuils de contexte

`context.budgets` fixe combien de jetons une session peut ajouter à son premier contexte mesuré, par rôle (`lead` : 150000, `crew` : 250000). `context.capPercent` (40) plafonne ce seuil à une part de la fenêtre mesurée, et `context.hardPercent` (20) est la marge au-delà de laquelle la relève est forcée. Par exemple, `{"context": {"budgets": {"lead": 60000}}}` fait passer la main au lead plus tôt.

### Le veilleur

- `watcher.autoStart` (`true`) : `relaylead launch` lance la boucle.
- `watcher.helpers` (`true`) : de courts passages ciblés juste après un événement d'une mission (une réponse, une tâche finie), pour que le lead soit réveillé en quelques secondes.
- `watcher.everySeconds` (`300`) : le temps entre deux passages de la boucle.
- Un fichier vide `~/.relaylead/STOP` met le veilleur au repos jusqu'à ce que vous le supprimiez.

Après 3 relances ratées d'un lead à la suite, ou tout de suite quand une session signale une erreur de facturation ou d'authentification, le veilleur arrête la mission, dit pourquoi et vous prévient.

### Clé API

Par défaut, les sessions se connectent avec votre compte Claude (`auth.mode` : `login`). Pour utiliser plutôt une clé API Anthropic :

```sh
relaylead init --api-key-env ANTHROPIC_API_KEY   # copie la valeur de cette variable dans ~/.relaylead/api-key
relaylead init --api-key-file ~/keys/anthropic   # ou désigne un fichier que vous gardez vous-même
```

Le fichier de clé n'est lisible que par vous. La clé n'est jamais affichée, ni écrite dans la configuration, un journal ou le fichier launchd. Chaque session la reçoit par le réglage `apiKeyHelper` de Claude Code, dans les réglages que Relaylead passe à cette session seulement : une petite commande lit le fichier quand Claude Code le demande, et rien n'est à approuver. Claude Code préfère alors cette clé à votre compte connecté, et une variable `ANTHROPIC_API_KEY` de votre shell n'est pas transmise aux sessions.

`relaylead doctor` demande à Claude Code quel identifiant il utiliserait (`ok api-key-use`). Pour vérifier une session en cours, ouvrez-la avec `relaylead show <mission>` et lancez `/status` : il doit citer `apiKeyHelper`, et non votre compte Claude.

### Variables d'environnement

- `RELAYLEAD_HOME` : où Relaylead range son état, `~/.relaylead` par défaut.
- `RELAYLEAD_CLAUDE` : le chemin de l'exécutable `claude`, s'il n'est pas dans votre `PATH`.

## Affichages

Trois vues montrent la même chose, lue dans les fichiers de `~/.relaylead` : chaque mission de la machine avec son état et sa priorité, ses tâches, les questions qui vous attendent (avec leurs options) et l'usage de votre compte sur 5 heures et 7 jours. Aucune n'appelle de modèle.

- **Entrée de la ligne d'état.** Dans Claude Code, le plugin ajoute une ligne comme `relaylead · 2 missions · ❓1 · quota 5 h 62 %`. Elle n'apparaît que lorsqu'une mission tourne ou qu'une question attend. Votre propre réglage `statusLine` n'est jamais touché. Désactivez-la avec `relaylead config set display.statusLine false`.
- **Panneau.** Un panneau à côté de la conversation : une carte par mission (les questions d'abord, puis les tâches), un bouton par option, un champ pour une réponse libre (sauf pour les questions de permission et de geste irréversible), et l'usage. Il se met à jour toutes les 5 secondes. La première fois qu'une mission tourne, Claude Code demande *Always / This time / Never* ; le choix est gardé dans `display.pane`, ou réglez-le avec `relaylead config set display.pane always`. **`/pane`** l'ouvre ou le ferme à tout moment. Dans un terminal, l'ouverture automatique demande une fenêtre d'environ 144 colonnes ; `/pane` l'ouvre quelle que soit la largeur.
- **Page web locale.** `relaylead dashboard` sert une page sur `127.0.0.1` seulement (port `display.dashboardPort`, 4317 ; `--port` pour un lancement, `--no-open` pour ne pas ouvrir le navigateur), l'ouvre, et la met à jour toute seule. Elle fonctionne Claude Code fermé. Vous pouvez y répondre à une question (une option, ou un texte libre) et arrêter une mission. Chaque lancement crée un jeton aléatoire que porte la page, et les requêtes avec un autre Host ou une autre Origin sont refusées : aucun autre site ouvert dans votre navigateur ne peut agir sur vos missions. N'importe quel programme de votre Mac peut en revanche lire la page, jeton compris : voir [Sécurité](safety.md#la-page-web-locale). Arrêtez le serveur avec Ctrl-C.

Le panneau et la ligne d'état demandent une version de Claude Code qui accepte les mods de plugin ; sans elle, Relaylead fonctionne pareil, sans ces deux vues. `relaylead overview --json` affiche ce qu'elles lisent, pour vos propres scripts.

## Commandes

Lancez-les depuis la racine de votre projet, sauf mention contraire. Le nom d'une mission est celui qu'a affiché `launch` (voir `relaylead list`). Les commandes marquées *pour les sessions* servent au lead et aux équipiers ; vous en aurez rarement besoin.

### `relaylead help [command]`

Liste les commandes, ou en explique une : `relaylead help merge`. `relaylead <commande> --help` fait de même. `relaylead --version` affiche la version.

### `relaylead launch`

Lance une mission avec un lead et son équipe, affiche son nom, et rend la main tout de suite.

- `--request <texte>` : ce que vous voulez, en une ligne.
- `--name <nom>` : le nom de la mission (celui du dossier par défaut). Les noms sont uniques sur la machine : donnez un autre nom à une seconde mission dans le même dossier.
- `--tasks <dossier>` : le dossier de tâches de la mission, dans le projet (`source.dir`, `tasks` par défaut).
- `--priority <valeur>` : `high`, `normal` (par défaut) ou `low`. Changez-la plus tard avec `relaylead priority`.
- `--dir <chemin>` : le dossier du projet (le dossier courant par défaut).
- `--team <nom>` et `--agent <nom>` : l'équipe et l'agent (`code` et `claude`, les seuls intégrés).
- `--force` : lancer même si une mission terminée de ce projet, pas encore fusionnée, a pris ses tâches à la même source (voir plus bas).

Plusieurs missions d'un même projet tournent côte à côte, chacune avec sa branche d'intégration et ses worktrees ; leurs opérations git sur le dépôt passent à tour de rôle. Chaque mission a besoin de ses propres tâches :

```sh
relaylead launch --name backend --tasks tasks/backend --request "Construis l'API"
relaylead launch --name frontend --tasks tasks/frontend --request "Construis les pages"
```

`launch` refuse :

- quand le dossier de tâches manque, ne contient aucun fichier `.md`, ou a des modifications non commitées ; le message dit lequel, avec un exemple de tâche ;
- tant qu'une mission du même projet, pas encore terminée, prend ses tâches à la même source (le même dossier, ou le même label GitHub) ;
- quand une mission du même projet, terminée mais pas fusionnée, avait la même source, puisque la nouvelle referait les mêmes tâches : fusionnez-la (`relaylead merge <m>`), retirez-la (`relaylead remove <m>`), ou passez `--force`. Cela ne vaut pas pour la livraison `files`, qui n'a rien à fusionner ;
- tant que la fusion d'une telle mission n'est pas finie (un équipier résout un conflit, ou une question attend) : attendez-la (voir `relaylead brief`), ou passez `--force`.

Par exemple, sans dossier de tâches, avec `"language": "fr"` :

```text
$ relaylead launch --request "Réalise les tâches"
relaylead launch: il n'y a pas de dossier de tâches « tasks » dans ce projet. Créez-le avec un fichier par tâche, par exemple tasks/hello.md :
  ---
  title: Dire bonjour
  ---
  Créer hello.txt qui dit bonjour.
puis commitez-le (git add tasks && git commit -m "tâches") : les équipiers travaillent à partir des commits
```

Un lancement qui échoue retire la branche et le worktree d'intégration qu'il a créés. `launch` lance aussi la boucle du veilleur, sauf si `watcher.autoStart` vaut `false`.

### `relaylead list`

Une ligne par mission : nom, état, session du lead, dossier. L'état peut indiquer `(n queued)`, `usage-pause (resume …)` ou `(abandoned)`. Une mission dont les fichiers sont illisibles apparaît comme `unreadable`, avec son chemin, et les autres s'affichent quand même.

### `relaylead brief`

Ce que la console montre à l'ouverture d'une conversation, en un texte court : les problèmes d'installation (seulement s'il y en a), ce qui s'est passé depuis le dernier coup d'œil, chaque question ouverte en entier (missions terminées comprises), une ligne par mission en cours, et une section *Terminées, pas encore fusionnées* avec la commande à lancer pour chaque mission qui peut être fusionnée. « Rien de nouveau. » ne s'affiche que s'il n'y a ni nouveauté ni question nouvelle. Il n'appelle aucun modèle.

```text
$ relaylead brief
Rien de nouveau.
Aucune question ouverte.
Aucune mission en cours.
Terminées, pas encore fusionnées :
  hello-api : relaylead merge hello-api
```

### `relaylead answer <mission> <id> <choice>`

Répond à une question par le numéro ou le texte d'une option. `--other "<texte>"` donne une réponse libre à la place (pas pour les questions `q-irr-…` et `q-perm-…`). Le lead est réveillé en quelques secondes.

```sh
relaylead answer hello-api q-license 1
relaylead answer hello-api q-license --other "MIT, au nom de Lilia Digital"
```

### `relaylead question list [<mission>] [--all]`

Les questions ouvertes en JSON (toutes avec `--all`), chacune avec son identifiant, son texte, ses options numérotées et la recommandée. Une mission inconnue est une erreur. `question ask` est *pour les sessions* : c'est ainsi que le lead vous pose une question.

### `relaylead tell <mission> <text>`

Transmet quelque chose au lead : un changement de plan, une contrainte. Le message est gardé dans la mission et le lead est réveillé en quelques secondes ; il le lit dans la sortie de son prochain `relaylead wait`. Refusé pour une mission terminée ou arrêtée.

```sh
relaylead tell hello-api "Utilise le port 8080, pas 3000"
```

### `relaylead merge <mission>`

Fusionne une mission terminée dans la branche d'où elle a été lancée. Jamais lancé par Relaylead de lui-même. Affiche le commit de fusion (ou la pull request), ou le conflit et la tâche qui le résout. Voir [Fin d'une mission](#fin-dune-mission).

### `relaylead priority <mission> <high|normal|low>`

Change la priorité d'une mission, même en cours : ses seuils d'usage et son rang dans la file d'attente.

### `relaylead show <mission>`

Ouvre la session du lead dans Claude Code, pour la lire et y écrire. Une mission terminée n'a plus de session :

```text
$ relaylead show hello-api
la mission hello-api est done : il n'y a plus de session à ouvrir ; pour relire son travail, utilisez claude --resume
```

### `relaylead stop <mission>`

Arrête la mission et toutes ses sessions. Les worktrees de tâches propres sont retirés (fichiers ignorés compris, comme `node_modules`) ; leurs branches restent. Un worktree avec des modifications non commitées, ou dont la session tourne encore, est gardé et signalé.

### `relaylead remove <mission> [--force]`

Retire une mission finie (terminée ou arrêtée) : ses worktrees de tâches, ses branches de tâches `relaylead/<mission>/…` et son état. Ses sessions sont retirées de la liste `claude agents` (leurs conversations restent dans `claude --resume`). La branche d'intégration et son worktree restent, avec le travail livré. Avant de supprimer quoi que ce soit, la commande refuse une branche de tâche avec des commits non livrés et un worktree de tâche avec des modifications non commitées, et les nomme. `--force` les supprime quand même et affiche chaque branche supprimée avec son dernier commit, pour pouvoir la recréer avec `git branch <nom> <commit>`.

### `relaylead dashboard [--port n] [--no-open]`

Sert la page web locale décrite dans [Affichages](#affichages) jusqu'à Ctrl-C.

### `relaylead overview --json`

Toutes les missions de la machine en JSON : nom, dossier, priorité, état, pause, tâches, questions ouvertes avec leurs options, usage du compte et réglages d'affichage. N'écrit rien et n'utilise pas le réseau.

### `relaylead config set <key> <value>`

Écrit un réglage d'affichage dans `~/.relaylead/config.json` : `display.pane` (`always` ou `never`), `display.statusLine` (`true` ou `false`), `display.dashboardPort` (de 1 à 65535). Les autres réglages se modifient dans les fichiers.

### `relaylead init [--yes] [--api-key-env NAME] [--api-key-file PATH] [--no-memory] [--versioned-memory]`

Prépare la machine une fois (`~/.relaylead/config.json`), puis le projet courant (`.relaylead.json`, jamais écrasé). Elle doit tourner à la racine d'un dépôt git. Dans un terminal, elle pose quelques questions : la langue (`fr` proposé quand `LANG` commence par `fr`, demandée tant que les réglages de la machine n'ont pas de langue), votre compte Claude ou une clé API, s'il faut lancer `install`, s'il faut tenir une mémoire de projet et s'il faut la versionner. Avec `--yes`, ou sans terminal, elle prend les valeurs par défaut, et écrit quand même la langue. Tant qu'`install` n'a pas tourné, elle se termine par les étapes suivantes : écrire vos tâches dans `tasks/` et les commiter, puis `relaylead install` et `relaylead doctor`. [Premiers pas](getting-started.md#une-mission-complète-depuis-le-terminal) montre un passage complet.

### `relaylead install`

Enregistre l'agent launchd du veilleur (`dev.relaylead.watcher`) et le plugin Claude Code, qui apporte la console `/relaylead`, le panneau `/pane` et les commandes `/relaylead:*`. Rend aussi `~/.relaylead` privé à votre compte (dossiers en 700, fichiers en 600). Peut être relancé sans risque. Sans Claude Code, l'étape du plugin est sautée. Se termine par `relaylead doctor`.

### `relaylead uninstall [--purge] [--force]`

Arrête le veilleur et attend sa fin, puis retire ce que `install` a ajouté, et rien d'autre. `--purge` supprime aussi `~/.relaylead` (état des missions, journaux, fichier de clé), après avoir vérifié que le dossier appartient bien à Relaylead. `--purge` refuse tant qu'une mission n'est pas finie, et la nomme ; `--purge --force` arrête d'abord les sessions de ces missions, puis supprime. Voir [Désinstaller](#désinstaller).

### `relaylead doctor`

Vérifie Node, Claude Code, git, le planificateur (et que le Node et le `PATH` enregistrés à l'installation existent toujours), le plugin, le veilleur, l'authentification, la configuration (clés inconnues, `language`, `permissionMode`, `parallel`, `maxSessions`), les permissions de `~/.relaylead`, la mémoire du projet, les missions abandonnées et un éventuel fichier `STOP`. Une ligne par vérification : `ok`, `warn` ou `fail`, son nom et son détail. Sort avec le code 1 si une vérification a échoué, et ne lance aucune session.

### `relaylead watcher start|stop|status|run`

- `watcher start` : lance la boucle (rien ne change si elle tourne déjà).
- `watcher stop` : l'arrête, jusqu'au prochain `watcher start` ou `launch`.
- `watcher status` : dit si elle tourne, et quand elle est passée pour la dernière fois.
- `watcher run [--mission <nom>]` : fait un passage tout de suite, sur toutes les missions ou sur une seule, et affiche ce qu'il a fait.

### `relaylead wait`

- `wait --all [--timeout secondes] [--json]` : pour la console. Attend qu'il se passe dans une mission quelque chose que vous devez savoir (une question, une tâche en échec, une mission terminée ou arrêtée, une fusion), puis affiche une ligne par événement, avec le nom de sa mission. Une mission terminée qui peut être fusionnée arrive avec sa commande suivante : `[hello-api] mission terminée ; ramenez son travail dans votre branche avec : relaylead merge hello-api`. `--timeout 0` regarde une fois. Chaque événement n'est donné qu'une fois.
- `wait [--timeout secondes] [--mission nom]` : *pour les sessions*. Le lead attend qu'une tâche, une question ou un message de sa mission change.

### `relaylead task`

Gère les tâches d'une mission. Hors d'une session, ajoutez `--mission <nom>`.

- `task list [--short]` : les tâches en JSON, avec état, `ready`, `ask` et résumé ; `--short` affiche une ligne par tâche.
- `task retry <id> [--profile p]` : lance un nouvel équipier sur une tâche en échec, sur la même branche, en lui disant comment l'essai précédent a échoué. Limité par `maxAttempts`.
- `task deliver <id> [--no-hooks]` : livre une tâche terminée. `--no-hooks` saute vos hooks git ; vous seul pouvez l'utiliser.
- `task start <id>`, `task done <id>`, `task fail <id> [--summary texte]` : *pour les sessions*.

### `relaylead state`, `decision`, `memory`

*Pour les sessions.* `state get|set <état> [--note texte]` lit ou écrit l'état déclaré par le lead. `decision <texte>` note une décision prise avec vous ; `decision --list` les affiche, avec chaque message transmis par `tell`. `memory show` et `memory write --base <empreinte> --file <fichier> | --text <texte>` lisent et remplacent la mémoire du projet.

## Fichiers et dossiers

Ce que Relaylead écrit, et où.

**Dans votre projet :**

| Chemin | Écrit par | Remarques |
| --- | --- | --- |
| `.relaylead.json` | `init` | Les réglages du projet, jamais écrasés par `init`. À commiter ou non : voir [Configuration](#configuration). |
| `tasks/*.md` | vous, ou la console | Vos tâches. Elles doivent être commitées avant un lancement. |
| `.relaylead/worktrees/<mission>/<tâche>/` | les missions | Un worktree git par tâche en cours, retiré une fois la tâche livrée. |
| `.relaylead/worktrees/<mission>/_integration/` | les missions | Le worktree de la branche d'intégration. |
| `.relaylead/memory.md`, `.relaylead/memory-archive/` | les leads | La mémoire du projet (`memoire.md` dans les projets préparés avant la 0.4). |
| `.git/info/exclude` | `init`, les missions | Reçoit `.relaylead/` (ou des règles qui ne laissent visible que la mémoire, si elle est versionnée), pour que rien de tout cela n'apparaisse dans `git status`. Votre `.gitignore` n'est pas touché. |
| branches `relaylead/<mission>/<tâche>` | les missions | Une par tâche, supprimée une fois livrée. |
| branche `relaylead/<mission>/integration` | les missions | Le travail livré. Reste après la fusion, jusqu'à ce que vous la supprimiez. |
| `out/<mission>/<tâche>/` | la livraison `files` | Seulement avec cette livraison. |

**Sur votre Mac :**

| Chemin | Contenu |
| --- | --- |
| `~/.relaylead/config.json` | Les réglages de la machine. |
| `~/.relaylead/missions/<mission>/` | L'état d'une mission, ses tâches, questions, décisions, messages et son `journal.log`. Retiré après la fusion. |
| `~/.relaylead/watcher.log` | Une ligne par action du veilleur. |
| `~/.relaylead/api-key` | La clé API, seulement avec `--api-key-env`. |
| `~/Library/LaunchAgents/dev.relaylead.watcher.plist` | L'agent launchd du veilleur. |
| La liste des plugins de Claude Code | Le plugin `relaylead` de la marketplace `relaylead-local`. Rien n'est écrit directement dans vos réglages Claude Code. |

`~/.relaylead` est réservé à votre compte (700 pour les dossiers, 600 pour les fichiers) ; `install` et `doctor` corrigent les dossiers plus anciens.

## Journaux et diagnostic

- **`relaylead doctor`** d'abord. Une ligne `fail` dit ce qui manque ; une ligne `warn` dit quelle commande lancer.
- **`~/.relaylead/watcher.log`** : une ligne par action du veilleur (relances, réveils, relèves, échecs, un lead signalé `lead-stuck`). Déplacé dans `watcher.log.1` au-delà de 1 Mio. `relaylead watcher run` affiche les lignes qu'un passage ajoute.
- **`~/.relaylead/missions/<mission>/journal.log`** : les avertissements et les échecs d'une mission, dont les actions refusées par les garde-fous.
- **`relaylead show <mission>`** ouvre la conversation du lead, pour voir ce qu'il fait.

La [FAQ](faq.md#dépannage) répond aux problèmes courants un par un.

## Désinstaller

```sh
relaylead uninstall --purge    # veilleur, plugin et ~/.relaylead
npm uninstall -g relaylead
```

`--purge` refuse tant qu'une mission n'est pas finie, et la nomme. Arrêtez-la d'abord (`relaylead stop <mission>`), ou ajoutez `--force` pour arrêter les sessions de toutes les missions en cours avant la suppression. Sans `--purge`, `~/.relaylead` reste, avec vos réglages et vos missions.

`uninstall` ne touche pas à vos projets. Dans chaque projet où des missions ont tourné, vous pouvez ensuite retirer :

```sh
git worktree list                              # les worktrees sous .relaylead/worktrees/
git worktree remove .relaylead/worktrees/<mission>/_integration
git branch --list 'relaylead/*'                # les branches créées par Relaylead
git branch -D relaylead/<mission>/integration  # quand vous n'avez plus besoin du travail
rm -rf .relaylead .relaylead.json
```

Retirez ensuite les lignes `.relaylead/` de `.git/info/exclude`. Si une étape d'`uninstall` échoue, elle affiche la commande à lancer à la main.
