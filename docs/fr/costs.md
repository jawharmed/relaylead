<p align="right"><a href="../costs.md">English</a> · <strong>Français</strong></p>

# Ce que coûte Relaylead

Relaylead est gratuit et open source. Les sessions Claude Code qu'il lance utilisent votre abonnement Claude ou votre clé API, comme n'importe quelle session que vous lancez vous-même. Cette page dit quels modèles tournent, ce que nous avons mesuré, et comment dépenser moins.

## Les modèles utilisés

| Rôle | Modèle | Effort | Remarques |
| --- | --- | --- | --- |
| Lead | Opus (`--model opus`) | moyen | Un par mission. Claude Code traduit l'alias vers son Opus du moment : Opus 5.5 en novembre 2026. |
| Équipier | Sonnet (`--model sonnet`) | moyen | Un par tâche en cours. Sonnet 5.5 en novembre 2026. |
| Veilleur | aucun | | Une boucle Node.js. Elle n'appelle jamais de modèle. |
| Console | le modèle de votre conversation | | Seulement quand vous lui parlez dans Claude Code. |
| `brief`, page web, ligne d'état, `/pane` | aucun | | Ils lisent des fichiers locaux. |

Les modèles sont fixés par les profils intégrés de Relaylead et ne se changent pas par un réglage en 0.4.

## Ce que coûte une mission

Nous avons mesuré une vraie mission le 23 novembre 2026 (Claude Code 2.1.330, macOS) : un projet jouet avec deux toutes petites tâches, dont une posait d'abord une question. Elle est allée du lancement à la fin en une minute et demie environ.

| Session | Modèle | Messages | Cache écrit | Cache lu | Sortie | Coût au tarif API |
| --- | --- | --- | --- | --- | --- | --- |
| Lead | Opus 5.5 | 20 | 22 238 | 978 982 | 2 780 | environ 0,43 $ |
| Équipier, tâche 1 | Sonnet 5.5 | 7 | 12 664 | 300 546 | 942 | environ 0,09 $ |
| Équipier, tâche 2 | Sonnet 5.5 | 5 | 12 208 | 210 363 | 602 | environ 0,08 $ |
| **Mission** | | | | | | **environ 0,60 $** |

Prix retenus, par million de jetons (tarif public d'Anthropic, novembre 2026) : Opus 5.5, 8 $ pour une écriture de cache (cache d'une heure), 0,20 $ pour une lecture de cache, 20 $ pour la sortie ; Sonnet 5.5, 4 $, 0,10 $ et 10 $. Avec des écritures de cache de cinq minutes, le total serait un peu plus bas.

Ce qu'on en retient :

- **Le lead fait l'essentiel de la facture.** Il relit son contexte à chaque étape (lister les tâches, attendre, livrer) : son coût grandit avec le nombre d'étapes, donc avec le nombre de tâches, de questions et d'attentes.
- **Le coût d'un équipier grandit avec sa tâche** : le code qu'il lit, les tests qu'il lance, les changements qu'il fait.
- **Deux toutes petites tâches, c'est un plancher, pas une moyenne.** Nous n'avons pas encore publié de mesure d'une grosse mission. Suivez vos premières missions avec `relaylead brief` et votre usage avant d'en lancer de grosses.

## La console face à brief et à la page web

La console `/relaylead` est une conversation Claude : chaque échange coûte des jetons. Les autres vues lisent des fichiers locaux et ne coûtent rien. Mesures faites avec Opus 5.5 au tarif API, par `claude -p` (novembre 2026) :

