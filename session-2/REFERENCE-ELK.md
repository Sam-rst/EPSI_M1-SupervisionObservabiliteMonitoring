# Référence ELK — Elasticsearch, Kibana & alertes

**Module BOTE848 — Supervision, Observabilité et Monitoring Avancé DevOps**  
Exemples basés sur le scénario ShopFlow (incident paiement du 14/11/2024)

---

## Sommaire

1. [Architecture ELK](#1-architecture-elk)
2. [Concepts fondamentaux](#2-concepts-fondamentaux)
3. [Elasticsearch — API REST](#3-elasticsearch--api-rest)
4. [KQL — Kibana Query Language](#4-kql--kibana-query-language)
5. [Kibana UI — Discover, Lens, Dashboards](#5-kibana-ui--discover-lens-dashboards)
6. [Alertes Kibana](#6-alertes-kibana)
7. [Bonnes pratiques](#7-bonnes-pratiques)
8. [Référence rapide](#8-référence-rapide)

---

## 1. Architecture ELK

```
┌─────────────────────────────────────────────────────────┐
│                    STACK ELK                            │
│                                                         │
│  Applications        Collecte          Stockage / UI    │
│  ┌──────────┐       ┌──────────┐      ┌─────────────┐  │
│  │ service  │──────▶│ Filebeat │─────▶│Elasticsearch│  │
│  │   API    │  logs │ Logstash │ bulk │   (index)   │  │
│  │ payment  │       │ Fluentd  │      └──────┬──────┘  │
│  └──────────┘       └──────────┘             │         │
│                                              ▼         │
│                                       ┌─────────────┐  │
│                                       │   Kibana    │  │
│                                       │  (UI + API) │  │
│                                       └─────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Rôle de chaque composant

| Composant | Rôle | Port par défaut |
|---|---|---|
| **Elasticsearch** | Moteur de stockage et d'indexation full-text | 9200 (HTTP), 9300 (cluster) |
| **Logstash** | Pipeline : collecte, transformation, enrichissement | 5044 (Beats input) |
| **Kibana** | Interface de visualisation, exploration, alertes | 5601 |
| **Filebeat** | Agent léger de collecte sur les hôtes | — (push vers Logstash/ES) |

### Modèle de données

```
Elasticsearch
└── Index (ex: shopflow-logs)
    └── Document (une ligne de log)
        ├── _id        : identifiant unique
        ├── _index     : nom de l'index
        └── _source    : le document JSON original
            ├── timestamp   : "2024-11-14T08:34:06Z"
            ├── level       : "ERROR"
            ├── service     : "payment-service"
            ├── message     : "Timeout appel provider..."
            └── latency_ms  : 5001
```

### Cycle de vie d'un log dans ELK

```
1. Application émet un log (stdout / fichier)
2. Filebeat lit le fichier → envoie à Logstash ou directement à ES
3. Logstash parse, filtre, enrichit → envoie à Elasticsearch
4. Elasticsearch indexe le document dans l'index cible
5. Kibana interroge ES via l'API REST pour afficher / alerter
```

---

## 2. Concepts fondamentaux

### Index

Un **index** est l'équivalent d'une table de base de données.  
Contient des documents JSON. Chaque index a un **mapping** qui définit le type des champs.

```
shopflow-logs          ← index unique (notre TP)
shopflow-logs-2024.11  ← index avec rotation temporelle (production)
shopflow-logs-*        ← wildcard pour requêter plusieurs index
```

### Mapping

Le mapping définit comment Elasticsearch indexe chaque champ :

| Type ES | Utilisation | Exemple |
|---|---|---|
| `keyword` | Valeur exacte, non tokenisée (filtre, agrégation) | `level`, `service`, `error_code` |
| `text` | Full-text search, tokenisé | `message` |
| `date` | Timestamps ISO 8601 | `timestamp` |
| `integer` / `float` | Métriques numériques | `latency_ms`, `amount` |

> **Règle** : les champs sur lesquels vous filtrez ou agrégez doivent être `keyword`, pas `text`.

### Full-text search vs filtre exact

```
text (message)     → tokenisé → recherche par mot
keyword (service)  → valeur exacte → filtre strict

"payment-service" en keyword → filtre exact ✓
"payment-service" en text    → cherche "payment" ET "service" séparément ✗
```

### ILM — Index Lifecycle Management

En production, les index grossissent. ILM automatise leur rotation :

```
Hot   → index actif, ingestio rapide (SSD)
Warm  → index récent, lectures fréquentes (HDD)
Cold  → index archivé, lectures rares
Delete → suppression automatique (ex: après 30 jours)
```

---

## 3. Elasticsearch — API REST

Toutes les opérations Elasticsearch passent par une API REST sur le port **9200**.

### Vérification de santé

```bash
# Santé du cluster
curl -s http://localhost:9200/_cluster/health | python3 -m json.tool

# Exemple de réponse
{
  "cluster_name": "docker-cluster",
  "status": "yellow",     ← yellow = 1 nœud (normal en dev)
  "number_of_nodes": 1,
  "active_shards": 5
}
```

### Gestion des index

```bash
# Lister tous les index
curl -s http://localhost:9200/_cat/indices?v

# Détail d'un index (mapping + settings)
curl -s http://localhost:9200/shopflow-logs/_mapping | python3 -m json.tool

# Nombre de documents dans l'index
curl -s http://localhost:9200/shopflow-logs/_count

# Supprimer un index
curl -X DELETE http://localhost:9200/shopflow-logs
```

### Créer un index avec mapping explicite

```bash
curl -X PUT http://localhost:9200/shopflow-logs \
  -H "Content-Type: application/json" \
  -d '{
    "mappings": {
      "properties": {
        "timestamp":  { "type": "date" },
        "level":      { "type": "keyword" },
        "service":    { "type": "keyword" },
        "message":    { "type": "text" },
        "latency_ms": { "type": "integer" },
        "amount":     { "type": "float" },
        "error_code": { "type": "keyword" },
        "user_id":    { "type": "keyword" },
        "trace_id":   { "type": "keyword" }
      }
    }
  }'
```

### Injecter des documents

```bash
# Injecter un document unique
curl -X POST http://localhost:9200/shopflow-logs/_doc \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2024-11-14T08:34:06Z",
    "level": "ERROR",
    "service": "payment-service",
    "message": "Timeout appel provider de paiement",
    "error_code": "PAYMENT_TIMEOUT",
    "latency_ms": 5001,
    "user_id": "user_008",
    "order_id": "order_1008"
  }'

# Injecter en masse (bulk API) — format NDJSON
curl -X POST http://localhost:9200/_bulk \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @shopflow.ndjson
```

### Requêtes via l'API REST (Query DSL)

```bash
# Tous les documents
curl -s "http://localhost:9200/shopflow-logs/_search?pretty"

# Filtrer par niveau ERROR
curl -s -X POST http://localhost:9200/shopflow-logs/_search \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": { "level": "ERROR" }
    }
  }'

# Compter les erreurs PAYMENT_TIMEOUT — contexte ShopFlow
curl -s -X POST http://localhost:9200/shopflow-logs/_count \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": { "error_code": "PAYMENT_TIMEOUT" }
    }
  }'

# Montant total bloqué — agrégation sum
curl -s -X POST http://localhost:9200/shopflow-logs/_search \
  -H "Content-Type: application/json" \
  -d '{
    "size": 0,
    "query": { "term": { "error_code": "PAYMENT_TIMEOUT" } },
    "aggs": {
      "montant_total": { "sum": { "field": "amount" } }
    }
  }'

# Histogram : erreurs par heure
curl -s -X POST http://localhost:9200/shopflow-logs/_search \
  -H "Content-Type: application/json" \
  -d '{
    "size": 0,
    "aggs": {
      "par_heure": {
        "date_histogram": {
          "field": "timestamp",
          "calendar_interval": "1h"
        },
        "aggs": {
          "erreurs": {
            "filter": { "term": { "level": "ERROR" } }
          }
        }
      }
    }
  }'
