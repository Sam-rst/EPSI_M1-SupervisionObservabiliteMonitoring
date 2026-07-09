#!/usr/bin/env bash
# =============================================================================
# BOTE848 — Script de vérification stack TP
# =============================================================================
# À exécuter 15 min avant la séance pour valider que tout fonctionne.
# Usage : ./scripts/check-tp-ready.sh
# =============================================================================

set -u

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local description="$1"
  local command="$2"
  printf "%-50s " "$description"
  if eval "$command" > /dev/null 2>&1; then
    printf "${GREEN}✓ OK${NC}\n"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗ FAIL${NC}\n"
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================================"
echo "BOTE848 - Vérification stack TP Session 2"
echo "============================================================"
echo ""

echo "--- Prérequis hôte ---"
check "Docker installé"                "docker --version"
check "Docker Compose v2 installé"     "docker compose version"
check "Docker daemon actif"            "docker info"
echo ""

echo "--- Conteneurs UP ---"
for container in app-sample traffic-gen loki promtail prometheus node-exporter cadvisor grafana jaeger; do
  check "Conteneur $container actif"   "docker ps --format '{{.Names}}' | grep -q '^${container}$'"
done
echo ""

echo "--- Endpoints HTTP ---"
check "App sample (8000)"              "curl -fsS http://localhost:8000/"
check "App metrics (8000/metrics)"     "curl -fsS http://localhost:8000/metrics | grep -q http_requests_total"
check "Loki ready (3100)"              "curl -fsS http://localhost:3100/ready | grep -q ready"
check "Prometheus (9090)"              "curl -fsS http://localhost:9090/-/healthy"
check "Grafana (3000)"                 "curl -fsS http://localhost:3000/api/health | grep -q ok"
check "Node exporter (9100)"           "curl -fsS http://localhost:9100/metrics | grep -q node_cpu"
check "cAdvisor (8080)"                "curl -fsS http://localhost:8080/healthz"
check "Jaeger UI (16686)"              "curl -fsS http://localhost:16686 -o /dev/null"
echo ""

echo "--- Pipeline complet ---"
check "Prometheus a découvert app"     "curl -fsS http://localhost:9090/api/v1/targets | grep -q '\"job\":\"app-sample\".*\"health\":\"up\"'"
check "Loki reçoit des logs"           "curl -fsS 'http://localhost:3100/loki/api/v1/labels' | grep -q service"
check "Règles d'alerte chargées"       "curl -fsS http://localhost:9090/api/v1/rules | grep -q HighErrorRate"
check "Jaeger reçoit des traces"       "curl -fsS 'http://localhost:16686/api/services' | grep -q api-gateway"
echo ""

echo "============================================================"
printf "Résultat : ${GREEN}%d OK${NC} / ${RED}%d FAIL${NC}\n" "$PASS" "$FAIL"
echo "============================================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}⚠ Des vérifications ont échoué.${NC}"
  echo "Pistes :"
  echo "  - Les conteneurs viennent peut-être de démarrer : attendre 30s puis relancer"
  echo "  - Logs : docker compose logs <service>"
  echo "  - État : docker compose ps"
  exit 1
fi

echo -e "${GREEN}✓ Stack prête pour la séance !${NC}"
exit 0
