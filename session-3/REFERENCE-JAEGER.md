# 📖 RÉFÉRENCE — Jaeger & Tracing Distribué

**Document de référence formateur/participant — Séance 3, BOTE848**

---

## Sommaire

1. [Introduction & contexte](#1-introduction--contexte)
2. [Concepts fondamentaux du tracing distribué](#2-concepts-fondamentaux-du-tracing-distribué)
3. [Sampling : stratégies d'échantillonnage](#3-sampling--stratégies-déchantillonnage)
4. [OpenTelemetry : le standard d'instrumentation](#4-opentelemetry--le-standard-dinstrumentation)
5. [Architecture Jaeger](#5-architecture-jaeger)
6. [Déploiement Jaeger](#6-déploiement-jaeger)
7. [Jaeger UI : guide d'utilisation](#7-jaeger-ui--guide-dutilisation)
8. [Corrélation logs / métriques / traces](#8-corrélation-logs--métriques--traces)
9. [Bonnes pratiques & pièges courants](#9-bonnes-pratiques--pièges-courants)
10. [Jaeger vs alternatives (Zipkin, Tempo, X-Ray)](#10-jaeger-vs-alternatives-zipkin-tempo-x-ray)
11. [Glossaire](#11-glossaire)
12. [FAQ](#12-faq)

---

## 1. Introduction & contexte

### 1.1 Pourquoi le tracing, après les logs et les métriques ?

Dans la progression des 3 piliers de l'observabilité (vue en séance 1), le tracing est volontairement abordé en dernier car il répond à une question que ni les logs ni les métriques ne peuvent résoudre seuls :

```
LOGS       → "QUOI s'est-il passé ?"        (message d'erreur précis)
MÉTRIQUES  → "QUAND / COMBIEN ?"            (tendance, volume, seuil dépassé)
TRACES     → "OÙ exactement, dans la chaîne d'appels ?"  (localisation causale)
```

Sur une architecture monolithique, la question "où" se pose peu — il n'y a qu'un seul endroit où chercher. Sur une architecture distribuée (microservices), une seule requête utilisateur peut traverser 5, 10, 50 services. Sans tracing, retrouver le service responsable d'une lenteur revient à chercher une aiguille dans une meule de foin de logs non corrélés.

### 1.2 Origine : Dapper, Zipkin, Jaeger

```
2010 : Google publie le papier "Dapper" — système de tracing interne
       à Google, à l'origine de tous les traceurs modernes
2012 : Twitter open-source Zipkin, inspiré de Dapper
2017 : Uber open-source Jaeger, donné à la CNCF
2019 : Jaeger devient projet "graduated" de la CNCF
2021+ : OpenTelemetry unifie l'instrumentation (voir section 4) —
        Jaeger devient un des backends possibles, plus un standard fermé
```

Jaeger reste aujourd'hui l'un des backends de traces les plus utilisés, en particulier dans l'écosystème Kubernetes/Cloud Native, aux côtés de Grafana Tempo.

### 1.3 Cas d'usage typiques

- Diagnostiquer une latence anormale sur un parcours utilisateur (ex : checkout ShopFlow)
- Identifier le service responsable d'une erreur en cascade
- Visualiser les dépendances réelles entre microservices (dependency graph)
- Détecter des appels redondants ou en série qui pourraient être parallélisés
- Analyser l'impact d'un déploiement sur la latence bout-en-bout

---

## 2. Concepts fondamentaux du tracing distribué

### 2.1 Trace

Une **trace** représente le parcours complet d'une requête à travers tous les services qu'elle traverse. Elle est identifiée par un `trace_id` unique, généré au tout début de la requête (généralement au niveau du premier point d'entrée, ex : l'API Gateway).

### 2.2 Span

Un **span** représente une unité de travail au sein d'une trace : un appel HTTP, une requête base de données, un traitement métier, etc.

```
Structure d'un span :
├─ trace_id          : identifiant de la trace parente
├─ span_id           : identifiant unique de ce span
├─ parent_span_id    : span_id du span parent (null si span racine)
├─ operation_name    : nom de l'opération (ex: "GET /api/checkout")
├─ start_time / duration
├─ tags/attributes   : métadonnées clé-valeur (http.status_code, db.statement...)
├─ logs/events       : événements ponctuels attachés au span (ex: exception)
└─ status            : OK / ERROR
```

Un ensemble de spans reliés entre eux par leurs `parent_span_id` forme un arbre : la trace.

### 2.3 Context propagation

Pour que deux services différents sachent qu'ils participent à la **même** trace, l'identifiant de trace (et le span parent courant) doit voyager avec la requête — typiquement dans les en-têtes HTTP.

```
Standard W3C Trace Context (recommandé, utilisé par OpenTelemetry) :

traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  └── trace_id (32 hex) ─┘ └ parent span_id (16 hex)┘ │
           version                                            flags (sampled?)

Ancien standard B3 (Zipkin) — encore rencontré :
X-B3-TraceId, X-B3-SpanId, X-B3-ParentSpanId, X-B3-Sampled
```

**Ce qu'il faut retenir** : chaque service qui reçoit une requête avec un `traceparent` crée un span enfant portant le même `trace_id`, et propage à son tour ce contexte (mis à jour) vers les services qu'il appelle. C'est ce mécanisme, entièrement automatisé par les SDK modernes, qui permet de reconstruire l'arbre complet a posteriori.

### 2.4 Anatomie visuelle : le waterfall

Exemple réel sur le stack ShopFlow (un seul service `api-gateway`, 4 spans internes) :

```
Trace ID: 74acfed8735c8a41a01a1b4fa5ff1ced       Durée totale : ~230ms
service: api-gateway (un seul service pour toute la trace)

POST /api/checkout                        [0    ─────────────────── 230ms]  (span auto, HTTP)
├─ checkout.validate_cart                 [2    ▎ 18ms]
├─ checkout.check_inventory                [21   ▎ 27ms]
└─ checkout.process_payment                [49   ──────────────── 228ms]
   └─ payment.stripe_api_call              [50   ──────────────── 227ms]  ⚠️ ERROR (status)
```

Lecture d'un waterfall :
- La **largeur** d'une barre = la durée du span
- L'**indentation** = la relation parent/enfant (profondeur d'appel)
- Sur une architecture multi-services, un span très large par rapport à ses frères est souvent un bon candidat au diagnostic de bottleneck — **mais ce n'est pas systématique** (voir l'exemple ci-dessus : le span en erreur n'est pas plus long que les autres)
- Un span rouge/marqué erreur = point de défaillance à examiner en priorité, **indépendamment de sa durée**

⚠️ **Piège pédagogique volontaire dans le TP** : sur ShopFlow, l'incident payment ne se traduit pas par une durée anormale — `payment.stripe_api_call` dure le même ordre de grandeur (100-300ms) qu'il réussisse ou échoue. C'est le **statut** du span (`ERROR`) et son **attribut** (`error_code`) qui localisent le problème, pas sa largeur dans le waterfall. Un vrai timeout réseau produirait, lui, un span anormalement long — les deux cas existent en production, et Jaeger sert aux deux.

---

## 3. Sampling : stratégies d'échantillonnage

### 3.1 Pourquoi échantillonner ?

Contrairement aux métriques (agrégées, volume faible), une trace complète peut représenter plusieurs kilo-octets de données par requête. Sur un système à fort trafic (des milliers de requêtes/seconde), tracer 100% du trafic devient rapidement coûteux en stockage et en bande passante.

### 3.2 Stratégies principales

```
HEAD-BASED SAMPLING
├─ Décision prise AU DÉBUT de la trace (avant de savoir comment elle se termine)
├─ Ex : "1 requête sur 100" (taux fixe), ou probabiliste
├─ Avantage : simple, peu coûteux (décision locale, immédiate)
└─ Inconvénient : peut manquer les traces en erreur si le taux est bas

TAIL-BASED SAMPLING
├─ Décision prise APRÈS la fin complète de la trace
├─ Permet des règles comme : "garder 100% des traces en erreur,
│  1% des traces normales, 100% des traces > 2s"
├─ Avantage : ne rate jamais les cas intéressants
└─ Inconvénient : plus complexe (nécessite un buffer/collector spécialisé
   type OpenTelemetry Collector avec processeur tail_sampling)

ADAPTIVE SAMPLING (Jaeger)
├─ Jaeger peut ajuster dynamiquement le taux par service/opération
│  pour garantir un volume cible de traces/seconde
└─ Évite de noyer le stockage sur les services à fort trafic tout en
   gardant une couverture correcte sur les services peu sollicités
```

### 3.3 Recommandation pédagogique

Pour le TP (environnement de démo, faible volume), le sampling est configuré à **100%** (`AlwaysOn`) afin de garantir que la trace de l'incident soit toujours visible. En production, ce n'est jamais le cas — c'est un point à mentionner explicitement pour ne pas laisser croire aux participants que 100% est la norme.

```javascript
// Exemple : configuration du sampler côté SDK (à titre indicatif)
const { TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');

const sdk = new NodeSDK({
  sampler: new TraceIdRatioBasedSampler(0.1), // 10% des traces
  // ...
});
```

---

## 4. OpenTelemetry : le standard d'instrumentation

### 4.1 Pourquoi OpenTelemetry ?

Avant 2019, chaque backend de tracing (Jaeger, Zipkin, Datadog...) avait son propre SDK d'instrumentation, ce qui forçait à recoder l'instrumentation si on changeait de backend. **OpenTelemetry** (fusion des projets OpenTracing et OpenCensus) fournit :

- Un SDK unique, multi-langages (Node.js, Python, Java, Go, .NET...)
- Un format d'export standard (OTLP — OpenTelemetry Protocol)
- Une auto-instrumentation pour les librairies courantes (frameworks HTTP, clients DB, etc.)
- La possibilité de changer de backend (Jaeger → Tempo → Datadog...) sans changer le code d'instrumentation, seulement la configuration de l'exporter

```
Application ── OpenTelemetry SDK ── OTLP ──▶ N'IMPORTE QUEL backend compatible
                                              (Jaeger, Tempo, Zipkin, SaaS...)
```

### 4.2 Auto-instrumentation vs instrumentation manuelle

```
AUTO-INSTRUMENTATION
├─ Fournie par des packages officiels (ex: @opentelemetry/auto-instrumentations-node)
├─ Instrumente automatiquement : HTTP entrant/sortant, Express, clients DB
│  (PostgreSQL, MongoDB, Redis...), gRPC, etc.
├─ Zéro modification du code métier nécessaire
└─ Couvre 80% des besoins de visibilité de base

INSTRUMENTATION MANUELLE
├─ Nécessaire pour capturer une logique MÉTIER spécifique
│  (ex : "le calcul de remise a pris X ms", pas juste "l'appel HTTP")
├─ Se fait via l'API Tracer : tracer.startActiveSpan(...)
└─ Permet d'ajouter des attributs métier (order.id, user.tier, etc.)
   qui n'existeraient pas dans un span HTTP générique
```

### 4.3 Exemple réel (le code déployé dans `app-sample`)

```javascript
// tracing.js — initialisation (chargée AVANT tout le reste, cf. server.js)
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'api-gateway',
  traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
  instrumentations: [getNodeAutoInstrumentations()]
});
sdk.start();
```

```javascript
// Extrait de server.js — instrumentation manuelle de /api/checkout
const tracer = opentelemetry.trace.getTracer('api-gateway');

await tracer.startActiveSpan('checkout.process_payment', async (paymentSpan) => {
  paymentSpan.setAttribute('order.id', orderId);
  paymentSpan.setAttribute('payment.provider', 'stripe');

  await tracer.startActiveSpan('payment.stripe_api_call', async (stripeSpan) => {
    stripeSpan.setAttribute('payment.provider', 'stripe');
    await new Promise((r) => setTimeout(r, latencyMs));

    if (Math.random() < failureRate) {
      const err = new Error(errorCode); // PAYMENT_TIMEOUT | PAYMENT_INVALID_CARD | PAYMENT_RATE_LIMIT
      stripeSpan.recordException(err);
      stripeSpan.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: errorCode });
      paymentSpan.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: errorCode });
      stripeSpan.end();
      paymentSpan.end();
      return; // la réponse HTTP 500 est envoyée juste après
    }

    stripeSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
    stripeSpan.end();
    paymentSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
    paymentSpan.end();
  });
});
```

Notez qu'ici un seul `service.name` (`api-gateway`) porte tous les spans — `checkout.process_payment` et `payment.stripe_api_call` sont des opérations **internes** au même processus, pas des appels réseau vers d'autres conteneurs. C'est un choix d'architecture (monolithe simple pour la formation) : le principe de la trace et du waterfall reste identique à un système réellement distribué.

⚠️ **Piège fréquent** : oublier `span.end()` dans un chemin d'erreur non prévu. Un span jamais fermé n'apparaîtra jamais dans Jaeger (ou apparaîtra comme "en cours" indéfiniment). Dans le code ci-dessus, `.end()` est appelé explicitement dans les deux branches (erreur et succès) plutôt que dans un bloc `finally`, pour rester lisible avec `startActiveSpan` — les deux approches sont valides du moment qu'aucun chemin ne saute l'appel à `.end()`.

### 4.4 Équivalent Python (illustratif — le stack ShopFlow est en Node.js)

Cet exemple montre à quoi ressemblerait la même logique dans un service Python. Il ne fait pas partie du stack déployé.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
processor = BatchSpanProcessor(OTLPSpanExporter(endpoint="jaeger:4317", insecure=True))
provider.add_span_processor(processor)
trace.set_tracer_provider(provider)

tracer = trace.get_tracer(__name__)

def process_payment(order):
    with tracer.start_as_current_span("payment.stripe_api_call") as span:
        span.set_attribute("order.id", order["id"])
        span.set_attribute("payment.provider", "stripe")
        try:
            result = stripe_api_call(order)
            span.set_status(trace.Status(trace.StatusCode.OK))
            return result
        except Exception as err:
            span.record_exception(err)
            span.set_status(trace.Status(trace.StatusCode.ERROR, str(err)))
            raise
```

---

## 5. Architecture Jaeger

### 5.1 Composants

```
Application instrumentée (OpenTelemetry SDK)
    │  export OTLP (gRPC :4317 ou HTTP :4318)
    ▼
Jaeger Collector
    │  validation, enrichissement, indexation
    ▼
Storage backend
    │  (Elasticsearch, Cassandra, Kafka en tampon, ou mémoire pour démo)
    ▼
Jaeger Query (API de lecture)
    ▼
Jaeger UI
```

Historiquement, un **Jaeger Agent** (sidecar recevant les spans en UDP local) faisait tampon entre l'application et le Collector. Depuis la généralisation d'OpenTelemetry (export direct en OTLP vers le Collector), l'Agent est de moins en moins utilisé dans les nouveaux déploiements.

### 5.2 Backends de stockage

| Backend | Cas d'usage | Remarque |
|---------|-------------|----------|
| **Mémoire (in-memory)** | Démo, TP, dev local | Perdu au redémarrage, volume limité — c'est celui utilisé dans ce module |
| **Elasticsearch** | Production, volumétrie moyenne à forte | Réutilise une stack déjà connue (cf. séance 2 ELK) |
| **Cassandra** | Production, très forte volumétrie | Scalabilité horizontale, plus complexe à opérer |
| **Kafka (en amont)** | Tampon de résilience avant indexation | Découple ingestion et indexation en cas de pic |

### 5.3 Image "all-in-one" (utilisée en TP)

Pour simplifier le déploiement en environnement de formation, Jaeger fournit une image Docker unique regroupant Agent + Collector + Query + UI + stockage mémoire :

```yaml
# Extrait docker-compose.yml — tel que déployé sur ShopFlow (pas de profils :
# tous les services démarrent avec un simple `docker compose up -d`)
services:
  jaeger:
    image: jaegertracing/all-in-one:1.55
    container_name: jaeger
    ports:
      - "16686:16686"   # Jaeger UI
      - "4317:4317"     # OTLP gRPC receiver
      - "4318:4318"     # OTLP HTTP receiver
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    restart: unless-stopped
    networks:
      - bote848
```

En production, ces composants sont déployés séparément (souvent via l'opérateur Kubernetes Jaeger), chacun scalable indépendamment.

---

## 6. Déploiement Jaeger

### 6.1 Démarrage (contexte TP ShopFlow)

```bash
# Reconstruire app-sample (nouvelles dépendances OpenTelemetry) et démarrer
# tout le stack, y compris jaeger — pas de profils sur ce projet
docker compose up -d --build

# Vérifier le statut
docker compose ps

# Vérifier l'UI
curl -s http://localhost:16686 -o /dev/null -w "%{http_code}\n"   # → 200
```

### 6.2 Vérifier la réception des traces

```bash
# API Jaeger Query — lister les services connus (doit inclure api-gateway)
curl -s http://localhost:16686/api/services | jq .

# Rechercher les traces d'un service via l'API (équivalent programmatique
# de la recherche dans l'UI)
curl -s "http://localhost:16686/api/traces?service=api-gateway&limit=5" | jq '.data[].traceID'
```

### 6.3 Variables d'environnement côté application

```bash
# Dans le conteneur app-sample (déjà configuré dans docker-compose.yml)
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317
OTEL_SERVICE_NAME=api-gateway
OTEL_TRACES_SAMPLER=always_on   # 100% en environnement de démo
```

---

## 7. Jaeger UI : guide d'utilisation

### 7.1 Recherche de traces

| Champ | Usage |
|-------|-------|
| **Service** | Filtre par nom de service (`serviceName` déclaré dans le SDK) |
| **Operation** | Filtre par nom d'opération (ex : `POST /api/checkout`) |
| **Tags** | Filtre par attributs de span (ex : `payment.provider=stripe`, `error=true`) |
| **Min/Max Duration** | Filtre par durée (ex : `3s` pour ne voir que les traces lentes) |
| **Lookback** | Fenêtre temporelle (dernière heure, dernières 24h, ou plage custom) |
| **Limit Results** | Nombre max de traces retournées |

### 7.2 Lecture d'une trace (waterfall view)

- Chaque ligne = un span, largeur proportionnelle à sa durée
- Clic sur un span → panneau de détail avec tags, logs/events, et process (métadonnées du service : version, host...)
- Les spans en erreur sont visuellement marqués (icône ou couleur rouge selon la version d'UI)

### 7.3 Comparaison de traces

Jaeger UI permet de sélectionner deux traces (ex : une normale, une en incident) et de les comparer côte à côte — utile pour visualiser rapidement "qu'est-ce qui diffère" entre un comportement sain et un comportement dégradé.

### 7.4 Dependency Graph (System Architecture)

Onglet dédié qui agrège l'ensemble des traces collectées pour reconstruire automatiquement **qui appelle qui** à l'échelle du système. Sur ShopFlow (service unique `api-gateway`), ce graphe est trivial (un seul nœud) — son intérêt apparaît surtout sur une vraie architecture multi-services, en début de mission sur un système inconnu, pour comprendre la cartographie réelle des dépendances (souvent différente de la documentation officielle).

---

## 8. Corrélation logs / métriques / traces

### 8.1 Le `trace_id` comme clé pivot

```
Log structuré (Loki), avec trace_id injecté par server.js :
{
  "timestamp": "2026-07-07T19:40:11.136Z",
  "level": "error",
  "service": "api-gateway",
  "message": "Payment processing failed",
  "error_code": "PAYMENT_RATE_LIMIT",
  "trace_id": "74acfed8735c8a41a01a1b4fa5ff1ced"   ← même identifiant que dans Jaeger
}

Trace (Jaeger) :
trace_id: 74acfed8735c8a41a01a1b4fa5ff1ced
  └─ payment.stripe_api_call span : ~200ms, status=ERROR, error_code=PAYMENT_RATE_LIMIT
```

Tant que le `trace_id` est propagé jusque dans les logs applicatifs (bonne pratique : l'injecter automatiquement dans chaque log émis pendant qu'un span est actif — c'est exactement ce que fait `server.js` via `opentelemetry.trace.getSpan(...)`), on peut sauter d'un outil à l'autre pour une même requête.

### 8.2 Grafana comme point d'unification

Grafana permet de configurer des liens automatiques entre datasources :

```yaml
datasources:
  - name: Jaeger
    type: jaeger
    url: http://jaeger:16686
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        tags: ['service']
        filterByTraceID: true
      tracesToMetrics:
        datasourceUid: prometheus
        tags: [{ key: 'service', value: 'service' }]
```

Concrètement, dans Grafana Explore : ouvrir une trace → bouton **"Logs for this span"** → bascule vers Loki filtré sur ce `trace_id` ; bouton **"Related metrics"** → bascule vers Prometheus sur le même service/période.

### 8.3 Ce que chaque pilier apporte, en synthèse

| Pilier | Répond à | Granularité | Volume |
|--------|----------|--------------|--------|
| Métriques | QUAND / COMBIEN | Agrégée | Faible |
| Logs | QUOI | Événement individuel | Très élevé |
| Traces | OÙ (dans la chaîne d'appels) | Hiérarchique (spans) | Moyen (dépend du sampling) |

---

## 9. Bonnes pratiques & pièges courants

### 9.1 Bonnes pratiques

- **Toujours fermer un span** (`span.end()`), y compris dans les chemins d'erreur (`finally`)
- **Propager le contexte** systématiquement entre services (ne pas créer de traces "orphelines" en oubliant de transmettre le `traceparent`)
- **Injecter le `trace_id` dans les logs** applicatifs pour permettre la corrélation
- **Nommer les opérations de façon cohérente** (`domaine.action`, ex: `payment.stripe_api_call`) plutôt que des noms trop génériques (`process`, `handle`)
- **Ajouter des attributs métier pertinents** (order.id, user.tier...) plutôt que de se limiter aux attributs techniques auto-générés
- **Adapter le sampling** à l'environnement (100% en dev/démo, taux réduit + tail-based en production)

### 9.2 Pièges courants

| Piège | Conséquence | Solution |
|-------|-------------|----------|
| Span jamais fermé | N'apparaît jamais (ou reste "actif" indéfiniment) dans l'UI | Toujours utiliser `try/finally` |
| Context non propagé entre services (ex: appel asynchrone via une queue sans transmettre les headers) | Trace "coupée" — deux traces distinctes au lieu d'une | Propager manuellement le contexte dans les messages de queue |
| Sampling à 100% en production | Explosion du volume de stockage, coûts | Passer en tail-based sampling ou taux réduit |
| Cardinalité excessive dans les attributs (ex: mettre `user_id` comme nom d'opération) | Dependency graph illisible, recherche inefficace | Réserver les identifiants uniques aux **tags**, pas aux noms d'opération |
| Confondre span "lent" et span "coupable" | Un span parent est souvent long simplement parce qu'il attend son enfant | Toujours descendre jusqu'au span **feuille** le plus long pour trouver la vraie cause |

---

## 10. Jaeger vs alternatives (Zipkin, Tempo, X-Ray)

| Critère | Jaeger | Zipkin | Grafana Tempo | AWS X-Ray |
|---------|--------|--------|---------------|-----------|
| Origine | Uber / CNCF | Twitter | Grafana Labs | AWS |
| Stockage natif | ES, Cassandra, mémoire | ES, Cassandra, mémoire | Object storage (S3, GCS) — très économique | Propriétaire AWS |
| Intégration Grafana | Bonne (datasource native) | Bonne (datasource native) | Excellente (même éditeur) | Limitée hors AWS |
| Compatible OpenTelemetry | Oui (OTLP natif) | Oui (via collector) | Oui (OTLP natif) | Oui (via collector) |
| Cas d'usage typique | Kubernetes / Cloud Native générique | Historique, encore présent en legacy | Écosystème Grafana déjà en place, gros volumes | Environnement 100% AWS |

**Pourquoi Jaeger pour ce module ?** Maturité CNCF, excellente documentation, intégration Grafana directe (cohérent avec Loki et Prometheus déjà utilisés en séance 2), et image "all-in-one" qui simplifie considérablement le déploiement en environnement de formation.

---

## 11. Glossaire

| Terme | Définition |
|-------|------------|
| **Trace** | Parcours complet d'une requête à travers un système distribué |
| **Span** | Unité de travail au sein d'une trace (un appel, une opération) |
| **Trace ID** | Identifiant unique partagé par tous les spans d'une même trace |
| **Span ID** | Identifiant unique d'un span donné |
| **Parent span** | Span dont un autre span (enfant) découle directement |
| **Context propagation** | Mécanisme de transmission du trace_id/span_id entre services |
| **Sampling** | Stratégie de sélection des traces à conserver (head-based, tail-based, adaptive) |
| **OTLP** | OpenTelemetry Protocol — format d'export standard |
| **Collector** | Composant recevant, validant et indexant les spans |
| **Waterfall** | Représentation visuelle en cascade des spans d'une trace |
| **Dependency graph** | Cartographie des appels entre services, reconstruite à partir des traces |
| **Auto-instrumentation** | Instrumentation automatique des librairies standards, sans code additionnel |

---

## 12. FAQ

**Q : Peut-on faire du tracing sans OpenTelemetry ?**
Oui (Jaeger a eu son propre client historique, `jaeger-client`), mais c'est aujourd'hui déconseillé : OpenTelemetry est devenu le standard de facto, maintenu activement, et évite le verrouillage sur un backend précis.

**Q : Les traces remplacent-elles les logs ?**
Non. Les traces montrent la structure temporelle et causale d'une requête, mais restent généralement pauvres en détail textuel comparées à un log applicatif complet (stacktrace entière, valeurs de variables...). Les deux pilliers sont complémentaires, reliés par le `trace_id`.

**Q : Pourquoi ne voit-on pas 100% des requêtes dans Jaeger en production ?**
À cause du sampling (section 3). C'est un choix assumé : tracer 100% du trafic à grande échelle serait généralement prohibitif en coût de stockage.

**Q : Un span peut-il avoir plusieurs parents ?**
Non, un span a au maximum un seul parent direct (structure d'arbre). En revanche, un span peut avoir des **liens** (`links`) vers d'autres traces, pour des cas comme les traitements batch qui agrègent plusieurs requêtes.

**Q : Que se passe-t-il si un service n'est pas instrumenté ?**
La trace "saute" ce service : le span parent (avant) et le span suivant (après, si le service en aval est instrumenté) ne seront pas reliés directement, créant un "trou" dans la trace. C'est un signal fréquent en début de projet d'instrumentation progressive.

---

*Document de référence — Version 1.0 — Séance 3, BOTE848*