| Ce que vous faites | Coût |
| --- | --- |
| N'importe quelle nouvelle conversation Claude Code, sans Relaylead (« Réponds seulement : OK. ») | 0,19 $, le démarrage de Claude Code lui-même |
| Ouvrir la console dans une nouvelle conversation et demander où en sont les missions | de 0,30 à 0,35 $ |
| La première question d'un débutant dans un dossier vide (« que dois-je faire pour lancer ma première mission ? ») | 0,46 $ |
| Une relance dans la même conversation (« où en sont mes missions ? ») | de 0,13 à 0,15 $ |
| Répondre à une question par la console | environ 0,13 $ |
| Attendre les événements en arrière-plan, entre deux événements | 0 $ |
| `relaylead brief`, `relaylead dashboard`, la ligne d'état, `/pane` | 0 $ |

Autrement dit : **la console pour décider, `brief` ou la page web pour regarder.** Écrire une mission avec la console, répondre à une question avec vos propres mots ou résoudre ensemble un conflit de fusion vaut bien quelques dizaines de centimes. Lui demander « où en est-on ? » dix fois par jour, non : `relaylead brief` affiche le même texte gratuitement.

## Usage de l'abonnement et pause automatique

Avec un abonnement Claude, ces jetons comptent dans votre usage sur 5 heures et sur 7 jours, au lieu d'une facture. Relaylead lit cet usage dans ce que rapporte Claude Code, et met une mission en pause quand elle atteint le seuil de sa priorité :

| Priorité | Pause à, fenêtre de 7 jours | Pause à, fenêtre de 5 heures |
| --- | --- | --- |
| `low` | 70 % | 80 % |
| `normal` | 90 % | 85 % |
| `high` | 98 % | 85 % |

Une mission en pause arrête ses sessions et reprend toute seule quand la fenêtre se réinitialise. Changez les seuils avec le réglage [`usage`](guide.md#limite-dusage-et-pause-automatique), et la priorité d'une mission avec `relaylead priority <mission> low`.

Avec une clé API, il n'y a pas de telles fenêtres : les sessions puisent dans votre crédit API. Quand le crédit est épuisé, le veilleur arrête aussitôt la mission et vous prévient, plutôt que de réveiller des sessions qui échoueraient de la même façon.

## Dépenser moins

- **Regardez sans la console :** `relaylead brief`, `relaylead dashboard`, la ligne d'état.
- **Regroupez les toutes petites modifications** en une seule tâche : chaque tâche coûte un démarrage de session et plusieurs étapes du lead.
- **Écrivez des tâches précises**, avec un moyen clair de les vérifier. Une tâche floue fait lire et essayer davantage l'équipier.
- **Gardez la mémoire du projet courte.** Chaque lead la lit en premier. Le plafond par défaut est de 200 lignes.
- **Utilisez la priorité `low`** pour les missions qui peuvent attendre : elles se mettent en pause plus tôt et laissent de la marge dans votre semaine.
- **Arrêtez une mission qui part de travers** avec `relaylead stop <mission>`, corrigez les tâches et relancez. Le travail déjà livré reste sur la branche d'intégration.

## Comment ces chiffres ont été mesurés

- **Mission :** nombres de jetons lus dans les transcriptions des sessions lors d'un test indépendant de Relaylead 0.3.0, le 23 novembre 2026, puis chiffrés au tarif public ci-dessus. Relaylead 0.4 ne change ni les modèles ni la méthode du lead.
- **Console :** `claude -p "<texte>" --output-format json`, coût lu dans `total_cost_usd`, dans un environnement d'essai isolé avec le plugin chargé, les 22 et 23 novembre 2026. Pour une conversation reprise, le coût d'un échange est la différence avec la session reprise. Ces appels reprennent une conversation enregistrée, ce qui réécrit son cache ; dans une conversation restée ouverte, une relance coûte sans doute moins (non mesuré).
- **Environnement :** une nouvelle conversation Claude Code porte environ 35 000 jetons de consignes système, d'outils et de plugins avant même que vous tapiez quoi que ce soit. Cette part, 0,19 $ ici, ne dépend pas de Relaylead et varie selon votre propre installation.

Les prix changent ; consultez [la page des tarifs d'Anthropic](https://claude.com/pricing) pour les chiffres du moment.
