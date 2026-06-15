# Rapport d'incident — TMA Acme-Shop

> **Type de document** : Compte-rendu d'incident de production (TMA — Tierce Maintenance Applicative)
> **Diffusion** : Direction technique, équipe SRE/Run, référent métier Paiement

---

## 1. Fiche d'identification

| Champ | Valeur |
|---|---|
| **Référence incident** | INC-2025-0516-001 |
| **Titre** | Taux d'erreur critique sur le `checkout-service` — timeouts gateway de paiement |
| **Criticité** | P1 — Majeur (parcours de paiement dégradé, CA directement impacté) |
| **Statut** | Diagnostiqué — palliatif à appliquer |
| **Date / heure de détection** | 2025-05-16 10:45 (alerte AlertManager) |
| **Fenêtre observée** | 2025-05-16 10:35:00Z → 10:44:35Z (≈ 10 min) |
| **Service impacté** | `payment-service` (parcours `checkout`) |
| **Composant en cause** | Gateway de paiement externe `stripe-api-eu-west` |
| **Auteur du rapport** | Samuel RESSIOT — SRE on-call |
| **Source de données** | `tp-data/incident-logs.json` (snapshot logs JSONL, 77 événements) |

**Déclencheur** : alerte AlertManager — `Error rate critical on checkout-service — threshold 1% breached for 5 min`.

---

## 2. Synthèse pour la direction (TL;DR)

> Entre **10:35 et 10:45**, le service de paiement a rejeté **47 transactions**, dont **40 par timeout** (85 %) vers la gateway **Stripe EU-West**. Le code applicatif n'est **pas en cause** : il subit la latence d'un fournisseur externe (5 à 8 s, au-delà du timeout applicatif de 5 s). **26 clients** sont touchés et **~10 230 €** de commandes sont en échec sur la fenêtre. Action immédiate : **basculer le routage paiement** vers une gateway de secours et ouvrir un ticket fournisseur Stripe.

---

## 3. Démarche d'investigation (le « process »)

Investigation menée uniquement à partir des logs structurés (JSONL), sans accès au code ni aux développeurs, dans la fenêtre de 10 min avant le point direction. Chaque étape ci-dessous est **reproductible** : la requête `jq` et son résultat réel sont fournis.

### Étape 1 — Qualifier le volume et la nature de l'alerte

**Objectif** : transformer une alerte vague (« error rate high ») en chiffres. Combien d'erreurs, de quels niveaux ?

```bash
# Comptage des erreurs
cat incident-logs.json | jq -c 'select(.level=="ERROR")' | wc -l
# => 47

# Volumétrie par niveau de log
cat incident-logs.json | jq -r '.level' | sort | uniq -c | sort -rn
# =>  47 ERROR / 29 INFO / 1 WARN
```

**Constat** : 47 erreurs sur ~77 événements. Le trafic nominal (INFO) continue : ce n'est **pas une panne totale** mais une **dégradation ciblée**.

### Étape 2 — Isoler le type d'erreur dominant

**Objectif** : ne pas se disperser. Quelle erreur concentre le problème ?

```bash
cat incident-logs.json \
  | jq -r 'select(.level=="ERROR") | .context.error_code' \
  | sort | uniq -c | sort -rn
# =>  40 PAYMENT_TIMEOUT
#      5 PAYMENT_INVALID_CARD
#      2 PAYMENT_RATE_LIMIT
```

