# Coût de la console : 0.2 et 0.3

Date : 22 novembre 2026. Claude Code 2.1.330, macOS, connexion par le compte (abonnement : le cache de la conversation principale est écrit pour une heure, au double du prix d'entrée). Modèle par défaut du compte : Claude Opus 5.5.

## Environnement d'essai

- Isolé : plugin chargé par `claude --plugin-dir`, CLI par un dossier `bin` en tête du `PATH`, `RELAYLEAD_HOME` jetable, `RELAYLEAD_WATCHER=off`, `RELAYLEAD_NOTIFY=off`. Rien d'installé, aucune session lancée.
- « 0.2 » : le commit `2a8abdc` (version 0.2.0) exporté par `git archive`. « 0.3 » : la branche du lot E.
- Projet jouet (dépôt git, deux tâches, `.relaylead.json` en français) et état fabriqué comme dans les tests : mission `site` en attente avec une question ouverte (deux options, recommandée), mission `api` terminée avec une question de conflit de fusion (trois options). `doctor` signale le planificateur et le plugin non installés, dans les deux versions.
- Chaque ouverture part d'une copie neuve de cet état, pour que les deux versions voient les mêmes nouveautés.
- Appels : `claude -p "<texte>" --output-format json`. Conversation chaude : `--resume <session> --fork-session` sur la session de l'ouverture.
- Coûts relevés dans `total_cost_usd`. Pour un appel repris, ce champ cumule toute la session : le coût de l'appel seul est la différence avec la session reprise. Ils concordent avec les prix publics (Opus 5.5 : 8 $/Mjeton en écriture de cache sur une heure, 0,20 $ en lecture, 20 $ en sortie ; Haiku 5.5 sous 100 000 jetons : 0,20 $, 0,01 $ et 0,50 $).

## Relevé

| Appel | Modèle | Tours (`num_turns`) | Entrée | Sortie | Cache écrit | Cache lu | Coût ($) |
|---|---|---|---|---|---|---|---|
| Témoin : « Réponds seulement : OK. » | Opus 5.5 | 1 | 2 | 5 | 23 231 | 11 735 | 0,188 |
| Ouverture 0.2 : « /relaylead où en sont mes missions ? » | Opus 5.5 | 4 | 8 | 996 | 37 744 | 151 481 | 0,352 |
| Ouverture 0.3 : même texte | Opus 5.5 | 2 | 4 | 710 | 35 142 | 49 953 | 0,305 |
| Suivi 0.2, conversation chaude : « Refais le point sur mes missions. » | Opus 5.5 | 3 | 6 | 781 | 14 202 | 170 143 | 0,163 |
| Suivi 0.3, conversation chaude : même texte | Opus 5.5 | 2 | 4 | 461 | 13 456 | 100 352 | 0,137 |
| Suivi 0.3, deuxième tour chaud : même texte | Opus 5.5 | 2 | 4 | 526 | 14 646 | 127 761 | 0,153 |
| `/relaylead:etat` (`model: haiku`), conversation chaude | Haiku 5.5 | 2 | 4 | 708 | 63 957 | 52 449 | 0,014 |
| Tour Opus juste après `/relaylead:etat` (`--model claude-opus-5-5`) | Opus 5.5 | 2 | 4 | 574 | 30 557 | 116 708 | 0,279 |
| `/relaylead:etat`, conversation neuve | Haiku 5.5 | 2 | 4 | 627 | 34 165 | 48 810 | 0,008 |
| Reprise sans `--model` après `/relaylead:etat` | Haiku 5.5 | 2 | 4 | 478 | 15 032 | 131 399 | 0,005 |

Dix appels au total.

## Ce qu'on en tire

**Environnement.** L'appel témoin, sans Relaylead, coûte déjà 0,188 $ : environ 35 000 jetons de contexte (système, outils, plugins, mémoire de la machine). Une conversation neuve paie ce prix quoi qu'on fasse. Seul le coût marginal dépend de Relaylead.

**Ouverture (conversation neuve).**
- Coût marginal de Relaylead : 0,352 − 0,188 = **0,164 $** en 0.2, 0,305 − 0,188 = **0,117 $** en 0.3, soit **−29 %**. L'appel entier passe de 0,352 à 0,305 $ (−13 %).
- Allers-retours : 4 → 2. `relaylead brief` remplace `doctor`, `wait --all --timeout 0` et `overview --json`.
- Cache relu : 151 000 → 50 000 jetons (−67 %). Sortie : 996 → 710 jetons (−29 %).

**Suivi dans une conversation chaude.**
- Un échange « refais le point » coûte 0,163 $ en 0.2 et 0,137 $ en 0.3, soit **−16 %**. Tours : 3 → 2 ; cache relu : 170 000 → 100 000 (−41 %) ; sortie : 781 → 461 (−41 %).
- Chaque appel repris par `-p --resume` écrit 13 000 à 15 000 jetons de cache dans les deux versions, soit environ 0,11 $ du coût de l'échange. Je n'ai pas isolé cette part, qui tient à la reprise. Dans une conversation restée ouverte, l'échange coûterait sans doute bien moins, et le gain relatif serait plus grand. C'est une hypothèse, non mesurée.

**Questions.** Dans tous les appels, les deux questions ont été montrées telles quelles, avec leur mission, leur contexte, leurs options numérotées et la recommandée marquée. En 0.3, la console recopie la sortie de `brief` dans un bloc de code. Haiku l'a aussi recopiée sans la changer.

**Taille du skill.** 7 490 → 3 738 octets (−50 %).

## Levier « modèle léger » : retiré

Forme essayée : un skill du plugin `etat` (`/relaylead:etat`) avec `model: haiku`, `disable-model-invocation: true` et `allowed-tools: Bash(relaylead brief)`. D'après la documentation de Claude Code (skills, frontmatter `model`), le modèle n'est changé que pour le tour en cours. D'après la page sur le cache, ce tour relit toute la conversation sans cache, puisque chaque modèle a son propre cache.

Mesure, en conversation chaude, sur deux tours avec le même nombre de reprises :
- tout sur Opus : 0,137 + 0,153 = **0,290 $** ;
- `/relaylead:etat` puis Opus : 0,014 + 0,279 = **0,293 $**.

Le tour Haiku économise environ 0,12 $, mais le tour Opus suivant les reperd. Il doit écrire dans son cache tout ce qu'il n'a pas vu : 30 557 jetons au lieu de 13 000 à 15 000. Bilan : aucun gain, et même 1 % de plus.

D'autres raisons s'ajoutent :
- **Reprise sur Haiku.** Une conversation reprise (`--resume`) dont le dernier tour était `/relaylead:etat` a continué sur Haiku (dernière ligne du relevé). Un réglage `--model` explicite a été nécessaire pour revenir à Opus. Avec ce levier, une décision pourrait donc partir sur le modèle léger, ce que la conception exclut.
- **Longues conversations.** Haiku 5.5 coûte cinq fois plus cher au-delà de 100 000 jetons de contexte. Dans une longue conversation, relire tout sans cache y coûte plus qu'une lecture du cache d'Opus.
- **Conversation neuve.** Le seul cas gagnant est une conversation qu'on n'ouvre que pour voir l'état (0,008 $ contre 0,305 $). Pour ce cas, `relaylead brief` dans un terminal donne le même texte sans aucun appel au modèle.

Ruling : selon la conception (§3 et §4), un levier sans gain mesuré en conversation chaude est retiré. Le skill `etat` a été supprimé. Le test du plugin vérifie qu'aucun skill ne change de modèle.

## Traces

Les transcriptions des dix appels (`~/.claude/projects/-private-tmp-rl-essai-e-…`), leur cache local et le dossier d'essai ont été supprimés. `~/.claude.json` et `~/.claude/history.jsonl` n'ont gardé aucune entrée du dossier d'essai (vérifié par recherche du chemin).
