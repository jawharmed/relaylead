# Essai final v1 : vrai Claude Code sur macOS

- Date : 2026-11-21, 21:37 à 22:05 (heure locale).
- Code : main a1249d8 (worktree détaché sur origin/main), paquet `relaylead-0.1.0.tgz` produit par `npm pack` (71 fichiers).
- Machine : macOS (Darwin 24.6.0), Node 24.19.0, Claude Code 2.1.330, gh connecté.
- Installation isolée : `npm install -g --prefix <scratch>/prefix <tarball>`, `<scratch>/prefix/bin` en tête du PATH.
- Écart volontaire : `RELAYLEAD_HOME=<scratch>/home` pour tout l'essai. `~/.relaylead` contenait déjà une mission de l'utilisateur (`toy-1`), que `uninstall --purge` aurait effacée. La variable est reprise dans le plist launchd, donc le veilleur launchd a bien servi pendant l'essai.
- Les commandes ont été lancées sans les variables `CLAUDE*` / `ANTHROPIC*` de la session qui pilotait l'essai, pour reproduire le terminal d'un utilisateur.
- 22 sessions `claude agents` existaient au départ. Aucune n'a été touchée : même liste et mêmes états à la fin.

## Bilan

| Étape | Résultat |
| --- | --- |
| 1. Paquet et installation isolée | OK |
| 2. install, doctor, launchd, plugin | OK |
| 3. Projet jouet, local-merge | OK |
| 4. Continuité (kill -9 du lead) | OK, avec une réserve (voir plus bas) |
| 5. Humain dans la boucle | OK (la notification ne laisse aucune trace dans le journal, défaut mineur) |
| 6. GitHub issues et PR | OK (aucune revue de PR, défaut moyen) |
| 7. Mode clé API | Défaut : la clé ne fuit pas, mais les sessions tournent sur le compte connecté |
| 8. Ménage | OK, avec un défaut (la boucle du veilleur survit à `uninstall --purge`). Le dépôt GitHub d'essai n'a pas pu être supprimé (droit gh manquant) |

## 1. Paquet et installation isolée : OK

```
npm pack --pack-destination <scratch>     -> relaylead-0.1.0.tgz, 71 fichiers
npm install -g --prefix <scratch>/prefix  -> added 1 package in 378ms
which relaylead                           -> <scratch>/prefix/bin/relaylead
```

## 2. install et doctor : OK (4,9 s)

```
scheduler installed (~/Library/LaunchAgents/dev.relaylead.watcher.plist)
plugin installed: relaylead@relaylead-local
ok node / ok claude 2.1.330 / ok git / ok scheduler: installed and loaded / ok plugin / ok watcher / ok auth: login
```
- `launchctl print gui/501/dev.relaylead.watcher` : `run interval = 300 seconds`, programme node + `<prefix>/.../bin/relaylead.js watcher run`, `RELAYLEAD_HOME` présent dans l'environnement. Plus tard dans l'essai : `runs = 2`, `last exit code = 0`.
- `claude plugin list` : `relaylead@relaylead-local`, version 0.1.0, `Status: ✔ enabled`, lu depuis `<prefix>/lib/node_modules/relaylead/plugin`.

## 3. Projet jouet : OK (environ 40 s)

Dépôt git local `rl-essai` (package.json avec `node --test`), tâches `tasks/add.md` et `tasks/readme.md`.
- `relaylead init --yes` : écrit config.json et `.relaylead.json`, puis rappelle d'accepter la confiance du dossier. Il affiche aussi « next: relaylead install » alors que l'installation est déjà faite (mineur).
- Premier `launch` : refus clair et immédiat (« Claude Code does not trust the folder … run `claude` once … »), sans état laissé derrière. Une fois la confiance acceptée par `claude` dans un pty (expect), le lancement passe.
- `launch` à 21:42:49, état `done` à 21:43:27 : 2 tâches `delivered`. `relaylead/integration` contient deux merges et deux commits `chore(relaylead): deliver …`. `npm test` passe dans `_integration`, `state: done` est écrit dans les fichiers de tâches, et le checkout de l'utilisateur n'a pas bougé (seul `.relaylead.json` apparaît en non suivi).
- Note du lead : « Delivered both tasks … Nothing failed or set aside. »
- Deuxième mission (`rl-cont`) avec 3 tâches enchaînées par `depends` : toutes livrées dans l'ordre en environ 1 min.

