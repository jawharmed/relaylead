# Lot 1 : mission réelle avec Claude Code sur macOS

Relevé du 16 novembre 2026. Claude Code 2.1.325, Node 24, macOS. Relaylead `main` après la PR n°29.

## Procédure

1. `npm link` depuis le dépôt de Relaylead ; `relaylead --version` → `0.1.0`.
2. Copier `fixtures/toy-repo/` dans un dossier neuf, `git init -b main`, tout commiter.
3. Lancer `claude` une fois dans ce dossier et accepter « Yes, I trust this folder ».
4. Depuis ce dossier : `relaylead launch --agent claude --request "Do the tasks in tasks/"`.
5. Suivre par `relaylead list` et `relaylead question list <mission>`.
6. Répondre par `relaylead answer <mission> <id> <choix>`.
7. Attendre `relaylead state get --mission <mission>` = `done`, puis vérifier.

Un essai = une copie neuve du dépôt jouet : relancer une mission dans le même dossier est prévu pour un lot suivant.

## Relevé

| Point | Résultat |
|---|---|
| Durée | 65 s du lancement à `done`, dont 5 s d'attente de la réponse humaine |
| Sessions lancées | 3 : le lead (opus) et deux développeurs (sonnet), un par tâche |
| `relaylead` trouvé par les sessions | Oui, par le PATH donné dans les réglages de session |
| Question | Posée par le lead 13 s après le lancement, avant de lancer la tâche b, avec les options tirées du texte : « English only », « English and French », « Skip this task » |
| Réponse transmise au développeur | Oui : réponse « English and French », et `greet` accepte `lang` (`fr` → `Bonjour, <nom> !`) |
| Ordre des tâches | b lancée après la livraison de a, sa branche partant de l'intégration qui contenait déjà a |
| Refus du garde-fou | Aucun (journal vide) |
| Demande d'autorisation restée en attente | Aucune |
| Branches fusionnées dans `relaylead/integration` | Les deux (`relaylead/toy-1/a`, `relaylead/toy-1/b`), chacune suivie de son commit `chore(relaylead): <id> livrée` |
| Tests du dépôt jouet sur l'intégration | `npm test` : 3 réussis, 0 échec |
| Dossier de l'utilisateur | Inchangé : branche `main`, aucun fichier modifié |
| Worktrees restants | Seulement celui d'intégration |
| Sessions restantes après `done` | Aucun processus : les deux développeurs `stopped`, le lead `done` sans processus ; l'assistant de fin s'est terminé |

## Défauts trouvés

Aucun défaut bloquant. Les points de robustesse déjà connus (verrou suivant le PID du lead, relance dans le même dossier, tâche en échec non relançable, `npm install` autorisé avec ses scripts, hooks git des commits techniques) font l'objet du lot suivant.
