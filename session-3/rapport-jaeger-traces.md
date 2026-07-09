# Rapport TP — Traces distribuées avec Jaeger

> **Module BOTE848 — Séance 3 / Bloc 2**
> **Auteur** : Samuel RESSIOT
> **Application** : `api-gateway` (app-sample instrumentée OpenTelemetry → Jaeger)
> **Scénario** : incident paiement ShopFlow (taux d'échec 5 % → 30 %)

---

## Partie B — Comprendre l'instrumentation

**Q1 — Spans manuels d'un `/api/checkout` réussi (dans l'ordre)** — 4 spans :
1. `checkout.validate_cart`
2. `checkout.check_inventory`
3. `checkout.process_payment`
4. `payment.stripe_api_call` (sous-span du précédent)

**Q2 — `payment.stripe_api_call` : enfant ou frère ?**
**Enfant** de `checkout.process_payment`. Dans `server.js`, `startActiveSpan('payment.stripe_api_call')` est appelé **à l'intérieur** du callback de `checkout.process_payment` ; comme `startActiveSpan` place le span dans le contexte actif, le span imbriqué devient automatiquement enfant du span courant.

**Q3 — Deux méthodes sur `stripeSpan` en cas d'échec :**
`stripeSpan.recordException(err)` et `stripeSpan.setStatus({ code: ERROR, message: errorCode })`.

**Q4 — La latence s'exécute-t-elle différemment selon succès/échec ? (piège)**
**Non.** `await new Promise((r) => setTimeout(r, latencyMs))` s'exécute **avant** le test d'échec, et `latencyMs` (100-300 ms) est calculé une seule fois, indépendamment du résultat. → **Le span en erreur n'est pas plus long qu'un span normal.** L'anomalie sera dans le **statut**, pas la durée.

---

## Partie C — Traces en erreur

**Q5 — Durées des spans sur une trace NORMALE :**

| Span | Durée |
|---|---|
| `checkout.validate_cart` | ~17 ms |
| `checkout.check_inventory` | ~28 ms |
| `checkout.process_payment` | ~193 ms |
| `payment.stripe_api_call` | ~193 ms |

→ Pas du même ordre : `stripe_api_call` (~193 ms) domine les deux premières étapes (~17-28 ms). Le paiement est l'étape lourde.

**Q6 — trace_id de la trace en erreur :** `49356fbdf3635a5e7c625f8c11574f3c`

**Q7 — Span(s) en erreur :**
`payment.stripe_api_call` est la **source** de l'erreur. Elle **remonte** par propagation à son parent `checkout.process_payment` et à la racine `POST /api/checkout` (rouges aussi). `validate_cart` et `check_inventory` restent **OK** (verts). → 1 vraie source, 2 rouges par propagation, 2 sains.

**Q8 — Attributs du span en erreur :**
- `payment.provider` = **stripe**
- exception / statut = **PAYMENT_INVALID_CARD** (code tiré au hasard parmi `PAYMENT_TIMEOUT` / `PAYMENT_INVALID_CARD` / `PAYMENT_RATE_LIMIT`)

**Q9 — Durée du span en erreur vs normale (piège confirmé) :**
Span en erreur = **253 ms**, vs ~193 ms en moyenne sur une trace normale (plage 100-300 ms). → **253 ms est dans la plage normale : le span en erreur n'est PAS anormalement long.** Confirmation exacte de la réponse Q4.

---

## Partie D — Synthèse (Incident Analysis — Traces)

**Trace ID (trace en erreur)** : `49356fbdf3635a5e7c625f8c11574f3c`
**Span en erreur** : `payment.stripe_api_call`
**Durée du span en erreur** : 253 ms
**Durée moyenne du même span sur une trace normale** : ~193 ms
**Écart de durée notable ?** : **Non** (253 ms est dans la plage normale 100-300 ms)

**Attribut technique relevé (error_code / message d'exception)** :
`payment.provider = stripe` · `error_code = PAYMENT_INVALID_CARD` (exception enregistrée via `recordException`)

**Ce que cette trace montre, que les logs et métriques seuls ne montraient pas** :
La **localisation précise dans la chaîne d'exécution** : quel span exact échoue (`payment.stripe_api_call`), sa position dans la hiérarchie parent/enfant, et la **propagation** du statut d'erreur vers les spans parents. Les métriques disaient *« le taux d'erreur monte »*, les logs *« PAYMENT_INVALID_CARD sur telle commande »* ; la trace montre *« l'échec est à l'étape appel Stripe, pas à la validation panier ni au stock, et ce n'est pas une lenteur »*.

**Root cause réelle de l'incident déclenché** :
Hausse du **taux d'échec du provider de paiement** (5 % → 30 % via `PAYMENT_FAILURE_RATE=0.30`). Les échecs Stripe (`PAYMENT_INVALID_CARD` / `TIMEOUT` / `RATE_LIMIT`) surviennent à latence **normale** — ce n'est **pas** un problème de performance.

**Piège identifié** :
Contrairement à l'intuition « le tracing sert à trouver le span lent », l'anomalie ici n'est **pas** une durée anormale. C'est le **statut** du span (ERROR) et son **attribut error_code** qui localisent le problème.

---

## Bonus — Corrélation logs ↔ traces

La requête Loki `{service="api-gateway"} |= "<trace_id>"` **ne renvoie rien** : dans ce docker-compose, app-sample n'est pas câblé à Loki (même limite qu'en séance 2). Mais l'app **émet bien** le log avec le `trace_id`, retrouvable via `docker logs app-sample` :

```json
{"level":"error","service":"api-gateway","message":"Payment processing failed",
 "error_code":"PAYMENT_INVALID_CARD","duration_ms":254,
 "trace_id":"49356fbdf3635a5e7c625f8c11574f3c"}
```

→ **Même trace_id, même error_code, même durée** que le span Jaeger : la corrélation log ↔ trace est prouvée (le `trace_id` est le lien commun entre les 3 piliers).

---

## Les 3 piliers de l'observabilité (bilan des séances 2-3)

| Pilier | Outil | Question à laquelle il répond |
|---|---|---|
| **Logs** | ELK / Loki | *Que s'est-il passé ?* (message, error_code, montant) |
| **Métriques** | Prometheus | *Est-ce que ça se passe maintenant ?* (taux d'erreur, P99, temps réel) |
| **Traces** | Jaeger | *Où exactement dans la chaîne ça casse ?* (span par span) |

Le `trace_id` est le fil qui relie les trois.