**Constat** : `PAYMENT_TIMEOUT` représente **85 %** des erreurs. Les 5 `PAYMENT_INVALID_CARD` sont du **bruit de fond métier** (cartes refusées par la banque, durées 300–770 ms — comportement normal, sans rapport avec l'incident). Les 2 `PAYMENT_RATE_LIMIT` sont traités à l'étape 5.

### Étape 3 — Borner l'incident dans le temps

**Objectif** : début, fin, durée. Sert à l'estimation d'impact et à la communication.

```bash
cat incident-logs.json | jq -r 'select(.level=="ERROR") | .timestamp' | sort | head -1
# => 2025-05-16T10:35:00Z  (première)
cat incident-logs.json | jq -r 'select(.level=="ERROR") | .timestamp' | sort | tail -1
# => 2025-05-16T10:44:35Z  (dernière du snapshot)
```

**Constat** : démarrage net à **10:35:00**, erreurs continues sur toute la fenêtre → incident **actif et non résorbé** au moment du snapshot.

### Étape 4 — Localiser la cause racine (composant + symptôme mesurable)

**Objectif** : où ça casse, et pourquoi. On regarde le service émetteur, la gateway, et la métrique `duration_ms`.

```bash
# Le service émetteur est unique
cat incident-logs.json | jq -r 'select(.level=="ERROR") | .service' | sort | uniq -c
# =>  47 payment-service

# La gateway impliquée est unique
cat incident-logs.json | jq -r 'select(.level=="ERROR") | .context.gateway // "(n/a)"' | sort | uniq -c | sort -rn
# =>  42 stripe-api-eu-west / 5 (n/a -> les invalid-card)

# Statistiques de latence des timeouts
cat incident-logs.json | jq -s '
  [.[] | select(.context.error_code=="PAYMENT_TIMEOUT") | .context.duration_ms]
  | {count: length, min: min, max: max, avg: (add/length)}'
# => { "count": 40, "min": 5021, "max": 8149, "avg": 6484.18 }
```

**Constat** : **100 %** des timeouts pointent vers la **même gateway externe** `stripe-api-eu-west`, avec des latences de **5021 → 8149 ms (moy. 6484 ms)**, toutes **au-dessus du timeout applicatif de 5000 ms**. Le `payment-service` ne fait que **reporter** la lenteur de l'upstream : pas de défaut de code côté Acme-Shop.

### Étape 5 — Confirmer le scénario (signal précurseur + effet de cascade)

**Objectif** : valider l'hypothèse par des signaux indépendants, pas une seule métrique.

```bash
# Signal précurseur : un WARN avant la cascade
cat incident-logs.json | jq -c 'select(.level=="WARN")'
# => 10:37:42 api-gateway "Slow upstream response" upstream=payment-service duration_ms=4065

# Effet de cascade : retries puis rate-limiting du fournisseur
cat incident-logs.json | jq -r 'select(.context.error_code=="PAYMENT_TIMEOUT") | .context.attempt_number' | sort | uniq -c
# =>  16 (tentative 1) / 13 (tentative 2) / 11 (tentative 3)

cat incident-logs.json | jq -c 'select(.context.error_code=="PAYMENT_RATE_LIMIT") | {ts:.timestamp, retry_after:.context.retry_after_seconds}'
# => 10:43:18 retry_after=60 / 10:44:35 retry_after=60
```

**Constat** : la chronologie est cohérente avec une **dégradation progressive** (et non une panne brutale) :
1. **10:35** — premiers timeouts ;
2. **10:37:42** — l'`api-gateway` émet un WARN « Slow upstream » (4065 ms, déjà proche du seuil) ;
3. les clients/SDK **rejouent** (24 erreurs en tentative 2 ou 3) ;
4. **10:43 puis 10:44** — la gateway commence à **rate-limiter** (`PAYMENT_RATE_LIMIT`, retry_after 60 s) — la cascade de retries aggrave la saturation.

### Étape 6 — Mesurer l'impact (technique + métier)

**Objectif** : chiffrer pour la décision (combien de clients, combien d'€).

```bash
# Clients uniques impactés
cat incident-logs.json | jq -r 'select(.level=="ERROR") | .context.user_id' | sort -u | wc -l
# => 26

# Montant des commandes en échec (timeouts)
cat incident-logs.json | jq -s '
  [.[] | select(.context.error_code=="PAYMENT_TIMEOUT") | .context.amount_eur]
  | {transactions: length, montant_total_eur: (add), panier_moyen_eur: (add/length)}'
# => { "transactions": 40, "montant_total_eur": 10229.12, "panier_moyen_eur": 255.73 }
```

**Constat** : **26 clients uniques** impactés, **40 commandes** en échec, **≈ 10 229 €** de CA à risque sur 10 min (panier moyen 256 €).

---

## 4. Analyse de la cause racine (RCA)

| Question | Réponse étayée |
|---|---|
| **Quoi ?** | 47 erreurs paiement en 10 min, dont 40 `PAYMENT_TIMEOUT` (85 %). |
| **Où ?** | `payment-service` → gateway externe `stripe-api-eu-west` (100 % des timeouts). |
| **Pourquoi ?** | Latence de la gateway 5–8 s > timeout applicatif 5 s. Cause **externe** (fournisseur), pas un bug applicatif Acme-Shop. |
| **Facteur aggravant** | Retries automatiques (tentatives 2 et 3 = 24/40) → rate-limiting de la gateway → boucle d'auto-aggravation. |
| **Preuve de progressivité** | WARN précurseur `api-gateway` à 10:37:42 (4065 ms) avant le pic. |

**Cause racine retenue** : dégradation de performance de la gateway de paiement **`stripe-api-eu-west`** (incident fournisseur ou saturation régionale), le timeout applicatif de 5 s convertissant cette latence en échecs de transaction.

---

## 5. Impact

- **Technique** : parcours `checkout` dégradé ; ~85 % des tentatives de paiement en échec sur la fenêtre ; risque de saturation par les retries (rate-limit déjà atteint à 10:43).
- **Métier** : 26 clients impactés, ≈ 10 230 € de commandes en échec sur 10 min. Extrapolation indicative si non résolu : ~60 k€/h de CA à risque (à pondérer selon le trafic réel).
- **Image** : risque d'abandon de panier et de tickets support clients.

---

## 6. Actions

### 6.1 Palliatif (immédiat — < 15 min)

1. **Vérifier la status page Stripe** région EU-West et **ouvrir un ticket fournisseur P1** si non déjà signalé.
2. **Basculer le routage des paiements** vers une gateway de secours (`stripe-api-eu-central` ou fallback) le temps du rétablissement.
3. **Réduire / temporiser les retries** côté `payment-service` pour stopper la boucle d'auto-aggravation (rate-limit).
4. **Communication client** : message d'attente aux 26 clients impactés ; rejouer les commandes en échec après rétablissement.

### 6.2 Correctif (court terme)

- Confirmer le rétablissement de la latence EU-West (< 5 s) avant retour au routage nominal.
- Réconcilier les 40 commandes en échec (relance ou remboursement éventuel des doublons liés aux retries).

### 6.3 Préventif (moyen terme — post-mortem)

- **Circuit breaker** sur la gateway de paiement (fail-fast au lieu d'attendre 5 s × N retries).
- **Fallback multi-gateway** automatisé (bascule EU-West ↔ EU-Central sur seuil de latence/erreur).
- **Backoff exponentiel + plafond de retries** pour éviter le rate-limiting auto-infligé.
- **Alerte avancée** sur la latence upstream (`duration_ms` du WARN `api-gateway`) afin de détecter dès ~4 s, **avant** la bascule en timeouts.
- **SLO/SLA fournisseur** : suivre la latence p95/p99 de la gateway et formaliser les engagements Stripe.

---

## 7. Chronologie de l'incident

| Heure (UTC) | Événement |
|---|---|
| 10:35:00 | Premier `PAYMENT_TIMEOUT` (user_032, 7959 ms) — début de l'incident |
| 10:35–10:37 | Montée en charge des timeouts (14 erreurs) |
| 10:37:42 | **WARN** `api-gateway` « Slow upstream response » (4065 ms) — signal précurseur |
| 10:38–10:42 | Plateau d'erreurs, retries en tentatives 2 et 3 |
| 10:43:18 | Premier `PAYMENT_RATE_LIMIT` (retry_after 60 s) — début de cascade |
| 10:44:35 | Dernier événement du snapshot (incident toujours actif) |
| 10:45 | Alerte AlertManager / prise en charge SRE |

---

## 8. Suivi

| Action | Responsable | Échéance | Statut |
|---|---|---|---|
| Bascule routage gateway de secours | SRE on-call | Immédiat | À faire |
| Ticket fournisseur Stripe (P1) | SRE on-call | Immédiat | À faire |
| Réconciliation des 40 commandes | Équipe Paiement | J+1 | À faire |
| Post-mortem & actions préventives | SRE + Lead Paiement | J+5 | À planifier |

---

*Toutes les métriques de ce rapport ont été produites par requêtes `jq` sur `tp-data/incident-logs.json` et sont reproductibles via les commandes ci-dessus.*
