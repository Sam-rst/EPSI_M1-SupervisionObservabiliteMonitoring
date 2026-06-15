# Référence Loki — Architecture, LogQL & Grafana

**Module BOTE848 — Supervision, Observabilité et Monitoring Avancé DevOps**  
Exemples basés sur le scénario ShopFlow (incident paiement du 14/11/2024)

---

## Sommaire

1. [Architecture Loki](#1-architecture-loki)
2. [Concepts fondamentaux — Labels et streams](#2-concepts-fondamentaux--labels-et-streams)
3. [Promtail — Collecte et configuration](#3-promtail--collecte-et-configuration)
4. [LogQL — Requêtes sur les logs](#4-logql--requêtes-sur-les-logs)
5. [LogQL — Métriques](#5-logql--métriques)
6. [Grafana — Explorer et visualiser](#6-grafana--explorer-et-visualiser)
7. [Bonnes pratiques](#7-bonnes-pratiques)
8. [Référence rapide](#8-référence-rapide)

---

## 1. Architecture Loki

```
┌──────────────────────────────────────────────────────────────┐
│                      STACK LOKI                              │
│                                                              │
│  Applications          Collecte           Stockage / UI      │
│  ┌──────────┐         ┌──────────┐       ┌──────────────┐   │
│  │ service  │  stdout │          │ push  │ Distributor  │   │
│  │   API    │────────▶│ Promtail │──────▶│  (Loki)      │   │
│  │ payment  │  fichier│          │ HTTP  │  Ingester    │   │
│  └──────────┘         └──────────┘       │  Querier     │   │
│                                          │  Ruler       │   │
│                                          └──────┬───────┘   │
│                                                 │           │
│                                    ┌────────────▼─────────┐ │
│                                    │       Grafana        │ │
│                                    │  (Explore + panels)  │ │
│                                    └──────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Rôle de chaque composant

| Composant | Rôle | Port par défaut |
|---|---|---|
| **Distributor** | Reçoit les logs de Promtail, valide les labels, distribue aux ingesters | 3100 |
| **Ingester** | Stocke les logs en mémoire (chunks), flush sur disque/objet store | 3100 |
| **Querier** | Exécute les requêtes LogQL en récupérant les chunks | 3100 |
| **Ruler** | Évalue les règles d'alerte LogQL | 3100 |
| **Promtail** | Agent de collecte : lit les fichiers de logs, attache des labels, pousse vers Loki | 9080 |
| **Grafana** | Interface de visualisation et d'exploration | 3000 |

> En mode monolithique (notre TP), tous les composants Loki tournent dans un seul processus sur le port 3100.

### Différence fondamentale avec Elasticsearch

```
ELASTICSEARCH
└── Indexe TOUS les champs de chaque document
    → Recherche full-text très puissante
    → Coût : RAM et stockage élevés

LOKI
└── Indexe UNIQUEMENT les labels
    → Le contenu des logs est compressé, non indexé
    → Grep distribué sur les chunks au moment de la requête
    → Coût : stockage très faible, RAM réduite
```

---

## 2. Concepts fondamentaux — Labels et streams

### Stream

Un **stream** est l'unité de stockage de Loki.  
C'est un ensemble de logs partageant exactement la même combinaison de labels.

```
Stream 1 : {job="shopflow", service="payment-service", level="ERROR"}
Stream 2 : {job="shopflow", service="api-gateway",     level="INFO"}
Stream 3 : {job="shopflow", service="auth-service",    level="WARN"}
```

Chaque stream est stocké dans un **chunk** compressé séparé.  
Une requête LogQL sélectionne d'abord les streams concernés, puis filtre leur contenu.

### Labels

Les labels sont des paires `clé=valeur` attachées à chaque ligne de log au moment de l'ingestion.  
Ce sont les **seuls** critères indexés par Loki.

**Labels statiques** (définis dans la config Promtail) :

```yaml
labels:
  job: shopflow      ← toujours la même valeur
  env: prod
```

**Labels dynamiques** (extraits du contenu du log) :

```yaml
pipeline_stages:
  - json:
      expressions:
        level:   level       ← extrait du JSON
        service: service
  - labels:
      level:               ← promu en label indexé
      service:
```

### Cardinalité — règle critique

La **cardinalité** est le nombre de combinaisons de labels distinctes.  
Une cardinalité élevée = trop de streams = dégradation des performances.

```
✅ Bon label (cardinalité faible)
   service = "payment-service" | "api-gateway" | "auth-service"
   → 3 valeurs → 3 streams max par combinaison

❌ Mauvais label (cardinalité haute)
   user_id = "user_001" | "user_002" | ... | "user_100000"
   → 100 000 valeurs → explosion des streams
   → Solution : garder user_id dans le contenu du log, pas en label

❌ Très mauvais label
   trace_id = "trace_a1b2c3..." (unique par requête)
   → autant de streams que de requêtes → OOM garanti
```

**Règle pratique** : moins de 10 labels distincts, moins de 1 000 valeurs uniques par label.

### Labels ShopFlow utilisés dans ce TP

```
job      = "shopflow"          ← identifie la source
env      = "prod"              ← environnement
service  = "payment-service"   ← service applicatif (extrait du JSON)
          | "api-gateway"
          | "auth-service"
level    = "INFO" | "WARN" | "ERROR"   (extrait du JSON)
instance = "pay-1" | "gw-1" | "auth-1" (extrait du JSON)
error_code = "PAYMENT_TIMEOUT" | ...   (extrait du JSON, présent si erreur)
```

---

## 3. Promtail — Collecte et configuration

Promtail est l'agent de collecte officiel pour Loki. Il lit des fichiers de logs, attache des labels, et pousse les logs vers Loki.

### Structure de la configuration

```yaml
# promtail-config.yml

server:
  http_listen_port: 9080   ← UI Promtail (status, targets)

positions:
  filename: /tmp/positions.yaml   ← mémorise où Promtail en est dans la lecture

clients:
  - url: http://loki:3100/loki/api/v1/push   ← endpoint Loki

scrape_configs:
  - job_name: shopflow            ← nom du job
    static_configs:
      - targets: [localhost]
        labels:
          job: shopflow           ← label statique
          env: prod
          __path__: /logs/shopflow.log   ← fichier à lire

    pipeline_stages:              ← traitement ligne par ligne
      - json:
          expressions:
            level:      level
            service:    service
            error_code: error_code
      - labels:
          level:
          service:
          error_code:
```

### Pipeline stages — les plus utiles

```yaml
# Parser JSON et extraire des champs
- json:
    expressions:
      level:      level
      service:    service
      message:    message
      latency_ms: latency_ms

# Promouvoir un champ extrait en label
- labels:
    level:
    service:

# Ajouter un label statique
- static_labels:
    datacenter: eu-west-1

# Filtrer les lignes (ne garder que les ERRORs)
- match:
    selector: '{job="shopflow"}'
    stages:
      - drop:
          expression: '.*"level":"INFO".*'

# Remplacer le timestamp du log par celui du champ JSON
- timestamp:
    source: timestamp
    format: RFC3339

# Transformer un champ en métrique (ex: histogramme de latence)
- metrics:
    http_latency_seconds:
      type: Histogram
      source: latency_ms
      config:
        buckets: [100, 500, 1000, 5000]
```

### Vérifier le statut de Promtail

```bash
# Logs du conteneur
docker logs shopflow-promtail 2>&1 | tail -30

# UI Promtail (si port exposé)
curl http://localhost:9080/targets

# Vérifier la position de lecture (offset dans le fichier)
cat /tmp/positions.yaml
```

---

## 4. LogQL — Requêtes sur les logs

LogQL est le langage de requête de Loki. Sa syntaxe s'inspire de PromQL (Prometheus).

### Structure générale

```
{sélecteur_de_labels} | filtre_de_pipeline | ...

└── obligatoire ───┘   └── optionnel ──────────┘
```

### 4.1 Sélecteurs de labels

Le sélecteur est toujours entre `{}`. Il est **obligatoire**.

```logql
# Un seul label
{job="shopflow"}

# Combinaison de labels (ET implicite)
{job="shopflow", level="ERROR"}

# Opérateurs disponibles
{service="payment-service"}    ← égalité exacte
{service!="api-gateway"}       ← différent
{service=~"payment|auth"}      ← regex : payment-service OU auth-service
{service!~".*gateway.*"}       ← regex négative : tout sauf gateway
```

### 4.2 Filtres de contenu

S'appliquent après le sélecteur, sur le texte brut de chaque ligne.

```logql
# Contient la chaîne
{job="shopflow"} |= "timeout"

# Ne contient pas
{job="shopflow"} != "INFO"

# Correspond à une regex
{job="shopflow"} |~ "ERROR|WARN"

# Ne correspond pas à une regex
{job="shopflow"} !~ ".*INFO.*"
```

### 4.3 Parser JSON — accéder aux champs non indexés

`| json` demande à Loki de parser chaque ligne comme JSON au moment de la requête.  
Cela donne accès à tous les champs, même non promus en labels.

```logql
# Parser et filtrer sur latency_ms (champ non indexé)
{job="shopflow", service="payment-service"}
  | json
  | latency_ms > 5000

# Parser et filtrer sur montant
{job="shopflow"}
  | json
  | error_code = "PAYMENT_TIMEOUT"
  | amount > 200

# Parser un sous-champ JSON imbriqué
{job="shopflow"}
  | json
  | line_format "{{.context.order_id}}"
```

> **Note** : `| json` a un coût CPU car Loki parse chaque ligne à la volée.  
> Pour les champs filtrés fréquemment, préférez les promouvoir en labels via Promtail.

### 4.4 Reformater la sortie

```logql
# Afficher seulement certains champs
{job="shopflow", level="ERROR"}
  | json
  | line_format "{{.timestamp}} | {{.service}} | {{.message}}"

# Ajouter un label calculé
{job="shopflow"}
  | json
  | label_format service_env="{{.service}}-{{.env}}"
```

### 4.5 Requêtes ShopFlow — exemples complets

```logql
# Tous les logs du job
{job="shopflow"}

# Logs d'erreur uniquement (par label)
{job="shopflow", level="ERROR"}

# Erreurs du payment-service
{job="shopflow", level="ERROR", service="payment-service"}

# Timeouts par label directement
{job="shopflow", error_code="PAYMENT_TIMEOUT"}

# Chercher "rétablie" dans le contenu (grep)
{job="shopflow"} |= "rétablie"

# Timeouts avec montant élevé (parsing JSON nécessaire)
{job="shopflow", error_code="PAYMENT_TIMEOUT"}
  | json
  | amount > 200

# Toutes les requêtes lentes (> 3s) sur le payment-service
{job="shopflow", service="payment-service"}
  | json
  | latency_ms > 3000

# Erreurs multi-services : payment OU gateway
{job="shopflow", level="ERROR", service=~"payment-service|api-gateway"}

# Trace complète d'un incident (par trace_id)
{job="shopflow"}
  | json
  | trace_id = "trace_f4g5h6"
```

---

## 5. LogQL — Métriques

LogQL permet aussi de calculer des métriques à partir des logs.  
Ces requêtes retournent des séries temporelles, pas des lignes de logs.

> Dans Grafana, basculez en mode **"Metrics"** pour ce type de requête.

### 5.1 count_over_time — compter des événements

```logql
# Nombre de logs d'erreur par fenêtre de 5 minutes
count_over_time({job="shopflow", level="ERROR"} [5m])

# Nombre de timeouts paiement par fenêtre de 1 minute
count_over_time({job="shopflow", error_code="PAYMENT_TIMEOUT"} [1m])

# Nombre de logs par service (agrégé)
sum by (service) (
  count_over_time({job="shopflow"} [5m])
)
```

### 5.2 rate — taux par seconde

```logql
# Taux d'erreurs par seconde (sur 5 min)
rate({job="shopflow", level="ERROR"} [5m])

# Taux d'erreurs paiement par seconde
rate({job="shopflow", error_code="PAYMENT_TIMEOUT"} [1m])

# Taux par service (pour comparer)
sum by (service) (
  rate({job="shopflow", level="ERROR"} [5m])
)
```

### 5.3 bytes_over_time et bytes_rate — volume de logs

```logql
# Volume de logs ingérés (en octets) par fenêtre de 5 min
bytes_over_time({job="shopflow"} [5m])

# Débit d'ingestion par seconde
bytes_rate({job="shopflow"} [5m])
```

### 5.4 Métriques sur champs parsés (unwrap)

`unwrap` extrait la valeur numérique d'un champ JSON pour faire des agrégations.

```logql
# Latence moyenne du payment-service sur 5 minutes
avg_over_time(
  {job="shopflow", service="payment-service"}
    | json
    | unwrap latency_ms [5m]
)

# Latence max sur la fenêtre
max_over_time(
  {job="shopflow", service="payment-service"}
    | json
    | unwrap latency_ms [5m]
)

# P95 de la latence
quantile_over_time(0.95,
  {job="shopflow", service="payment-service"}
    | json
    | unwrap latency_ms [5m]
)

# Montant total bloqué (pendant l'incident)
sum_over_time(
  {job="shopflow", error_code="PAYMENT_TIMEOUT"}
    | json
    | unwrap amount [1h]
)
```

### 5.5 Ratio d'erreurs

```logql
# Taux d'erreurs relatif (erreurs / total) sur 5 min
sum(rate({job="shopflow", level="ERROR"} [5m]))
/
sum(rate({job="shopflow"} [5m]))

# En pourcentage
(
  sum(rate({job="shopflow", level="ERROR"} [5m]))
  /
  sum(rate({job="shopflow"} [5m]))
) * 100
```

---

## 6. Grafana — Explorer et visualiser

### 6.1 Explore — requêtes ad hoc

**Accès** : menu latéral → icône boussole → **Explore**

| Élément UI | Description |
|---|---|
| Sélecteur de datasource (haut gauche) | Choisir **Loki** |
| Mode **Logs** | Requêtes qui retournent des lignes de logs |
| Mode **Metrics** | Requêtes qui retournent des séries temporelles |
| Query builder | Constructeur visuel (cliquer "switch to builder") |
| Code editor | Saisie LogQL directe (cliquer "switch to code") |
| Sélecteur de plage | Haut droite — "Last 5 years" pour ShopFlow |

**Astuce** : en mode Logs, cliquez sur une ligne pour l'expandre et voir les labels extraits.

### 6.2 Créer un panel dans un Dashboard

**Accès** : **Dashboards** → **New** → **New dashboard** → **Add visualization**

**Sélectionner la datasource** : Loki

**Configurer la requête** :

```
Mode Code : saisir la requête LogQL directement
Mode Builder : sélectionner les labels via des menus déroulants
```

**Types de visualisation pour les logs Loki :**

| Type Grafana | Requête LogQL | Cas d'usage ShopFlow |
|---|---|---|
| **Logs** | `{job="shopflow", level="ERROR"}` | Timeline des erreurs |
| **Time series** | `rate({...}[5m])` | Évolution du taux d'erreurs |
| **Stat** | `sum(count_over_time({error_code="PAYMENT_TIMEOUT"}[1h]))` | Total timeouts |
| **Bar gauge** | `sum by(service)(count_over_time(...[1h]))` | Erreurs par service |
| **Table** | `{...} \| json \| line_format "..."` | Détail des incidents |

### 6.3 Dashboard ShopFlow — construction pas à pas

**Panel 1 : Timeline des erreurs**

```
Type       : Logs
Requête    : {job="shopflow", level="ERROR"}
Options    : Deduplicate = Signature, Order = Newest first
Titre      : "Logs d'erreur — Incident ShopFlow"
```

**Panel 2 : Taux d'erreurs paiement dans le temps**

```
Type       : Time series
Requête    : rate({job="shopflow", error_code="PAYMENT_TIMEOUT"}[1m])
Legend     : "Timeouts/s"
Thresholds : vert < 0.01 | orange < 0.1 | rouge ≥ 0.1
Titre      : "Taux de timeouts paiement"
```

**Panel 3 : Total commandes bloquées**

```
Type       : Stat
Requête    : sum(count_over_time({job="shopflow", error_code="PAYMENT_TIMEOUT"}[12h]))
Unit       : none (commandes)
Titre      : "Commandes bloquées"
```

**Panel 4 : Montant total bloqué**

```
Type       : Stat
Requête    : sum_over_time({job="shopflow", error_code="PAYMENT_TIMEOUT"} | json | unwrap amount [12h])
Unit       : Currency EUR
Titre      : "Montant bloqué (€)"
```

**Panel 5 : Erreurs par service**

```
Type       : Bar chart
Requête    : sum by (service) (count_over_time({job="shopflow", level="ERROR"}[12h]))
Legend     : {{service}}
Titre      : "Erreurs par service"
```

### 6.4 Alertes Grafana + Loki

**Accès** : dans un panel → **Alert** tab → **New alert rule**

```yaml
Nom      : "ShopFlow — Taux d'erreurs paiement critique"
Requête  : sum(rate({job="shopflow", error_code="PAYMENT_TIMEOUT"}[5m]))

Condition: WHEN last() OF A IS ABOVE 0.05
           ← plus de 0.05 timeout/seconde = ~3 timeouts/min

For      : 1m    ← attendre 1 min avant de déclencher

Labels   : severity=critical, team=sre
Annotations:
  summary     : "Timeouts paiement StripeAPI détectés"
  description : "{{ $values.A }} timeouts/s sur payment-service"
```

**Contact points** (notification) :

**Alerting** → **Contact points** → **Add contact point**

| Type | Configuration |
|---|---|
| **Email** | Adresse(s) destinataire(s) |
| **Slack** | Webhook URL du channel |
| **Webhook** | URL HTTP (PagerDuty, OpsGenie, Teams...) |

---

## 7. Bonnes pratiques

### Labels — ce qu'il faut indexer

```
✅ À promouvoir en labels (cardinalité faible, filtrés souvent)
   job, env, service, level, instance, region

✅ À garder dans le contenu (cardinalité élevée)
   user_id, order_id, trace_id, message, amount

❌ Ne jamais mettre en label
   timestamp (déjà géré par Loki)
   UUID, hash, valeurs numériques continues
```

### Optimiser les requêtes

```logql
-- ✅ Filtrer par labels d'abord (indexés, rapide)
{job="shopflow", level="ERROR", service="payment-service"}
  | json
  | amount > 100

-- ❌ Éviter : parse JSON en premier sans filtre label
{job="shopflow"}
  | json
  | level = "ERROR"   ← parse TOUS les logs avant de filtrer
```

### Fenêtres de temps (range vector)

```logql
[1m]   ← granularité fine, bruit possible
[5m]   ← bon équilibre pour alertes
[15m]  ← lissage, bonne visibilité sur les tendances
[1h]   ← résumés, rapports
[24h]  ← bilans journaliers
```

### Rétention et stockage

- Loki stocke par défaut les logs **28 jours** (configurable via `limits_config.retention_period`)
- Le stockage est compressé (~80% de réduction par rapport aux logs bruts)
- Pour de la rétention longue durée, configurer un **object store** (S3, GCS, MinIO)

---

## 8. Référence rapide

### Sélecteurs de labels

```
{label="valeur"}      ← égalité exacte
{label!="valeur"}     ← différent
{label=~"regex"}      ← correspond à la regex
{label!~"regex"}      ← ne correspond pas
{l1="v1", l2="v2"}   ← ET (combinaison)
```

### Filtres de pipeline

```
|= "texte"       ← contient
!= "texte"       ← ne contient pas
|~ "regex"       ← correspond regex
!~ "regex"       ← ne correspond pas regex
| json           ← parser JSON
| label_format   ← reformater les labels
| line_format    ← reformater la ligne
| unwrap champ   ← extraire valeur numérique
```

### Fonctions métriques

```
count_over_time({...}[5m])          ← nombre de lignes
rate({...}[5m])                     ← lignes/seconde
bytes_over_time({...}[5m])          ← octets
bytes_rate({...}[5m])               ← octets/seconde

avg_over_time(...| unwrap X [5m])   ← moyenne de X
max_over_time(...| unwrap X [5m])   ← maximum de X
min_over_time(...| unwrap X [5m])   ← minimum de X
sum_over_time(...| unwrap X [5m])   ← somme de X
quantile_over_time(0.95, ... [5m])  ← percentile 95
```

### Agrégations

```
sum(...)             ← somme
avg(...)             ← moyenne
max(...)             ← maximum
min(...)             ← minimum
sum by (label)(...)  ← somme groupée par label
```

### Ports par défaut

```
Loki API         : 3100
Promtail UI      : 9080
Grafana UI       : 3000
```

### Endpoints Loki utiles

```bash
GET  http://localhost:3100/ready          # Santé Loki
GET  http://localhost:3100/loki/api/v1/labels         # Labels disponibles
GET  http://localhost:3100/loki/api/v1/label/service/values  # Valeurs d'un label
GET  "http://localhost:3100/loki/api/v1/query_range?query={job='shopflow'}&start=...&end=..."
```

---

*BOTE848 — EPSI Mastère SIN/EISI — 2025-2026*
