# Relaylead 0.2 : essai réel avec Claude Code sur macOS

Relevé du 22 novembre 2026, de 13:09 à 13:50, avec Claude Code 2.1.330, Node 24 (launchd) et Node 20 (shell des sessions), sur `main` 4ff2dcd. Paquet produit par `npm pack` (`relaylead-0.1.0.tgz`, 87 fichiers), installé dans un préfixe isolé `<scratch>/prefix`, placé en tête du PATH. Les variables `CLAUDE*` et `ANTHROPIC*` de la session hôte étaient retirées. Authentification `login`, `maxSessions` à 1 dans `~/.relaylead/config.json`.

Projets jouets : `<scratch>/rl-essai` (Node, `node --test`) avec des sources `tasks/backend` (2 tâches), `tasks/frontend` (1 tâche) puis `tasks/console`, `tasks/reprise`, `tasks/occupe|norm|haut`. Dépôt GitHub privé `rl-essai-gh-20261122` avec une issue. La confiance des dossiers a été acceptée par `claude` dans un pty (expect).

## Synthèse

| Étape | Résultat |
|---|---|
| 1. Installation | OK (version annoncée 0.1.0, voir défaut 6) |
| 2. Projet jouet, `init --yes` | OK |
| 3. Multi-mission, file, priorité | OK |
| 4. Continuité (`kill -9` du lead) | OK |
| 5. Fusion et conflit | OK |
| 6. Mémoire | OK (une leçon fausse, voir défaut 5) |
| 7. Console | Partiel : défauts 1, 3, 4 et 5 |
| 8. Affichages | OK pour overview et dashboard ; questions des missions terminées absentes (défaut 2) ; panneau et ligne d'état à voir par l'auteur |
| 9. GitHub (`github-pr` et `merge`) | OK |
| 10. Ménage | Partiel : cache du plugin laissé par `uninstall`, dépôt GitHub non supprimé (droit manquant), entrées de `~/.claude.json` |

## 1. Installation : OK

- `npm install -g --prefix <scratch>/prefix <tarball>` : 1 paquet, 0,4 s. `relaylead --version` → `0.1.0`.
- `relaylead install` (4,8 s) : plist `dev.relaylead.watcher` écrit et chargé, plugin `relaylead@relaylead-local` installé, puis `doctor` tout `ok`.
- `relaylead doctor` : 7 lignes `ok` (node, claude, git, scheduler, plugin, watcher, auth), sortie 0.

## 2. Projet jouet : OK

- `relaylead init --yes` écrit `config.json` et `.relaylead.json` (`memory.enabled: true`, `versioned: false`) et ajoute `.relaylead/memoire.md` et `.relaylead/memoire-archive/` à `.git/info/exclude`. `.gitignore` n'est pas touché.
- `relaylead init --yes | head -2` plante sur `EPIPE` (défaut 10). Les fichiers sont quand même écrits.

## 3. Multi-mission : OK

- `launch --name backend --tasks tasks/backend --priority high` à 13:15:28, puis `frontend` (normale) à 13:15:31.
- Le lead de `frontend` a demandé sa place le premier (12:15:40.7, contre 12:15:42.5 pour `backend`). Il l'a obtenue : il n'y a pas de préemption, la file ne joue qu'une fois le plafond atteint. `list` affiche alors `backend  working (2 queued)`.
- Une seule session d'équipier à la fois tout du long. `frontend` est `done` à 13:16:08, `backend` à 13:17:17. Branches `relaylead/backend/integration` et `relaylead/frontend/integration`.
- **Ordre de la file vérifié à part** : `occupe` (basse) tient la place avec une tâche de 45 s. `norm` (normale) est mise en file à 13:42:03, puis `haut` (haute) à 13:42:20. Quand la place se libère, `haut` part la première (`queue-start` à 12:42:46Z), puis `norm` (12:43:18Z).
- Refus d'une mission sur une source déjà prise (`--tasks tasks/console`, chemin relatif, avec `/` final ou absolu) : message clair, sortie 1, aucune mission créée.
- `relaylead priority backend low` : `priority of backend: low`, visible dans `overview --json`. C'est aussi accepté sur une mission `done`.
- Pause de quota par priorité observée sans la provoquer : `occupe` (basse) a été mise en pause à `week 70% >= 70%`. Sessions arrêtées 3 min plus tard (`usage-stop`), `list` affiche `usage-pause (resume 2026-11-23 0…)`.

## 4. Continuité : OK

- `kill -9` du lead de `backend` (PID 58492) à 13:16:25, alors que `greeting` tournait.
- Le veilleur note `lead-restarting` à 12:16:30Z (+5 s). Le lead revient sous le même nom avec un nouveau PID (63853), et sa première commande arrive à 12:16:39Z (+14 s).
- La mission finit sans perte : 2 tâches livrées, `done` à 13:17:17, soit 52 s après le kill.
- Le veilleur a aussi arrêté l'équipier de `triple` après son `task done` (`stop-orphan-crew`), ce qui est le comportement attendu.

