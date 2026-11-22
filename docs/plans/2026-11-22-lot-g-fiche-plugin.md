# Lot G : fiche du plugin et du paquet

Conception : `docs/specs/2026-11-22-relaylead-0-3-design.md`, §2.3, §3 et §5.

## Tâches

1. **Métadonnées.** Auteur « Lilia Digital » (sans e-mail) dans `plugin.json`, `marketplace.json` (propriétaire et entrée) et `package.json`. Ajout de `homepage`, `repository`, `keywords`, `displayName` au manifeste du plugin, selon la référence officielle.
2. **README du plugin** (`plugin/README.md`, en anglais) : ce que fait le plugin, installation, commandes, console, lien vers le guide. Plus de 40 mots hors blocs de code (règle de l'annuaire).
3. **Icône.** SVG sobre (un relais), dans le dossier du plugin, déclarée par le champ `icon` de `plugin.json` (lu par l'annuaire, ignoré par Claude Code).
4. **Validation.** `claude plugin validate plugin` sans avertissement ; test du dossier du plugin mis à jour ; `npm pack --dry-run` vérifié.
5. **Hors dépôt.** Textes de soumission à l'annuaire et d'annonce dans `relaylead-orchestration/suivi/diffusion.md`. Rien n'est soumis, publié ni envoyé.

## Tests

`test/plugin.test.js` : auteur, icône déclarée et présente, README présent.
