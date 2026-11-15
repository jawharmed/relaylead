# Résultats de l'essai jetable (lot 0)

- Date : 2026-11-15 01:06 CET
- Claude Code : 2.1.325 (Claude Code)
- Système : macOS 15.7.9, 12 cœurs, Node v24.19.0
- Charge au départ : 7.34 9.76 9.60
- Isolation : sessions lancées par `spike/launch.js` avec `--setting-sources project,local --strict-mcp-config` (sans les plugins, MCP ni hooks de l'utilisateur), sauf variante `--mode user`.

## Points

| Point | Résultat | Preuve | Conséquence |
|---|---|---|---|

## Observations hors points

- `--restricted` (Claude Code 2.1.325) retire Bash et les outils qui exécutent du code ainsi que WebFetch (sauf si `--tools` les nomme), ignore les réglages utilisateur/projet/local et confine les outils de fichiers aux dossiers de travail : base naturelle du profil `web-reader` en quarantaine (avec `--tools WebFetch,WebSearch`).
- `--safe-mode` désactive aussi les hooks : inutilisable pour les sessions d'équipe.
- `node --test spike/` (dossier) échoue sous Node 24 : utiliser un motif `node --test 'spike/*.test.js'`.

## Ce qui change dans le design
