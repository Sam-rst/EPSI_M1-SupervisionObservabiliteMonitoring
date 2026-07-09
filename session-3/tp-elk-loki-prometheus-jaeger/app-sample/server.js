// =============================================================================
// BOTE848 — Application échantillon pour TP Session 2
// =============================================================================
// Objectifs pédagogiques :
//   - Exposer les 4 types de métriques Prometheus (Counter, Gauge, Histogram, Summary)
//   - Produire des logs JSON structurés (consommés par Promtail → Loki)
//   - Simuler un scénario e-commerce réaliste avec incidents configurables
//   - (Séance 3) Exporter des traces OpenTelemetry vers Jaeger
// =============================================================================

// ⚠️ DOIT être le tout premier require du fichier : l'auto-instrumentation
// OpenTelemetry doit patcher http/express AVANT qu'ils ne soient chargés.
require('./tracing');
const opentelemetry = require('@opentelemetry/api');
const tracer = opentelemetry.trace.getTracer('api-gateway');

const express = require('express');
const promClient = require('prom-client');

const app = express();
app.use(express.json());

const SERVICE_NAME = process.env.SERVICE_NAME || 'api-gateway';
const ENV = process.env.ENV || 'development';

// =============================================================================
// Logger structuré JSON → stdout (capté par Docker → Promtail → Loki)
// =============================================================================
function log(level, message, context = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    env: ENV,
    message,
    ...context,
  }));
}

// =============================================================================
// Registre métriques Prometheus
// =============================================================================
const register = new promClient.Registry();
register.setDefaultLabels({ service: SERVICE_NAME, env: ENV });

// Métriques par défaut Node.js (CPU process, GC, event loop, heap)
promClient.collectDefaultMetrics({ register });

// --- COUNTER : nombre total de requêtes HTTP -------------------------------
// Un Counter ne fait que monter. Reset uniquement au redémarrage du process.
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Nombre total de requêtes HTTP reçues',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

// --- COUNTER : erreurs de paiement par code --------------------------------
const paymentErrorsTotal = new promClient.Counter({
  name: 'payment_errors_total',
  help: 'Nombre total d\'erreurs de paiement',
  labelNames: ['error_code'],
  registers: [register],
});

// --- COUNTER : commandes traitées avec succès ------------------------------
const ordersTotal = new promClient.Counter({
  name: 'orders_total',
  help: 'Nombre total de commandes traitées avec succès',
  registers: [register],
});

// --- GAUGE : connexions actives (peut monter ET descendre) -----------------
const activeConnections = new promClient.Gauge({
  name: 'app_active_connections',
  help: 'Nombre de connexions actives en cours',
  registers: [register],
});

// --- GAUGE : profondeur de la file de traitement ---------------------------
const queueDepth = new promClient.Gauge({
  name: 'app_queue_depth',
  help: 'Profondeur de la file de traitement asynchrone',
  registers: [register],
});

// --- HISTOGRAM : distribution latence requêtes HTTP ------------------------
// Permet de calculer P50/P95/P99 via histogram_quantile() en PromQL.
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Latence des requêtes HTTP en secondes',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// --- SUMMARY : quantiles paiement (pré-calculés côté app) ------------------
// Différence vs Histogram : quantiles calculés côté app (pas côté Prometheus).
// Moins flexible mais plus précis. Non agrégeable entre instances.
const paymentDuration = new promClient.Summary({
  name: 'payment_processing_duration_seconds',
  help: 'Durée du traitement paiement (quantiles pré-calculés)',
  percentiles: [0.5, 0.9, 0.95, 0.99],
  registers: [register],
});

// =============================================================================
// Middleware métriques (mesure automatique toutes routes)
// =============================================================================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;
    const status = res.statusCode.toString();
    httpRequestsTotal.labels(req.method, route, status).inc();
    httpRequestDuration.labels(req.method, route, status).observe(duration);
  });
  next();
});

// =============================================================================
// Routes métier
// =============================================================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, env: ENV });
});

// Liste d'utilisateurs (latence faible, succès)
app.get('/api/users', (req, res) => {
  setTimeout(() => {
    log('info', 'Users list requested', { endpoint: '/api/users' });
    res.json([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Charlie' },
    ]);
  }, Math.random() * 40 + 10);
});