## 4. Continuité : OK, avec une réserve

Mission `rl-kill` : une tâche avec `ask`, une autre qui en dépend.
- Question `q-greet` créée 12 s après le lancement. Un `kill -9` du lead pendant l'attente de la réponse le laisse `blocked`. Le veilleur le considère au repos (mission `waiting`) et ne le relance pas, comme prévu par la conception.
- Réponse à 21:49:57. Une passe ciblée réveille le lead à 21:49:58 (`wake-lead 7947adda: question q-greet is now answered`).
- Pendant qu'un équipier travaillait (21:50:09), `kill -9` du processus du lead (pid 48525). Le lead revient à 21:50:23 (+14 s, même session, nouveau pid 54151) et la mission est `done` à 21:50:59. Les 7 tâches sont `delivered` et rien n'est perdu.
- Réserve : ce redémarrage en 14 s vient du service de Claude Code lui-même, qui relance une session tuée, et non du veilleur.
- Pour tester le veilleur, mission `rl-watch` : `kill -9` du lead puis `claude stop <lead>` à 21:51:42, pendant qu'un équipier travaillait. Le veilleur journalise `relaunch-lead 0c4c50c7 resumed` à 20:51:58Z (+16 s). C'est une passe ciblée, déclenchée par la fin de la tâche de l'équipier, qui a fait la relance. La mission est `done` à 21:52:31, sans perte.
- La passe launchd (toutes les 5 min) a tourné (runs=2, exit 0), mais elle n'a jamais eu à relancer : les passes ciblées ont toujours agi avant elle.

## 5. Humain dans la boucle : OK

Dépôt nu local `bare.git` déclaré comme remote `backup`, avec une branche `obsolete`. Tâche : `git push backup --delete obsolete`.
- 21:53:02 : question `q-irr-6cf2b6036103` de type `irreversible`, options `Refuse` / `Allow once`. Journal de la mission : `Bash irreversible: git push --delete`.
- Notification : un enrobage `osascript` placé dans le PATH a enregistré `-e display notification "Question q-irr-6cf2b6036103: git push backup --delete obsolete" with title "Relaylead: rl-hitl"` et `exit=0`. Rien n'apparaît dans `journal.log` ni dans `watcher.log` (défaut mineur 4).
- L'équipier finit en `task fail` en citant la question. Réponse `relaylead answer rl-hitl q-irr-… 2` (Allow once) à 21:53:31. Le lead est réveillé en 1 s et relance la tâche, la commande passe (journal : `Bash allowed once by the user (question q-irr-6cf2b6036103)`), et la mission est `done` à 21:54:12. La branche est supprimée de `bare.git`.
- Usage unique : `questions/q-irr-….used.json` est écrit. Rejouer le hook PreToolUse avec la même commande renvoie `deny … its one-time permission is already used`.

## 6. GitHub : OK (environ 1 min)

Dépôt privé `rl-essai-gh-20261121`, label `relaylead`, issues #1 et #2. `.relaylead.json` : source `github-issues` et livraison `github-pr`.
- `launch` à 21:55:19, `done` vers 21:56:30.
- PR #3 (issue-2) et #4 (issue-1) vers `relaylead/integration`, toutes deux `MERGED` (20:55:56Z et 20:56:16Z). Issues #1 et #2 `CLOSED` avec le commentaire « Delivered by relaylead ». `relaylead/integration` a été créée sur le remote.
- `reviews: []` sur les deux PR : aucune revue (défaut moyen 2). Les branches de tâche restent sur GitHub après la fusion (défaut mineur 7).

## 7. Mode clé API : défaut

