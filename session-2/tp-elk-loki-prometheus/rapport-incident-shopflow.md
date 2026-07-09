# Rapport d'incident — ShopFlow — 14/11/2024

> **Module BOTE848 — Supervision, Observabilité & Monitoring DevOps — Séance 2**
> **TP : ELK vs Loki vs Prometheus**
> **Auteur** : Samuel RESSIOT
> **Source de données** : `logs/shopflow.log` (format JSON Lines)

> ⏱️ **Note fuseau horaire** : les logs sont en **UTC** (`...Z`). Kibana/Grafana affichent en **heure locale (CET, UTC+1)**. Choisissez une convention et restez cohérent (l'énoncé du TP parle en UTC : 08h..).

---

## Synthèse de l'incident

| Champ | Valeur |
|---|---|
| **Heure de début** | 08:34:06 UTC (09:34:06 Paris) |
| **Heure de fin** (rétablissement) | 08:43:15 UTC (09:43:15 Paris) |
| **Durée totale** | ~9 minutes |
| **Service impacté** | `payment-service` |
| **Provider externe** | StripeAPI |
| **Code d'erreur** | `PAYMENT_TIMEOUT` |
| **Nombre de commandes échouées** | 17 |
| **Montant total bloqué** | 4 726 € |
| **Utilisateurs uniques impactés** | 17 (1 timeout chacun) |

**Cause identifiée** :
Le provider de paiement StripeAPI est devenu injoignable. Chaque appel du
`payment-service` a expiré, générant 17 `PAYMENT_TIMEOUT` entre 08:34:06 et
08:42:36 UTC, jusqu'au rétablissement à 08:43:15 (downtime 9 min).

---

## ┌─ PARTIE A — Analyse ELK (Kibana + KQL) ─┐

| Requête | KQL | Mon résultat |
|---|---|---|
| **A-1** Tous les ERROR | `level: "ERROR"` | 34 |
| **A-2** ERROR payment-service | `level: "ERROR" AND service: "payment-service"` | 17 (error_code dominant : PAYMENT_TIMEOUT, 100 %) |
| **A-3** Timeouts | `error_code: "PAYMENT_TIMEOUT"` | 17 — 1er à 08:34:06 UTC, dernier à 08:42:36 UTC |
| **A-4** Utilisateurs impactés | (Visualize `user_id`) | 17 utilisateurs uniques — 1 seul timeout chacun (distinct values = 17) |
| **A-5** Montant bloqué | (Lens → Sum of `amount`, filtré `PAYMENT_TIMEOUT`) | 4 726 € |
| **A-6** Fin de l'incident | `service: "payment-service" AND message: "rétablie"` | Rétablissement à 08:43:15 UTC |

**Récapitulatif chiffré ELK** :
- Nombre total d'erreurs : 34
- Erreurs `PAYMENT_TIMEOUT` : 17
- Montant financier bloqué : 4 726 €
- Début incident : 08:34:06 — Fin : 08:43:15 — Durée : ~9 min

---

## ┌─ PARTIE B — Analyse Loki (Grafana + LogQL) ─┐

| Requête | LogQL | Mon résultat |
|---|---|---|
| **B-2** Tous les ERROR | `{job="shopflow", level="ERROR"}` | 34 |
| **B-3** ERROR payment-service | `{job="shopflow", level="ERROR", service="payment-service"}` | 17 |
| **B-4** Timeouts | `{job="shopflow", error_code="PAYMENT_TIMEOUT"}` | 17 |
| **B-5** Recherche texte | `{job="shopflow"} \|= "rétablie"` | 1 (« Connexion au provider de paiement rétablie ») |
| **B-6** Taux d'erreurs / temps | `sum by (service) (count_over_time({job="shopflow", level="ERROR"}[5m]))` | Pic visible ✅ — 2 services : `payment-service` (17) + `api-gateway` (17) = 34 |
| **B-7** Filtre latence (JSON) | `{job="shopflow", service="payment-service"} \| json \| latency_ms > 5000` | 14 (strict `>`) — **17** avec `>= 5000` (3 timeouts sont pile à 5000 ms) |

**Récapitulatif Loki** :
- Requête LogQL clé : `{job="shopflow", service="payment-service"} | json | latency_ms >= 5000`
- Erreurs au pic : 34 dans la fenêtre (17 payment-service + 17 api-gateway)
- Latence des timeouts : 5000 → 5004 ms (moyenne ≈ 5001 ms, tous au seuil de 5 s)

> ✅ **Résultats identiques à ELK** (34 / 17 / 17 / 1) — même incident, syntaxe différente : Loki filtre **par label indexé** (rapide) vs recherche texte `|=` (grep sur le contenu).
> ⚠️ **Piège des seuils** : `latency_ms > 5000` (strict) renvoie 14 et **rate 3 timeouts** pile à 5000 ms → utiliser `>= 5000` pour capturer les 17.
> 📌 **Note technique** : le `promtail-config.yml` n'a **pas de stage `timestamp`** → Promtail horodate les logs à l'**heure d'ingestion** (pas nov. 2024). Chercher sur « Last 15 min » dans Grafana, pas sur la date d'origine. Le vrai timestamp reste dans le contenu JSON.

---

## ┌─ PARTIE C — Synthèse ELK vs Loki ─┐

### Tableau comparatif (observé pendant le TP)

| Critère | ELK | Loki |
|---|---|---|
| Démarrage (temps/ressources) | Lourd (~60 s, Elasticsearch + Kibana) | Léger (~30 s, Loki + Promtail + Grafana) |
| Modèle d'index | Index **full-text** sur tout le contenu | Index sur les **labels** seulement |
| Syntaxe | KQL (`level: "ERROR"`) | LogQL (`{level="ERROR"}` + `\|=`) |
| Recherche full-text | ✅ native, instantanée | ⚠️ possible via `\|=` (grep, pas d'index) |
| RAM consommée | ~1,5 Go | ~200 Mo |
| Intégration Grafana | via plugin | ✅ native (même écosystème que Prometheus) |

### C.2 — Recommandation de migration (au CTO)

**Recommandation : migrer vers Loki.**

Le besoin de ShopFlow est le **diagnostic d'incidents**, pas l'audit full-text ni la
compliance — or c'est exactement le terrain de Loki, qui n'indexe que les **labels**
(`service`, `level`, `error_code`) et stocke le contenu compressé. À **200 Go/jour**,
l'indexation full-text systématique d'Elasticsearch coûte cher en RAM et en stockage
(~1,5 Go vs ~200 Mo constaté sur le TP) : Loki réduit fortement la facture des
**1 800 €/mois**. L'équipe est déjà formée sur **Grafana** (pour Prometheus) : Loki
réutilise cet acquis et offre un **panneau unique** métriques + logs, sans montée en
compétence supplémentaire. Loki tourne nativement sur **Docker Compose / VM**, sans
imposer Kubernetes. On ne conserverait ELK que si un besoin de **recherche full-text
ad hoc ou de compliance** apparaissait — ce qui n'est pas le cas aujourd'hui.

### C.3 — Questions de compréhension

**1. Pourquoi Elasticsearch consomme plus de RAM que Loki ?**
Elasticsearch construit un **index inversé sur le contenu de chaque champ** (chaque mot
est tokenisé et indexé), maintenu en partie en mémoire (heap, caches, doc values). Loki
n'indexe que les **labels** (métadonnées) et garde le contenu des logs **compressé en
chunks** (stockage objet), sans index full-text → empreinte mémoire minime.

**2. Différence entre `{level="ERROR"}` et `|= "ERROR"` en LogQL ?**
`{level="ERROR"}` est un **sélecteur de label** : il choisit les *streams* via un label
indexé (rapide, obligatoire, fait au niveau de l'index). `|= "ERROR"` est un **filtre de
ligne** : un *grep* sur le contenu brut des streams déjà sélectionnés (parcourt le texte,
plus lent, matche « ERROR » n'importe où dans la ligne). Le premier cible la métadonnée,
le second cherche dans le contenu.

**3. Un cas où choisir ELK plutôt que Loki ?**
Quand on a besoin de **recherche full-text ad hoc** ou d'**audit/compliance/SIEM** : ex.
une équipe sécurité qui doit retrouver *« toutes les lignes mentionnant cette IP ou cette
chaîne, tous services confondus »*, sans connaître les labels à l'avance. L'index inversé
d'ES rend ça instantané ; Loki devrait faire un grep coûteux si les labels ne réduisent
pas d'abord la fenêtre.

**4. Qu'est-ce qu'un stream ? Pourquoi éviter les labels à haute cardinalité ?**
Un **stream** = une combinaison **unique** de labels (ex. `{job="shopflow",
service="payment-service", level="ERROR"}`) ; toutes les lignes partageant ces labels vont
dans le même stream. Un label à **haute cardinalité** (`user_id`, `trace_id`, `order_id`…)
génère un stream distinct par valeur → **explosion du nombre de streams**, de l'index et de
la mémoire, ce qui ruine le modèle « petit index » de Loki. On garde donc des labels à
**faible cardinalité** (service, level, env) et on met le reste dans le **contenu**
(interrogé via `| json`).

---

## ┌─ PARTIE D — Métriques Prometheus (temps réel) ─┐

Incident déclenché via `curl http://localhost:8080/incident/start` (30 % des
`/api/checkout` échouent en `PAYMENT_TIMEOUT`). Dashboard : `ShopFlow — Métriques
Prometheus` (4 panels, voir `grafana-dashboard-shopflow.json`).

**Baselines vs incident** :

| Métrique | Baseline | Pendant incident | Écart |
|---|---|---|---|
| Débit total | ~2 req/s | ~2 req/s | stable |
| Taux d'erreur 5xx (%) | ~0,3 % | ~9,5 % | ×30 |
| Latence P95 checkout | 0,24 s | 9,2 s | ×38 |
| Latence P99 checkout | 0,25 s | 9,8 s | ×40 |
| Connexions DB actives | faibles (~5/50) | jusqu'à 35/50 (70 %) | ↗ saturation |
| Premier panel à réagir | — | **Latence P99** (puis taux d'erreur) | — |

> 💡 Le **P99 de latence** réagit en premier et le plus violemment : les checkouts qui
> échouent au timeout (~5-6 s) sont captés par le 99ᵉ percentile bien avant que le taux
> d'erreur (moyenné sur `rate[5m]`) ne rattrape la réalité. Le **P50 reste bas** (client
> médian servi vite) → d'où l'intérêt des percentiles vs la moyenne.
> Le taux global plafonne à ~9-10 % (et non 30 %) car seul `/api/checkout` échoue, dilué
> dans le trafic sain des autres endpoints.

**Corrélation logs** (app-sample non câblé à Loki dans ce compose → logs lus via
`docker logs shopflow-app-sample`) :
1. Message + `error_code` : *« Paiement échoué — timeout provider »*, `error_code:
   PAYMENT_TIMEOUT`, `provider: stripe-api-eu-west` — **même code que l'incident statique
   des Parties A/B**.
2. Cohérent avec Prometheus ? **Oui** — les logs montrent `latency_ms ≈ 5999 ms`, ce qui
   explique le pic P99 (~9 s) et le taux d'erreur du dashboard. Métrique = *« ça va mal »*,
   log = *« pourquoi : timeout Stripe »*.
3. Détection visuelle : **quasi immédiate** (le P99 décolle en ~15-30 s après le
   déclenchement, dès le premier scrape à latence élevée).

---

## ┌─ CONCLUSION — Comparatif des 3 outils ─┐

| Critère | ELK | Loki | Prometheus |
|---|---|---|---|
| Type de données | Logs | Logs | Métriques |
| Post-mortem (historique) | ✅ | ✅ | ⚠️ (rétention limitée) |
| Détection temps réel | ❌ | ❌ | ✅ |
| Montant financier bloqué | ✅ | ✅ | ❌ |
| Root cause dans les logs | ✅ | ✅ | ❌ seul |
| Alertes automatiques | ⚠️ | ⚠️ | ✅ natif |
| Consommation RAM | ~1,5 Go | ~200 Mo | ~100 Mo |

**Quel outil aurait détecté l'incident le plus tôt ?**
**Prometheus** — le P99 de latence et le taux d'erreur 5xx explosent en temps réel, avec
alerting natif, sans attendre une analyse de logs a posteriori.

**Quel outil donne le plus d'information sur la cause ?**
**ELK / Loki** — les logs portent le `error_code` (PAYMENT_TIMEOUT), le `provider`
(stripe-api-eu-west), le montant bloqué et le message de rétablissement : la root cause et
l'impact métier précis.

**Quel outil pour ne plus rater ce type d'incident à l'avenir ?**
**Prometheus (détection + alerting) corrélé à Loki dans Grafana** — les métriques disent
*« quelque chose ne va pas maintenant »*, les logs disent *« voici pourquoi »*. La
combinaison des deux dans un seul écran est la solution gagnante.
