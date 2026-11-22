# Lot B : la console dans Claude (0.2)

Conception : `docs/specs/2026-11-22-relaylead-console-design.md`, §5.1, §5.3 (priorité, chevauchement), §5.4 (decisions.md), §8 point 7. Hors périmètre : fusion dans main et `relaylead merge` (lot A2), multi-mission côté cœur (lot A1).

## Tâches

1. **CLI de la console.**
   - `relaylead tell <mission> <texte>` : un fichier par message dans `missions/<m>/told/<nnnnnn>.json` (écrit une fois, par `tell` seul), refus depuis une session, pour une mission inconnue ou finie ; réveil du lead par une passe ciblée. Le message est un changement de genre `message` (avec son texte) dans `relaylead wait` du lead, et le motif de réveil du veilleur le dit.
   - `relaylead wait --all [--timeout s]` : événements de toutes les missions de la machine (question ouverte, tâche échouée, mission finie ou arrêtée), chacun nommant sa mission ; vue mémorisée dans `~/.relaylead/console-snapshot.json`, écrite par cette commande seule, sans toucher aux `wait-snapshot.json` des leads. Sans snapshot, une mission déjà finie n'est pas un événement.
   - `relaylead decision <texte>` et `decision --list` : une ligne par décision dans `decisions.md` de la mission, par le lead.
   - Consigne du lead (`catalog/profiles/lead.md`) : lit les consignes à son réveil, lit et note les décisions.
   - Erreurs codées en anglais et en français ; tests (`test/console.test.js`).
2. **Skill `relaylead`** (`plugin/skills/relaylead/SKILL.md`) : vérification d'installation, init conversationnel, rédaction et lancement, attente en tâche de fond, questions telles quelles, consignes, suivi, reprise à l'ouverture, priorité et chevauchement.
3. **Docs** : README (démarrage par `/relaylead`) et `docs/guide.md`.
