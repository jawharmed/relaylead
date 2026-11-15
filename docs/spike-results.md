# Résultats de l'essai jetable (lot 0)

- Date : 2026-11-15 01:06 CET
- Claude Code : 2.1.325 (Claude Code)
- Système : macOS 15.7.9, 12 cœurs, Node v24.19.0
- Charge au départ : 7.34 9.76 9.60
- Isolation : sessions lancées par `spike/launch.js` avec `--setting-sources project,local --strict-mcp-config` (sans les plugins, MCP ni hooks de l'utilisateur), sauf variante `--mode user`.

## Points

| Point | Résultat | Preuve | Conséquence |
|---|---|---|---|
| 2a. `--session-id` avec `--bg` | **Échec** | « warning: --bg manages the session id; ignoring --session-id » | L'identifiant se lit dans la sortie (`backgrounded · <id court> · <nom>`) puis dans `claude agents --json` (`sessionId` complet, dont l'id court est le préfixe). Spec : supprimer `--session-id`. |
| 2b. Définition d'agent en `--bg` | **Partiel** | `--agents <json>` : « no agent named … — spawning with default template », consignes ignorées. `--plugin-dir` + `--agent plugin:nom` : même avertissement mais consignes appliquées, **effort du profil ignoré** (`medium` au lieu de `low`). Options directes `--append-system-prompt`, `--model`, `--effort`, `--allowedTools` : **tout appliqué** (consignes, haiku, effort `low`) | L'adaptateur Claude traduit un profil en **options de lancement**, pas en définition d'agent. `--agents` reste utilisable au premier plan (`-p`). |
| 2c. Noms | **À gérer par Relaylead** | Deux sessions `rl-e2/lead/1` acceptées en même temps ; `claude logs rl-e2/lead/1` : « 3 sessions match … Use more of the name, or the id » (inclut `…/10`) | L'unicité des noms est à la charge de Relaylead ; toute commande vers une session passe par son id court, jamais par son nom. |
| 2d. États observés | Relevé | `working` ; `blocked` + `status: idle` (tour fini en attente d'une entrée : la session avait posé une question) ; `done` + `idle` (tour fini sans attente) ; `stopped`, `failed` (doc). `waitingFor` absent hors demande | `blocked` ne veut pas dire bloqué : c'est « attend une entrée ». Le veilleur ne doit jamais l'arrêter sur ce seul état. |
| 2e. Garde d'isolation des sessions `--bg` | **Découverte** | Write refusé : « This background session hasn't isolated its changes yet. Call EnterWorktree first… » dans un dépôt git partagé | Un équipier qui modifie un dépôt doit entrer dans un worktree (cohérent avec la spec). Le lead n'écrit son état que par l'outil `relaylead` (Bash), pas par Edit/Write. |
| 2f. Dossier non approuvé | **Découverte** | « Workspace not trusted. Run `claude` in … once and accept the trust prompt » | L'assistant `init` doit faire approuver le dossier de la mission (lancement interactif de `claude` une fois), sinon `launch` échoue. |
| 1. Barre d'état d'une session `--bg` lancée par une autre session | **Réussi** | Relevé écrit par la sonde pour la session lancée depuis cette session ; `total_input_tokens` = 38 388 = calcul depuis le transcript (écart nul) ; `context_window_size` = 1 000 000 ; `rate_limits` présents | Les deux sources concordent ; le transcript suffit si la barre d'état manque. |

## Observations hors points

- `--restricted` (Claude Code 2.1.325) retire Bash et les outils qui exécutent du code ainsi que WebFetch (sauf si `--tools` les nomme), ignore les réglages utilisateur/projet/local et confine les outils de fichiers aux dossiers de travail : base naturelle du profil `web-reader` en quarantaine (avec `--tools WebFetch,WebSearch`).
- `--safe-mode` désactive aussi les hooks : inutilisable pour les sessions d'équipe.
- `node --test spike/` (dossier) échoue sous Node 24 : utiliser un motif `node --test 'spike/*.test.js'`.

## Ce qui change dans le design
