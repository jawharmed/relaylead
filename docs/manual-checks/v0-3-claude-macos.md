# Relaylead 0.3 : essai réel ciblé avec Claude Code sur macOS

Relevé du 23 novembre 2026, de 00:35 à 00:55, avec Claude Code 2.1.330 et Node 24.19, sur `main` 67a1370 (PR #112). Paquet produit par `npm pack` (`relaylead-0.2.0.tgz`, 90 fichiers). Il est installé dans un préfixe isolé `<essai>/prefix`, placé en tête du PATH. Le dossier d'essai est `/private/tmp/rl-essai-0-3-*`. Les variables `CLAUDE*` et `ANTHROPIC*` de la session hôte étaient retirées. Authentification `login`. La confiance des dossiers a été acceptée par `claude` dans un pty (expect).

L'essai porte sur ce qui a changé depuis la 0.2. Le moteur multi-mission n'a pas été réessayé.

## Synthèse

| Étape | Résultat |
|---|---|
| 1. Installation, `doctor`, `plugin validate` | OK (conseils de l'annuaire, voir défaut 4) |
| 2. Projet jouet, mission `tasks-dir` avec `ask` | OK |
| 3. Console (`claude -p`) et `relaylead brief` | OK pour le contenu ; `claude -p` ne rend pas la main (défaut 1) |
| 4. Réponse libre par la page web | OK |
| 5. `state set done` hors session | OK |
| 6. GitHub (`github-issues` + `github-pr`, `merge`) | OK |
| 7. Ménage | OK, sauf le dépôt GitHub (droit `delete_repo` manquant) |

Aucun défaut bloquant.

## 1. Installation : OK

- `npm install -g --prefix …` : 1 paquet en 0,4 s. `relaylead --version` affiche `0.2.0` : la version n'est pas encore relevée pour la 0.3.0.
- `relaylead install` prend 7,4 s. Il écrit et charge le plist `dev.relaylead.watcher` et installe le plugin `relaylead@relaylead-local`.
- `relaylead doctor` : 7 lignes `ok` (node, claude, git, scheduler, plugin, watcher, auth `login`), sortie 0.
- `claude plugin validate` sur le plugin installé (`~/.claude/plugins/cache/relaylead-local/relaylead/0.2.0`) affiche **« ✔ Validation passed »**, sans avertissement.
  - `plugin.json` : auteur « Lilia Digital », icône `./icon.svg` (présente), page d'accueil, documentation, support, licence, mots-clés. README du plugin présent.
  - Le skill `/relaylead:etat` n'est plus fourni (levier retiré).
  - Deux remarques ne changent pas le verdict (défaut 4) : le README n'a pas de ligne d'installation depuis une marketplace, et `network.hosts` n'est pas déclaré.

## 2. Projet jouet : OK

- Le dépôt git local `rl-essai` est un petit projet Node (`node --test`). Il a deux tâches dans `tasks/` :
  - `farewell` ajoute `farewell = 'Goodbye'` ;
  - `couleur` porte `ask: Which colour should lib/colour.js export?`.
- `relaylead init --yes` active la mémoire, non versionnée, et l'exclut par `.git/info/exclude`.
- `launch --name rl-jouet` à 00:39:26. La question `q-couleur` est ouverte à 00:39:41 et `farewell` est livrée pendant l'attente.
- La question n'offre que « Yes, do it / Skip this task » à une question qui demande une couleur (défaut 2).

## 3. Console : contenu OK, `claude -p` ne rend pas la main

Appel : `claude -p --output-format json "/relaylead où en sont mes missions ?"`, dans le projet.

- **Première commande : `relaylead brief`**, seule. Sa sortie est recopiée dans un bloc de code. La question est montrée telle quelle, avec la mission, le texte, les options numérotées et la recommandée marquée. La console ajoute : « Tu peux aussi répondre avec tes propres mots, par exemple en donnant directement la couleur voulue. La question demande une couleur, mais aucune des deux options n'en propose une. »
- **Puis elle lance `relaylead wait --all` en tâche de fond**, alors que le skill (§3) dit de ne jamais le faire en `claude -p`. `claude -p` reste alors bloqué : après 3 min il tournait toujours.
  - J'ai tué l'attente (son PID) : la console l'a relancée une fois, comme le veut le skill.
  - Je l'ai tuée une seconde fois : la console a dit que le suivi était coupé, a remontré la question telle quelle et a rendu la main (défaut 1).
- **Coût** (`total_cost_usd` du JSON, pour toute la session) : **0,418 $** et `num_turns` = 2. Le JSON ne compte que le dernier tour.
  - Dans la transcription : 8 requêtes, toutes sur Opus 5.5, pour 16 jetons en entrée, 1 658 en sortie, 346 953 en cache lu et 39 442 en cache écrit.
  - La première réponse seule (3 requêtes : `brief`, `wait`, texte) coûte environ **0,33 $** (37 223 écrits, 97 351 lus, 471 en sortie). Les 5 autres requêtes viennent des deux réveils causés par l'arrêt de l'attente (≈ 0,09 $).
  - L'appel témoin du relevé de coût 0.3 coûtait 0,188 $. Le coût marginal de l'ouverture est donc d'environ 0,14 $, proche des 0,117 $ mesurés par le lot E.
- **`relaylead brief` dans le terminal** : même contenu (« Nothing new. », la question avec ses deux options numérotées et la recommandée, « rl-jouet: waiting · tasks 1/2 delivered »). Seule la marque « (new) » a disparu, puisque l'événement avait été vu par la console.

## 4. Réponse libre par la page web : OK

- `relaylead dashboard --no-open` affiche `dashboard on http://127.0.0.1:4317`. Il écoute sur 127.0.0.1 seulement (lsof). La page contient un jeton de 48 caractères et un champ de réponse libre.
- Requêtes POST `/api/answer` avec `{"mission":"rl-jouet","id":"q-couleur","other":"teal"}` :
  - sans jeton : 403 `bad token` ;
  - mauvais jeton : 403 `bad token` ;
  - bon jeton avec une autre `Origin` : 403 `bad origin` ;
  - bon jeton avec un texte vide : 400 `bad request` ;
  - **bon jeton : 200 `question q-couleur answered: teal`** (00:45:05). `question list --all` donne `answer: {choice: "teal", other: true}` ;
  - deuxième réponse : 409 `already answered ("teal")`.
- **Transmission à l'équipier :**
  - le veilleur réveille le lead à 00:45:06 (`wake-lead … question q-couleur is now answered`) ;
  - l'équipier crée `lib/colour.js` avec `export const colour = 'teal';`, et la tâche est livrée (`delivered#1`, « colour = 'teal'; npm test passes ») ;
  - la mission est `done` à 00:45:51, 46 s après la réponse.
- Mémoire : 12 lignes, absente de `git status`. Elle résume `rl-jouet` (« colour = teal, chosen by the user »). Sa leçon sur la réponse libre est juste.

## 5. `state set done` hors session : OK

- La mission `rl-garde` (une tâche `ask`, dossier `tasks-garde`) attendait sa question.
- `relaylead state set done --mission rl-garde` : **refusé**, sortie 1. Le message demande de compacter la mémoire (`memory show`, `memory write --base`, `--mission` hors session, `--no-memory` en secours).
- Après `memory show` et `memory write --mission rl-garde --base <empreinte>` (« memory written (12 lines) »), la même commande est acceptée : sortie 0, mission `done`. La commande n'affiche rien en cas de succès (défaut 3).
- Autres vérifications :
  - `brief` montre la question de la mission terminée (`[rl-garde] q-nombre (new)`) et « No mission running » ;
  - `question ask --mission rl-garde …` est refusé : « mission "rl-garde" is over (done or stopped): a question asked now would never be seen », sortie 1.
- Sessions de `rl-garde` retirées de `claude agents` dès `done`.

## 6. GitHub : OK

- Dépôt privé `jawharmed/rl-essai-gh-20261123-0-3` avec le label `relaylead` et l'issue n°1 (« Add a farewell message »). `.relaylead.json` : `github-issues` + `github-pr`.
- La mission `rl-gh` est lancée à 00:48:14 et `done` à 00:49:20 (66 s). La PR n°2 `relaylead/rl-gh/issue-1` → intégration est fusionnée.
- **Après la livraison dans l'intégration, l'issue n°1 reste OPEN** (`closedAt: null`).
- `relaylead merge rl-gh` (12 s) :
  - `mission rl-gh merged into main (…/pull/3)` ;
  - `your local branch main is 3 commit(s) behind the remote one: run git pull there when you are ready (relaylead does not pull for you)` ;
  - PR n°3 « Relaylead: rl-gh » → `main` fusionnée ;
  - **issue n°1 fermée** (COMPLETED, 23:49:39Z) ;
  - **branche distante `relaylead/rl-gh/integration` supprimée** : `git ls-remote --heads origin` ne liste plus que `main` ;
  - `git status` local : `[derrière 3]`, ce qui confirme l'avertissement ;
  - `origin/main` porte `farewell`.

## 7. Ménage : OK, sauf le dépôt GitHub

- Tableau de bord arrêté par SIGINT sur son PID. `relaylead remove rl-gh` et `relaylead remove rl-jouet` réussis. `rl-garde` avait été retirée à l'étape 5.
- `relaylead uninstall --purge` : `scheduler removed`, `plugin removed`, `deleted ~/.relaylead`.
- Vérifiés vides ensuite :
  - `launchctl print gui/501/dev.relaylead.watcher` : service introuvable ;
  - `~/Library/LaunchAgents/*relaylead*` ;
  - `claude plugin list` et `claude plugin marketplace list` : aucun relaylead ;
  - **`~/.claude/plugins/cache/relaylead-local` : supprimé par `uninstall`** (défaut 7 de la 0.2 corrigé) ;
  - `~/.relaylead`.
- Supprimés à la main (traces de Claude Code, pas de Relaylead) :
  - le préfixe et le dossier d'essai ;
  - `~/.claude/projects/*rl-essai-0-3*` et `~/Library/Caches/claude-cli-nodejs/*rl-essai-0-3*` ;
  - `/private/tmp/claude-501/*rl-essai-0-3*` ;
  - `session-env`, `file-history` et `tasks` des 9 sessions de l'essai ;
  - dans `~/.claude.json` : les 2 entrées de confiance, le chemin du dépôt GitHub et les compteurs `relaylead:relaylead`, `relaylead:etat` et `relaylead@inline`, retirés par une réécriture atomique, JSON vérifié ;
  - les 6 lignes de l'essai dans `~/.claude/history.jsonl` ;
  - le cache npm (`npm cache clean --force`).
- `which -a relaylead` est vide.
- Les sauvegardes tournantes `~/.claude/backups/.claude.json.backup.*` antérieures au nettoyage contiennent encore les entrées de l'essai. Claude Code n'en garde que 5 et les remplace en quelques minutes : je ne les ai pas touchées.
- **Non supprimé : le dépôt GitHub `rl-essai-gh-20261123-0-3`** (privé). `gh repo delete` répond HTTP 403, car il faut le droit `delete_repo`. À faire par l'auteur : `gh auth refresh -h github.com -s delete_repo`, puis `gh repo delete jawharmed/rl-essai-gh-20261123-0-3 --yes`.
- Sessions de l'utilisateur : `claude agents --json --all` donne 22 sessions avant et 22 après, mêmes identifiants, mêmes noms, mêmes états.
- Résidus d'essais antérieurs laissés tels quels : entrées de confiance de `…/scratchpad/essai-final/*` et `…/scratchpad/essai-0-2/*` dans `~/.claude.json`.

## Défauts

1. **Moyen** : en `claude -p`, la console lance quand même `relaylead wait --all` et ne rend pas la main (défaut 3 de la 0.2, toujours là).
2. **Mineur** : une tâche `ask` qui demande une valeur n'offre que « Yes, do it / Skip this task ». La réponse libre rend le cas jouable.
3. **Mineur** : `state set done` n'affiche rien quand il réussit.
4. **Mineur** : conseils de `plugin validate` pour l'annuaire (ligne d'installation absente du README, `network.hosts` non déclaré).

Détails, reproduction et pistes : rapport `essai-0-3-report.md`.