```

---

## 4. KQL — Kibana Query Language

KQL est le langage de requête utilisé dans la barre de recherche de Kibana (Discover, Dashboards).  
Il s'exécute côté Kibana et se traduit en Query DSL Elasticsearch.

### Syntaxe de base

```
champ : valeur          → filtre exact sur un champ keyword
champ : "texte libre"   → recherche full-text sur un champ text
champ : *               → champ existe (non null)
NOT champ : valeur      → négation
A AND B                 → les deux conditions
A OR B                  → l'une ou l'autre
```

### Filtres exacts (champs keyword)

```kql
# Un seul service
service : "payment-service"

# Un niveau de log
level : "ERROR"

# Un code d'erreur spécifique — contexte ShopFlow
error_code : "PAYMENT_TIMEOUT"

# Un utilisateur précis
user_id : "user_008"

# Un ordre précis
order_id : "order_1008"
```

### Recherche full-text (champs text)

```kql
# Contient le mot "timeout" dans le message
message : "timeout"

# Contient "provider" ET "paiement"
message : "provider" AND message : "paiement"

# Contient la phrase exacte
message : "Timeout appel provider de paiement"
```

### Combinaisons logiques

```kql
# Erreurs du payment-service — incident ShopFlow
level : "ERROR" AND service : "payment-service"

# Tous les services sauf l'API gateway
NOT service : "api-gateway"

# Erreurs de payment OU d'auth
service : "payment-service" OR service : "auth-service"

