# Lot 1.1 : robustesse avec Claude Code sur macOS

Relevé du 18 novembre 2026, avec Claude Code 2.1.327 et Node 24 sur macOS. Relaylead `main` après la PR n°61.

## Procédure

Un seul dossier d'essai et quatre missions successives, qui portent toutes le nom par défaut, `essai-1-1`.

1. `npm link` depuis le dépôt de Relaylead ; `relaylead --version` → `0.1.0`.
2. Copier `fixtures/toy-repo/` dans un dossier neuf, `git init -b main`, tout commiter, lancer `claude` une fois et accepter « Yes, I trust this folder ».
3. Ajouter un hook `pre-merge-commit` qui passe et écrit une ligne dans un fichier hors du dépôt.
4. **Mission 1 :**
   - `relaylead launch --agent claude --request "Do the tasks in tasks/"` ;
   - une fois `a` livrée et la question de `b` posée, `kill -9` du processus du lead ;
   - `relaylead launch --name autre …` dans le même dossier ;
   - `relaylead stop`, puis `relaylead remove`.
5. **Mission 2,** relancée par la même commande dans le même dossier :
   - remplacer le hook `pre-merge-commit` par un hook qui sort en 1 ;
   - répondre « English and French » ;
   - quand la livraison de `b` est refusée, `relaylead task deliver b --no-hooks --mission essai-1-1`, puis répondre à la question du lead.
6. **Mission 3, sur une intégration neuve :**
   - `remove`, puis supprimer le worktree et la branche `relaylead/integration` ;
   - remettre le hook qui passe et ajouter un hook `commit-msg` qui charge `ms` depuis `node_modules`, comme husky ou commitlint ;
   - lancer la mission, puis arrêter le premier développeur dès son démarrage par `claude stop`, à l'aide d'une boucle sur `relaylead task list` ;
   - répondre « English only », puis livrer `a` et `b` par `--no-hooks` quand le lead le demande.
7. **Mission 4, sur une intégration neuve :**
   - commiter `.relaylead.json` avec `{"delivery": {"runHooks": false}}`, en gardant les deux hooks ;
   - répondre « English only ».

## Relevé

| Point | Résultat |
|---|---|
| Durées | Mission 1 : `a` livrée 32 s après le lancement. Mission 4 : 131 s du lancement à `done`, dont 87 s d'attente de la réponse humaine. Missions 2 et 3 : allongées par les interventions de l'essai |
| Sessions lancées | Mission 1 : le lead et un développeur. Mission 2 : le lead et un développeur (`a` déjà livrée). Mission 3 : le lead et trois développeurs (`a` deux fois, `b`). Mission 4 : le lead et deux développeurs |
| Lead tué par `kill -9` | Claude Code relance aussitôt la même session en `--resume`, avec un nouveau PID |
| Verrou du dossier | `relaylead launch` dans le même dossier : `dir-busy`, la mission étant `waiting` (lead tué) puis `working` (mission 3) ; aucune mission `autre` créée |
| `relaylead stop` | Plus aucune session de la mission, y compris le lead relancé par Claude ; mission `stopped` |
| `relaylead remove` puis relance | Acceptée sans `dir-busy` ni `mission-exists`. L'intégration et son worktree sont gardés : `a`, déjà `done` sur l'intégration, apparaît `delivered` et n'est pas refaite |
| Développeur arrêté en plein travail | Arrêt 1 s après le lancement ; `a` passe `failed` 3 s plus tard (« crew session ended without a result ») |
| Relance par le lead | `relaylead task retry a` 6 s après l'échec, première tentative archivée dans `tasks/archive/a.1.json` ; la seconde se termine en 20 s et la tâche est livrée |
| Hook `pre-merge-commit` qui refuse | `hook-failed`, fusion annulée, intégration propre. 3 s plus tard, le lead pose `deliver-b` : sortie du hook, aucune tâche dépendante, commande `--no-hooks` |
| Hook `commit-msg` qui a besoin de `node_modules` | Le worktree d'intégration n'est pas installé, donc le hook refuse. Même chemin : la question cite « module ms introuvable », nomme `b` comme dépendante de `a` et propose d'installer `node_modules` ou de livrer par `--no-hooks` |
| `--no-hooks` | Livre la tâche ; aucun des deux hooks n'est lancé (aucune ligne dans le fichier du hook) |
| `"delivery": {"runHooks": false}` | Mission 4 : les deux livraisons passent avec les deux hooks en place, sans question ni ligne de hook |
| Commits techniques | Chaque livraison donne une fusion suivie de `chore(relaylead): deliver <id>` |
| Ligne du hook qui passe | Écrite à chaque livraison avec hooks (`relaylead/integration`) |
| Installation des dépendances | Les développeurs disent dans leur résumé avoir lancé `npm ci --ignore-scripts` ; `node_modules/ms` est présent dans le worktree de tâche |
| Refus du garde-fou | Aucun : pas de `journal.log` dans les quatre missions |
| Worktrees restants | Seulement celui d'intégration, à chaque fin de mission |
| Sessions restantes après `done` | Missions 2 et 4 : aucune en moins de 15 s. Mission 3 : voir le défaut n°63 |
| Dossier de l'utilisateur | Inchangé : `main` ne porte que les commits de l'essai, aucun fichier modifié |

## Défauts trouvés

- **#63 :** après `state set done`, Claude peut laisser le lead `working` et `idle`. Le reaper ne regarde que `state`, donc il attend son délai de 10 min avant de l'arrêter (mission 3 ; pas aux missions 2 et 4).
- **#64 :** la commande `--no-hooks` citée dans la question du lead n'a pas `--mission`, et le registre garde `"pid": null` pour le lead.

Pendant l'essai, la CI de `main` a aussi montré une instabilité déjà connue sous Windows, sans rapport avec cet essai : #62.
