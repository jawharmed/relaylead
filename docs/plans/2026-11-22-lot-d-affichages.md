# Lot D : affichages (ligne d'état, panneau, page web locale)

Conception : `docs/specs/2026-11-22-relaylead-console-design.md`, §5.5. Les trois affichages lisent la même source.

## Tâches

1. **Source unique** : `core/overview.js` (`buildOverview()`) et `relaylead overview --json`. Missions de la machine : nom, dossier, priorité, état, pause, tâches (nom, état), questions ouvertes (texte, options, recommandée), quota 5 h / 7 j lu dans `usage.json`, réglages d'affichage (`display.*`). Aucun appel réseau : une mission dont les tâches viennent de GitHub est lue depuis ses fichiers `tasks/<id>.json`.
2. **Réglages** : `relaylead config set <clé> <valeur>` (clés `display.pane`, `display.statusLine`, `display.dashboardPort`), écrit dans `~/.relaylead/config.json`. Défauts : `display: { pane: null, statusLine: true, dashboardPort: 4317 }`.
3. **Mod du plugin** : `plugin/hooks/hooks.json` + `register.tsx`, contrat d'état `plugin/types/index.d.ts`. Entrée `$.ui.status`, panneau `$.ui.open`, rafraîchissement `$.clock.every` + `$.process.run(['relaylead','overview','--json'])`, boutons de réponse (`relaylead answer`), commande `/relaylead:panneau`, proposition « Toujours / Cette fois / Jamais » (bandeau au-dessus de la saisie). Validé par `claude plugin validate` (hors `npm test`).
4. **`relaylead dashboard`** : `core/dashboard.js`, serveur `http` sur 127.0.0.1, une page (`core/dashboard-page.html`), jeton aléatoire par lancement pour répondre et arrêter, vérification de Host et d'Origin, ouverture par `open`.
5. **Docs** : section « Displays » du guide, une ligne au README.

## Ergonomie

Hiérarchie mission > tâches > question. Une mission est une carte : nom, état en pastille colorée, priorité, avancement (`2/5`). Les questions ouvertes passent en tête de la carte, avec leurs boutons, car ce sont elles qui attendent la personne. Le quota est une jauge en pied. Clair et sombre suivent le système.

## Tests (`node --test`)

- `overview --json` sur un état fabriqué ;
- `config set` ;
- serveur : page servie, action refusée sans jeton ou avec un mauvais Host, réponse acceptée avec jeton.
