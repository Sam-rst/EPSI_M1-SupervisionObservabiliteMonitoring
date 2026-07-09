// =============================================================================
// BOTE848 — Initialisation OpenTelemetry (traces → Jaeger)
// =============================================================================
// Ce fichier DOIT être chargé avant tout le reste (require('./tracing') en
// toute première ligne de server.js), pour que l'auto-instrumentation puisse
// patcher les modules (http, express) avant qu'ils ne soient utilisés.
// =============================================================================

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger:4317';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'api-gateway';

const sdk = new NodeSDK({
  serviceName: SERVICE_NAME,
  traceExporter: new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Désactive l'instrumentation du filesystem (bruit, non pertinent pour le TP)
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  level: 'info',
  service: SERVICE_NAME,
  message: 'OpenTelemetry tracing initialized',
  otlp_endpoint: OTLP_ENDPOINT,
}));

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});

module.exports = sdk;