Dans `<home>/config.json` : `auth: {mode: "api-key", keyFile: "~/.config/anthropic/relaylead-key"}`. `doctor` affiche `ok api-key: file found`.
- Mission `rl-api` (une tâche `VERSION`) : le lead démarre sans aucune question d'approbation et la mission est `done` en moins de 40 s.
- Aucune fuite : recherche des 8 derniers caractères de la clé, sans les afficher, dans `RELAYLEAD_HOME` (journaux, settings, état), dans les sorties de `launch`, dans 20 instantanés `ps -axww` pris pendant la mission, dans le plist, dans `.relaylead/` du projet et dans les transcriptions `~/.claude/projects/*rl-essai*` : 0 occurrence.
- Mais la clé ne sert pas. `usage.json` a été réécrit à 20:58:06.009Z par la statusline du lead `rl-api` (lecture de contexte `1f4bb5ff` à 20:58:06.007Z) avec `fiveHour 15 %` et `sevenDay 55 %`. Ces fenêtres d'usage n'existent qu'avec un abonnement claude.ai : la session tournait donc sur le compte connecté. La clé n'est pas dans `customApiKeyResponses.approved` de `~/.claude.json`. En session de fond, Claude Code ne demande rien et ignore la clé (défaut majeur 1). Je n'ai pas approuvé la clé pour comparer : cela en aurait copié une partie dans `~/.claude.json`.
- Arrêt rapide : la configuration est revenue en `login` aussitôt après.

## 8. Ménage : OK, avec un défaut

- `relaylead remove` sur chaque mission. Les 21 sessions de l'essai restaient listées dans `claude agents --all` (défaut mineur 5) : `claude stop` puis `claude rm` sur chacune.
- `relaylead uninstall --purge` : `scheduler removed`, `plugin removed`, `deleted <home>`. Ensuite, `launchctl print` répond `Could not find service`, le plist est absent et `claude plugin list` comme `claude plugin marketplace list` ne mentionnent plus relaylead.
- Défaut 3 : la boucle `relaylead.js watcher loop` (pid 37197, lancée par le premier `launch`) tournait encore après l'uninstall. Elle a recréé `<home>/watcher-loop.json` 11 s plus tard, puis s'est arrêtée à sa passe suivante (22:02:57) en laissant un dossier `<home>` vide.
- Supprimés : le préfixe npm, le tarball, `rl-essai`, `bare.git`, le clone GitHub local, `<home>` et les transcriptions `~/.claude/projects/*essai-final*`.
- Dépôt GitHub `jawharmed/rl-essai-gh-20261121` non supprimé : `gh repo delete` répond HTTP 403, car il faut le droit `delete_repo` (`gh auth refresh -h github.com -s delete_repo`, interactif). À supprimer à la main.
- Restent dans `~/.claude.json` les deux entrées de confiance des dossiers d'essai (chemins scratch), laissées pour ne pas toucher à la configuration de l'utilisateur.
- Sessions de l'utilisateur : 22 avant, 22 après, mêmes identifiants et mêmes états. `~/.relaylead/missions/toy-1` est intact.

## Revérification après corrections (branche `fix/essai-final`, 5575d17)

- Date : 2026-11-21, 22:20 à 22:33. Paquet `relaylead-0.1.0.tgz` (72 fichiers) produit par `npm pack` depuis la branche. Même méthode qu'avant : installation isolée sous `<scratch>/prefix`, `RELAYLEAD_HOME=<scratch>/home`, variables `CLAUDE*` / `ANTHROPIC*` retirées de l'environnement.
- `relaylead install` : OK (scheduler et plugin installés, doctor tout ok). `relaylead init --yes` n'affiche plus « next: relaylead install » quand l'installation est déjà faite.

### Mode clé API : OK

- Config machine : `auth: {mode: "api-key", keyFile: "~/.config/anthropic/relaylead-key"}`.
- `relaylead doctor` :
  ```
  ok api-key: file found
  ok api-key-use: claude picks the key through apiKeyHelper
  ok api-key-check: in a running session (relaylead show <mission>), /status must name apiKeyHelper, not your Claude account
  ```
