# Lot C (0.2) : mémoire de projet

Conception : `docs/specs/2026-11-22-relaylead-console-design.md` §5.4 et §8 point 5.

## Décisions

- Fichier : `<projet>/.relaylead/memoire.md`, toujours dans le dossier du projet de la mission (`mission.dir`, chemin absolu du dépôt principal), jamais dans un worktree.
- Commandes du lead : `relaylead memory show` (lecture, avec avertissement si le plafond est dépassé) et `relaylead memory write --file <f> | --text "<texte>"` (remplace la mémoire ; `\n` dans `--text` vaut un saut de ligne, car le lead ne peut écrire qu'une ligne par commande).
- Écriture sous verrou `~/.relaylead/locks/memory-<hash du dépôt>.lock`. L'ancienne version est copiée dans `.relaylead/memoire-archive/<date>.md` avant d'être remplacée ; l'archive n'est jamais lue.
- Un texte au-dessus du plafond est refusé : la compaction doit le respecter.
- Réglages `.relaylead.json` : `memory.enabled` (true), `memory.maxLines` (200), `memory.versioned` (false : `.git/info/exclude` reçoit le fichier et l'archive).
- `init` pose deux questions (activer ; versionner), `--yes` prend les défauts. `doctor` signale (warn) une mémoire au-dessus du plafond dans le projet courant.
- Consigne du lead : lire la mémoire au démarrage et à la relève (compacter d'abord si l'avertissement apparaît) ; compacter avant de se déclarer terminé.

## Tâches

1. Plan (ce fichier).
2. `core/memory.js`, réglages par défaut, messages, commande `relaylead memory`.
3. Consigne du lead et texte de démarrage.
4. `init` et `doctor`.
5. Docs (guide, README, skill de console).
6. Tests `node --test`.