## 5. Fusion : OK

- `relaylead merge backend` (1 s) : `merged into main (6d4f081)`.
- `relaylead merge frontend` : `conflicts with main (lib/messages.js); the merge was cancelled and nothing changed…`, sortie 0. Ensuite :
  - la tâche `merge-into-main` part à 12:18:34Z ;
  - l'équipier fusionne `main` dans l'intégration et garde les deux valeurs (`greeting` et `backendGreeting`) ;
  - le veilleur livre et refusionne seul : `frontend merged into main (37325de)` à 12:18:52Z, 18 s après le conflit ;
  - `npm test` passe sur `main` (3/3).
- Aucune question n'a été posée : l'équipier a réussi.
- Nettoyage par le veilleur à la passe suivante : `backend mission-removed` à 12:20:35Z et `frontend` à 12:20:39Z, environ 1 min 45 s après la fusion. Les dossiers de mission et les worktrees `_integration` sont supprimés, les branches d'intégration restent (comme documenté). Plus aucune session des deux missions dans `claude agents`, dès 5 s après `done`.

## 6. Mémoire : OK

- `.relaylead/memoire.md` : 12 lignes après les deux missions et 21 lignes à la fin (plafond 200). Une ligne par mission (frontend, backend, console, reprise, haut, norm), plus des conventions et des leçons. 5 archives dans `memoire-archive/`.
- Le fichier est absent de `git status` (`.relaylead/` exclu).
- Dans les 6 transcriptions de leads, `memory write` précède toujours `state set done`, de 3 à 4 s.
- Une leçon fausse a été écrite (« answer with Other and type the text ») : voir le défaut 5.
- `relaylead state set done --mission occupe` lancé hors session est accepté sans écriture de la mémoire (défaut 8).

## 7. Console : partiel

