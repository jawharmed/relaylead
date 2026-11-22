# Relaylead 0.3 : console allégée, finitions et fiche du plugin

Date : 22 novembre 2026. Base : 0.2.0 (`docs/specs/2026-11-22-relaylead-console-design.md`). Décisions de l'auteur du 22 novembre au soir.

## 1. Pourquoi

L'essai réel de la 0.2 a mesuré 0,29 à 0,56 $ par aller-retour avec la console (`claude -p`, sans cache). L'auteur juge ce coût trop élevé : il faut l'alléger. La 0.3 solde aussi les défauts mineurs reportés et prépare la diffusion (fiche du plugin), sans rien publier ni annoncer.

## 2. Objectifs

1. **Console allégée** (décision de l'auteur : les deux leviers).
   - Moins de jetons et moins d'allers-retours à chaque échange : skill plus court, sorties compactes, une seule commande pour l'ouverture.
   - Le suivi courant (état, rattrapage des événements, listes) passe par un modèle léger (Haiku). Les décisions restent sur le modèle principal de l'utilisateur : réponses aux questions, consignes (`tell`), lancement, fusion, arrêt.
2. **Défauts reportés de la 0.2** (rapport d'essai, défauts 8, 9, 11 et réponse libre) :
   - `state set done` refusé hors session tant que la mémoire n'est pas écrite (même garde que pour le lead).
   - `question ask` refusé sur une mission terminée, hors du cœur.
   - `github-pr` : l'issue n'est fermée qu'à la fusion (`relaylead merge`), plus à la livraison dans l'intégration. Après la fusion, la branche distante d'intégration est supprimée et l'utilisateur est prévenu si sa branche locale est en retard.
   - Réponse libre (« Autre ») dans la page web et dans le panneau, comme `answer --other`, sauf pour les questions `q-irr-` et `q-perm-`.
3. **Fiche du plugin et du paquet.**
   - Auteur affiché : « Lilia Digital » (choix de l'auteur), dans `plugin.json` et `package.json`.
   - README du plugin, icône, mots-clés, page d'accueil.
   - `claude plugin validate` sans avertissement.
   - Textes de soumission à l'annuaire et d'annonce préparés hors du dépôt. Rien n'est envoyé : l'auteur le fera après son test.

## 3. Hors objectifs et anti-objectifs

- Pas de nouvelle fonction de mission.
- Pas de publication npm ni de soumission à l'annuaire par l'orchestrateur.
- **Anti-objectif :** une console moins chère qui tait une question, la résume ou applique une décision sans l'utilisateur. Les règles de la §4 du skill (montrer chaque question telle quelle) restent intactes.
- **Anti-objectif :** un levier « modèle léger » qui coûte plus qu'il n'économise. Chaque levier est mesuré, et un levier sans gain mesuré est retiré (ruling écrit).

## 4. Console allégée : ce qui est décidé

Leviers, dans cet ordre :

1. **Une commande d'ouverture.** `relaylead brief` (texte court, pas de JSON) remplace la suite `doctor` → `wait --all --timeout 0` → `overview --json` de l'ouverture. Elle affiche :
   - les problèmes d'installation seulement s'il y en a ;
   - les événements nouveaux ;
   - chaque question ouverte telle quelle (mission, texte, contexte, options numérotées, recommandée marquée), y compris celles des missions terminées ;
   - une ligne par mission non terminée.
   Elle reprend les mêmes données que `overview` et `wait --all --timeout 0`, sans dupliquer leur logique.
2. **Sorties compactes** pour les commandes que la console appelle souvent. Le JSON n'est utilisé que là où la console doit vraiment le lire.
3. **Skill raccourci.** Garder les règles, retirer les redites et les détails que la commande `brief` rend inutiles. Cible : moins de la moitié de la taille actuelle (7,5 Ko), les règles de la §4 intactes.
4. **Modèle léger pour le suivi courant.**
   - Forme à choisir par l'implémenteur, d'après la documentation officielle de Claude Code et une mesure : un agent du plugin sur Haiku, ou une commande `/relaylead:etat` avec `model: haiku`.
   - Il ne fait que lire et rapporter, et il rapporte chaque question telle quelle.
   - Garde-fou : un changement de modèle perd le cache de la conversation. Si la mesure montre que ce levier coûte plus qu'il n'économise dans une conversation déjà chaude, il est retiré et la raison est notée.

**Mesure.**
- Avant et après, avec `claude -p --output-format json`, dans un environnement d'essai isolé.
- On relève les jetons d'entrée, de sortie et de cache, le nombre de tours et le coût.
- On sépare le coût de l'environnement (un appel témoin sans `/relaylead`) du coût marginal de Relaylead.
- Les chiffres vont dans `docs/manual-checks/v0-3-console-cout.md`.

## 5. Ce qui reste à l'implémenteur

- Le format exact de `brief` et des sorties compactes.
- La forme du levier « modèle léger » et sa mesure.
- Les messages en anglais et en français (`core/messages.js`).
- L'icône : simple, sobre, sans marque d'un tiers.
