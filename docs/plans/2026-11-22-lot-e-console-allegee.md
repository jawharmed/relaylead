# Lot E : console allégée

Conception : `docs/specs/2026-11-22-relaylead-0-3-design.md`, §2.1, §3 et §4. But : moins de jetons et moins d'allers-retours par échange avec la console, sans jamais taire ni résumer une question.

## Tâches

1. **`relaylead brief`** (`core/brief.js`, commande dans `core/cli.js`). Texte court, pas de JSON :
   - les lignes `warn` et `fail` de `doctor`, seulement s'il y en a ;
   - les événements nouveaux, par le même rattrapage que `wait --all --timeout 0` (`waitForEvents(0, …)`, qui écrit `console-snapshot.json`) ;
   - chaque question ouverte de toutes les missions (`buildOverview()`, missions terminées comprises), telle quelle : mission, id, texte, contexte, options numérotées, recommandée marquée, « nouvelle » si elle vient d'arriver ;
   - une ligne par mission non terminée (état, avancement des tâches, file, pause, priorité si elle n'est pas normale).
   Aucune logique de lecture dupliquée : `brief` ne fait que mettre en forme ce que rendent `doctor`, `waitForEvents` et `buildOverview`. Messages en anglais et en français.
2. **Sorties compactes.** `wait --all` écrit le même texte que `brief` pour ses événements (questions en entier) ; `--json` garde l'ancien JSON. `task list --short` : une ligne par tâche (id, état, essai, titre, résumé). Le JSON des leads et `overview --json` (panneau) ne changent pas.
3. **Skill raccourci** (`plugin/skills/relaylead/SKILL.md`) : moins de 3,7 Ko ; ouverture = `relaylead brief` seul ; règles de la §4 (chaque question telle quelle, jamais résumée) gardées mot pour mot sur le fond ; `allowed-tools` mis à jour (`brief`, plus de `doctor`, `overview`, `question list`).
4. **Modèle léger.** Skill du plugin `etat` (`/relaylead:etat`) avec `model: haiku`, lecture seule (`relaylead brief` seul autorisé), qui recopie les questions telles quelles. Mesuré ; retiré avec un ruling écrit s'il coûte plus qu'il n'économise dans une conversation chaude (le changement de modèle relit toute la conversation sans cache).
5. **Mesure** avant/après dans `docs/manual-checks/v0-3-console-cout.md` : `claude -p --output-format json`, environnement isolé (plugin par `--plugin-dir`, CLI par `PATH`, `RELAYLEAD_HOME` jetable, état de missions fabriqué), appel témoin sans `/relaylead`, conversation froide et chaude (`--resume … --fork-session`). Jetons d'entrée, de sortie, de cache, `num_turns`, coût.

## Tests (`node --test`)

- `brief` : rien à dire ; question ouverte d'une mission terminée montrée telle quelle avec options et recommandée ; événement nouveau une seule fois (rattrapage partagé avec `wait --all`) ; ligne de mission non terminée ; texte en français.
- `wait --all` en texte et en `--json` ; `task list --short`.