Chaque appel est un `claude -p "<texte>" --output-format json`, lancé dans le projet avec le plugin installé. Les jetons ci-dessous sont lus dans la transcription ; ils correspondent au JSON pour l'appel 1. Chaque requête porte environ 45 000 jetons de contexte, surtout l'environnement Claude de la machine (plugins, skills, hooks de l'utilisateur).

| Appel | Contenu | Requêtes | Entrée / sortie | Cache lu / écrit | Coût |
|---|---|---|---|---|---|
| 1 | « /relaylead où en sont mes missions ? » | 11 (dont 2 réveils après arrêt de l'attente) | 22 / 1 837 | 438 640 / 33 373 | 0,39 $ (JSON) |
| 2 | « dis au lead de console… » (`tell`) | 8 | 16 / 1 253 | 306 324 / 29 542 | ≈ 0,31 $ |
| 3 | nouvelle conversation, « je choisis l'option 1 » | 19 (dont réveils sur question et fin de mission) | 38 / 3 518 | 807 659 / 36 590 | ≈ 0,56 $ |
| 4 | nouvelle conversation, « /relaylead » seul (reprise) | 7 | 14 / 723 | 262 331 / 29 145 | ≈ 0,29 $ |

Les coûts marqués ≈ sont extrapolés au prorata des jetons de l'appel 1. Total : environ 1,55 $.

- **Appel 1 : OK.** Doctor, `wait --all --timeout 0`, list, question list, state get. La question de `console` est affichée telle quelle avec le nom de la mission et les options numérotées, la recommandée marquée. La console relève elle-même que les options ne répondent pas à la question. Mais `claude -p` ne rend pas la main (défaut 3) : il a fallu tuer deux fois l'attente.
- **Appel 2 : OK pour la transmission.** `relaylead tell console "…"` → `message m-000001 told to the lead`. Le veilleur réveille le lead à 12:26:17Z, et le lead lit le message dans `wait` (kind `message`, avec le texte) à 12:26:23Z puis le note par `relaylead decision`. **Mais la consigne n'a pas atteint l'équipier** (défaut 1) : la tâche a été faite avec un autre texte (`'Goodbye from console'`).
- **Appel 3 : OK.**
  - `relaylead answer console q-farewell 1` est passé par la console.
  - Elle se réveille sur la nouvelle question `q-deliver-farewell` (affichée telle quelle).
  - Elle se réveille ensuite sur la fin de mission et demande « Je fusionne la mission dans `main` ? ».
- **Appel 4 : défaut.** Une nouvelle conversation avec une question ouverte (`reprise/q-readme`) lit bien la question (`wait --all --timeout 0` puis `question list`). Mais elle répond seulement « elle attend ta réponse à une question avant de continuer », sans le texte ni les options (défaut 4).
- Pendant qu'il tourne, `claude -p` apparaît dans `claude agents` comme session interactive. Il en sort à la fin.

## 8. Affichages

- `relaylead overview --json` est cohérent avec `list` et `task list` : missions, priorités, états, tâches, `sessions {running, max: 1}`, quota 5 h et 7 j, réglages d'affichage.
- `relaylead dashboard --no-open` : `dashboard on http://127.0.0.1:4317`, écoute sur 127.0.0.1 seulement (lsof). Vérifications par curl :
  - `GET /` : 200, la page contient un jeton de 48 caractères ;
  - `GET /api/overview` : 200, sans en-tête CORS ;
  - POST `/api/answer` sans jeton ou avec un mauvais jeton : 403 `bad token` ;
  - bon jeton avec un autre `Origin` : 403 `bad origin` ;
  - bon jeton avec un autre `Host` : 403 `bad host` ;
  - bon jeton sur une question déjà répondue : 409 `already answered` ;
  - bon jeton sur une question ouverte : 200 `question q-essai-dash answered: Non`, vérifié par `question list --all`.
- La question de test, ouverte sur une mission `done`, n'apparaissait pas dans `/api/overview` (défaut 2).
- `claude plugin validate` sur le plugin installé : « Validation passed with warnings ». Pas d'auteur ; pour l'annuaire, README manquant (refus) et pas d'icône. Le module de hooks déclare `session.start`, `command.run{panneau}`, `ui.render` AbovePrompt et Pane, et `$.ui.status`.
- **Panneau et ligne d'état : à voir par l'auteur** (session interactive seulement).

## 9. GitHub : OK

- `.relaylead.json` : `source github-issues` (label `relaylead`) et `delivery github-pr`. Mission `gh` lancée à 13:37:24 et `done` à 13:38:30 :
  - PR n°2 `relaylead/gh/issue-1` → intégration, fusionnée à 12:38:06Z ;
  - issue n°1 fermée à 12:38:15Z.
- `relaylead merge gh` (7 s) : `merged into main (https://github.com/…/pull/3)`. PR n°3 « Relaylead: gh » fusionnée, et `origin/main` porte les deux merges.
- Nettoyage par le veilleur à 12:40:49Z (`integration branch merged`). La branche distante `relaylead/gh/integration` reste sur GitHub, et le `main` local n'est pas mis à jour (« derrière 3 »).
- L'issue est fermée dès la livraison dans l'intégration, avant la fusion dans `main` (défaut 12).

## 10. Ménage : partiel

- Sessions de l'essai : arrêtées et retirées par Relaylead (`done`, puis `remove`). `claude agents --json --all` donne 21 sessions avant et 21 après, mêmes identifiants et mêmes états.
- `relaylead remove` sur les 5 missions restantes. `occupe` est refusée (« work not delivered: relaylead/occupe/note ») puis passe avec `--force`, qui affiche la branche supprimée et son commit.
- Tableau de bord arrêté par SIGINT sur son PID.
- `relaylead uninstall --purge` : `watcher stopped`, `scheduler removed`, `plugin removed`, `deleted ~/.relaylead`.
- Vérifié vide ensuite : `launchctl print gui/$(id -u)/dev.relaylead.watcher` (service introuvable), `~/Library/LaunchAgents/*relaylead*`, `claude plugin list` et `claude plugin marketplace list` (aucun relaylead), `~/.relaylead`.
- **Reste après `uninstall`** : `~/.claude/plugins/cache/relaylead-local` (68 Ko, marqué `.orphaned_at`), supprimé à la main (défaut 7).
- Supprimés à la main : le préfixe, le scratchpad d'essai, les transcriptions `~/.claude/projects/*essai-0-2*`, `~/.claude/session-env/<sessions de l'essai>`, `~/Library/Caches/claude-cli-nodejs/*essai-0-2*`, les sorties de tâches de fond `/private/tmp/claude-501/*essai-0-2*`, et le cache npm (`npm cache clean --force`). `which -a relaylead` est vide.
- **Non supprimés :**
  - le dépôt GitHub `rl-essai-gh-20261122` : `gh repo delete` répond HTTP 403, il faut le droit `delete_repo` (`gh auth refresh -h github.com -s delete_repo`, interactif) ;
  - dans `~/.claude.json` : entrées de confiance des deux dossiers d'essai, compteurs `relaylead:relaylead` et `relaylead@inline`, chemin local du dépôt GitHub ;
  - 12 lignes de `~/.claude/history.jsonl`.
  Ces deux fichiers sont écrits en continu par les sessions Claude ouvertes, donc je ne les ai pas modifiés.
- Résidus d'essais antérieurs, non touchés : les sessions `toy-1/*` et `essai-1-1/*` (dans `claude agents`, donc celles de l'utilisateur) avec leurs transcriptions, et des caches `claude-cli-nodejs/*essai-final*`.
