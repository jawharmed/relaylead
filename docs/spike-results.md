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
| 1. Barre d'état d'une session `--bg` lancée par une autre session | **Réussi** | `rl-e1/3` (haiku) : relevé écrit dès le premier tour, mis à jour à chaque tour (00:22:24, 00:22:45, 00:23:09), `env: "e1"` transmis par `--settings` ; contexte de la barre d'état = calcul du transcript (42 366, puis 42 791), écart maximal 0,028 % de la fenêtre (relevé pris entre deux écritures du transcript). Sur sonnet après lecture d'un fichier de 209 Ko : 121 816 des deux côtés, écart nul. `context_window_size` = 1 000 000, `rate_limits` présents (5 h : 54 %, semaine : 53 %). Mesure faite sans `attach` ni `logs` | Les deux sources concordent ; le transcript suffit si la barre d'état manque. L'environnement passé par le champ `env` de `--settings` atteint les commandes de la session. |
| 5. Base réelle à la première mesure | Relevé | Session isolée (haiku, « Réponds OK. ») : 40 505 jetons ; mêmes réglages avec la configuration de l'utilisateur (`--mode user` : plugins, skills, MCP) : 51 973 jetons, soit +11 468 (+28 %). Autres sessions isolées haiku : 38 388 à 42 366 | La base dépend surtout de la configuration chargée : la relève doit partir de la première mesure réelle de chaque session, pas d'une constante. Le lancement isolé est le défaut sain. Le `statusLine` passé par `--settings` l'emporte sur celui de l'utilisateur, même en `--mode user`. |
| 2g. Ordre des options | **Découverte** | Avec `--allowedTools A B C` placé juste avant la consigne, la session démarre « idle — send a prompt to start » : la consigne a été prise pour un nom d'outil | L'adaptateur place les options à valeurs multiples (`--allowedTools`, `--tools`, `--add-dir`…) avant les autres, ou passe la consigne autrement, et vérifie que la session a bien démarré (premier tour dans le transcript). |
| 2h. Liste blanche et commandes composées | **Découverte** | Consigne « fais 3 fois `node …wait.js` et dis l'heure » : la session écrit une boucle `for … ; date` et reste bloquée sur une demande d'autorisation (`waitingFor: "permission prompt"`) malgré `Bash(node *)` | Une liste blanche par préfixe refuse les commandes composées : les consignes des profils doivent demander une commande par appel, et le garde-fou de Relaylead (lot 3) doit transformer ces demandes en refus avec message, jamais en attente. |

## Observations hors points

- `--restricted` (Claude Code 2.1.325) retire Bash et les outils qui exécutent du code ainsi que WebFetch (sauf si `--tools` les nomme), ignore les réglages utilisateur/projet/local et confine les outils de fichiers aux dossiers de travail : base naturelle du profil `web-reader` en quarantaine (avec `--tools WebFetch,WebSearch`).
- `--safe-mode` désactive aussi les hooks : inutilisable pour les sessions d'équipe.
- `node --test spike/` (dossier) échoue sous Node 24 : utiliser un motif `node --test 'spike/*.test.js'`.

## Ce qui change dans le design
