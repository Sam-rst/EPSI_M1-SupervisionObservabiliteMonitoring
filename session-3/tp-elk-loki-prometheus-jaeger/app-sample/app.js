// app-sample/app.js
// ShopFlow — application de démonstration BOTE848
// Expose /metrics (Prometheus), /health, et les routes ShopFlow
// Mode incident : INCIDENT_MODE=true → 30% d'erreurs PAYMENT_TIMEOUT sur /api/checkout

const http = require('http');
const url = require('url');

// ── Implémentation Prometheus client minimale (sans dépendance externe) ──────

const metrics = {
  counters: {},
  gauges: {},
  histogramBuckets: {},
  histogramSum: {},
  histogramCount: {},
};

const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

function incCounter(name, labels, value = 1) {
  const key = name + labelStr(labels);
  metrics.counters[key] = (metrics.counters[key] || { labels, value: 0 });
  metrics.counters[key].value += value;
}

function setGauge(name, labels, value) {
  const key = name + labelStr(labels);
  metrics.gauges[key] = { labels, value };
}

function observeHistogram(name, labels, value) {
  const key = name + labelStr(labels);
  if (!metrics.histogramBuckets[key]) {
    metrics.histogramBuckets[key] = { labels, buckets: Array(LATENCY_BUCKETS.length + 1).fill(0) };
    metrics.histogramSum[key] = { labels, value: 0 };
    metrics.histogramCount[key] = { labels, value: 0 };
  }
  LATENCY_BUCKETS.forEach((le, i) => {
    if (value <= le) metrics.histogramBuckets[key].buckets[i]++;
  });
  metrics.histogramBuckets[key].buckets[LATENCY_BUCKETS.length]++; // +Inf
  metrics.histogramSum[key].value += value;
  metrics.histogramCount[key].value++;
}

function labelStr(labels) {
  return '{' + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',') + '}';
}

function renderMetrics() {
  const lines = [];

  // Counter : http_requests_total
  lines.push('# HELP http_requests_total Total des requêtes HTTP reçues');
  lines.push('# TYPE http_requests_total counter');
  Object.values(metrics.counters).forEach(({ labels, value }) => {
    lines.push(`http_requests_total${labelStr(labels)} ${value}`);
  });

  // Gauge : db_connections_active
  lines.push('# HELP db_connections_active Connexions actives vers la base de données');
  lines.push('# TYPE db_connections_active gauge');
  Object.values(metrics.gauges).forEach(({ labels, value }) => {
    lines.push(`db_connections_active${labelStr(labels)} ${value}`);
  });

  // Histogram : http_request_duration_seconds
  lines.push('# HELP http_request_duration_seconds Durée des requêtes HTTP en secondes');
  lines.push('# TYPE http_request_duration_seconds histogram');
  Object.entries(metrics.histogramBuckets).forEach(([key, { labels, buckets }]) => {
    LATENCY_BUCKETS.forEach((le, i) => {
      lines.push(`http_request_duration_seconds_bucket${labelStr({ ...labels, le: String(le) })} ${buckets[i]}`);
    });
    lines.push(`http_request_duration_seconds_bucket${labelStr({ ...labels, le: '+Inf' })} ${buckets[LATENCY_BUCKETS.length]}`);
    lines.push(`http_request_duration_seconds_sum${labelStr(labels)} ${metrics.histogramSum[key].value.toFixed(6)}`);
    lines.push(`http_request_duration_seconds_count${labelStr(labels)} ${metrics.histogramCount[key].value}`);
  });

  return lines.join('\n') + '\n';
}

// ── Simulation du comportement ShopFlow ──────────────────────────────────────

let incidentMode = process.env.INCIDENT_MODE === 'true';
let dbConnections = 8;

// Fluctuation naturelle des connexions DB
setInterval(() => {
  const base = incidentMode ? 35 : 8;
  const noise = Math.floor(Math.random() * 6) - 3;
  dbConnections = Math.max(1, Math.min(50, base + noise));
  setGauge('db_connections_active', { job: 'app-sample', pool: 'primary' }, dbConnections);
}, 5000);

