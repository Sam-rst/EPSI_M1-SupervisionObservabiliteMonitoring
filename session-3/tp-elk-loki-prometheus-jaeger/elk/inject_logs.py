#!/usr/bin/env python3
"""
inject_logs.py — Injecte shopflow.log dans Elasticsearch via l'API bulk.
Utilisé au démarrage du conteneur elk-injector.
"""

import json
import time
import urllib.request
import urllib.error

ES_URL = "http://elasticsearch:9200"
INDEX  = "shopflow-logs"
LOG_FILE = "/logs/shopflow.log"


def wait_for_elasticsearch(max_retries=30, delay=5):
    print("⏳ Attente démarrage Elasticsearch...")
    for attempt in range(max_retries):
        try:
            req = urllib.request.urlopen(f"{ES_URL}/_cluster/health", timeout=5)
            data = json.loads(req.read())
            if data.get("status") in ("yellow", "green"):
                print(f"✅ Elasticsearch prêt (status: {data['status']})")
                return True
        except Exception:
            pass
        print(f"   Tentative {attempt + 1}/{max_retries}...")
        time.sleep(delay)
    return False


def create_index():
    mapping = {
        "mappings": {
            "properties": {
                "timestamp":  {"type": "date"},
                "level":      {"type": "keyword"},
                "service":    {"type": "keyword"},
                "instance":   {"type": "keyword"},
                "env":        {"type": "keyword"},
                "message":    {"type": "text"},
                "user_id":    {"type": "keyword"},
                "order_id":   {"type": "keyword"},
                "error_code": {"type": "keyword"},
                "latency_ms": {"type": "integer"},
                "amount":     {"type": "float"},
                "provider":   {"type": "keyword"},
                "http_status":{"type": "integer"},
                "trace_id":   {"type": "keyword"}
            }
        }
    }
    # Supprimer index si existe déjà
    try:
        req = urllib.request.Request(f"{ES_URL}/{INDEX}", method="DELETE")
        urllib.request.urlopen(req)
        print(f"🗑️  Index {INDEX} existant supprimé")
    except Exception:
        pass

    # Créer index
    data = json.dumps(mapping).encode()
    req = urllib.request.Request(
        f"{ES_URL}/{INDEX}",
        data=data,
        method="PUT",
        headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req)
    print(f"📁 Index {INDEX} créé avec mapping")


def inject_logs():
    with open(LOG_FILE, "r") as f:
        lines = [line.strip() for line in f if line.strip()]

    bulk_body = ""
    for i, line in enumerate(lines):
        doc = json.loads(line)
        action = json.dumps({"index": {"_index": INDEX, "_id": str(i + 1)}})
        bulk_body += action + "\n" + json.dumps(doc) + "\n"

    data = bulk_body.encode("utf-8")
    req = urllib.request.Request(
        f"{ES_URL}/_bulk",
        data=data,
        method="POST",
        headers={"Content-Type": "application/x-ndjson"}
    )
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read())

    errors = [item for item in result.get("items", []) if "error" in item.get("index", {})]
    print(f"✅ {len(lines)} logs injectés dans Elasticsearch ({len(errors)} erreurs)")
    if errors:
        print(f"   Premières erreurs : {errors[:2]}")


if __name__ == "__main__":
    if not wait_for_elasticsearch():
        print("❌ Elasticsearch non disponible après timeout")
        exit(1)

    create_index()
    inject_logs()
    print("🎉 Injection terminée. Index 'shopflow-logs' prêt dans Kibana.")
