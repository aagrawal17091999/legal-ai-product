# Deployment & Production Runbook

Everything runs on the **Hetzner CAX21 box** — the Next.js app (via pm2) and
Postgres (with pgvector) are co-located. One repo, one logical "project", two
isolated environments.

## Environments

| | Production | Staging |
|---|---|---|
| Checkout dir | `/opt/legal-ai-product` | `/opt/legal-ai-product-staging` |
| pm2 process | `nyayasearch` | `nyayasearch-staging` |
| Database | `legalai_prod` | `legalai_dev` |
| Env file | `.env.production.local` | `.env.staging.local` |
| nginx host | `getlegalbrain.com` (+ `www`) | `staging.getlegalbrain.com` |

Both databases live in the **same Postgres cluster**. Application data (users,
chats, payments, workspaces, audit/trace) is **isolated per environment** — never
share it. The case-law reference data is the *same content* in both, seeded from
one artifact (below).

## Two classes of data

- **Reference data** — `supreme_court_cases`, `high_court_cases`, `case_chunks`,
  `case_paragraphs`. Read-only, huge (~16GB raw), expensive to rebuild (Voyage
  embeddings). Built ONCE, restored identically into every environment.
- **Application data** — everything else. User-generated, per-environment, backed
  up nightly.

### Seeding reference data (same judgments in prod & staging)

```bash
# Build the artifact once from prod and push to R2:
ENV_FILE=.env.production.local bash scripts/dump-reference-data.sh --upload

# Seed staging (or a fresh dev DB) with the exact same data — no re-embedding:
ENV_FILE=.env.staging.local bash scripts/restore-reference-data.sh --from-r2
```

When you add a court or a new reference table, update `REFERENCE_TABLES` in
`scripts/dump-reference-data.sh` and the `--clean` list in
`scripts/restore-reference-data.sh`.

## Deploying

```bash
bash scripts/deploy.sh                # production (fetch → build → migrate → reload → tag)
bash scripts/deploy.sh staging        # staging
REF=prod-20260629-101500 bash scripts/deploy.sh   # roll back to a tagged release
```

Deploy order guarantees: migrations run **before** the pm2 reload and gate it —
a failed migration leaves the old process serving. Reload (not restart) keeps
in-flight SSE chat streams alive. Production deploys are auto-tagged `prod-<ts>`.

**Migration safety:** code rollback does not roll back the schema. Keep migrations
additive/backward-compatible (add column → backfill → switch reads → drop later)
so rolling back code never meets a schema it can't handle. Note the duplicate
`019_*` migration numbers — harmless (the ledger keys on filename) but renumber
the next collision.

## Cron (systemd, NOT Vercel)

`vercel.json` crons are **inert** on Hetzner. The real scheduler is a systemd
timer calling the endpoint locally with `CRON_SECRET`:

```bash
sudo cp deploy/systemd/nyayasearch-rag-retention.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nyayasearch-rag-retention.timer
systemctl list-timers | grep nyayasearch     # confirm next run
```

## Health checks

`GET /api/health` — unauthenticated, checks DB connectivity, 200 up / 503 down.
Point an external monitor (UptimeRobot/BetterStack) at `https://getlegalbrain.com/api/health`.

## Scalability for ~1000 users — verdict

Measured on the live DB (June 2026): **14GB** total, `case_chunks` = **781,674 rows /
12GB**, and its HNSW index `idx_chunks_embedding` = **6.1GB**. Postgres 16.14 on
aarch64 (Hetzner CAX), running on **stock defaults** (`shared_buffers=128MB`).

1000 *registered* users is not 1000 concurrent — realistic peak is tens of
concurrent sessions and a handful of simultaneous RAG searches + LLM streams. The
app tier (Node event loop, now clustered) handles that easily. **The bottleneck is
the 6.1GB vector index vs. box RAM.** HNSW is fast only while the index stays in
memory/page-cache; on an 8GB box shared with the app it can't reliably stay warm
under concurrency, so vector-search tail latency spikes.

**Actions (in impact order):**
1. **Upsize the box to 16GB (CAX31, 8 vCPU) before launch.** Highest-leverage
   single change — lets `shared_buffers=4GB` + OS page-cache hold the 6GB index
   hot while leaving room for pm2 instances. 8GB is the current risk.
