# MSPR — ShopFlow : Nouvel Incident
## Séance 3 / Bloc 4 — Durée : 1h

---

## 🎯 Contexte

> Le support ShopFlow remonte des signalements épars, difficiles à reproduire : certains clients se plaignent que leur commande met "bizarrement longtemps" à se valider, sans message d'erreur — la commande finit toujours par passer. Ce n'est pas systématique, donc personne n'avait creusé jusqu'ici.
>
> Vous êtes l'astreinte SRE. **Contrairement à l'incident du Bloc 2** (où l'erreur n'était pas liée à la durée), cette fois l'anomalie est **exactement** une question de durée. Diagnostiquez, en autonomie guidée.

⚠️ Ne réutilisez pas mécaniquement la conclusion du Bloc 2 : là-bas, la trace en erreur n'était pas plus longue que la normale. Ici, vous allez vérifier si c'est le cas ou non — ne présumez de rien avant d'avoir regardé les données.

## 📋 Objectifs

- Repérer une opération anormalement lente au milieu d'un trafic globalement rapide
- Investiguer successivement Logs → Métriques → Traces
- Confirmer (ou infirmer) l'hypothèse d'un bottleneck de durée avec des preuves
- Rédiger un rapport d'incident complet, en contrastant avec le Bloc 2

## 📋 Prérequis

- Stack Docker démarré (`docker compose up -d --build`), Jaeger inclus
- `traffic-gen` actif depuis au moins 2-3 minutes (l'anomalie n'apparaît que sur une partie du trafic)
- Avoir traité le TP-Jaeger.md (Bloc 2)

---

## Phase 1 — Détection (10 min)

