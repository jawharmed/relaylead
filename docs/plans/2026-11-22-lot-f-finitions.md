# Lot F : finitions (0.3)

Conception : `docs/specs/2026-11-22-relaylead-0-3-design.md`, §2.2.

1. `state set done` : même garde mémoire hors session que pour le lead.
2. `question ask` refusé sur une mission terminée (déjà fait en 0.2.x : `mission-question-over`, le cœur pose ses questions `q-merge-*` sans passer par la commande) ; test déjà présent.
3. `github-pr` : l'issue est fermée à `relaylead merge` ; après la fusion, branche distante d'intégration supprimée, avertissement si la branche locale est en retard.
4. Réponse libre (« Autre ») dans la page web et le panneau, sauf `q-irr-` et `q-perm-`.

Tests : `node --test` avec faux agent, faux `gh` et dépôt nu.
