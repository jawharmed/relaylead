<p align="right"><a href="../faq.md">English</a> · <strong>Français</strong></p>

# FAQ de Relaylead

Des réponses courtes à de vraies questions, avec des liens vers le détail. Les problèmes sont à la fin, dans [Dépannage](#dépannage).

## À propos de Relaylead

### Qu'est-ce que Relaylead ?

Relaylead est un outil open source en ligne de commande, accompagné d'un plugin Claude Code, pour macOS. Il fait travailler une équipe de sessions Claude Code en arrière-plan sur une mission : une session lead découpe le travail en tâches, des sessions équipières les réalisent sur leurs propres branches git, et un veilleur sans IA fait avancer le tout. On ne vous pose une question qu'avant un geste irréversible, et le travail n'arrive sur votre branche que lorsque vous le fusionnez.

### À qui s'adresse-t-il ?

Aux développeurs qui utilisent déjà Claude Code et dont le travail se découpe en tâches claires : une liste de petites fonctionnalités, des correctifs, des tests à ajouter, de la documentation à écrire. Si vous menez plusieurs sessions Claude Code à la main et relancez celles qui s'arrêtent, Relaylead fait cette partie à votre place.

### En quoi est-ce différent des sous-agents ou des agent teams de Claude Code ?

Les sous-agents vivent dans une seule conversation, et les agent teams de Claude Code, encore expérimentales, s'arrêtent avec leur session : quand elle se termine ou que son contexte se remplit, le travail s'arrête aussi. Les sessions de Relaylead sont des sessions indépendantes en arrière-plan (`claude --bg`). Un veilleur extérieur à Claude Code les relance, passe la main à un lead neuf quand le contexte se remplit, et met en pause avant vos limites d'usage. Chaque équipier travaille dans son propre worktree git, et l'état est rangé dans des fichiers : un plantage ou un redémarrage du Mac ne fait rien perdre.

### Est-ce que ça marche sous Linux ou Windows ?

Pas encore. Le veilleur repose sur launchd et Relaylead n'est testé que sous macOS. `relaylead install` refuse sur les autres systèmes.

### C'est gratuit ?

Relaylead est gratuit, sous licence MIT. Les sessions qu'il lance utilisent votre abonnement Claude ou votre clé API. Voir [Coûts](costs.md).

### Peut-on l'utiliser en français ?

Oui. Mettez `"language": "fr"` dans `~/.relaylead/config.json` ; `relaylead init` le propose quand votre `LANG` commence par `fr`. Tous les messages, l'aide et `doctor` sont traduits, et cette documentation est complète en français. Les commandes et les options restent en anglais.

## Installation et mise en place

### Quel abonnement Claude faut-il ?

N'importe quel abonnement qui inclut Claude Code : Pro, Max, Team ou Enterprise. Vous pouvez aussi utiliser une clé API Anthropic : `relaylead init --api-key-env ANTHROPIC_API_KEY`. Voir [Clé API](guide.md#clé-api).

### Pourquoi Claude Code dit-il que le dossier n'est pas de confiance ?

Claude Code n'ouvre de sessions que dans les dossiers auxquels vous avez fait confiance. Lancez `claude` une fois dans le dossier du projet et choisissez **Yes, I trust this folder**. La réponse par défaut, *No, exit*, refuse : appuyer sur Entrée sans déplacer la sélection en est la cause habituelle.

### Faut-il passer par la console ?

Non. Chaque action a sa commande : `relaylead launch`, `brief`, `answer`, `tell`, `merge`. La console dans Claude Code est une facilité pour écrire des missions et répondre aux questions en toutes lettres. Voir [Premiers pas](getting-started.md#une-mission-complète-depuis-le-terminal).

### Faut-il commiter `.relaylead.json` ?

Commitez-le si les réglages appartiennent au projet et que votre équipe doit les partager. Il ne contient jamais de secret : les clés API restent dans `~/.relaylead/`. Laissez-le hors de git si les réglages ne concernent que vous. Relaylead fonctionne de la même façon dans les deux cas.

### Comment mettre Relaylead à jour ?

```sh
npm install -g relaylead@latest
relaylead install      # met à jour le plugin et l'agent launchd du veilleur
```

`relaylead --version` affiche la version installée. Le [changelog](../../CHANGELOG.md) (en anglais) dit ce qui change et quoi faire en mettant à jour.

### Comment désinstaller complètement Relaylead ?

```sh
relaylead uninstall --purge
npm uninstall -g relaylead
```

`--purge` refuse tant qu'une mission peut encore avoir des sessions en cours ; arrêtez-la d'abord, ou ajoutez `--force` pour les arrêter (rien n'est supprimé si l'une d'elles ne peut pas l'être). Fermez par Ctrl-C une page `relaylead dashboard` encore ouverte. Les branches et les worktrees de vos projets restent : [Désinstaller](guide.md#désinstaller) explique comment les retirer.

## Faire tourner des missions

### Comment écrire une tâche ?

Un fichier Markdown par tâche dans `tasks/`, commité. Un `title` dans un petit en-tête, puis la consigne :

```markdown
---
title: Ajouter une route de santé
depends: [server]
ask: La route /health doit-elle aussi donner l'état de la base de données ?
---
Ajoute GET /health qui renvoie 200 et {"status":"ok"}. Couvre-la par un test.
```

`depends` et `ask` sont facultatifs. [Bien écrire ses tâches](getting-started.md#bien-écrire-ses-tâches) donne des conseils.

### Peut-on prendre les tâches dans des issues GitHub ?

Oui : mettez `"source": {"type": "github-issues"}` et `"delivery": {"type": "github-pr"}` dans `.relaylead.json`, et posez le label `relaylead` sur les issues. Il faut `gh`, connecté. Lisez d'abord [Les issues écrites par d'autres](safety.md#les-issues-écrites-par-dautres).

### Peut-on faire tourner plusieurs missions à la fois ?

Oui, dans un même projet ou dans plusieurs. Dans un même projet, donnez à chaque mission son nom et son dossier de tâches :

```sh
relaylead launch --name backend --tasks tasks/backend --request "Construis l'API"
relaylead launch --name frontend --tasks tasks/frontend --request "Construis les pages"
```

Au plus 4 équipiers travaillent à la fois sur la machine (`maxSessions`) ; les autres attendent en file, la mission la plus prioritaire d'abord.

### Comment dire quelque chose au lead pendant qu'il travaille ?

`relaylead tell <mission> "Utilise l'API v2"`, ou « dis au lead de X de … » dans la console. Le lead est réveillé en quelques secondes et suit la consigne.

### Que se passe-t-il quand une tâche échoue ?

Le lead lit le résumé de l'équipier. Quand un nouvel essai peut lever la cause, il lance un nouvel équipier sur la même branche, en lui disant comment le premier essai a échoué (`maxAttempts` vaut 2 essais en tout). Sinon, il vous signale l'échec par une question (*Go on without it* ou *Stop the mission now*) et continue les autres tâches. Une livraison ratée a sa propre question (*I fixed it: deliver again* ou *Finish without this task*).

### Peut-on fermer Claude Code, ou son portable, pendant une mission ?

Fermer Claude Code ne change rien : les sessions tournent en arrière-plan. Quand le Mac se met en veille, tout s'arrête et reprend au réveil. Après un redémarrage, launchd relance le veilleur, qui relance les leads arrêtés. Les questions posées entre-temps restent ouvertes jusqu'à votre réponse.

### Et si je ne réponds jamais à une question ?

Le lead attend, et avance sur ce qui ne dépend pas de la réponse. Après 7 jours sans activité (`abandonDays`), vous recevez un rappel, et `relaylead list` marque la mission `abandoned`. Rien n'est arrêté ni supprimé. Pour les questions que le lead pose de lui-même, vous pouvez choisir d'appliquer l'option recommandée après un délai : voir [Questions](guide.md#questions).

## Git et votre dépôt

### Relaylead modifie-t-il ma branche ou ma copie de travail ?

Pas pendant qu'une mission tourne. Le travail se fait dans des worktrees à part, sous `.relaylead/worktrees/`, et sur des branches `relaylead/<mission>/…`. Votre branche ne change que lorsque vous lancez `relaylead merge`, qui demande une copie de travail sans modification non commitée.

### Qu'est-ce que Relaylead écrit dans mon dépôt ?

`.relaylead.json` (écrit par `init`), le dossier `.relaylead/` (les worktrees et la mémoire du projet), des branches locales nommées `relaylead/<mission>/…`, et une ligne `.relaylead/` dans `.git/info/exclude` pour que rien de tout cela n'apparaisse dans `git status`. Votre `.gitignore` n'est jamais touché, et rien n'est poussé sauf avec la livraison GitHub. La liste complète : [Fichiers et dossiers](guide.md#fichiers-et-dossiers).

### Comment relire le travail avant qu'il n'arrive sur ma branche ?

```sh
git log --oneline main..relaylead/<mission>/integration
git diff main...relaylead/<mission>/integration
```

Le worktree d'intégration, `.relaylead/worktrees/<mission>/_integration/`, est une copie de travail normale où vous pouvez lancer les tests.

### Que se passe-t-il en cas de conflit de fusion ?

`relaylead merge` annule la fusion et rien ne reste à moitié fait. Un équipier résout le conflit sur sa propre branche, lance les tests, et Relaylead refait la fusion tout seul. Si l'équipier n'y arrive pas, vous recevez une question : le résoudre ensemble dans la console, relancer avec des indications, ou mettre en pause.

## Coûts et limites

### Combien coûte une mission ?

Une vraie mission de deux petites tâches a coûté environ 0,60 $ au tarif public de l'API, dont les trois quarts pour le lead (Opus) ; les équipiers tournent sur Sonnet. Les missions plus grosses coûtent plus : la part du lead grandit avec le nombre d'étapes. Avec un abonnement, cela compte dans votre usage. Voir [Coûts](costs.md).

### Relaylead va-t-il épuiser ma limite de la semaine ?

Il met une mission en pause quand votre usage atteint le seuil de sa priorité : 90 % de la semaine et 85 % de la fenêtre de 5 heures pour `normal`, 70 % et 80 % pour `low`. La mission reprend toute seule après la réinitialisation. Vous êtes prévenu quand elle se met en pause (une notification macOS, et un événement dans la console). Voir [Usage de l'abonnement](costs.md#usage-de-labonnement-et-pause-automatique).

### Pourquoi la console coûte-t-elle plus cher que `relaylead brief` ?

La console est une conversation Claude ; chaque échange est un appel au modèle. `brief` lit des fichiers locaux. La console pour décider, `brief`, la page web ou la ligne d'état pour regarder.

## Sécurité

### Peut-on laisser des sessions tourner sans surveillance ?

Pour votre propre code et vos propres tâches, les garde-fous attrapent les erreurs habituelles : écrire hors du worktree, pousser sur `main`, ouvrir `.env`, lancer une commande git destructrice. Ce n'est pas un bac à sable contre un agent détourné. Lisez [Sécurité](safety.md).

### Peut-on le lancer sur des issues GitHub écrites par d'autres ?

Seulement avec des précautions. Le texte d'une issue devient la consigne d'un équipier, et un équipier peut lancer `node` et `git`. Utilisez un compte macOS ou une machine sans aucun secret, un jeton `gh` limité à ce dépôt, et relisez la branche d'intégration avant de fusionner. Voir [Les issues écrites par d'autres](safety.md#les-issues-écrites-par-dautres).

### Relaylead envoie-t-il des données quelque part ?

Aucune télémétrie. Les sessions parlent à Anthropic comme n'importe quelle session Claude Code ; `gh` et `git push` n'atteignent GitHub qu'avec la source ou la livraison GitHub. La page web n'écoute que sur `127.0.0.1`.

## Dépannage

Commencez par `relaylead doctor` : chaque ligne `warn` ou `fail` dit quoi faire.

### `launch` dit que le dossier de tâches manque, est vide ou n'est pas commité

Les équipiers partent des commits : le dossier de tâches doit exister, contenir au moins un fichier `.md`, et être commité. Chaque cas a son message, avec un exemple de tâche, par exemple :

```text
relaylead launch: le dossier de tâches « tasks » ne contient aucun fichier .md. Ajoutez un fichier par tâche, par exemple tasks/hello.md :
  ---
  title: Dire bonjour
  ---
  Créer hello.txt qui dit bonjour.
puis commitez-le (git add tasks && git commit -m "tâches")
```

La solution :

```sh
mkdir -p tasks
$EDITOR tasks/premiere-tache.md
git add tasks && git commit -m "Ajoute les tâches"
```

Avec `--tasks <dossier>`, la même règle vaut pour ce dossier.

### `launch` dit qu'une autre mission prend déjà ses tâches à cette source

Deux missions sur les mêmes tâches feraient le même travail. Si l'autre mission tourne encore, donnez à la nouvelle son propre dossier de tâches (`--tasks tasks/autre`) ou attendez. Si elle est terminée mais pas fusionnée, le message dit quoi faire :

```text
relaylead launch: la mission « hello-api » de ce projet est terminée mais pas fusionnée, et elle prenait ses tâches à la même source (tasks-dir "tasks") : cette mission les referait. Fusionnez la mission terminée avec : relaylead merge hello-api ; ou jetez-la avec : relaylead remove hello-api ; ou lancez quand même avec --force
```

Si sa fusion est en cours (un équipier résout un conflit), attendez qu'elle se termine, ou passez `--force`.

### « une mission nommée … existe déjà »

Les noms de missions sont uniques sur la machine. Passez `--name`, ou retirez la mission finie avec `relaylead remove <mission>`.

### Une mission s'est arrêtée sur une erreur de facturation ou d'authentification

Réveiller les sessions échouerait de la même façon : le veilleur a donc arrêté la mission et vous a prévenu. Ajoutez du crédit API ou corrigez la clé ou la connexion (`relaylead doctor`), puis relancez. Le travail déjà livré est sur la branche d'intégration ; lancez d'abord `relaylead remove <mission>` pour réutiliser le nom.

### Une mission s'est arrêtée après 3 relances ratées

Le lead n'a pas pu être relancé. `relaylead list` et `~/.relaylead/missions/<mission>/journal.log` disent pourquoi. Corrigez la cause, puis relancez.

### Le veilleur ne fait rien

Lancez `relaylead watcher status`, et vérifiez que `~/.relaylead/STOP` n'existe pas. Si `relaylead doctor` dit que le planificateur n'est pas installé ou pas chargé, lancez `relaylead install`. Après une mise à jour de Node (avec nvm, par exemple), `relaylead doctor` signale que le planificateur lance un fichier qui n'existe plus : relancez `relaylead install` depuis un terminal où `node` et `claude` sont trouvés, pour que launchd prenne les nouveaux chemins.

### Un lead ne répond pas

Le veilleur le signale comme `lead-stuck` dans `~/.relaylead/watcher.log` et ne l'arrête jamais pour cette seule raison. Ouvrez-le avec `relaylead show <mission>` et écrivez-lui.

### Une livraison échoue à cause d'un hook git

Les commits de Relaylead lancent vos hooks dans le worktree d'intégration, où `node_modules` n'est pas installé : des hooks comme husky ou commitlint y échouent. Mettez `"delivery": {"runHooks": false}` dans `.relaylead.json`, ou livrez cette tâche vous-même avec `relaylead task deliver <id> --no-hooks --mission <mission>`.

### Un équipier dit qu'une écriture a été refusée

Depuis la 0.4, les outils de fichiers d'un équipier n'écrivent que dans son propre worktree (et son propre dossier temporaire). Si une tâche doit vraiment modifier des fichiers ailleurs, faites-le vous-même, ou réécrivez la tâche pour que le travail reste dans le dépôt.

### Une mission apparaît comme `unreadable`

L'un de ses fichiers d'état (`mission.json`, `state.json` ou `lead.json`, dans le dossier affiché) n'est pas du JSON valide, et ses sessions tournent peut-être encore. Les autres missions ne sont pas touchées. Réparez ou restaurez le fichier pour revoir la mission ; `relaylead remove` ne sait pas encore retirer une mission illisible.

### `doctor` signale un problème de configuration

`warn config` nomme le fichier et le réglage : un réglage inconnu (souvent une faute de frappe, sinon ignorée en silence) ou une valeur que Relaylead ne peut pas utiliser. Corrigez le fichier ; `relaylead doctor` dit alors `ok`.

### Le panneau ou la ligne d'état n'apparaît pas

Ils demandent une version de Claude Code qui accepte les mods de plugin, et le plugin installé (`relaylead doctor`, ligne `plugin`). Ouvrez le panneau avec `/pane`. La ligne d'état n'apparaît que lorsqu'une mission tourne ou qu'une question attend, et se désactive avec `display.statusLine`.

### `relaylead show` dit que la session n'existe plus

La mission est finie et ses sessions ont été retirées de `claude agents`. Leurs conversations sont toujours dans `claude --resume`.

### Erreurs GitHub

Vérifiez `gh auth status`. La source `github-issues` et la livraison `github-pr` demandent `gh` connecté, et une branche d'intégration qui peut être poussée.