2. **Apply `deploy/postgres/tuning.conf`** — stock 128MB `shared_buffers` is the
   biggest quick win regardless of box size.
3. **Run in pm2 cluster mode** (`ecosystem.config.js`) — uses >1 core and makes
   `pm2 reload` truly zero-downtime. Keep `instances=2` so Postgres keeps RAM.
4. **Connection math is fine at this scale**: 2 instances × `DB_POOL_MAX=10` + staging
   + cron ≈ 35 < 100. PgBouncer (`deploy/pgbouncer/`) is the scale-*out* path, not
   needed at launch.
5. **Retention now covers `error_logs`** (was unbounded — 43MB at 2 users).
6. Load-test with `scripts/eval_retrieval.mjs` + a concurrency tool against staging
   after upsizing; watch p95 search latency and `pg_stat_activity` connection count.

Beyond ~a few thousand concurrent users, split Postgres onto its own box (app box
+ dedicated DB box) — the co-located design is the ceiling, not this row count.

## Implemented in code (this batch)

| Concern | Artifact |
|---|---|
| Zero-downtime + multicore | `ecosystem.config.js` (pm2 cluster) |
| Connection resilience | `src/lib/db.ts` (pool caps, timeouts, idle-error handler) |
| DB performance | `deploy/postgres/tuning.conf` |
| Nightly backups | `scripts/backup-app-data.sh` + `nyayasearch-backup.{service,timer}` |
| Cron (Vercel cron is inert here) | `scripts/cron-tick.sh` + `nyayasearch-rag-retention.{service,timer}` |
| Log growth | `error_logs` retention added to the retention route |
| Reverse proxy | `deploy/nginx/nyayasearch.conf` (TLS, headers, rate limit, SSE-safe) |
| Disk watchdog | `scripts/disk-alert.sh` + `nyayasearch-disk-alert.{service,timer}` |
| Health probe | `GET /api/health` |
| Connection scale-out | `deploy/pgbouncer/pgbouncer.ini` (future) |

## Razorpay — status

Webhook code is **production-grade already**: timing-safe HMAC signature check,
DB-backed idempotency (`uq_credit_tx_payment` unique index → concurrent retries
can't double-credit), terminal-state guards on cancellation, order-notes fallback
for top-ups. No code changes needed. Remaining is **operational**:
- [ ] Swap `RAZORPAY_KEY_ID/SECRET` to **live** mode.
- [ ] Recreate plans in live mode; update `RAZORPAY_PLAN_MONTHLY/YEARLY` (live plan IDs differ).
- [ ] Register the live webhook URL → `https://getlegalbrain.com/api/payments/webhook`,
      subscribe to: `subscription.activated`, `subscription.charged`,
      `subscription.cancelled`, `subscription.completed`, `payment.captured`.
- [ ] Set `RAZORPAY_WEBHOOK_SECRET` to the live webhook's secret.

## Remaining operational checklist (needs the box / live credentials)

- [ ] Upsize to CAX31 (16GB) and apply `tuning.conf`.
- [ ] Enable WAL archiving for PITR (wal-g) — the `archive_command` lines in
      `tuning.conf` + a `walg.env`. `backup-app-data.sh` is the daily net; WAL is
      the minute-level net. **Test a restore of both.**
- [ ] Firebase: prod project / authorized domains / prod admin key.
- [ ] R2: prod bucket + lifecycle rule on `app-backups/`; clean orphaned objects
      from deleted workspaces.
- [ ] Install the nginx conf + `certbot` for TLS; set real hostnames.
- [ ] `pm2 install pm2-logrotate` (unrotated pm2 logs fill the shared disk).
- [ ] Sentry (`@sentry/nextjs`) as an external error sink alongside the DB logger —
      needs a DSN + `instrumentation.ts`; do as a follow-up.
- [ ] Set `BACKUP_ENC_PASSPHRASE` + `ALERT_WEBHOOK_URL` in `.env.production.local`.
- [ ] Encrypted off-box copy of each `.env.*.local`.
- [ ] Investigate why `error_logs` is 43MB at 2 users (likely over-logging).
- [ ] Note: `high_court_cases` is currently **empty (0 rows)** — HC data not yet loaded.