// Initialisation gauge
setGauge('db_connections_active', { job: 'app-sample', pool: 'primary' }, dbConnections);

function simulateRequest(endpoint) {
  const isCheckout = endpoint === '/api/checkout';
  const isIncident = incidentMode && isCheckout && Math.random() < 0.30;

  let latencyMs;
  let status;

  if (isIncident) {
    // Timeout paiement — scénario ShopFlow
    latencyMs = 5000 + Math.random() * 3000; // 5–8s
    status = '500';
  } else {
    // Comportement normal — latences réalistes par route
    const baselines = {
      '/api/products':  { mean: 80,  std: 30  },
      '/api/checkout':  { mean: 180, std: 60  },
      '/api/users':     { mean: 60,  std: 20  },
      '/health':        { mean: 5,   std: 2   },
      '/metrics':       { mean: 3,   std: 1   },
    };
    const b = baselines[endpoint] || { mean: 100, std: 40 };
    latencyMs = Math.max(10, b.mean + (Math.random() - 0.5) * 2 * b.std);
    // 0.3% d'erreurs aléatoires en conditions normales
    status = Math.random() < 0.003 ? '500' : '200';
  }

  return { latencyMs, status, isIncident };
}

function jsonLog(level, message, extra = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'app-sample',
    env: 'prod',
    message,
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

// ── Serveur HTTP ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const endpoint = parsed.pathname;
  const method = req.method;

  // ── /health ────────────────────────────────────────────────────
  if (endpoint === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', incident: incidentMode }));
    return;
  }

  // ── /metrics ───────────────────────────────────────────────────
  if (endpoint === '/metrics') {
    const body = renderMetrics();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(body);
    return;
  }

  // ── /incident/start et /incident/stop ─────────────────────────
  if (endpoint === '/incident/start') {
    incidentMode = true;
    jsonLog('WARN', 'Mode incident activé — 30% PAYMENT_TIMEOUT sur /api/checkout', { trigger: 'manual' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ incident: true, message: 'Incident mode activé' }));
    return;
  }

  if (endpoint === '/incident/stop') {
    incidentMode = false;
    jsonLog('INFO', 'Mode incident désactivé — retour conditions normales', { trigger: 'manual' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ incident: false, message: 'Incident mode désactivé' }));
    return;
  }

  // ── Routes ShopFlow ────────────────────────────────────────────
  const knownEndpoints = ['/api/products', '/api/checkout', '/api/users'];
  if (!knownEndpoints.includes(endpoint)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const { latencyMs, status, isIncident } = simulateRequest(endpoint);
  const traceId = 'trace_' + Math.random().toString(36).substr(2, 8);

  // Simuler la durée de traitement
  setTimeout(() => {
    // Enregistrer la métrique
    incCounter('http_requests_total', {
      job: 'app-sample',
      method,
      endpoint,
      status,
    });
    observeHistogram('http_request_duration_seconds', {
      job: 'app-sample',
      endpoint,
    }, latencyMs / 1000);

    // Log structuré JSON (compatible Loki si branché)
    if (status === '500') {
      jsonLog('ERROR', 'Paiement échoué — timeout provider', {
        endpoint,
        status: parseInt(status),
        latency_ms: Math.round(latencyMs),
        error_code: 'PAYMENT_TIMEOUT',
        provider: 'stripe-api-eu-west',
        trace_id: traceId,
      });
    } else {
      jsonLog('INFO', 'Requête traitée', {
        endpoint,
        method,
        status: parseInt(status),
        latency_ms: Math.round(latencyMs),
        trace_id: traceId,
      });
    }

    res.writeHead(parseInt(status), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: status === '200' ? 'ok' : 'error',
      endpoint,
      latency_ms: Math.round(latencyMs),
    }));
  }, latencyMs);
});

const PORT = parseInt(process.env.PORT || '8080');
server.listen(PORT, () => {
  jsonLog('INFO', `ShopFlow app-sample démarré`, { port: PORT, incident: incidentMode });
});