# Timeouts ET latence élevée
error_code : "PAYMENT_TIMEOUT" AND latency_ms > 5000
```

### Filtres numériques et plages

```kql
# Latence supérieure à 5 secondes
latency_ms > 5000

# Montant entre 100 et 500€
amount >= 100 AND amount <= 500

# Codes HTTP d'erreur serveur
http_status >= 500

# Plage avec syntaxe bracket (inclusive)
latency_ms : [1000 TO 5000]

# Plage exclusive
latency_ms : {1000 TO 5000}
```

### Wildcards et expressions

```kql
# Tous les services contenant "service"
service : *-service

# Tous les user_id commençant par "user_01"
user_id : user_01*

# Tous les error_code commençant par "PAYMENT"
error_code : PAYMENT_*
```

### Requêtes ShopFlow — exemples complets

```kql
# Vue d'ensemble de l'incident : tous les événements payment
service : "payment-service"

# Uniquement les timeouts
error_code : "PAYMENT_TIMEOUT"

# Commandes bloquées avec montant élevé (> 200€)
error_code : "PAYMENT_TIMEOUT" AND amount > 200

# Erreurs vues par l'utilisateur final (502 gateway)
http_status : 502

# Période de rétablissement : après 08:43
service : "payment-service" AND message : "rétablie"

# Paiements réussis après rétablissement (pour valider)
service : "payment-service" AND message : "validé"

# Toutes les erreurs de l'incident (payment + gateway)
level : "ERROR" AND (service : "payment-service" OR service : "api-gateway")
```

---

## 5. Kibana UI — Discover, Lens, Dashboards

### 5.1 Discover — exploration des logs

**Accès** : menu latéral → icône boussole → **Discover**

| Élément UI | Description |
|---|---|
| Barre de recherche (haut) | Saisie KQL |
| Sélecteur de plage temporelle (haut droite) | Absolute / Relative / Quick |
| Panneau gauche | Liste des champs disponibles |
| Tableau central | Documents correspondants |
| Histogramme (haut centre) | Distribution temporelle des résultats |

**Ajouter des colonnes au tableau**

Par défaut, Kibana affiche `_source` brut. Cliquez sur un champ dans le panneau gauche → **"Add to table"** pour créer une colonne dédiée.

Colonnes utiles pour ShopFlow : `timestamp`, `level`, `service`, `message`, `error_code`, `latency_ms`

**Filtrer depuis le tableau**

Cliquez sur une valeur dans un document → icône **"+"** pour inclure / **"−"** pour exclure.  
Kibana ajoute automatiquement le filtre dans la barre KQL.

**Sauvegarder une recherche**

Bouton **"Save"** (haut droite) → nommer → disponible dans **Dashboards**.

### 5.2 Lens — visualisations

**Accès** : menu latéral → **Visualize Library** → **Create visualization** → **Lens**

Types de visualisation utiles pour les logs :

| Type | Cas d'usage |
|---|---|
| **Bar / Horizontal bar** | Erreurs par service, top utilisateurs impactés |
| **Line / Area** | Évolution temporelle du taux d'erreurs |
| **Metric** | Chiffre unique : montant total bloqué, nombre d'erreurs |
| **Pie** | Répartition des error_code |
| **Data table** | Liste des incidents avec champs détaillés |

**Créer un graphique : erreurs par service — ShopFlow**

1. Lens → type **Bar vertical**
2. Axe X : champ `service` → agrégation **Terms** (top 5)
3. Axe Y : agrégation **Count**
4. Filtre KQL en haut : `level : "ERROR"`
5. **Save and return** → disponible pour un Dashboard

**Créer une métrique : montant total bloqué**

1. Lens → type **Metric**
2. Valeur : champ `amount` → agrégation **Sum**
3. Filtre KQL : `error_code : "PAYMENT_TIMEOUT"`
4. Label : "Montant bloqué (€)"

### 5.3 Dashboards

**Accès** : menu latéral → **Dashboards** → **Create dashboard**

Un dashboard assemble plusieurs visualisations Lens + recherches Discover sur une même page.

**Workflow typique ShopFlow :**

```
1. Créer les visualisations dans Lens (séparément)
   ├── Graphique : erreurs dans le temps
   ├── Métrique : montant total bloqué
   ├── Bar chart : erreurs par service
   └── Table : détail des commandes échouées

