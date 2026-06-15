# Référence Prometheus — Métriques, PromQL & Alertes

**Module BOTE848 — Supervision, Observabilité et Monitoring Avancé DevOps**  
Exemples basés sur le scénario ShopFlow (incident paiement — app-sample)

---

## Sommaire

1. [Architecture Prometheus](#1-architecture-prometheus)
2. [Les quatre types de métriques](#2-les-quatre-types-de-métriques)
3. [Le modèle de données](#3-le-modèle-de-données)
4. [Instrumentation d'une application](#4-instrumentation-dune-application)
5. [PromQL — Query Language](#5-promql--query-language)
6. [Alertes avec Prometheus & AlertManager](#6-alertes-avec-prometheus--alertmanager)
7. [Intégration Grafana](#7-intégration-grafana)
8. [Métriques système — Node Exporter & cAdvisor](#8-métriques-système--node-exporter--cadvisor)
9. [Référence rapide](#9-référence-rapide)

---

## 1. Architecture Prometheus

### Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────┐
│                      PROMETHEUS ECOSYSTEM                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ app-sample   │    │ node-exporter│    │    cAdvisor      │  │
│  │ :8080/metrics│    │ :9100/metrics│    │  :8080/metrics   │  │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘  │
│         │                   │                     │            │
│         └───────────────────┼─────────────────────┘            │
│                             │  HTTP scrape (pull)              │
│                    ┌────────▼────────┐                         │
│                    │   PROMETHEUS    │                         │
│                    │   :9090         │                         │
│                    │ ┌─────────────┐ │                         │
│                    │ │  TSDB local │ │                         │
│                    │ │  (15j rét.) │ │                         │
│                    │ └──────┬──────┘ │                         │
│                    │        │ rules  │                         │
│                    └────────┼────────┘                         │
│                             │                                  │
│              ┌──────────────┼──────────────┐                  │
│              ▼              ▼              ▼                   │
│       ┌────────────┐ ┌──────────────┐ ┌─────────┐            │
│       │AlertManager│ │   Grafana    │ │  Prom   │            │
│       │  :9093     │ │   :3000      │ │   UI    │            │
│       └────────────┘ └──────────────┘ └─────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### Modèle Pull vs Push

Prometheus utilise un **modèle pull** : c'est lui qui va chercher les métriques.

```
Modèle PULL (Prometheus)          Modèle PUSH (autres outils)
─────────────────────────         ──────────────────────────
Prometheus → scrape /metrics      Application → envoie données
                                  
✅ Cible contrôle ce qu'elle      ⚠️  Backend doit être disponible
   expose                            au moment de l'envoi
✅ Prometheus détecte si une      ⚠️  Configuration distribuée
   cible est down                    (chaque app sait où envoyer)
✅ Pas de configuration           ⚠️  Risque de surcharge push
   côté application               
✅ Fonctionne derrière NAT        
```

### Cycle de scrape

```
Intervalle scrape (défaut: 15s)
│
├─ T=0s   : Prometheus scrape http://app-sample:8080/metrics
│            ← reçoit texte brut format Exposition
│            → stocke dans TSDB avec timestamp
│
├─ T=15s  : Nouveau scrape → nouvelle valeur dans série temporelle
│
├─ T=30s  : Nouveau scrape ...
│
└─ ...    : Continue indéfiniment
```

### Format d'exposition (texte brut)

Ce que Prometheus reçoit quand il scrape `/metrics` :

```
# HELP http_requests_total Total des requêtes HTTP reçues
# TYPE http_requests_total counter
http_requests_total{method="GET",endpoint="/api/products",status="200"} 1523
http_requests_total{method="POST",endpoint="/api/checkout",status="200"} 247
http_requests_total{method="POST",endpoint="/api/checkout",status="500"} 74

# HELP http_request_duration_seconds Latence des requêtes HTTP
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="0.1"} 12
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="0.5"} 198
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="1.0"} 241
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="+Inf"} 247
http_request_duration_seconds_sum{endpoint="/api/checkout"} 87.3
http_request_duration_seconds_count{endpoint="/api/checkout"} 247

# HELP db_connections_active Connexions base de données actives
# TYPE db_connections_active gauge
db_connections_active{pool="primary"} 8
```

---

## 2. Les quatre types de métriques

### Counter — ne fait que monter

```
Définition : valeur qui ne peut qu'augmenter (reset à 0 au redémarrage)
Cas d'usage : comptage d'événements, bytes traités, erreurs

                         Counter : http_requests_total
valeur
  ▲
  │                                          ●
  │                              ●──────────
  │                  ●──────────
  │      ●──────────
  │●────
  └──────────────────────────────────────────▶ temps
    (reset si process redémarre → rebond à 0)
```

**Exemple ShopFlow :**
```
http_requests_total{method="POST", endpoint="/api/checkout", status="500"} 74
                                                                           ^^
                                                               74 erreurs depuis démarrage
```

**Usage PromQL :** toujours utiliser `rate()` ou `increase()`, jamais la valeur brute.

```promql
# ❌ Mauvais : valeur absolue sans sens pour un counter
http_requests_total

# ✅ Bon : taux de requêtes par seconde sur 5 minutes
rate(http_requests_total[5m])

# ✅ Bon : nombre de requêtes sur la dernière heure
increase(http_requests_total[1h])
```

---

### Gauge — monte et descend

```
Définition : valeur instantanée qui peut varier librement
Cas d'usage : CPU, mémoire, connexions actives, température

                    Gauge : db_connections_active
valeur
  ▲
10│              ●────●
  │         ●───      ●──●
  │    ●────               ●──●
  │●───                        ●───
  └──────────────────────────────────▶ temps
```

**Exemple ShopFlow :**
```
db_connections_active{pool="primary"} 8
payment_queue_size 23
active_sessions 142
```

**Usage PromQL :** lire directement, comparer dans le temps.

```promql
# Valeur actuelle
db_connections_active

# Moyenne sur 5 minutes
avg_over_time(db_connections_active[5m])

# Alerte si trop haut
db_connections_active > 45
```

---

### Histogram — distribution des valeurs

```
Définition : mesure la distribution d'une valeur dans des buckets cumulatifs
Cas d'usage : latences, tailles de requêtes, tout ce qui a une distribution

Histogram : http_request_duration_seconds (buckets cumulatifs)

Requêtes    │░░░░░░░░░░░░░░░░░░░░░░░░░ 198  │ ≤ 0.5s
ayant pris  │░░░░░░░░░░░░ 12              │ ≤ 0.1s
au plus X   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 241 │ ≤ 1.0s
            │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 247 │ ≤ +Inf (total)
            └──────────────────────────────────▶ bucket (le=)
```

**Ce que Prometheus stocke :**
```
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="0.1"}   12
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="0.5"}  198
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="1.0"}  241
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="2.0"}  247
http_request_duration_seconds_bucket{endpoint="/api/checkout",le="+Inf"} 247
http_request_duration_seconds_sum{endpoint="/api/checkout"}               87.3
http_request_duration_seconds_count{endpoint="/api/checkout"}            247
```

**Usage PromQL :** calculer des percentiles (P95, P99).

```promql
# Percentile 95 de la latence sur 5 minutes
histogram_quantile(
  0.95,
  rate(http_request_duration_seconds_bucket{endpoint="/api/checkout"}[5m])
)

# Latence moyenne
rate(http_request_duration_seconds_sum[5m])
/
rate(http_request_duration_seconds_count[5m])
```

> **Pourquoi les buckets sont cumulatifs ?**  
> `le="0.5"` signifie "less than or equal to 0.5s". Si 198 requêtes sont ≤ 0.5s,
> alors forcément toutes les 198 sont aussi ≤ 1.0s. C'est ce qui permet de calculer
> des percentiles par interpolation.

---

### Summary — quantiles pré-calculés

```
Définition : quantiles calculés par l'application elle-même (pas par Prometheus)
Cas d'usage : quand les buckets histogram ne conviennent pas, métriques custom

Summary : rpc_duration_seconds
rpc_duration_seconds{quantile="0.5"}  0.012  ← médiane
rpc_duration_seconds{quantile="0.9"}  0.045
rpc_duration_seconds{quantile="0.99"} 0.312  ← P99
rpc_duration_seconds_sum              145.7
rpc_duration_seconds_count            1234
```

**Histogram vs Summary — comment choisir ?**

| Critère | Histogram | Summary |
|---------|-----------|---------|
| Calcul quantile | Prometheus (à la query) | Application (à l'ingestion) |
| Agrégation multi-instances | ✅ Oui (`sum()`) | ❌ Non (mathématiquement incorrect) |
| Flexibilité buckets | Définis à l'avance | Quantiles définis à l'avance |
| Cas courant | Latences HTTP, tailles | Métriques très spécifiques |
| **Recommandation BOTE848** | **Préférer Histogram** | Usage avancé uniquement |

---

## 3. Le modèle de données

### Série temporelle (time series)

Chaque métrique Prometheus est une **série temporelle** identifiée de façon unique par :
- son **nom** (`http_requests_total`)
- ses **labels** (paires clé=valeur)

```
http_requests_total{method="POST", endpoint="/api/checkout", status="500"}
│                  │                                                      │
│                  └── labels (identifient la série unique)               │
└── nom de la métrique                                                     │
                                                                           └── valeur stockée
```

### Cardinalité

> ⚠️ **Concept critique** : la cardinalité = nombre total de séries temporelles uniques

```
Labels de http_requests_total dans ShopFlow :
  method   : GET, POST, DELETE       → 3 valeurs
  endpoint : /products, /checkout, /health, /users → 4 valeurs
  status   : 200, 201, 400, 404, 500 → 5 valeurs

Cardinalité = 3 × 4 × 5 = 60 séries temporelles

Si on ajoutait user_id comme label :
  1000 utilisateurs actifs
  Cardinalité = 3 × 4 × 5 × 1000 = 60 000 séries ← EXPLOSION
```

**Règles pour contrôler la cardinalité :**

```
✅ Bon label : nombre de valeurs limité et stable
   job="app-sample"         (1 valeur)
   env="production"         (2-3 valeurs : prod, staging, dev)
   method="GET"             (5-6 valeurs HTTP)
   status="200"             (dizaine de codes HTTP)

❌ Mauvais label : cardinalité explosive
   user_id="user_12345"     (millions de valeurs)
   trace_id="abc123def"     (unique par requête)
   timestamp="..."          (unique à chaque instant)
   ip_address="..."         (potentiellement illimité)
```

---

## 4. Instrumentation d'une application

### Node.js (app-sample ShopFlow)

```javascript
const prometheus = require('prom-client');

// ── Counter ──────────────────────────────────────────────────────
const httpRequestsTotal = new prometheus.Counter({
  name: 'http_requests_total',
  help: 'Total des requêtes HTTP reçues',
  labelNames: ['method', 'endpoint', 'status']
});

// ── Gauge ─────────────────────────────────────────────────────────
const activeConnections = new prometheus.Gauge({
  name: 'db_connections_active',
  help: 'Connexions actives vers la base de données',
  labelNames: ['pool']
});

// ── Histogram ─────────────────────────────────────────────────────
const requestDuration = new prometheus.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Durée des requêtes HTTP en secondes',
  labelNames: ['method', 'endpoint'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0]
  //        50ms 100ms 250ms 500ms  1s  2.5s  5s
});

// ── Summary ───────────────────────────────────────────────────────
const paymentDuration = new prometheus.Summary({
  name: 'payment_processing_duration_seconds',
  help: 'Durée traitement paiement',
  labelNames: ['provider'],
  percentiles: [0.5, 0.9, 0.95, 0.99]
});

// ── Utilisation dans les routes ───────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const end = requestDuration.startTimer({
    method: 'POST',
    endpoint: '/api/checkout'
  });

  try {
    const result = await processPayment(req.body);
    httpRequestsTotal.inc({ method: 'POST', endpoint: '/api/checkout', status: '200' });
    res.json(result);
  } catch (err) {
    httpRequestsTotal.inc({ method: 'POST', endpoint: '/api/checkout', status: '500' });
    res.status(500).json({ error: err.message });
  } finally {
    end(); // enregistre la durée dans le histogram
  }
});

// ── Endpoint /metrics ─────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prometheus.register.contentType);
  res.send(await prometheus.register.metrics());
});
```

### Python (exemple alternatif)

```python
from prometheus_client import Counter, Gauge, Histogram, start_http_server
import time

http_requests_total = Counter(
    'http_requests_total',
    'Total requêtes HTTP',
    ['method', 'endpoint', 'status']
)

db_connections = Gauge(
    'db_connections_active',
    'Connexions DB actives',
    ['pool']
)

request_duration = Histogram(
    'http_request_duration_seconds',
    'Latence requêtes HTTP',
    ['endpoint'],
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0]
)

# Lancer le serveur /metrics sur le port 8000
start_http_server(8000)

# Dans une route
http_requests_total.labels(method='GET', endpoint='/api/products', status='200').inc()
db_connections.labels(pool='primary').set(8)

with request_duration.labels(endpoint='/api/checkout').time():
    time.sleep(0.3)  # traitement simulé
```

---

## 5. PromQL — Query Language

### Concepts de base

```
INSTANT VECTOR    : valeur de la métrique à l'instant T
RANGE VECTOR      : série de valeurs sur une fenêtre temporelle
SCALAR            : nombre unique

Exemples :
  http_requests_total                    → instant vector
  http_requests_total[5m]                → range vector (5 minutes)
  42                                     → scalar
```

### Sélecteurs de labels

```promql
# Égalité exacte
http_requests_total{status="200"}

# Différent de
http_requests_total{status!="200"}

# Regex (correspond à)
http_requests_total{status=~"5.."}      ← tous les codes 5xx

# Regex (ne correspond pas)
http_requests_total{status!~"2.."}      ← tout sauf les 2xx

# Combinaison ET (virgule)
http_requests_total{method="POST", endpoint="/api/checkout"}

# Filtrer sur le job
http_requests_total{job="app-sample"}
```

### Fonctions essentielles

#### `rate()` — taux de variation par seconde

```promql
# Requêtes par seconde (moyenne sur 5 min)
rate(http_requests_total[5m])

# Taux d'erreurs 5xx par seconde
rate(http_requests_total{status=~"5.."}[5m])

# Interprétation :
#   Si rate(...) = 2.5 → 2.5 requêtes par seconde en moyenne
```

> **Règle :** toujours utiliser `rate()` avec un range vector `[Xm]`.  
> La fenêtre doit être ≥ 2× l'intervalle de scrape (ex: scrape 15s → fenêtre ≥ 30s).

#### `increase()` — augmentation sur une période

```promql
# Nombre de requêtes sur la dernière heure
increase(http_requests_total[1h])

# Nombre d'erreurs ce matin (entre 8h et 12h)
increase(http_requests_total{status=~"5.."}[4h])
```

#### `avg_over_time()`, `max_over_time()` — agrégation temporelle

```promql
# Moyenne des connexions DB sur 10 minutes
avg_over_time(db_connections_active[10m])

# Pic de connexions sur 1 heure
max_over_time(db_connections_active[1h])
```

#### `histogram_quantile()` — percentiles

```promql
# P95 de la latence checkout sur 5 minutes
histogram_quantile(
  0.95,
  rate(http_request_duration_seconds_bucket{endpoint="/api/checkout"}[5m])
)

# P50 (médiane) toutes requêtes
histogram_quantile(
  0.5,
  rate(http_request_duration_seconds_bucket[5m])
)

# P99 (le plus sensible aux pics)
histogram_quantile(
  0.99,
  rate(http_request_duration_seconds_bucket[5m])
)
```

### Agrégations

```promql
# Somme de toutes les séries
sum(rate(http_requests_total[5m]))

# Somme groupée par endpoint
sum by (endpoint) (rate(http_requests_total[5m]))

# Moyenne par méthode HTTP
avg by (method) (rate(http_request_duration_seconds_sum[5m]))

# Maximum sur toutes les instances
max(db_connections_active)

# Compte le nombre de séries (instances up)
count(up{job="app-sample"})
```

### Opérateurs arithmétiques

```promql
# Taux d'erreur en pourcentage
100 * sum(rate(http_requests_total{status=~"5.."}[5m]))
    / sum(rate(http_requests_total[5m]))

# Mémoire disponible en Mo
node_memory_MemAvailable_bytes / 1024 / 1024

# CPU utilisé (1 - idle)
1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))
```

### Requêtes ShopFlow — scénario incident paiement

```promql
# ── DÉTECTION DE L'INCIDENT ─────────────────────────────────────

# 1. Taux d'erreurs global
sum(rate(http_requests_total{status=~"5.."}[5m]))

# 2. Taux d'erreurs sur le checkout spécifiquement
rate(http_requests_total{endpoint="/api/checkout", status=~"5.."}[5m])

# 3. Pourcentage d'erreurs checkout (SLO breached si > 1%)
100 * rate(http_requests_total{endpoint="/api/checkout", status=~"5.."}[5m])
    / rate(http_requests_total{endpoint="/api/checkout"}[5m])

# ── MESURE DE L'IMPACT ───────────────────────────────────────────

# 4. Latence P95 checkout (doit être < 500ms en conditions normales)
histogram_quantile(
  0.95,
  rate(http_request_duration_seconds_bucket{endpoint="/api/checkout"}[5m])
)

# 5. Latence P99 checkout (révèle les cas extrêmes)
histogram_quantile(
  0.99,
  rate(http_request_duration_seconds_bucket{endpoint="/api/checkout"}[5m])
)

# 6. Latence moyenne
rate(http_request_duration_seconds_sum{endpoint="/api/checkout"}[5m])
/ rate(http_request_duration_seconds_count{endpoint="/api/checkout"}[5m])

# ── INVESTIGATION ────────────────────────────────────────────────

# 7. Connexions DB (saturation ?)
db_connections_active

# 8. Comparaison requêtes totales vs erreurs
sum by (status) (rate(http_requests_total[5m]))

# 9. Toutes les métriques de l'app-sample
{job="app-sample"}
```

### Opérateur `up` — santé des cibles

```promql
# Toutes les cibles et leur état (1=up, 0=down)
up

# Cibles down uniquement
up == 0

# Est-ce que app-sample est accessible ?
up{job="app-sample"}
```

---

## 6. Alertes avec Prometheus & AlertManager

### Anatomie d'une règle d'alerte

```yaml
# fichier : alert.rules.yml
groups:
  - name: shopflow_alerts           # Groupe logique d'alertes
    interval: 30s                   # Fréquence d'évaluation des règles

    rules:
      - alert: HighErrorRate        # Nom de l'alerte (unique)
        
        expr: |                     # Expression PromQL
          100 * sum(rate(http_requests_total{status=~"5.."}[5m]))
              / sum(rate(http_requests_total[5m])) > 1
        
        for: 2m                     # Durée avant déclenchement
                                    # (évite les faux positifs transitoires)
        
        labels:                     # Labels attachés à l'alerte
          severity: warning         # critical / warning / info
          team: backend
        
        annotations:                # Informations lisibles
          summary: "Taux d'erreur élevé sur ShopFlow"
          description: >
            Le taux d'erreur est à {{ $value | printf "%.1f" }}%
            (seuil : 1%). Vérifier les logs checkout.
          runbook: "https://wiki.epsi.fr/runbooks/high-error-rate"
```

### Cycle de vie d'une alerte

```
Expression PromQL vraie → PENDING (attente du "for")
                               ↓ si toujours vraie après "for"
                           FIRING → envoyé à AlertManager
                               ↓ si expression redevient fausse
                          RESOLVED → notification de résolution
```

### Alertes ShopFlow — règles complètes

```yaml
groups:
  - name: shopflow_slo
    interval: 30s
    rules:

      # ── Disponibilité ────────────────────────────────────────────
      - alert: AppDown
        expr: up{job="app-sample"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Application ShopFlow inaccessible"
          description: "L'instance {{ $labels.instance }} ne répond plus depuis 1 minute."

      # ── Taux d'erreur ────────────────────────────────────────────
      - alert: HighErrorRateWarning
        expr: >
          100 * sum(rate(http_requests_total{status=~"5.."}[5m]))
              / sum(rate(http_requests_total[5m])) > 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Taux d'erreur > 1% ({{ $value | printf \"%.1f\" }}%)"

      - alert: HighErrorRateCritical
        expr: >
          100 * sum(rate(http_requests_total{status=~"5.."}[5m]))
              / sum(rate(http_requests_total[5m])) > 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Taux d'erreur critique > 5% ({{ $value | printf \"%.1f\" }}%)"
          description: "SLO breached. Budget d'erreur épuisé. Action immédiate requise."

      # ── Latence ──────────────────────────────────────────────────
      - alert: HighLatencyP95
        expr: >
          histogram_quantile(0.95,
            rate(http_request_duration_seconds_bucket{endpoint="/api/checkout"}[5m])
          ) > 0.5
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "P95 latence checkout > 500ms ({{ $value | printf \"%.0f\" }}ms)"

      # ── Saturation ───────────────────────────────────────────────
      - alert: DBConnectionsHigh
        expr: db_connections_active > 45
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Connexions DB élevées : {{ $value }}/50"
          description: "Risque de saturation du pool. Vérifier les requêtes longues."
```

### Configuration AlertManager

```yaml
# alertmanager.yml
global:
  smtp_from: 'alertmanager@shopflow.epsi.fr'
  smtp_smarthost: 'smtp.epsi.fr:587'

route:
  group_by: ['alertname', 'severity']
  group_wait: 30s        # Attente avant premier envoi (regroupe alertes simultanées)
  group_interval: 5m     # Intervalle entre envois pour un même groupe
  repeat_interval: 4h    # Répétition si alerte toujours active
  receiver: 'team-backend'

  routes:
    - match:
        severity: critical
      receiver: 'team-backend-pager'
      repeat_interval: 30m

receivers:
  - name: 'team-backend'
    email_configs:
      - to: 'backend@shopflow.epsi.fr'

  - name: 'team-backend-pager'
    email_configs:
      - to: 'oncall@shopflow.epsi.fr'
```

---

## 7. Intégration Grafana

### Datasource Prometheus (auto-provisionné)

```yaml
# grafana/provisioning/datasources/prometheus.yml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus:9090
    isDefault: true
    jsonData:
      timeInterval: 15s          # Doit correspondre au scrape_interval
      queryTimeout: 60s
```

### Méthodes RED — panneau Grafana recommandé

La méthode RED (Rate, Errors, Duration) est la référence pour les services HTTP :

```promql
# RATE — Requêtes par seconde
sum(rate(http_requests_total{job="app-sample"}[5m]))

# ERRORS — Taux d'erreur en %
100 * sum(rate(http_requests_total{status=~"5.."}[5m]))
    / sum(rate(http_requests_total[5m]))

# DURATION — P95 latence
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
)
```

### Méthode USE — panneau ressources système

La méthode USE (Utilization, Saturation, Errors) pour les ressources :

```promql
# UTILIZATION (CPU)
1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))

# SATURATION (Load average vs CPUs)
node_load1 / count(node_cpu_seconds_total{mode="idle"})

# ERRORS (erreurs réseau)
rate(node_network_receive_errs_total[5m])
```

### Template de dashboard JSON — panneau ShopFlow

```json
{
  "title": "ShopFlow — Incident Dashboard",
  "panels": [
    {
      "title": "Taux de requêtes (req/s)",
      "type": "timeseries",
      "targets": [{
        "expr": "sum(rate(http_requests_total{job=\"app-sample\"}[5m]))",
        "legendFormat": "Total req/s"
      }]
    },
    {
      "title": "Taux d'erreur (%)",
      "type": "timeseries",
      "targets": [{
        "expr": "100 * sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m]))",
        "legendFormat": "Error rate %"
      }],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "steps": [
              {"color": "green", "value": 0},
              {"color": "yellow", "value": 1},
              {"color": "red", "value": 5}
            ]
          }
        }
      }
    },
    {
      "title": "Latence P50 / P95 / P99",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.5, rate(http_request_duration_seconds_bucket[5m]))",
          "legendFormat": "P50"
        },
        {
          "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))",
          "legendFormat": "P95"
        },
        {
          "expr": "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))",
          "legendFormat": "P99"
        }
      ]
    }
  ]
}
```

---

## 8. Métriques système — Node Exporter & cAdvisor

### Node Exporter — métriques machine hôte

```promql
# ── CPU ──────────────────────────────────────────────────────────

# Utilisation CPU globale
1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))

# Par mode (user, system, iowait...)
avg by (mode) (rate(node_cpu_seconds_total[5m]))

# ── MÉMOIRE ──────────────────────────────────────────────────────

# Mémoire disponible en octets
node_memory_MemAvailable_bytes

# Pourcentage utilisé
1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# Mémoire utilisée en Go
(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / 1024^3

# ── DISQUE ───────────────────────────────────────────────────────

# Espace utilisé par filesystem
1 - (node_filesystem_avail_bytes / node_filesystem_size_bytes)

# Débit lecture/écriture
rate(node_disk_read_bytes_total[5m])
rate(node_disk_written_bytes_total[5m])

# ── RÉSEAU ───────────────────────────────────────────────────────

# Bande passante reçue
rate(node_network_receive_bytes_total{device!="lo"}[5m])

# Bande passante émise
rate(node_network_transmit_bytes_total{device!="lo"}[5m])
```

### cAdvisor — métriques conteneurs Docker

```promql
# ── CPU conteneurs ───────────────────────────────────────────────

# CPU par conteneur (en %)
rate(container_cpu_usage_seconds_total{name!=""}[5m]) * 100

# Top 5 conteneurs CPU
topk(5, rate(container_cpu_usage_seconds_total{name!=""}[5m]))

# ── MÉMOIRE conteneurs ───────────────────────────────────────────

# Mémoire utilisée par conteneur
container_memory_usage_bytes{name!=""}

# Mémoire app-sample spécifiquement
container_memory_usage_bytes{name="bote848-app-sample-1"}

# ── RÉSEAU conteneurs ────────────────────────────────────────────

# Trafic réseau par conteneur
rate(container_network_receive_bytes_total{name!=""}[5m])
rate(container_network_transmit_bytes_total{name!=""}[5m])
```

---

## 9. Référence rapide

### Configuration Prometheus (prometheus.yml)

```yaml
global:
  scrape_interval: 15s      # Fréquence de scrape
  evaluation_interval: 15s  # Fréquence d'évaluation des règles
  scrape_timeout: 10s       # Timeout par scrape

rule_files:
  - "alert.rules.yml"       # Fichier de règles d'alertes

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'app-sample'
    static_configs:
      - targets: ['app-sample:8080']
    metrics_path: '/metrics'
    scrape_interval: 15s

  - job_name: 'node'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']
```

### Sélecteurs et filtres PromQL

```
{label="valeur"}     ← égalité exacte
{label!="valeur"}    ← différent
{label=~"regex"}     ← correspond regex
{label!~"regex"}     ← ne correspond pas regex
{l1="v1",l2="v2"}   ← ET (combinaison)
```

### Fonctions PromQL essentielles

```
rate(metric[5m])                              ← taux par seconde
increase(metric[1h])                          ← augmentation sur période
avg_over_time(metric[10m])                    ← moyenne temporelle
max_over_time(metric[1h])                     ← maximum sur période
histogram_quantile(0.95, rate(bucket[5m]))    ← percentile 95
```

### Agrégations PromQL

```
sum(...)                ← somme toutes séries
avg(...)                ← moyenne
max(...)                ← maximum
min(...)                ← minimum
count(...)              ← nombre de séries
sum by (label)(...)     ← somme groupée par label
topk(5, ...)            ← top 5 valeurs
```

### Ports par défaut

```
Prometheus UI    : 9090
AlertManager     : 9093
Node Exporter    : 9100
cAdvisor         : 8080
Grafana          : 3000
app-sample       : 8080  (/metrics)
```

### Endpoints Prometheus utiles

```bash
GET  http://localhost:9090/-/healthy          # Santé Prometheus
GET  http://localhost:9090/targets            # État de toutes les cibles
GET  http://localhost:9090/alerts             # Alertes actives
GET  http://localhost:9090/rules              # Règles d'alerte chargées
GET  http://localhost:9090/config             # Configuration actuelle
GET  "http://localhost:9090/api/v1/query?query=up"   # API query
```

### Recharger la configuration sans redémarrer

```bash
# Envoyer signal HUP à Prometheus
docker-compose exec prometheus kill -HUP 1

# Ou via l'API
curl -X POST http://localhost:9090/-/reload
```

### Vérifier les métriques exposées

```bash
# Voir toutes les métriques de app-sample
curl http://localhost:8080/metrics

# Filtrer une métrique spécifique
curl -s http://localhost:8080/metrics | grep http_requests_total

# Voir les métriques node-exporter
curl http://localhost:9100/metrics | grep node_memory
```

### Unités et conversions courantes

```promql
# Octets → Mo
metric / 1024 / 1024

# Octets → Go
metric / 1024 / 1024 / 1024

# Secondes → millisecondes
metric * 1000

# Ratio → pourcentage
metric * 100
```

---

*BOTE848 — EPSI Mastère SIN/EISI — 2025-2026*