Ouvrez le dashboard unifié (Bloc 3), ou directement Prometheus (http://localhost:9090).

### Requête PromQL guidée

```promql
# Latence P95 par route
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{service="api-gateway"}[5m])) by (route)
```

### ✍️ Questions

1. Combien de routes distinctes apparaissent dans le résultat ?
2. L'une d'elles a-t-elle une latence P95 nettement supérieure aux autres ? Laquelle ?
3. Cette route est-elle appelée aussi souvent que les autres (indice : regardez aussi `sum(rate(http_requests_total{service="api-gateway"}[5m])) by (route)`) ? Qu'est-ce que cela vous dit sur la difficulté à détecter ce problème "à l'œil" ?

📝 Notez le nom de la route impactée avant de continuer.

---

## Phase 2 — Investigation Logs (10 min)

### Requête LogQL guidée

```logql
{service="api-gateway"} |= "Slow"
```

### ✍️ Questions

4. Quel message revient dans ces logs ?
5. Quel niveau de log (`level`) est utilisé — `error`, `warn`, ou `info` ? Qu'est-ce que cela suggère sur la gravité perçue par l'application elle-même ?
6. Relevez 3 valeurs de `duration_ms` sur des occurrences différentes. Sont-elles toutes proches, ou très variables ?

---

## Phase 3 — Investigation Métriques (10 min)

### Requête PromQL guidée

```promql
# Distribution de la latence sur la route identifiée en Phase 1
histogram_quantile(0.50, rate(http_request_duration_seconds_bucket{route="/api/slow"}[5m]))
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{route="/api/slow"}[5m]))
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{route="/api/slow"}[5m]))
```

### ✍️ Questions

7. Comparez P50, P95 et P99. Sont-ils proches (latence homogène) ou très écartés (latence très variable) ?
8. Comparez avec la latence de `/api/checkout` (vue en Bloc 2, ~100-300ms). Quel est l'ordre de grandeur de l'écart ?

---

## Phase 4 — Investigation Traces (20 min)

Ouvrez Jaeger UI : **http://localhost:16686**

### Étapes guidées

```
Service         : api-gateway
Operation       : GET /api/slow
Lookback        : Last 15 minutes
```

Ouvrez plusieurs traces trouvées et examinez le waterfall de chacune.

### ✍️ Questions

9. En ignorant les spans techniques d'auto-instrumentation Express (middleware), combien de spans **nommés** (`inventory.*`) voyez-vous dans une trace `GET /api/slow` ? Nommez-les.
10. Lequel des spans occupe la quasi-totalité de la durée totale ?
11. Ce span est-il marqué en **erreur** (comme dans le Bloc 2), ou en statut **OK** malgré sa durée ?
12. Relevez l'attribut `db.statement` du span le plus long. Que suggère-t-il sur la cause technique ?
13. Ouvrez 2-3 traces différentes de la même opération : la durée du span fautif est-elle toujours similaire, ou très variable d'une requête à l'autre ?

---

## Phase 5 — Rapport de synthèse (10 min)

Complétez ce rapport (présentation orale de 2 minutes à la suite) :

```markdown
## MSPR — Rapport d'Incident ShopFlow (Bloc 4)

**Route impactée** : _______________________
**Span fautif** : _______________________
**Statut du span** : OK / ERROR (entourez)
**Durée observée (plage)** : _______ ms à _______ ms

**Preuves par pilier**

- Métriques : _______________________________________________
  (P50/P95/P99 sur la route, comparaison avec /api/checkout)

- Logs : ______________________________________________________
  (message exact, niveau de log, valeurs de duration_ms)

- Traces : ____________________________________________________
  (span fautif, attribut db.statement, variabilité entre traces)

**Root cause proposée** :
_______________________________________________________________

**Ce qui différencie cet incident de celui du Bloc 2** :
_______________________________________________________________
(Bloc 2 : span en erreur, durée normale — Bloc 4 : span en _______,
durée _______)

**Pourquoi ce problème est-il resté "invisible" jusqu'ici ?**
_______________________________________________________________
(indice : fréquence d'appel de la route, cf. Phase 1 question 3)
```

---

## ✅ Livrables attendus

- [ ] Réponses aux 13 questions guidées
- [ ] Capture d'écran : requête PromQL de latence par route (Phase 1)
- [ ] Capture d'écran : logs `Slow endpoint called` (Phase 2)
- [ ] Capture d'écran : P50/P95/P99 sur la route impactée (Phase 3)
- [ ] Capture d'écran : waterfall Jaeger d'au moins une trace (Phase 4)
- [ ] Rapport de synthèse complété (Phase 5)
- [ ] Présentation orale (2 min)

---

## 🛠️ Troubleshooting

| Problème | Solution |
|----------|----------|
| Aucune latence anormale visible en Phase 1 | `traffic-gen` n'a peut-être pas encore appelé la route (5% de pondération seulement) : attendre 1-2 min de plus |
| Pas de logs "Slow" trouvés | Vérifier le label `service="api-gateway"` exact (visible dans le dashboard Phase 1) |
| Aucune trace `GET /api/slow` dans Jaeger | Élargir le Lookback ; vérifier que l'app a bien été reconstruite (`docker compose up -d --build`) |
| Toutes les traces ont une durée quasi identique | Peu probable vu l'aléatoire du scénario (500-2500ms) — si c'est le cas, vérifier que vous regardez bien plusieurs traces différentes, pas la même rechargée |

---

### Éléments de référence (comportement réel du code, `app-sample/server.js`)

- Route : `GET /api/slow`
- Service : `api-gateway` (même service que tout le reste — pas de microservice séparé)
- Spans : `inventory.check_stock` (parent) → `inventory.db_lock_wait` (enfant, porte la quasi-totalité de la durée)
- Durée : **aléatoire entre 500 et 2500 ms à chaque appel**, sans schéma temporel particulier (ce n'est pas une dégradation progressive avec un début/une fin, mais une lenteur intrinsèque et constante de l'opération)
- Statut : **toujours OK**, jamais d'erreur HTTP sur cette route
- Log associé : `{"level":"warn","service":"api-gateway","message":"Slow endpoint called","duration_ms":<500-2500>,"trace_id":"..."}`
- Fréquence d'appel : ~5% du trafic généré par `traffic-gen` (poids `weight: 5` dans `traffic-generator.js`), ce qui explique la difficulté de détection sans dashboard dédié

⚠️ Ces chiffres sont **aléatoires à chaque exécution** (pas de dataset figé à valider comme au Bloc 2) — c'est le comportement réel et vivant de l'application qui sert de scénario, pas un import de données. Faites tourner le TP vous-même avant la séance pour vérifier vos propres captures d'écran de référence.

---

*Document participant (+ grille animateur en annexe) — Version 2.0 (corrigée pour coller au stack réel : endpoint `/api/slow` existant, service unique `api-gateway`)*
