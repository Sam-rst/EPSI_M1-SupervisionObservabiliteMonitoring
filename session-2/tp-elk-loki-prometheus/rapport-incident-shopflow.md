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

## ┌─ PARTIE D — Métriques Prometheus (temps réel) ─┐

> À compléter **pendant** l'incident live (`./trigger-incident.sh start`).

**Baselines vs incident** :

| Métrique | Baseline | Pendant incident | Écart |
|---|---|---|---|
| Taux d'erreur 5xx (%) | _______ | _______ | _______ |
| Latence P95 checkout | _______ | _______ | _______ |
| Latence P99 checkout | _______ | _______ | _______ |
| Connexions DB actives | _______ / 50 | _______ / 50 | _______ |
| Premier panel à réagir | — | _______ | — |

**Corrélation Loki** (`{job="app-sample"} | json | level="ERROR"`) :
1. Message + `error_code` observés : _______
2. Cohérent avec les métriques Prometheus ? _______
3. Délai de détection visuelle : _______ secondes

---

## ┌─ CONCLUSION — Comparatif des 3 outils ─┐

| Critère | ELK | Loki | Prometheus |
|---|---|---|---|
| Type de données | _______ | _______ | _______ |
| Post-mortem (historique) | ___ | ___ | ___ |
| Détection temps réel | ___ | ___ | ___ |
| Montant financier bloqué | ___ | ___ | ___ |
| Root cause dans les logs | ___ | ___ | ___ |
| Alertes automatiques | ___ | ___ | ___ |
| Consommation RAM | _______ | _______ | _______ |

**Quel outil aurait détecté l'incident le plus tôt ?**
_______________________________________________________________

**Quel outil donne le plus d'information sur la cause ?**
_______________________________________________________________

**Quel outil pour ne plus rater ce type d'incident à l'avenir ?**
_______________________________________________________________
