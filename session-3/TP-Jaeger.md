# TP — Traces Distribuées avec Jaeger
## Séance 3 / Bloc 2 — Durée : 1h

---

## 🎯 Objectifs

À l'issue de ce TP, vous serez capable de :
- Déployer Jaeger dans le stack ShopFlow existant
- Comprendre le principe de l'instrumentation OpenTelemetry (auto + manuelle)
- Rechercher une trace dans Jaeger UI et lire un waterfall
- Identifier **quel span précis** est responsable d'un échec, et lire ses attributs techniques

## 📋 Prérequis

- Stack Docker de la séance 2 déjà démarré (`docker compose up -d`)
- Docker et Docker Compose fonctionnels
- Avoir traité le TP1-loki.md et TP2-prometheus.md (séance 2) — on réutilise la **même application** (`app-sample`, service `api-gateway`)

## 🧵 Rappel du contexte

> ShopFlow (e-commerce) expose une seule application (`api-gateway`) qui gère le checkout. En séance 2, vous avez observé des pics d'erreurs de paiement via les logs (Loki) et les métriques (Prometheus), déclenchés par `trigger-incident.sh` (le taux d'échec paiement passe de 5% à 30%).
>
> Aujourd'hui : vous allez retrouver **la trace exacte** d'une requête en échec pour voir, span par span, ce qui distingue une requête qui réussit d'une requête qui échoue — et vous découvrirez que ce n'est **pas une question de lenteur**.

⚠️ **Point important** : `app-sample` est une seule application (pas plusieurs microservices séparés). Les "étapes" que vous verrez dans la trace (`validate_cart`, `check_inventory`, `process_payment`, `stripe_api_call`) sont des **spans internes** au même service `api-gateway`, pas des appels réseau entre conteneurs différents. Le principe de Jaeger reste identique — la hiérarchie de spans fonctionne pareil, qu'elle traverse un ou dix services.

---

## Partie A — Déploiement de Jaeger (10 min)

Le service `jaeger` a été ajouté à votre `docker-compose.yml`, et `app-sample` a été instrumenté avec OpenTelemetry (fichier `tracing.js` + spans manuels dans `server.js`).

```bash
cd ~/BOTE848

# 1. Reconstruire l'image app-sample (nouvelles dépendances OpenTelemetry)
#    et démarrer le stack complet, y compris jaeger
docker compose up -d --build

# 2. Attendre le démarrage des nouveaux services
sleep 15

# 3. Vérifier que tout tourne
docker compose ps
# → tous les services doivent être "Up", y compris jaeger

# 4. Vérifier que Jaeger UI répond
curl -s http://localhost:16686 -o /dev/null -w "%{http_code}\n"
# → 200 attendu

# 5. Vérifier la stack complète (inclut désormais Jaeger)
./scripts/check-tp-ready.sh
```

**Vérification** :
- [ ] `docker compose ps` montre le conteneur `jaeger` en statut `Up`
- [ ] http://localhost:16686 affiche l'interface Jaeger UI dans votre navigateur
- [ ] `check-tp-ready.sh` affiche "Jaeger reçoit des traces" en ✓ OK (laisser tourner `traffic-gen` 30s si besoin)

---

## Partie B — Comprendre l'instrumentation (15 min)

Ouvrez les deux fichiers modifiés dans `app-sample/` :

```bash
cat ~/BOTE848/app-sample/tracing.js
cat ~/BOTE848/app-sample/server.js
```

`tracing.js` initialise le SDK OpenTelemetry et l'auto-instrumentation (Express, HTTP) :

```javascript
const sdk = new NodeSDK({
  serviceName: SERVICE_NAME,               // "api-gateway"
  traceExporter: new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
  instrumentations: [getNodeAutoInstrumentations({ /* ... */ })],
});
sdk.start();
```

Dans `server.js`, la route `/api/checkout` est instrumentée avec **4 spans manuels imbriqués** :

```javascript
app.post('/api/checkout', async (req, res) => {
  // ...
  await tracer.startActiveSpan('checkout.validate_cart', async (span) => {
    await new Promise((r) => setTimeout(r, Math.random() * 15 + 10));
    span.end();
  });

  await tracer.startActiveSpan('checkout.check_inventory', async (span) => {
    await new Promise((r) => setTimeout(r, Math.random() * 25 + 15));
    span.end();
  });

  await tracer.startActiveSpan('checkout.process_payment', async (paymentSpan) => {
    await tracer.startActiveSpan('payment.stripe_api_call', async (stripeSpan) => {
      await new Promise((r) => setTimeout(r, latencyMs));   // 100-300ms, TOUJOURS

      if (Math.random() < failureRate) {
        const errorCode = /* PAYMENT_TIMEOUT | PAYMENT_INVALID_CARD | PAYMENT_RATE_LIMIT */;
        stripeSpan.recordException(new Error(errorCode));
        stripeSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorCode });
        paymentSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorCode });
        // ...
      }
      // ...
    });
  });
});
```

### ✍️ Questions (à répondre dans votre rapport)

1. Combien de spans **manuels** (créés explicitement dans `server.js` avec `tracer.startActiveSpan`) sont exécutés pour une seule requête `/api/checkout` réussie ? Listez-les dans l'ordre.
2. Le span `payment.stripe_api_call` est-il **enfant** de `checkout.process_payment` ou son **frère** (même niveau) ? Justifiez avec le code.
3. Que se passe-t-il exactement dans le code quand le paiement échoue ? Citez les deux méthodes appelées sur `stripeSpan`.
4. Regardez la ligne `await new Promise((r) => setTimeout(r, latencyMs))`. Cette ligne s'exécute-t-elle **différemment** selon que le paiement va réussir ou échouer ? Qu'est-ce que cela implique pour la durée du span en cas d'erreur ?

