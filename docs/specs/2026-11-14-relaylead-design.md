# Relaylead : des équipes d'agents IA qu'on lance sur n'importe quelle mission

Design du 15 novembre 2026, version 6 (amendée par l'essai jetable : [`docs/spike-results.md`](../spike-results.md)). **Relaylead** est un nom de code ; le nom public sera choisi avant la première publication. Ce document est en français ; le produit est en anglais par défaut, avec le français.

## Intention

Un **outil open source pour le grand public** qui permet de confier un travail (tâches d'un projet, demande libre, recherche, contenu…) d'un simple appel à un **lead** qui le mène seul avec **son équipe** de spécialistes, en arrière-plan, sans que l'utilisateur soit devant le terminal. Le lead tient dans la durée : il passe le relais à une session neuve quand son contexte se remplit, se met en pause avant les limites d'usage et reprend seul ensuite.

Relaylead ne dépend **d'aucune IA en particulier** : un cœur commun pilote des agents en ligne de commande (Claude Code, Codex CLI, Gemini CLI…) à travers des **adaptateurs**. La version 1 livre l'adaptateur Claude Code.

Principes :
- **Rien d'imposé** : aucun service externe, aucun outil (GitHub, ntfy, tableau web…) n'est obligatoire ; tout confort supplémentaire est proposé et s'active par configuration.
- **Sûr par défaut** : les réglages de départ protègent un utilisateur qui découvre l'outil ; les modes plus permissifs se choisissent explicitement, avec avertissement.
- **Configurable sans code** : équipes types, profils, méthodes, sources de tâches, canaux d'alerte.
- **Dégradation douce** : chaque agent offre plus ou moins de prises (sessions en arrière-plan, hooks, mesures) ; Relaylead utilise la meilleure disponible et se replie sur une plus simple, sans casser.
- **Simple** : code lisible par un débutant, sans abstraction « au cas où ».

Défauts constatés sur un prototype d'orchestrateur fait à la main, qui servent de cahier des charges :

| Défaut constaté | Exigence |
|---|---|
| Le superviseur arrêtait des leads qui attendaient leurs agents : une douzaine de chantiers perdus en quelques jours | La mort ou la relève d'un lead ne perd jamais de travail ; jamais d'arrêt au seul motif qu'une session attend |
| Une session zombie de plusieurs heures en parallèle de deux autres | Un seul lead vivant par mission, garanti par verrou |
| Journal de plusieurs dizaines de Ko relu et réécrit à chaque étape ; heures inventées | État court en fichiers, écrit par un outil ; archive à part ; heure prise par l'horloge système |
| Machine surchargée, conteneurs et volumes de tests laissés derrière | Plafond de travaux lourds imposé ; nettoyage garanti |
| Questions à l'humain oubliées | Questions tenues par l'outil, séparées de l'historique |
| Quotas codés en dur pour une session | Limites d'usage arbitrées entre toutes les missions |

## Public de la version 1

- Agent : **Claude Code** (adaptateur livré). Abonnés **Pro ou Max** : limites 5 h et hebdomadaire gérées précisément. **Clé API** : acceptée, limites gérées par budget ou par réaction (voir Mesures).
- Systèmes : **macOS, Linux (WSL compris), Windows**.
- Langue : **anglais par défaut, français**.
- Distribution : **open source, licence MIT** ; paquet npm `relaylead` (l'outil) + intégration Claude Code sous forme de plugin, installée par l'outil.
- **Aucune télémétrie.**

## Vocabulaire (termes du produit entre parenthèses)

- **Agent** (*agent*) : un outil d'IA en ligne de commande (Claude Code, Codex CLI…).
- **Adaptateur** (*adapter*) : le module qui sait piloter un agent.
- **Profil** (*profile*) : un spécialiste réutilisable : agent, rôle, consignes, skills, modèle, effort, outils permis.
- **Méthode** (*method*) : la boucle d'un type de mission et ses critères de fin.
- **Équipe type** (*team template*) : une méthode + une sélection de profils + des réglages, dans un fichier.
- **Mission** (*mission*) : un travail confié à une équipe type, sur un dossier. Elle a son propre lead.
- **Lead** (*lead*) : une définition, une session par mission ; découpe, distribue, vérifie, livre, pose les questions ; ne produit pas lui-même.
- **Équipier** (*crew member*) : une session jetable qui fait une tâche avec un profil, puis s'arrête.
- **Source de tâches** (*task source*) et **livraison** (*delivery*).
- **Veilleur** (*watcher*) : programme sans IA, commun à toutes les missions, lancé toutes les 5 min par le planificateur du système.
- **Tableau** (*board*) et **pilotage** (*control session*) : suivi à distance (v1.1).

## Objectifs

1. Lancer une mission de partout, mêmes paramètres : `relaylead launch …` au terminal, commande intégrée dans l'agent (`/relaylead:launch …` dans Claude Code), une phrase au pilotage (v1.1).
2. Plusieurs missions en même temps, sur des projets différents, avec une priorité par mission.
3. Le lead tourne en arrière-plan ; `relaylead show <mission>` ouvre toujours le lead actuel.
4. Relève de contexte autonome, sans perte d'état.
5. Pause avant les limites d'usage selon la priorité, reprise seule ensuite.
6. Suivre les missions et répondre aux questions sans être au terminal.
7. Créer une équipe type, un profil, une méthode par configuration ; ajouter un agent en écrivant un adaptateur.
8. Équipes mixtes possibles (profils sur des agents différents) dès que plusieurs adaptateurs existent.

## Non-objectifs

- Cloud, plusieurs machines.
- Adaptateurs autres que Claude Code en version 1 (Codex CLI vient ensuite, puis d'autres, contributions bienvenues).
- Refaire ce que les agents donnent déjà (sessions en arrière-plan, sous-agents, worktrees…).

## Anti-objectifs

- Du travail perdu en silence ; deux leads sur une mission ; un lead qui mélange deux projets.
- Un réglage dangereux imposé à un utilisateur qui découvre l'outil.
- Casser la configuration existante de l'utilisateur (barre d'état, hooks, réglages de ses agents).
- Avoir besoin du terminal pour suivre ou débloquer une mission.

## Contraintes vérifiées (Claude Code 2.1.325)

- Contexte et limites d'usage exposés par la barre d'état (`context_window.used_percentage`, `rate_limits.five_hour|seven_day.used_percentage|resets_at`, ce dernier seulement pour Pro/Max) ; aucun hook ne les reçoit. Les hooks reçoivent le chemin du transcript, qui contient l'usage en jetons de chaque réponse.
- `claude --bg`, `claude agents --json`, `attach`, `logs`, `stop`, `rm`, `respawn`, `--resume`, `--name`, `--append-system-prompt`, `--effort`, `--model`, `--allowedTools`, `--permission-mode`. **Vérifié par l'essai** : `--session-id` est ignoré avec `--bg` (l'id se lit dans la sortie) ; `--agents <json>` est ignoré en `--bg` et l'effort d'un agent de plugin aussi ; les options à valeurs multiples (`--allowedTools`…) avalent la consigne si elles la précèdent ; le dossier de la session doit avoir été approuvé une fois ; une session `--bg` doit entrer dans un worktree avant de modifier un dépôt git.
- Hooks utiles : SessionStart, PreToolUse, PostToolUse, PermissionRequest, Stop, StopFailure (erreur `rate_limit` ; le dernier message donne une heure de reprise lisible, ex. « resets 2:54am (Europe/Paris) »), SubagentStart/Stop, PreCompact.
- Après une mort brutale (`kill -9`), le démon de Claude Code a relancé seul la session (même id, message « Continue from where you left off » ; une observation, sous macOS). Une session arrêtée n'est pas relancée ; le redémarrage de la machine n'a pas été essayé : il faut un veilleur extérieur. Aucune commande n'envoie un message à une session vivante : le veilleur passe par des fichiers et par le réveil.
- « Agent teams » (expérimental) ne survit pas à la fin de session.
- La façon dont les limites d'abonnement comptent le cache de prompt n'est pas publiée.
- Les hooks d'un plugin s'appliquent à toutes les sessions de l'utilisateur ; ceux passés par `--settings` à un lancement ne s'appliquent qu'à cette session. `--setting-sources`, `--strict-mcp-config` et `--plugin-dir` permettent d'isoler une session de la configuration de l'utilisateur.
- `PermissionRequest` ne se déclenche que si une demande allait s'afficher (jamais en mode sans autorisations) ; un refus indépendant du mode passe par `PreToolUse` (prouvé en mode manuel et en liste blanche élargie ; à vérifier avec le mode sans autorisations natif au lot 3).
- Une session qui a fini son tour (`blocked`) ne reçoit plus de hooks : un message en boîte aux lettres ne l'atteint pas tant qu'elle n'est pas réveillée.
- `claude stop` et `claude rm` prennent l'identifiant court de la session ; seuls `attach` et `logs` acceptent un nom (même partiel).

## Approches considérées

**Où tournent les équipiers :**
- **A allégée (retenue)** : équipiers jetables, une session en arrière-plan par tâche ; consigne en fichier en entrée, livraison et fichier de résultat en sortie ; pas de conversation ni de relève d'équipier. Lead sans mémoire : il relit l'état et la réalité à chaque étape. Relectures courtes en sous-agents quand l'agent en a.
- A (équipiers longs avec conversation, messagerie et relève par équipier) : système distribué lourd. Écartée.
- B (équipiers en sous-agents du lead) : la mort du lead emporte le travail. Écartée.
- C (Agent teams de Claude Code) : rien ne survit à la session, propre à un agent. Écartée pour l'instant.

**Quelle IA :**
- **Cœur indépendant + adaptateurs, Claude Code d'abord (retenue)** : interface d'adaptateur dès le départ, un seul adaptateur livré en v1.
- Plusieurs adaptateurs en v1 : plus attractif, mais tout à vérifier et tester par agent et par système ; v1 nettement retardée. Écartée.
- Plugin Claude Code seul : plus simple, mais généraliser plus tard demanderait de réorganiser le cœur. Écartée.

## Décisions de conception

1. Plusieurs missions à la fois ; un veilleur unique arbitre limites d'usage et charge selon la priorité.
2. Un lead par mission ; types de mission par méthodes ; équipes types par configuration ; deux ou trois équipes types livrées au départ.
3. Équipiers jetables, lead sans mémoire.
4. Aucun outil imposé : source de tâches et livraison se configurent par projet.
5. Sessions nommées lisiblement (`<mission>/lead/<n>`, `<mission>/<profil>/<n>`), unicité contrôlée ; identifiant technique en coulisses.
6. Relève : seuil relatif à la base mesurée, plafonné par un pourcentage.
7. Questions sans réponse : on attend par défaut ; « appliquer la recommandation après un délai » est un réglage. L'irréversible attend toujours.
8. Autorisations : liste blanche par défaut ; une demande hors liste devient une question ; le mode « tout autorisé » se choisit explicitement, avec avertissement ; rien n’attend jamais un humain.
9. Web en quarantaine pour les profils qui ont des accès en écriture ; l'outil n'impose aucune limite sur les accès confiés, il les conseille.
10. Alertes : liste de canaux essayés dans l'ordre, chacun avec sa condition ; aucun canal externe imposé.
11. Version 1 = moteur ; version 1.1 = tableau et pilotage.
12. Assistants : `init` et `new-team`.
13. Public : macOS + Linux + Windows, anglais + français, abonnés et clés API.
14. Implémentation en Node.js (18 ou plus), sans étape de compilation.
15. Open source, licence MIT ; nom public à choisir.
16. Cœur indépendant de l'IA, adaptateurs ; Claude Code en v1.
17. Aucune mention de projets réels de l'auteur dans ce qui est public.
18. Hooks et barre d'état de mesure passés à chaque lancement de session d'équipe (`--settings`), jamais installés globalement ; le plugin ne porte que les commandes `/relaylead:*`.
19. Dépôt public dès le début du développement, avec tests automatiques sur macOS, Linux et Windows (faux agent, sans compte Claude) ; essais avec le vrai Claude sous Windows sur une machine réelle avant la publication.

## Le design

### Architecture

```
relaylead (paquet npm, Node.js)
  bin/relaylead        launch, list, show, pause, resume, stop, answer, task, state, token,
                       watcher, install, uninstall, doctor
  core/                missions, tâches, questions, état, configuration, veilleur, alertes,
                       jetons, mesures, garde-fous communs
  sources/             tasks-dir (fichiers du dépôt), github-issues, request (demande libre)
  deliveries/          github-pr, local-merge, files
  adapters/claude/     pilotage de Claude Code : réglages de session (hooks, barre d'état,
                       options du profil) passés à chaque lancement ; plugin réduit aux
                       commandes /relaylead:*
  profiles/ methods/ teams/   catalogue de départ, indépendant de l'agent (anglais, français)
```

Contrat d'un adaptateur (chaque capacité déclare son niveau ; le cœur s'adapte) :

| Capacité | Rôle | Claude Code (v1) |
|---|---|---|
| `launch` | lancer une session en arrière-plan avec profil, nom, consigne, mode d'autorisation ; rendre son identifiant | options à valeurs multiples d'abord, puis `claude --bg --name … --settings …` ; id court lu dans la sortie, id complet par `claude agents --json` ; vérifier le premier tour |
| `resume` / `stop` / `list` | reprendre, arrêter, lister les sessions et leur état | `--resume`, `claude stop`, `claude agents --json` |
| `attach` | ouvrir une session pour la regarder | `claude attach` |
| `context` | mesurer le contexte utilisé | exact (barre d'état ou transcript) |
| `usage` | mesurer les limites d'usage | exact (Pro/Max), sinon budget / réaction |
| `inject` | faire lire un message à une session vivante | hook qui lit la boîte en fichiers |
| `guard` | refuser une action avant qu'elle soit faite | hooks PreToolUse / PermissionRequest |
| `heartbeat` | signe de vie à chaque action | hook PostToolUse |
| `profile` | traduire un profil Relaylead en réglages propres à l'agent | options de lancement : `--append-system-prompt`, `--model`, `--effort`, `--allowedTools`, `--permission-mode` (aucune écriture dans `~/.claude/agents`) |
| `subagents` | relectures courtes dans la session | oui |
| `session-settings` | fournir hooks, mesure du contexte, environnement et attribution des commits à la seule session lancée | `--settings` (hooks, barre d'état, `env`, `attribution`) + `--setting-sources project,local --strict-mcp-config` |
| `wake` | réveiller une session inactive avec un message | `claude stop <id>` → attendre la fin du processus (délai maximal) → `claude --bg --resume <sessionId> "<message>"` **sans options**, depuis le dossier de la session → vérifier que la sortie nomme le même id (sinon c'est une copie : l'arrêter, alerter). Le hook `Stop` retient en plus la fin d'un tour quand un message attend |
| `install` | brancher les commandes intégrées | plugin réduit aux commandes `/relaylead:*` |

Une session garde les options de son lancement : en changer demande une session neuve.

Sans `inject`, le cœur passe les messages au prochain lancement ou à la reprise ; sans `guard`, le mode « tout autorisé » est refusé pour cet agent et seuls ses propres mécanismes d'autorisation s'appliquent ; sans `heartbeat`, le veilleur se fie à l'activité du transcript.

### Mesures : contexte et limites d'usage

Chaque adaptateur fournit la meilleure source disponible, dans cet ordre :

- **Contexte** : (1) relevé exact de l'agent (barre d'état) ; (2) **calcul depuis le transcript** (jetons de la dernière réponse : entrée + cache) ; (3) limite simple en nombre de tours ou en durée, réglable.
- **Limites d'usage** : (1) **chiffres exacts** de l'agent (pourcentages et heures de remise) ; (2) **budget** fixé par l'utilisateur (sessions simultanées, heures de travail par fenêtre, jetons comptés dans les transcripts, dollars pour une clé API) ; (3) **réaction** : à l'erreur de limite, pause de la mission et reprise à l'heure indiquée par l'erreur si elle existe, sinon essais espacés (15 min, 30 min, 1 h…).
- Les relevés sont écrits avec leur heure dans `~/.relaylead/usage.json` (par agent) ; un relevé de plus de 30 min est considéré comme inconnu (pas de nouveau lancement sur cette base).
- Barre d'état : celle de l'utilisateur n'est jamais touchée. Chaque session d'équipe reçoit, par `--settings`, sa propre barre d'état de mesure (invisible, elle ne fait qu'écrire les relevés). Si l'agent n'en a pas, on se passe d'elle (transcript, budget, réaction).

### Où vivent les choses

```
~/.relaylead/                          machine (chemin équivalent sous Windows)
  config.json                          configuration machine
  profiles/ teams/ methods/            ajouts de l'utilisateur
  usage.json                           derniers relevés d'usage, par agent, avec leur heure
  tokens/                              verrous des travaux lourds (PID dedans)
  watcher.lock, watcher.log, STOP
  missions/<nom>/
    mission.json                       paramètres figés au lancement
    lead.json                          état du lead
    tasks/<id>.json                    une tâche : profil, consigne, étape, session, branche, résultat
    questions/<id>.json                une question : texte, options, recommandation, état, réponse
    mailbox/<destinataire>/<horodatage>.md
    journal.md                         court (< 3 Ko)
    archive/AAAA-MM-JJ.md
```

Règles d'écriture : un fichier par rédacteur, écriture atomique, **uniquement par l'outil `relaylead`**, jamais par édition directe d'une IA. La réalité (sessions, état de la source et de la livraison, worktrees) fait foi ; l'état est un cache rapproché au démarrage de chaque lead.

Profils : ceux du catalogue, ceux de l'utilisateur (`~/.relaylead/profiles/`), ceux du projet (`.relaylead/profiles/`, prioritaires). Un profil est un fichier Markdown avec un en-tête (agent, modèle, effort, skills, outils) et ses consignes ; l'adaptateur le traduit pour son agent.

### Configuration

| Niveau | Où | Contenu |
|---|---|---|
| Machine | `~/.relaylead/config.json` | langue, agents installés, mode d'autorisation, canaux d'alerte, seuils et budgets d'usage par priorité, jetons lourds, plafond de sessions, questions sans réponse, résumé quotidien |
| Projet | `.relaylead.json` (et `.relaylead/` pour profils propres) | source de tâches, livraison, branche d'intégration, interdits, commandes lourdes, liste blanche en plus |
| Mission | paramètres de lancement | équipe type, demande, priorité, parallélisme, réglages ponctuels |

Secrets : uniquement des références (`env:NOM`, `file:chemin`), jamais la valeur.

Paramètres d'une mission : `name` (défaut : nom du dossier), `dir` (défaut : dossier courant), `team` (défaut : deviné par le lead), `request` (obligatoire), `priority` (`high` / `normal` / `low`), `parallel` (défaut 4). Une seule mission vivante par dossier en version 1.

### Sources de tâches et livraisons (version 1)

- Sources : **fichiers de tâches dans le dépôt** (un Markdown par tâche, en-tête titre / état / dépendances), **issues GitHub**, **demande libre** (le lead la découpe en tâches locales).
- Livraisons : **PR GitHub** vers la branche d'intégration, **branche fusionnée en local**, **fichiers dans un dossier**.
- Chaque source et chaque livraison est un petit module (lister, prendre, marquer fait ; livrer, vérifier livré).

### Cycle de vie

1. **Lancer** : l'outil vérifie l'unicité, écrit `mission.json`, démarre le lead par l'adaptateur de son profil, avec `RELAYLEAD_MISSION=<nom>`, dans le dossier de la mission, et enregistre l'identifiant rendu par l'adaptateur.
2. **Travailler** : le lead lit `mission.json`, son état, la source et les sessions vivantes ; choisit les tâches prêtes ; écrit `tasks/<id>.json` et lance un équipier par tâche (adaptateur du profil, consigne en fichier). L'équipier travaille (worktree propre pour du code), pousse tôt et souvent quand la livraison le permet, écrit son résultat, s'arrête. Le lead fait relire, livre, marque la tâche faite. Une correction = une nouvelle tâche sur la même branche.
3. **Relève** : `seuil = min(base + budget_profil, plafond % × fenêtre)` ; base = première mesure de la session (essai : environ 40 k jetons pour une session isolée, 52 k avec la configuration de l'utilisateur) ; budget par profil (départ : lead 150 k, équipier 250-300 k, à caler) ; plafond 40 % ; seuil souple (« à la prochaine étape finie ») et dur (+20 %). Alerte si la base dépasse la moitié du seuil. Le lead écrit son état, `state: handover`, s'arrête sans attendre ses équipiers ; le veilleur lance le suivant dans le même passage. Un équipier au seuil dur pousse, note où il en est, s'arrête ; le lead relance la tâche.
4. **Limites d'usage** : seuils de pause par priorité (réglables) quand la mesure est exacte :

   | Priorité | Pause hebdomadaire | Pause 5 h |
   |---|---|---|
   | low | 70 % | 80 % |
   | normal | 90 % | 85 % |
   | high | 98 % | 85 % |

   Avec un budget, mêmes règles sur le budget ; en réaction, pause à l'erreur. Pause : la session pousse et s'arrête ; `state: usage-pause` et heure de reprise ; reprise par le veilleur à l'heure venue.
5. **Questions** : le lead crée `questions/<id>.json` (contexte, ce qui est prêt, question en une phrase, options, recommandation en premier), alerte, passe à autre chose. Réponse par `relaylead answer`, la commande intégrée, le tableau (v1.1). Sans réponse : attendre (défaut) ou appliquer la recommandation après le délai configuré, jamais pour l'irréversible.
6. **Demande hors liste blanche** : le garde-fou la refuse avec un message explicite et crée une question (autoriser une fois / toujours pour ce projet / refuser) ; la session continue autrement ou passe à autre chose.
7. **Irréversible** : branche principale, tags, déploiement, publication, envoi de mail, paiement, secrets. Le lead prépare et pose la question ; un « oui » crée une autorisation à usage unique, consommée une fois par le garde-fou.
8. **Fin** : demande faite → le lead arrête ses équipiers, fait le ménage, écrit le bilan, `state: done`, alerte.
9. **Résumé quotidien** (désactivé par défaut).

### Le veilleur

Programme Node.js lancé toutes les 5 min par le planificateur du système (launchd, timer systemd utilisateur ou cron, Planificateur de tâches Windows), installé par `relaylead install`. Verrou pour tout son passage ; `STOP` présent → ne fait rien. Pour chaque mission non terminée :

- **Un seul lead** : arrêter toute session de lead qui n'est pas celle de `lead.json`.
- **Lead absent**, mission ni en pause ni en attente → relancer (reprise si son contexte est bas, sinon session neuve).
- **Relève** demandée → arrêter l'ancienne, lancer la nouvelle.
- **Équipier mort** sans résultat → message au lead ; lead absent aussi → relancer le lead d'abord.
- **Bloqué ou en attente** : distingués par le battement de cœur (ou l'activité du transcript). Jamais d'arrêt au seul motif « en attente » (`blocked` veut dire « attend une entrée »).
- **Relance automatique en cours** : une session `working` sans processus est en cours de relance par Claude Code : délai de grâce avant toute action. Les actions du lead passent par `relaylead` et sont idempotentes, car une relance peut en rejouer une. Après `claude respawn` (mise à jour de Claude Code), le lead reste inactif : le veilleur le réveille.
- **Réveil** : un lead qui attend termine son tour ; quand un équipier finit, qu'une réponse arrive ou qu'un message l'attend, le veilleur (ou l'outil, appelé par l'équipier en fin de tâche) le réveille par la capacité `wake` de l'adaptateur. Le lead ne tourne donc pas à vide pendant les longues attentes.
- **Disjoncteur** : 3 relances ratées d'affilée → mission arrêtée, alerte.
- **Usage et charge** : appliquer les seuils ; si la charge dépasse le plafond, ne plus lancer de session pour les missions `low`.
- **Ménage** : jetons dont le PID est mort libérés ; orphelins signalés.
- **Battement externe** facultatif.
- Une ligne par action dans `watcher.log`, heure réelle. `relaylead doctor` vérifie prérequis et compatibilité des agents installés.

### Alertes

La notification `system` (locale) part toujours quand elle est disponible, mais elle ne prouve pas que l'humain l'a vue : sous macOS, `osascript` répond « réussi » même quand l'Éditeur de script n'a pas le droit de notifier et que rien ne s'affiche. L'installation envoie donc une notification de test, demande à l'utilisateur s'il l'a vue et, sinon, lui dit quoi faire : l'Éditeur de script n'apparaît dans Réglages Système › Notifications qu'après une première demande, qu'on déclenche en ouvrant dans l'Éditeur de script un petit script de test à exécuter. Une fois autorisé, l'envoi depuis le terminal est reçu (vérifié). Ensuite, liste ordonnée de canaux distants, chacun avec une condition ; le premier qui réussit gagne :

```json
"alerts": [
  { "channel": "ntfy", "server": "https://ntfy.sh", "topic": "…", "token": "env:NTFY_TOKEN" }
]
```

Canaux v1 : `system` (notification locale du système, toujours envoyée en plus), puis, au choix et dans l'ordre configuré, `ntfy`, `command` (commande fournie par l'utilisateur : mail, Slack…), et `agent` (mini-session jetable d'un agent qui sait notifier le téléphone), en option seulement : l'essai a montré que l'outil de Claude Code refuse d'envoyer quand il juge le terminal actif, et ne pousse au téléphone qu'avec Remote Control.

### Garde-fous et autorisations

- **Liste blanche par défaut** (lire ; écrire dans le dossier de la mission et ses worktrees ; git sur les branches de travail ; commandes de test et de build déclarées) + liste blanche du projet. Hors liste → question.
- **Mode « tout autorisé »** : choisi explicitement, avec avertissement, seulement pour un agent dont l'adaptateur a `guard` ; les garde-fous restent actifs. Pour Claude, il s'écrit par la liste blanche élargie (`Bash` sans motif, outils de fichiers) : le mode sans autorisations natif est inaccessible à une session `--bg` isolée (il exige les réglages de l'utilisateur).
- **Rien n'attend un humain** : un hook `PermissionRequest` répond à toute demande restante (accord selon la liste, sinon refus avec message et question). Les consignes des profils demandent une commande par appel, car une commande composée est jugée en bloc.
- **Garde-fous communs** (par `PreToolUse`, actifs quel que soit le mode : prouvé en mode manuel et en liste blanche élargie, à vérifier avec le mode sans autorisations natif au lot 3) : secrets déclarés, push vers la branche principale ou des tags, push forcé, suppressions récursives hors du dossier de la mission, irréversible sans autorisation à usage unique.
- **Interdits du projet** dans `.relaylead.json`.
- **Web en quarantaine** : les profils qui ont des accès en écriture n'ont pas les outils web ; ils délèguent la lecture à un profil `web-reader` (outils web seuls) qui rend un résumé. Les profils purement web n'ont pas de push et livrent des fichiers.
- **Accès confiés** : l'outil n'impose rien ; l'assistant `init` explique et conseille.
- **Travaux lourds** : `relaylead token -- <commande>` (jetons : moitié des cœurs, au plus 3 ; PID ; nettoyage garanti) ; le garde-fou refuse les commandes lourdes déclarées lancées hors jeton.

### Respect de la configuration de l'utilisateur

- Barre d'état, hooks, réglages et définitions d'agents de l'utilisateur jamais modifiés. Les sessions d'équipe reçoivent leurs hooks et leur barre d'état par `--settings` à chaque lancement : rien ne s'applique aux autres sessions de l'utilisateur. Par défaut, elles sont aussi isolées de ses plugins et MCP (`--setting-sources`, `--strict-mcp-config`) ; un projet peut en réautoriser.
- `relaylead uninstall` retire tout ce qu'`install` a ajouté et laisse `~/.relaylead` sauf demande contraire.

### Assistants

- **`init`** (`relaylead init` ou `/relaylead:init`) dans un projet : fait approuver le dossier par l'agent si besoin (Claude Code refuse sinon de lancer une session `--bg`) ; source, livraison, branche d'intégration, interdits, commandes lourdes, liste blanche, conseils d'accès → `.relaylead.json`. À la première utilisation sur la machine : prérequis (Node 18+, agents installés et leurs versions, `gh` si GitHub est choisi), langue, mode d'autorisation (avec avertissement), mesures d'usage (exactes, budget ou réaction selon l'agent et le compte), canaux d'alerte, installation du veilleur et des intégrations → `~/.relaylead/config.json`.
- **`new-team`** : méthode, profils (choisis dans le catalogue ou créés : agent, rôle, skills, modèle, effort, outils), réglages → `~/.relaylead/teams/<nom>.json` et `~/.relaylead/profiles/`.

### Version 1.1 : tableau et pilotage

- **Tableau** : page de suivi en direct, réponses en un clic, accessible de partout ; **miroir** des fichiers locaux. Première forme : page privée sur claude.ai avec base de données, pour les utilisateurs de Claude ; d'autres formes ensuite (fichier HTML local, autres hébergements). Sans forme disponible, tout reste en local.
- **Pilotage** : une session commune joignable depuis le téléphone (Claude : Remote Control), sans mémoire propre, surveillée par le veilleur comme un lead ; lance, met en pause, arrête une mission et répond aux questions par l'outil. Les méthodes interactives (brainstorming) s'y mènent.

## À prouver d'abord (essai jetable, Claude Code)

1. Une session `--bg` lancée par une autre session écrit des relevés de barre d'état ; le calcul depuis le transcript donne le même contexte.
2. `--session-id` fonctionne avec `--bg` ; `--name` accepte `/` ; `--agents <json>` avec `--agent` fonctionne en `--bg`.
3. Un hook lit une boîte en fichiers et injecte le message dans la session.
4. Un équipier `--bg` survit à l'arrêt de la session qui l'a lancé.
5. Base réelle par profil à la première mesure.
6. Poids du cache dans les limites d'usage (tours rapprochés puis espacés).
7. Une mini-session `claude -p` (haiku, effort bas) envoie une notification au téléphone.
8. Le hook d'autorisation d'une session `--bg` peut refuser avec message et laisser la session continuer.
9. Mêmes comportements sous Windows (shell des hooks, chemins) et Linux.
10. L'erreur de limite d'usage (StopFailure `rate_limit`) est détectable et son message donne, ou non, une heure de reprise.
11. (v1.1) Une session `--bg` lit et écrit la base d'un artefact ; Remote Control joignable et capable de lancer des sessions.

Un échec sur 1, 3, 4, 8 ou 9 change le design et revient en discussion avant le plan.

**Résultat (15 nov. 2026)** : 1, 3, 4, 8, réveil et Linux prouvés ; 2 remplacé par les options de lancement ; 7 échoue pour le canal `agent` (non bloquant, ordre des canaux changé) ; 10 réussi par un faux serveur ; 6 reporté au lot 2b ; Windows reporté au lot 4. Détail : [`docs/spike-results.md`](../spike-results.md).

## Laissé au constructeur

- Structure du code Node.js, format exact des fichiers, contrat détaillé de l'adaptateur.
- Contenu des profils et méthodes de départ (anglais et français) ; choix de la troisième équipe type.
- Mécanique de traduction. Version minimale de Claude Code : 2.1.325 (celle de l'essai), vérifiée par `doctor`.
- Ordre de construction, l'essai jetable en premier.