2. Ouvrir un nouveau Dashboard
3. "Add panel" → choisir les visualisations sauvegardées
4. Ajuster la plage temporelle : 14/11/2024 08:00–09:00
5. Sauvegarder le dashboard "Incident ShopFlow 14/11"
```

**Filtres globaux de dashboard**

Un filtre ajouté en haut du dashboard s'applique à **tous les panels**.  
Utile pour restreindre à une plage d'incident ou un service.

---

## 6. Alertes Kibana

Les alertes Kibana surveillent des conditions sur les données Elasticsearch et déclenchent des notifications.

**Accès** : menu latéral → **Stack Management** → **Alerts and Insights** → **Rules**

### Types de règles utiles pour les logs

| Type | Cas d'usage |
|---|---|
| **Elasticsearch query** | Déclenche quand une requête ES retourne N résultats |
| **Log threshold** | Déclenche quand le volume de logs dépasse un seuil |
| **Index threshold** | Déclenche sur une agrégation numérique (somme, moyenne) |

### Créer une règle : alerte sur les erreurs de paiement — ShopFlow

**Menu** : Rules → **Create rule** → type **Elasticsearch query**

```yaml
Nom          : "ShopFlow — Erreurs paiement critiques"
Check every  : 1 minute
Notify       : On status changes

Query KQL    : error_code : "PAYMENT_TIMEOUT"
Time window  : Last 5 minutes
Threshold    : count > 3    ← plus de 3 timeouts en 5 min = incident

Action       : Email / Slack webhook
Message      : "⚠️ {{context.value}} timeouts paiement détectés"
```

### Créer une règle : latence élevée

```yaml
Nom          : "ShopFlow — Latence payment > 3s"
Type         : Index threshold
Index        : shopflow-logs
Field        : latency_ms
Aggregation  : Average
Filter KQL   : service : "payment-service"
Threshold    : average(latency_ms) > 3000
Window       : 5 minutes
```

### Connecteurs de notification

Avant de créer une règle, configurez un connecteur :

**Stack Management** → **Connectors** → **Create connector**

| Connecteur | Usage |
|---|---|
| **Email** | Notification par mail |
| **Slack** | Message dans un channel |
| **Webhook** | Appel HTTP vers n'importe quel système |
| **PagerDuty** | Astreinte on-call |

---

## 7. Bonnes pratiques

### Naming des index

```
# Pattern recommandé
{application}-{type}-{date}

shopflow-logs-2024.11.14    ← logs du jour
shopflow-logs-2024.11.*     ← logs du mois
shopflow-metrics-2024.11    ← métriques séparées
```

### Cardinalité et mapping

```
✅ Bon : champ avec peu de valeurs distinctes → keyword
   service : "api-gateway" | "payment-service" | "auth-service"

❌ Mauvais : champ à haute cardinalité → ne pas indexer en keyword
   trace_id : "trace_a1b2c3"   → des millions de valeurs uniques
              → utiliser keyword mais sans agrégation, ou désactiver l'index
```

### Performances

- Limitez `size` dans les requêtes API (défaut : 10, max recommandé : 10 000)
- Préférez `filter` à `must` quand le score de pertinence n'est pas nécessaire (plus rapide, mise en cache)
- Utilisez `_source_includes` pour ne récupérer que les champs nécessaires

```bash
# Optimisé : filtre + champs limités
curl -X POST http://localhost:9200/shopflow-logs/_search \
  -H "Content-Type: application/json" \
  -d '{
    "size": 100,
    "_source": ["timestamp", "level", "service", "error_code"],
    "query": {
      "bool": {
        "filter": [
          { "term": { "level": "ERROR" } },
          { "range": { "timestamp": { "gte": "2024-11-14T08:30:00Z" } } }
        ]
      }
    }
  }'
```

---

## 8. Référence rapide

### KQL — Aide-mémoire

```
OPÉRATEUR          SYNTAXE                        EXEMPLE
──────────────────────────────────────────────────────────
Égalité            champ : valeur                 level : "ERROR"
Négation           NOT champ : valeur             NOT service : "gateway"
ET                 A AND B                        level:"ERROR" AND service:"pay"
OU                 A OR B                         level:"ERROR" OR level:"WARN"
Supérieur          champ > N                      latency_ms > 5000
Inférieur          champ < N                      amount < 100
Plage inclusive    champ : [A TO B]               latency_ms : [1000 TO 5000]
Wildcards          champ : val*                   service : *-service
Existe             champ : *                      error_code : *
Full-text          champ : "texte"                message : "timeout"
```

### API Elasticsearch — Aide-mémoire

```bash
GET  /_cluster/health                    # Santé cluster
GET  /_cat/indices?v                     # Liste des index
GET  /{index}/_mapping                   # Mapping d'un index
GET  /{index}/_count                     # Nombre de documents
POST /{index}/_search                    # Recherche (body JSON)
POST /{index}/_doc                       # Indexer un document
POST /_bulk                              # Indexation en masse
DELETE /{index}                          # Supprimer un index
```

### Ports par défaut

```
Elasticsearch API HTTP  : 9200
Elasticsearch cluster   : 9300
Kibana UI               : 5601
Logstash Beats input    : 5044
Filebeat                : (agent, pas de port serveur)
```

---

*BOTE848 — EPSI Mastère SIN/EISI — 2025-2026*
