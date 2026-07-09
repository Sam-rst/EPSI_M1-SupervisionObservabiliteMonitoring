#!/bin/sh
# trigger-incident.sh
# Déclenche ou stoppe l'incident paiement ShopFlow
# Usage : ./trigger-incident.sh start | stop | status

APP_URL="http://localhost:8080"

case "$1" in
  start)
    echo "🔴 Déclenchement de l'incident paiement ShopFlow..."
    curl -sf "$APP_URL/incident/start" | python3 -m json.tool 2>/dev/null || \
      curl -sf "$APP_URL/incident/start"
    echo ""
    echo "➜ 30% des requêtes /api/checkout vont échouer avec PAYMENT_TIMEOUT"
    echo "➜ Observez le dashboard Grafana sur http://localhost:3000"
    echo "➜ Prometheus UI : http://localhost:9090"
    ;;
  stop)
    echo "🟢 Arrêt de l'incident..."
    curl -sf "$APP_URL/incident/stop" | python3 -m json.tool 2>/dev/null || \
      curl -sf "$APP_URL/incident/stop"
    echo ""
    echo "➜ Retour aux conditions normales"
    echo "➜ Les métriques reviennent à la baseline en ~5 minutes (fenêtre rate[5m])"
    ;;
  status)
    echo "📊 Statut app-sample :"
    curl -sf "$APP_URL/health" | python3 -m json.tool 2>/dev/null || \
      curl -sf "$APP_URL/health"
    echo ""
    ;;
  *)
    echo "Usage : $0 start | stop | status"
    exit 1
    ;;
esac
