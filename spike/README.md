# Essai jetable (lot 0)

Scripts qui ont servi à vérifier, sur Claude Code 2.1.325, les hypothèses du design avant d'écrire le produit. Résultats : [`../docs/spike-results.md`](../docs/spike-results.md).

**Ce n'est pas le produit**, et ces scripts ne sont pas des exemples à suivre :

- Le mode « isolé » de `launch.js` autorise toutes les commandes (`Bash` sans motif, `acceptEdits`) : le bac à sable n'est qu'un dossier, pas une protection.
- `permission-hook.js` compare des préfixes de commande : `git status; <autre commande>` passerait. Le garde-fou du produit analyse la commande entière.
- Les sessions d'essai tournent dans `~/relaylead-sandbox` (dossier à approuver une fois dans Claude Code) et écrivent leurs sorties dans `spike/out/` (ignoré par git).

Réveiller une session inactive : `node spike/wake.js <id court> "<message>"` (arrêt, attente de la fin du processus, reprise sans options, vérification du même id). Tests : `node --test 'spike/*.test.js'` (Node 21 ou plus pour le motif).
