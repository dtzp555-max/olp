# OLP Cloud Deployment Plan — Family Testing Phase

**Status:** Draft — pending current Phase 6 completion  
**Target:** Oracle Cloud VM (existing infrastructure)  
**Audience:** Project maintainer deployment reference  
**Scope:** Single-VM deployment for family (3–5 users), spawn-binary architecture, public internet exposure with hardened auth

---

## 0. Prerequisites

- OLP current phase (Phase 6) is closed and tagged
- Oracle Cloud VM accessible via SSH (existing `opc` user)
- Domain name (optional but strongly recommended for TLS)
- Provider CLI OAuth completed on at least one machine (credentials transferable)

---

## 1. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│  Family Devices (anywhere on internet)                             │
│                                                                    │
│  Wife iPad / Kid Laptop / Maintainer MacBook / ...                 │
│  IDE: Cline / Continue.dev / Cursor / Aider / OpenClaw             │
│  Config: OPENAI_BASE_URL=https://olp.example.com/v1                │
│          OPENAI_API_KEY=olp_<personal-key>                         │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ HTTPS (TLS 1.3)
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│  Oracle Cloud VM                                                   │
│                                                                    │
│  ┌─ iptables / OCI Security List ──────────────────────────────┐   │
│  │  ALLOW: TCP 443 (HTTPS) from 0.0.0.0/0                     │   │
│  │  ALLOW: TCP 22  (SSH)   from maintainer IP only             │   │
│  │  DENY:  everything else                                     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌─ Nginx (reverse proxy + TLS termination) ───────────────────┐   │
│  │  :443 → TLS (Let's Encrypt auto-renew via certbot)          │   │
│  │  proxy_pass → http://127.0.0.1:4567                         │   │
│  │  Rate limit: 30 req/min per IP (burst 10)                   │   │
│  │  Request body limit: 1MB                                    │   │
│  │  Connection timeout: 300s (streaming needs long timeout)     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌─ OLP server.mjs ───────────────────────────────────────────┐    │
│  │  OLP_BIND=127.0.0.1   (loopback only — Nginx fronts it)    │   │
│  │  OLP_PORT=4567                                              │   │
│  │  auth.allow_anonymous: false                                │   │
│  │  auth.advertise_anonymous_key: false                        │   │
│  │  Per-key audit logging to ~/.olp/logs/audit.ndjson          │   │
│  │  Owner key: maintainer only                                 │   │
│  │  Guest keys: one per family member                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌─ Provider CLIs (installed on this VM) ──────────────────────┐   │
│  │  claude    → ~/.claude/.credentials.json (OAuth)            │   │
│  │  codex     → ~/.codex/auth.json (OAuth)                     │   │
│  │  vibe      → ~/.vibe/.env (API key)                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌─ systemd service ──────────────────────────────────────────┐    │
│  │  olp.service: auto-start, auto-restart on crash             │   │
│  │  Runs as dedicated `olp` user (not root, not opc)           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
         │
         │ Provider CLIs spawn outbound HTTPS calls
         ▼
  Anthropic API / OpenAI API / Mistral API
```

---

## 2. Security Design (7 Layers)

### Layer 1 — Network Perimeter (OCI Security List + iptables)

**Principle:** Minimum attack surface. Only two ports reachable from the internet.

```
OCI Security List (stateful ingress rules):
  ┌──────────┬────────────┬───────────────────────────────┐
  │ Port     │ Protocol   │ Source                        │
  ├──────────┼────────────┼───────────────────────────────┤
  │ 443      │ TCP        │ 0.0.0.0/0 (public HTTPS)     │
  │ 22       │ TCP        │ <maintainer-IP>/32 only       │
  └──────────┴────────────┴───────────────────────────────┘

  NOT exposed:
  - Port 4567 (OLP direct) — Nginx fronts it
  - Port 80 (HTTP) — only for certbot ACME challenge, redirect to 443
```

**iptables backup** (defense in depth — OCI Security List is primary, iptables is secondary):

```bash
# Drop everything by default
sudo iptables -P INPUT DROP
sudo iptables -P FORWARD DROP

# Allow established connections
sudo iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow loopback
sudo iptables -A INPUT -i lo -j ACCEPT

# Allow SSH from maintainer IP only
sudo iptables -A INPUT -p tcp --dport 22 -s <MAINTAINER_IP> -j ACCEPT

# Allow HTTPS from anywhere
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# Allow HTTP (certbot ACME only — Nginx redirects everything else)
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT

# Persist
sudo iptables-save | sudo tee /etc/iptables/rules.v4
```

### Layer 2 — TLS Termination (Nginx + Let's Encrypt)

**Principle:** All client traffic encrypted. OLP itself runs plain HTTP on loopback — simpler, no cert management in Node.

```nginx
# /etc/nginx/sites-available/olp.conf

# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name olp.example.com;
    
    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS — TLS 1.3 only
server {
    listen 443 ssl http2;
    server_name olp.example.com;
    
    # TLS config
    ssl_certificate     /etc/letsencrypt/live/olp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/olp.example.com/privkey.pem;
    ssl_protocols       TLSv1.3;                # TLS 1.3 only
    ssl_prefer_server_ciphers off;              # TLS 1.3 manages its own
    ssl_session_timeout 1d;
    ssl_session_cache   shared:SSL:10m;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    
    # Rate limiting (per IP)
    limit_req zone=olp_limit burst=10 nodelay;
    
    # Request body size (LLM prompts can be large but cap at 1MB)
    client_max_body_size 1m;
    
    # Proxy to OLP
    location / {
        proxy_pass http://127.0.0.1:4567;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # SSE streaming support (critical for /v1/chat/completions)
        proxy_set_header Connection '';
        proxy_buffering off;                    # Don't buffer SSE
        proxy_cache off;
        chunked_transfer_encoding on;
        
        # Long timeouts for LLM inference
        proxy_connect_timeout 10s;
        proxy_read_timeout 300s;                # 5 min — long reasoning
        proxy_send_timeout 300s;
    }
}

# Rate limit zone definition (in http {} block of nginx.conf)
# limit_req_zone $binary_remote_addr zone=olp_limit:10m rate=30r/m;
```

**Certbot auto-renewal:**

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d olp.example.com
# Auto-renew via systemd timer (certbot installs this automatically)
```

### Layer 3 — Application Auth (OLP Multi-Key)

**Principle:** Every request must carry a valid API key. No anonymous access. Per-key audit trail.

```json
// ~/.olp/config.json on the cloud VM
{
  "auth": {
    "allow_anonymous": false,
    "advertise_anonymous_key": false,
    "owner_only_endpoints": [
      "/health",
      "/v0/management/dashboard-data",
      "/v0/management/quota",
      "/v0/management/status",
      "/cache/stats",
      "/dashboard"
    ],
    "fallback_detail_header_policy": "owner_only"
  }
}
```

**Key provisioning plan:**

```
┌───────────────┬──────────┬─────────────────────────────────────┐
│ Key name      │ Tier     │ providers_enabled                   │
├───────────────┼──────────┼─────────────────────────────────────┤
│ cloud-owner   │ owner    │ all (dashboard + management access) │
│ wife-ipad     │ guest    │ anthropic, openai                   │
│ kid-laptop    │ guest    │ anthropic only (cost control)       │
│ maintainer-mb │ guest    │ all (daily driver, not owner tier)  │
└───────────────┴──────────┴─────────────────────────────────────┘
```

**Why maintainer uses a guest key for daily driving:** owner key gives access to management endpoints. Routine IDE usage should not carry owner privilege. Owner key is used only for dashboard access and administration.

**Key lifecycle:**
- Keys generated on the cloud VM via `olp-keys keygen`
- Plaintext token communicated to family member via secure channel (Signal / iMessage, not email)
- Each key logged independently in audit.ndjson (per-key `key_id` field)
- Revocation: `olp-keys revoke --id=<key-id>` — immediate, no grace period

### Layer 4 — Process Isolation (Dedicated User + systemd)

**Principle:** OLP runs as a non-root, non-login user. Crash recovery is automatic.

```bash
# Create dedicated user
sudo useradd --system --shell /usr/sbin/nologin --home-dir /opt/olp olp

# OLP code
sudo mkdir -p /opt/olp
sudo git clone https://github.com/dtzp555-max/olp.git /opt/olp/app
sudo chown -R olp:olp /opt/olp

# OLP data (keys, config, logs, cache)
sudo mkdir -p /home/olp/.olp/{keys,logs,cache}
sudo chown -R olp:olp /home/olp
```

**systemd unit:**

```ini
# /etc/systemd/system/olp.service
[Unit]
Description=OLP — Open LLM Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=olp
Group=olp

WorkingDirectory=/opt/olp/app
ExecStart=/usr/bin/node server.mjs

# Environment
Environment=OLP_BIND=127.0.0.1
Environment=OLP_PORT=4567
Environment=NODE_ENV=production
Environment=HOME=/home/olp

# Auto-restart on crash
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=/home/olp/.olp
PrivateTmp=true

# Resource limits
LimitNOFILE=65536
MemoryMax=1G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=olp

[Install]
WantedBy=multi-user.target
```

### Layer 5 — Credential Protection (Provider OAuth Tokens)

**Principle:** OAuth tokens are the crown jewels. Stolen tokens = someone else using your Claude/OpenAI subscription.

```
Credential storage on cloud VM:

~olp/
├── .claude/
│   └── .credentials.json     # chmod 600, owner=olp
├── .codex/
│   └── auth.json              # chmod 600, owner=olp
└── .vibe/
    └── .env                   # chmod 600, owner=olp

Security measures:
  1. chmod 600 on all credential files (olp user only)
  2. Credential files NOT in the git repo (already .gitignored)
  3. No credential in env vars (OLP reads from filesystem)
  4. Credential transfer: scp from local machine, then delete local copy of the scp command from shell history
  5. Periodic rotation: re-auth quarterly (or on any suspicion of compromise)
```

**Credential transfer procedure:**

```bash
# FROM maintainer's Mac mini (one-time):

# 1. Claude credentials
scp ~/.claude/.credentials.json opc@<cloud-ip>:/tmp/claude-cred.json
ssh opc@<cloud-ip> "sudo mv /tmp/claude-cred.json /home/olp/.claude/.credentials.json && sudo chown olp:olp /home/olp/.claude/.credentials.json && sudo chmod 600 /home/olp/.claude/.credentials.json"

# 2. Codex credentials
scp ~/.codex/auth.json opc@<cloud-ip>:/tmp/codex-cred.json
ssh opc@<cloud-ip> "sudo mv /tmp/codex-cred.json /home/olp/.codex/auth.json && sudo chown olp:olp /home/olp/.codex/auth.json && sudo chmod 600 /home/olp/.codex/auth.json"

# 3. Mistral API key
ssh opc@<cloud-ip> "sudo -u olp bash -c 'echo MISTRAL_API_KEY=sk-xxx > ~/.vibe/.env && chmod 600 ~/.vibe/.env'"

# 4. Verify
ssh opc@<cloud-ip> "sudo -u olp node /opt/olp/app/bin/olp.mjs doctor --json" | jq '.checks[] | select(.name | contains("auth"))'
```

### Layer 6 — Audit and Monitoring

**Principle:** Every request logged. Anomalies detectable. No silent failures.

**Audit (already built into OLP):**
- `~/.olp/logs/audit.ndjson` — append-only, per-request, includes `key_id`, provider, model, cache hit/miss, fallback hops
- Daily rotation: `audit-YYYY-MM-DD.ndjson` (built-in, triggers on first append after UTC midnight)
- External rotation tool: `olp-audit-rotate` (idempotent, cron-safe)

**Additional monitoring for cloud deployment:**

```bash
# Cron: daily audit rotation (belt-and-suspenders alongside in-server rotation)
0 0 * * * /usr/bin/node /opt/olp/app/bin/olp-audit-rotate.mjs

# Cron: daily health check + alert
*/5 * * * * curl -sf -H "Authorization: Bearer $OLP_OWNER_KEY" https://olp.example.com/health > /dev/null || echo "OLP health check failed at $(date)" >> /home/olp/alerts.log

# Cron: audit log size check (alert if >100MB — suggests anomalous traffic)
0 6 * * * find /home/olp/.olp/logs -name 'audit*.ndjson' -size +100M -exec echo "Large audit log: {}" \; >> /home/olp/alerts.log

# Cron: disk usage check
0 6 * * * df -h / | awk 'NR==2 && $5+0 > 80 {print "Disk usage above 80%: "$5}' >> /home/olp/alerts.log
```

**What to watch for (manually, weekly):**
1. `olp-keys list` — any unexpected keys?
2. Dashboard (`/dashboard`) — unusual request volume? Unknown providers being hit?
3. `journalctl -u olp --since "7 days ago" | grep -c ERROR` — error spike?
4. Audit log: `grep "fallback" ~/.olp/logs/audit.ndjson | wc -l` — fallback frequency (high = provider instability)

### Layer 7 — Update and Recovery

**Principle:** Rollback within 60 seconds. No data loss on failed update.

**Update procedure:**

```bash
# SSH to cloud VM as opc

# 1. Snapshot before update (Oracle Cloud console or CLI)
# OCI CLI: oci compute boot-volume-backup create ...

# 2. Pull latest code
cd /opt/olp/app
sudo -u olp git fetch origin main
sudo -u olp git log --oneline HEAD..origin/main  # review what's coming

# 3. Run tests BEFORE deploying
sudo -u olp git checkout main
sudo -u olp git pull
sudo -u olp node test-features.mjs
# STOP if tests fail

# 4. Restart service
sudo systemctl restart olp
sleep 3
sudo systemctl status olp  # verify running

# 5. Smoke test
curl -sf -H "Authorization: Bearer $OLP_OWNER_KEY" https://olp.example.com/health | jq .ok
# Expect: true
```

**Rollback:**

```bash
# If update breaks things:
cd /opt/olp/app
sudo -u olp git checkout <previous-tag>   # e.g. v0.6.0
sudo systemctl restart olp
```

**Backup (automated):**

```bash
# Cron: daily backup of OLP state (keys + config + recent audit)
0 3 * * * tar czf /home/opc/backups/olp-state-$(date +\%Y\%m\%d).tar.gz -C /home/olp .olp/keys .olp/config.json .olp/logs/audit.ndjson 2>/dev/null; find /home/opc/backups -name 'olp-state-*' -mtime +30 -delete
```

---

## 3. Implementation Checklist

Execute in order. Each step has a verification gate — do not proceed if the gate fails.

### Phase A — VM Preparation

```
[ ] A1. SSH to Oracle Cloud VM, verify Node.js >= 18
        Gate: `node --version` prints v18+

[ ] A2. Create `olp` system user
        Gate: `id olp` shows the user exists

[ ] A3. Clone OLP repo to /opt/olp/app
        Gate: `sudo -u olp node /opt/olp/app/test-features.mjs` — all tests pass

[ ] A4. Install provider CLIs (as olp user)
        - npm install -g @anthropic-ai/claude-code
        - npm install -g @openai/codex
        - (mistral vibe if needed)
        Gate: `which claude && which codex` both resolve

[ ] A5. Transfer OAuth credentials (Layer 5 procedure)
        Gate: `sudo -u olp claude auth status` shows authenticated
```

### Phase B — Security Hardening

```
[ ] B1. Configure OCI Security List (Layer 1)
        Gate: nmap from external IP shows only 22 and 443 open

[ ] B2. Configure iptables backup (Layer 1)
        Gate: `sudo iptables -L -n` matches the plan

[ ] B3. Install + configure Nginx (Layer 2)
        Gate: `curl -I http://olp.example.com` returns 301 → HTTPS

[ ] B4. Obtain Let's Encrypt certificate
        Gate: `curl -I https://olp.example.com` returns valid cert

[ ] B5. Verify Nginx SSE passthrough
        Gate: test streaming request completes without timeout
```

### Phase C — OLP Configuration

```
[ ] C1. Write ~/.olp/config.json (Layer 3 — auth config)
        Gate: config validates (no startup warnings in journal)

[ ] C2. Generate owner key
        Gate: `olp-keys list --owner-only` shows 1 owner key

[ ] C3. Generate family guest keys (one per person)
        Gate: `olp-keys list` shows correct count

[ ] C4. Install systemd unit (Layer 4)
        Gate: `systemctl status olp` shows active (running)

[ ] C5. Verify /health with owner key
        Gate: `curl -H "Authorization: Bearer $OWNER_KEY" https://olp.example.com/health | jq .ok` → true

[ ] C6. Verify /health rejects unauthenticated
        Gate: `curl https://olp.example.com/health` → 401

[ ] C7. Verify guest key cannot access /dashboard
        Gate: `curl -H "Authorization: Bearer $GUEST_KEY" https://olp.example.com/dashboard` → 403

[ ] C8. End-to-end LLM request with guest key
        Gate: streaming chat completion returns a valid response
```

### Phase D — Monitoring Setup

```
[ ] D1. Install cron jobs (Layer 6)
        Gate: `crontab -l` shows all 4 jobs

[ ] D2. Verify daily backup cron
        Gate: manual trigger produces valid tar.gz

[ ] D3. Test health-check alert
        Gate: stop OLP, wait 5min, check alerts.log has entry
```

### Phase E — Family Onboarding

```
[ ] E1. Send each family member their API key via Signal/iMessage
        (NOT via email, NOT via any cloud-stored medium)

[ ] E2. Each family member configures their IDE:
        export OPENAI_BASE_URL=https://olp.example.com/v1
        export OPENAI_API_KEY=olp_<their-key>

[ ] E3. Each family member runs a test prompt
        Gate: audit.ndjson shows their key_id in the log

[ ] E4. Verify per-key provider scoping
        Gate: kid's key cannot hit providers outside their scope
```

---

## 4. Security Threat Model

| Threat | Mitigation | Residual Risk |
|---|---|---|
| **Brute-force API key** | 32-byte entropy = 2^256 keyspace; Nginx rate limit 30r/m | Negligible |
| **TLS downgrade** | TLS 1.3 only; HSTS header | None with modern clients |
| **Credential theft (OAuth tokens on VM)** | chmod 600 + dedicated user + no root access to OLP dirs | VM root compromise (mitigated by OCI IAM) |
| **Stolen guest key** | Single-key revocation via `olp-keys revoke`; per-key audit trail for forensics | Window between theft and detection |
| **DDoS** | OCI DDoS protection (free tier) + Nginx rate limit + Nginx connection limit | Sustained volumetric attack may overwhelm free-tier VM |
| **Provider credential abuse** | OLP is the only consumer; anomalous spend visible on provider dashboard | Provider-side detection lag |
| **Supply chain (OLP code tampered)** | Git clone from known repo; `npm test` before deploy; no npm dependencies | Compromised maintainer GitHub account |
| **Log exfiltration** | audit.ndjson contains no message content (PII guard per ADR 0008); only metadata | Key IDs in logs (low sensitivity) |

---

## 5. Operational Runbooks

### Runbook: OAuth Token Expired

```
Symptom: /health shows provider auth.ok=false; fallback firing on every request
Diagnosis: sudo -u olp claude auth status → "not authenticated" or expired

Fix:
  1. sudo -u olp claude setup-token
  2. Complete OAuth flow (browser URL → paste code)
  3. Verify: sudo -u olp claude auth status → authenticated
  4. No OLP restart needed — next spawn picks up new credentials
```

### Runbook: Revoke a Compromised Key

```
Symptom: suspicious traffic in audit.ndjson from a specific key_id
  grep "<suspected-key-id>" ~/.olp/logs/audit.ndjson | tail -20

Fix:
  1. olp-keys revoke --id=<key-id>
  2. Notify family member: "Your key was revoked. Here's a new one."
  3. olp-keys keygen --name=<new-name> --providers=<same-providers>
  4. Send new key via secure channel
```

### Runbook: VM Disk Full

```
Symptom: OLP stops writing audit logs; new requests may fail
Diagnosis: df -h /

Fix:
  1. Purge old audit logs: find ~/.olp/logs -name 'audit-202*.ndjson' -mtime +90 -delete
  2. Purge old backups: find /home/opc/backups -name 'olp-state-*' -mtime +60 -delete
  3. Purge cache if needed: rm -rf ~/.olp/cache/*
  4. Verify: df -h / shows >20% free
```

### Runbook: OLP Process Crash Loop

```
Symptom: systemctl status olp shows "activating (auto-restart)"
Diagnosis: journalctl -u olp --since "10 min ago" | tail -50

Common causes:
  - Port conflict → check `lsof -nP -iTCP:4567`
  - Corrupt config.json → validate JSON syntax
  - Node.js version drift → `node --version`

Fix:
  1. Fix root cause
  2. sudo systemctl restart olp
  3. Gate: `curl -H "Authorization: Bearer $OWNER_KEY" https://olp.example.com/health | jq .ok`
```

---

## 6. Cost Estimate (Oracle Cloud Free Tier)

| Resource | Spec | Cost |
|---|---|---|
| VM | ARM Ampere A1 (4 OCPU, 24GB RAM) | **Free** (Always Free tier) |
| Boot volume | 200GB | **Free** (up to 200GB) |
| Outbound bandwidth | 10TB/month | **Free** (first 10TB) |
| Public IP | 1 reserved | **Free** |
| Domain | olp.example.com | ~$10/year (external registrar) |
| TLS cert | Let's Encrypt | **Free** |
| **Total** | | **~$10/year** (domain only) |

Oracle Cloud's Always Free ARM VM is overprovisioned for this use case. OLP + Nginx + 3 provider CLIs will use <1GB RAM and negligible CPU (the LLM inference happens at the provider, not here).

---

## 7. Migration Path to Commercial

This family deployment is a stepping stone. When commercial service is ready:

| Aspect | Family (this plan) | Commercial (future) |
|---|---|---|
| Upstream | spawn CLI (subscription) | direct API (commercial key) |
| Auth | OLP multi-key (filesystem) | Registration + billing system |
| TLS | Let's Encrypt (single domain) | Managed cert (Cloudflare / AWS ACM) |
| Compute | Single VM (Oracle Free) | Container cluster (auto-scale) |
| Monitoring | Cron + manual | Prometheus + Grafana + PagerDuty |
| Rate limit | Nginx per-IP | Per-key token bucket in OLP |
| Data | ~/.olp/ filesystem | PostgreSQL + S3 |

The deployment experience from this plan directly informs the commercial architecture. Every operational runbook becomes a feature requirement for the commercial platform.

---

**Authors:** project maintainer (with AI drafting assistance)  
**Created:** 2026-05-27