💡 La question 4 est un piège volontaire — répondez-y avant de passer à la Partie C, vous allez vérifier votre réponse avec de vraies données.

⚠️ **Dans Jaeger UI, une trace affichera plus que ces 4 spans** (souvent une dizaine). L'auto-instrumentation Express crée aussi des spans techniques pour son fonctionnement interne (middleware, routing...). Ce n'est pas une anomalie : concentrez-vous uniquement sur les spans nommés `checkout.*` et `payment.*` pour répondre aux questions — les autres ne sont pas à analyser dans ce TP.

---

## Partie C — Déclencher l'incident et rechercher les traces en erreur (20 min)

### Étape 1 — Générer du trafic sain (référence)

`traffic-gen` tourne déjà en continu. Laissez passer 30 secondes, puis ouvrez Jaeger UI : **http://localhost:16686**

Recherchez une trace **normale** :

| Champ | Valeur |
|-------|--------|
| Service | `api-gateway` |
| Operation | `POST /api/checkout` |
| Tags | *(laisser vide)* |
| Lookback | Last 5 minutes |

Ouvrez une trace au hasard qui a réussi (status 200). Ignorez les spans techniques d'auto-instrumentation (middleware Express) : repérez et notez uniquement les 4 spans nommés `checkout.validate_cart`, `checkout.check_inventory`, `checkout.process_payment`, `payment.stripe_api_call`, avec leurs durées approximatives.

### ✍️ Question

5. Notez la durée de chacun de ces 4 spans (`checkout.*` / `payment.*`) sur cette trace normale. Sont-elles très différentes les unes des autres, ou du même ordre de grandeur ?

### Étape 2 — Déclencher l'incident

```bash
./scripts/trigger-incident.sh start
# → taux d'échec paiement : 5% -> 30%
```

Laissez tourner 1 minute pour que `traffic-gen` génère plusieurs échecs.

### Étape 3 — Rechercher une trace en erreur

Dans Jaeger UI :

| Champ | Valeur |
|-------|--------|
| Service | `api-gateway` |
| Operation | `POST /api/checkout` |
| Tags | `error=true` |
| Lookback | Last 5 minutes |

Ouvrez une des traces trouvées.

### ✍️ Questions

6. Quel est le `trace_id` de cette trace (visible en haut de la page) ?
7. Parmi les 4 spans `checkout.*` / `payment.*`, lequel est marqué en erreur (rouge) ? Les 3 autres le sont-ils aussi ?
8. Cliquez sur le span en erreur : relevez l'attribut `payment.provider` et le message d'exception enregistré (`recordException`).
9. **Comparez la durée de ce span en erreur avec les durées notées à la question 5 (trace normale).** Le span en erreur est-il anormalement long, comme vous l'auriez peut-être supposé ?

💡 Reprenez votre réponse à la question 4 : aviez-vous anticipé ce résultat ?

### Étape 4 — Revenir à la normale

```bash
./scripts/trigger-incident.sh stop
# → taux d'échec paiement : 30% -> 5%
```

---

## Partie D — Synthèse (15 min)

Complétez ce rapport :

```markdown
## Incident Analysis — Traces

**Trace ID (trace en erreur)** : _______________________
**Span en erreur** : _______________________
**Durée du span en erreur** : _______ ms
**Durée moyenne du même span sur une trace normale** : _______ ms
**Écart de durée notable ?** : Oui / Non

**Attribut technique relevé (error_code / message d'exception)** :
_______________________________________________________________

**Ce que cette trace montre, que les logs et métriques seuls ne montraient pas** :
_______________________________________________________________

**Root cause réelle de l'incident déclenché** :
_______________________________________________________________

**Piège identifié** : dans ce scénario, l'anomalie n'est PAS une durée
anormalement longue (contrairement à l'intuition habituelle du tracing).
C'est le **statut** du span (ERROR) et son **attribut error_code** qui
localisent précisément le problème : une hausse du taux d'échec du
provider de paiement, pas une lenteur.
```

💡 Astuce : recherchez aussi le même `trace_id` dans Loki (`{service="api-gateway"} |= "<trace_id>"`) — vous devriez retrouver la ligne de log `Payment processing failed` avec le même identifiant, preuve concrète de la corrélation logs ↔ traces vue en théorie (Bloc 1).

---

## ✅ Livrables attendus

- [ ] Réponses aux 9 questions ci-dessus
- [ ] Capture d'écran d'une trace normale (les 4 spans `checkout.*`/`payment.*` identifiés, tous OK)
- [ ] Capture d'écran d'une trace en erreur (span `payment.stripe_api_call` en rouge)
- [ ] Rapport de synthèse complété (Partie D)
- [ ] (Bonus) Capture de la recherche du `trace_id` dans Loki confirmant la corrélation

---

## 🛠️ Troubleshooting

| Problème | Solution |
|----------|----------|
| Jaeger UI ne charge pas | Vérifier `docker compose ps` ; le port 16686 doit être libre sur votre machine |
| `api-gateway` n'apparaît pas dans la liste des services Jaeger | L'image `app-sample` n'a peut-être pas été reconstruite : relancer `docker compose up -d --build` |
| Aucune trace avec `error=true` | Vérifier que `trigger-incident.sh start` a bien été exécuté, et laisser `traffic-gen` tourner 1 minute de plus |
| Le waterfall semble incomplet (spans manquants) | Vérifier dans les logs du conteneur (`docker compose logs app-sample`) qu'aucune erreur d'export OTLP n'apparaît |
| Toutes les traces semblent avoir la même durée | C'est normal et attendu ici (cf. Partie C, question 9) — ce n'est pas un bug |

---

*Document participant - Version 2.0 (corrigée pour coller au stack réel — service unique `api-gateway`)*