- Le fichier de réglages de session contient `apiKeyHelper: "<node>" "<prefix>/…/core/api-key-helper.js" "~/.config/anthropic/relaylead-key"`, donc un chemin et jamais la clé. Ses variables d'environnement sont `BASH_DEFAULT_TIMEOUT_MS, PATH, RELAYLEAD_ALLOW, RELAYLEAD_HOME, RELAYLEAD_MISSION, RELAYLEAD_ROLE, RELAYLEAD_SESSION`, sans `ANTHROPIC_API_KEY`.
- Mission `rl-api` (une tâche avec `ask`, une tâche qui en dépend), lancée à 22:23:24. L'organisation de la clé n'a **plus de crédit**, donc aucune session n'a pu travailler, mais chaque appel l'a prouvé : il passe par la clé.
  - **Lead** : `failures/ff16cad0.json` contient `billing_error: Credit balance is too low` (21:23:27Z). Dans `/status` du lead (`claude attach`) : `Auth token: apiKeyHelper`, `API key: apiKeyHelper`, `Setting sources: Command line arguments`, et dans la conversation : « Credit balance too low · Add funds: https://platform.claude.com/settings/billing ». Avec l'abonnement, cette erreur n'existe pas.
  - **Réveil (`--resume`)** : passe du veilleur à 21:27:53Z, `wake-lead ff16cad0: task name is now todo; task version is now todo`. Le pid change (53558 → 53567), nouvelle `billing_error` à 21:27:57Z, et `/status` du lead repris affiche encore `Auth token: apiKeyHelper` / `API key: apiKeyHelper`. Le réveil garde donc la clé ; c'était le point incertain.
  - **Équipier** : le lead ne pouvait rien lancer, faute de crédit. J'ai posé la question de la tâche moi-même (`question ask --key version`), répondu, puis lancé `relaylead task start version --mission rl-api`. Dans `failures/468d3879.json` : `billing_error` à 21:29:34Z. Dans `/status` de `rl-api/developer/1` : `Auth token: apiKeyHelper` / `API key: apiKeyHelper`.
  - Aucun `usage.json` n'a été écrit pendant toute la mission, alors que la statusline tournait (lecture de contexte du lead à 21:23:27Z) : aucune fenêtre d'abonnement n'a été reçue.
  - `customApiKeyResponses` de `~/.claude.json` est inchangé (empreinte identique avant et après) : aucune approbation n'a été enregistrée.
  - Aucune fuite : 0 occurrence des 8 derniers caractères de la clé dans `RELAYLEAD_HOME`, dans les captures d'écran de `/status`, dans les transcriptions et dans `ps -axww`.
- Nouveau constat (voir le rapport, défaut 8) : quand la clé n'a plus de crédit, la mission reste `starting` et les sessions `blocked`. Le veilleur journalise `session-failure … billing_error`, réveille le lead (nouvel échec), mais ne prévient pas l'utilisateur : ni question ni notification, et rien dans `list`.

### `relaylead remove` : OK

- Mission `rl-api` arrêtée par `relaylead stop`, puis `relaylead remove rl-api`. Avant, `claude agents --all` listait `rl-api/lead/1` et `rl-api/developer/1` (`stopped`) ; après, plus aucune entrée.
- Mission `rl-done` en mode login (une tâche, `done` en 31 s), puis `relaylead remove rl-done` : `rl-done/lead/1` (`done`) et `rl-done/developer/1` (`stopped`) disparaissent de `claude agents`. 0 entrée du dossier d'essai à la fin.

### `relaylead uninstall --purge` : OK

- La boucle du veilleur tournait (lancée par `launch`). `uninstall --purge` (4 s) affiche `watcher stopped`, `scheduler removed`, `plugin removed`, puis `deleted <home>`.
- Juste après, et encore 35 s plus tard : 0 processus `watcher loop`, `<home>` absent, `launchctl print` répond `Could not find service "dev.relaylead.watcher"`, plus de plist, et ni `claude plugin list` ni `claude plugin marketplace list` ne mentionnent relaylead.

### Ménage

- Supprimés : le préfixe, le tarball, le projet `rl-api` et les transcriptions de l'essai. Sessions de l'utilisateur : 22 avant, 22 après, mêmes identifiants et mêmes états. `~/.relaylead/missions/toy-1` est intact.
- Il reste une entrée de confiance pour le dossier `rl-api` (chemin scratch) dans `~/.claude.json`.