// Checkout : route avec incidents simulés (cœur du scénario pédagogique)
// (Séance 3) Instrumentée manuellement : chaque étape interne devient un span,
// visible dans le waterfall Jaeger. Le trace_id est aussi injecté dans les logs
// structurés pour permettre la corrélation logs <-> traces (Bloc 3).
app.post('/api/checkout', async (req, res) => {
  const userId = `user_${Math.floor(Math.random() * 1000)}`;
  const orderId = `order_${Math.floor(Math.random() * 100000)}`;
  const amount = Math.floor(Math.random() * 200) + 20;

  const activeSpan = opentelemetry.trace.getSpan(opentelemetry.context.active());
  const traceId = activeSpan ? activeSpan.spanContext().traceId : null;

  // --- Étape 1 : validation panier (opération interne rapide, simulée) ------
  await tracer.startActiveSpan('checkout.validate_cart', async (span) => {
    span.setAttribute('order.id', orderId);
    await new Promise((r) => setTimeout(r, Math.random() * 15 + 10));
    span.end();
  });

  // --- Étape 2 : vérification stock (opération interne rapide, simulée) -----
  await tracer.startActiveSpan('checkout.check_inventory', async (span) => {
    span.setAttribute('order.id', orderId);
    await new Promise((r) => setTimeout(r, Math.random() * 25 + 15));
    span.end();
  });

  // --- Étape 3 : traitement du paiement (le point chaud du scénario) --------
  const failureRate = parseFloat(process.env.PAYMENT_FAILURE_RATE || '0.05');
  const latencyMs = Math.random() * 200 + 100;
  const endPaymentTimer = paymentDuration.startTimer();

  await tracer.startActiveSpan('checkout.process_payment', async (paymentSpan) => {
    paymentSpan.setAttribute('order.id', orderId);
    paymentSpan.setAttribute('payment.provider', 'stripe');

    // Sous-span : l'appel externe à l'API Stripe (simulé) — c'est ce span
    // qui devient le "bottleneck" quand le paiement échoue/traîne.
    await tracer.startActiveSpan('payment.stripe_api_call', async (stripeSpan) => {
      stripeSpan.setAttribute('payment.provider', 'stripe');
      await new Promise((r) => setTimeout(r, latencyMs));

      if (Math.random() < failureRate) {
        const errorCodes = ['PAYMENT_TIMEOUT', 'PAYMENT_INVALID_CARD', 'PAYMENT_RATE_LIMIT'];
        const errorCode = errorCodes[Math.floor(Math.random() * errorCodes.length)];
        const err = new Error(errorCode);

        stripeSpan.recordException(err);
        stripeSpan.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: errorCode });
        paymentSpan.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: errorCode });

        log('error', 'Payment processing failed', {
          user_id: userId,
          order_id: orderId,
          amount,
          error_code: errorCode,
          duration_ms: Math.round(latencyMs),
          attempt_number: 1,
          trace_id: traceId,
        });

        paymentErrorsTotal.labels(errorCode).inc();
        endPaymentTimer();
        stripeSpan.end();
        paymentSpan.end();
        res.status(500).json({ error: errorCode, orderId, traceId });
        return;
      }

      stripeSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
      stripeSpan.end();

      log('info', 'Payment processed successfully', {
        user_id: userId,
        order_id: orderId,
        amount,
        duration_ms: Math.round(latencyMs),
        trace_id: traceId,
      });

      ordersTotal.inc();
      endPaymentTimer();
      paymentSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
      paymentSpan.end();
      res.json({ orderId, status: 'paid', amount, traceId });
    });
  });
});

// Endpoint volontairement lent (pour démos latence + alertes)
// (Séance 3, MSPR) Instrumenté : contrairement à /api/checkout (où l'erreur
// n'est PAS liée à la durée), ici le span est réellement anormalement long —
// scénario de type "verrou base de données" (inventory), sans échec HTTP.
app.get('/api/slow', async (req, res) => {
  const activeSpan = opentelemetry.trace.getSpan(opentelemetry.context.active());
  const traceId = activeSpan ? activeSpan.spanContext().traceId : null;

  await tracer.startActiveSpan('inventory.check_stock', async (span) => {
    await tracer.startActiveSpan('inventory.db_lock_wait', async (dbSpan) => {
      const delay = Math.random() * 2000 + 500;
      dbSpan.setAttribute('db.statement', "SELECT ... FOR UPDATE stock WHERE sku = ?");
      await new Promise((r) => setTimeout(r, delay));
      dbSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
      dbSpan.end();

      log('warn', 'Slow endpoint called', { duration_ms: Math.round(delay), trace_id: traceId });

      span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
      span.end();
      res.json({ status: 'done (slow)', duration_ms: Math.round(delay), traceId });
    });
  });
});

// =============================================================================
// Endpoint /metrics (consommé par Prometheus)
// =============================================================================
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// =============================================================================
// Simulation activité arrière-plan (alimente les Gauges)
// =============================================================================
setInterval(() => {
  activeConnections.set(Math.floor(Math.random() * 50) + 10);
  queueDepth.set(Math.floor(Math.random() * 30));
}, 5000);

// =============================================================================
// Démarrage
// =============================================================================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  log('info', 'Server started', { port: PORT, failure_rate: process.env.PAYMENT_FAILURE_RATE || '0.05' });
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down gracefully');
  process.exit(0);
});
