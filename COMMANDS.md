# COMMANDS — everything you actually run

One-page reference for this project. Production is a **Hetzner box**
(`root@204.168.160.193`, `getlegalbrain.com`) running Next.js under pm2 cluster mode
+ co-located Postgres/pgvector behind nginx. **Not Vercel** — `vercel.json` crons are
inert here; systemd timers are the real scheduler.

Deeper background: [docs/deploying-changes.md](docs/deploying-changes.md) ·
[docs/deployment.md](docs/deployment.md) · [docs/GO_LIVE.md](docs/GO_LIVE.md) ·
[pipeline/PIPELINE.md](pipeline/PIPELINE.md)

---

## 0. Cheat sheet

| I want to… | Command |
|---|---|
| Run locally | `npm run dev` |
| Run tests | `npm test` |
| Apply migrations locally | `bash scripts/migrate.sh` |
| SSH to prod | `ssh root@204.168.160.193` |
| Deploy prod | on the box: `cd /opt/legal-ai-product && bash scripts/deploy.sh` |
| Deploy staging | `bash scripts/deploy.sh staging` |
| Roll back | `REF=prod-<ts> bash scripts/deploy.sh` |
| Verify prod | `bash scripts/verify-prod.sh` |
| Tail prod logs | `pm2 logs nyayasearch` |
| Search prod logs by account/time | Grafana Cloud → Explore → Loki (§10b)  |
| Change a secret | edit `.env.production.local` → reload (rebuild if `NEXT_PUBLIC_*`) |

---

## 1. Local development

```bash
npm install                                    # JS deps
pip install -r pipeline/requirements.txt       # Python pipeline deps (only if touching pipeline/)

cp .env.production.local.example .env.local    # then fill in real values
bash scripts/migrate.sh                        # applies migrations/*.sql to your local DB

npm run dev                                    # http://localhost:3000
```

Minimum env to boot: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, the Firebase
keys. Without `SARVAM_API_KEY` / `SARVAM_OCR_ENABLED=on`, OCR + translation still work but
read every page with Claude vision (more expensive).

```bash
npm run build     # production build (also the way to catch type/build errors)
npm start         # serve the built app on :3000
npm run lint      # eslint
npm test          # unit tests: rag, sarvam, billing, analytics
```

### Evals & diagnostics

```bash
npm run eval:retrieval      # retrieval quality against eval/golden_set.json
npm run eval:docchat        # doc-chat quality + cost  -> eval/results/*.jsonl
npm run eval:research       # case-law research cost
npm run measure:overlap     # chunk overlap measurement

npx tsx scripts/smoke_agent.mts        # live RAG agent smoke test (real API calls)
npx tsx scripts/e2e_support_spans.mts  # end-to-end citation support-span check
node scripts/test-filters.mjs          # find search filters that return 0 rows
```

---

## 2. Database

```bash
bash scripts/migrate.sh                          # local (.env.local)
ENV_FILE=.env.production.local bash scripts/migrate.sh   # prod DB — deploy.sh does this for you
psql "$DATABASE_URL" -f migrations/005_extraction_fields.sql   # one specific file
```

`migrate.sh` keeps a `schema_migrations` ledger, so every file runs **at most once**.
New migrations must be **additive/backward-compatible** — code rolls back, schema doesn't.
Files in `migrations/pending/` are deliberately parked and never auto-applied.

Connect to prod DB from the box:

```bash
DB=$(grep -E '^DATABASE_URL=' /opt/legal-ai-product/.env.production.local | tail -1 | cut -d= -f2-)
psql "$DB"
```

Make yourself staff + unlimited (needed for `/admin/errors`):

```bash
psql "$DB" -c "UPDATE users SET is_staff = TRUE, unlimited_credits = TRUE WHERE email = 'ansh@getlegalbrain.com';"
```

---

## 3. SSH into the box

```bash
ssh root@204.168.160.193
```

| | Production | Staging |
|---|---|---|
| Checkout | `/opt/legal-ai-product` | `/opt/legal-ai-product-staging` |
| pm2 process | `nyayasearch` (port 3000) | `nyayasearch-staging` (port 3001) |
| Database | `legalai_prod` | `legalai_dev` |
| Env file | `.env.production.local` | `.env.staging.local` |
| Host | `getlegalbrain.com` | `staging.getlegalbrain.com` |

---

## 4. Deploying

**Pushing to GitHub is not a deploy** — the box does not auto-pull.

```bash
# 1. laptop
git push origin main

# 2. box
ssh root@204.168.160.193
cd /opt/legal-ai-product
bash scripts/deploy.sh          # production
bash scripts/deploy.sh staging  # staging

# 3. verify
bash scripts/verify-prod.sh
curl -I https://getlegalbrain.com/api/health     # expect 200
```

`deploy.sh` runs, stopping on any failure:
`git fetch → checkout $REF (default origin/main) → npm ci → npm run build →
scripts/migrate.sh → pm2 reload → tag prod-<ts>`.
Migrations gate the reload — a failed migration leaves the old process serving.
`reload` (not `restart`) is zero-downtime, so in-flight SSE chat streams survive.

### Rollback

```bash
git tag | grep prod- | tail -5
REF=prod-20260811-120912 bash scripts/deploy.sh
```

Code rolls back; **migrations do not**.

### Changing env vars / secrets

Secrets live only in `/opt/legal-ai-product/.env.production.local` (`chmod 600`, never in git).

```bash
nano .env.production.local                      # KEY=value — never "KEY - value"

# server-only var (DB URL, API keys, webhook secret, plan ids):
pm2 reload nyayasearch --update-env

# NEXT_PUBLIC_* var (baked into the browser bundle at build time):
NODE_ENV=production npm run build && pm2 reload nyayasearch --update-env
```

When unsure, rebuild — it's always safe. Never `source` an env file into your shell:
exported vars become `process.env` and silently override every `.env` file.

---

## 5. Process management (pm2)

```bash
pm2 status
pm2 logs nyayasearch                 # tail
pm2 logs nyayasearch --lines 200
pm2 reload nyayasearch --update-env  # zero-downtime
pm2 restart nyayasearch              # kills in-flight streams — prefer reload
pm2 monit

# first-time start of each environment (then deploy.sh just reloads them)
pm2 start ecosystem.config.js --only nyayasearch         --env production
pm2 start ecosystem.config.js --only nyayasearch-staging --env staging
pm2 save && pm2 startup              # survive reboots
pm2 install pm2-logrotate            # keep logs from filling the shared disk
```

Keep `instances=2` — the 6GB pgvector HNSW index needs the page cache; don't use `-i max`.

---

## 6. Scheduled jobs (systemd, not Vercel cron)

| Timer | What it runs | Schedule |
|---|---|---|
| `nyayasearch-process-batches` | `/api/cron/process-batches` (OCR/translate worker) | continuous, 15s after each run |
| `nyayasearch-credit-refill` | `/api/cron/credit-refill` (yearly refills + comped-plan refill/expiry) | daily 04:00 |
| `nyayasearch-rag-retention` | `/api/cron/rag-retention` | daily 03:00 |
| `nyayasearch-backup` | `scripts/backup-app-data.sh --upload` | daily 02:30 |
| `nyayasearch-disk-alert` | `scripts/disk-alert.sh` | every 15 min |
| `nyayasearch-error-alert` | `scripts/alert-errors.sh` | every 5 min |
| `nyayasearch-search-canary` | `scripts/search-canary.sh` | every 10 min |
| `nyayasearch-log-archive` | `scripts/archive-logs.sh --upload --prune` | daily 03:30 |

If `process-batches` isn't running, uploads sit in `pending` forever.

```bash
# install / reinstall a unit
sudo cp deploy/systemd/nyayasearch-<name>.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nyayasearch-<name>.timer

systemctl list-timers | grep nyayasearch
journalctl -u nyayasearch-process-batches.service -n 50 --no-pager
systemctl start nyayasearch-search-canary.service     # run one now, out of band
```

The shipped units carry a `deploy` user placeholder that `bootstrap-box.sh` rewrites.
Installing by hand, set `User=root` and `WorkingDirectory=/opt/legal-ai-product` yourself —
there is no `deploy` user on this box.

Fire a cron endpoint manually:

```bash
ENV_FILE=.env.production.local bash scripts/cron-tick.sh /api/cron/process-batches
```

---

## 7. Monitoring & alerts

```bash
curl -I https://getlegalbrain.com/api/health   # 200 up / 503 down (unauthenticated)
bash scripts/verify-prod.sh                    # 40+ checks; never prints secret values
bash scripts/send-alert.sh --test              # prove the alert channel works
bash scripts/alert-errors.sh                   # critical-error watchdog, one-off
bash scripts/search-canary.sh                  # probe Voyage embed → pgvector → rerank
bash scripts/disk-alert.sh                     # disk watchdog, one-off
```

Watchdog knobs (in `.env.production.local`): `ERROR_ALERT_WINDOW_MIN` (15),
`ERROR_ALERT_THRESHOLD` (3), `ERROR_ALERT_COOLDOWN_MIN` (60), `CANARY_MIN_ROWS` (5),
`CANARY_ATTEMPTS` (3), `DISK_ALERT_PCT` (80). Delivery: `ALERT_EMAIL_TO` + `SMTP_*`,
falling back to `ALERT_WEBHOOK_URL`, then stderr.

---

## 8. Backup & restore

Two classes of data: **application data** (users, chats, payments, workspaces — irreplaceable,
backed up nightly) and **reference data** (case law + embeddings — ~12GB, expensive to rebuild,
dumped once and restored identically everywhere).

```bash
# nightly app-data backup (excludes reference tables)
ENV_FILE=.env.production.local bash scripts/backup-app-data.sh            # local dump
ENV_FILE=.env.production.local bash scripts/backup-app-data.sh --upload   # encrypt + push to R2

# build the reference artifact once from prod
ENV_FILE=.env.production.local bash scripts/dump-reference-data.sh --upload

# seed staging / a fresh dev DB with the same judgments — no re-embedding
ENV_FILE=.env.staging.local bash scripts/restore-reference-data.sh --from-r2
ENV_FILE=.env.staging.local bash scripts/restore-reference-data.sh reference-data-<ts>.dump
ENV_FILE=.env.staging.local YES=1 bash scripts/restore-reference-data.sh --from-r2   # no prompt
```

Encryption needs `BACKUP_ENC_PASSPHRASE`. Adding a reference table means updating
`REFERENCE_TABLES` in `dump-reference-data.sh` **and** the `--clean` list in
`restore-reference-data.sh`.

---

## 9. Box setup (one-time)

```bash
ssh root@204.168.160.193
cd /opt/legal-ai-product && git pull origin main
cp .env.production.local.example .env.production.local
nano .env.production.local && chmod 600 .env.production.local
sudo bash scripts/bootstrap-box.sh       # nginx + certbot + PG tuning + pm2 + timers
# then run the certbot line it prints
```

nginx by hand:

```bash
sudo cp deploy/nginx/nyayasearch.conf /etc/nginx/sites-available/nyayasearch
sudo ln -sf /etc/nginx/sites-available/nyayasearch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Postgres tuning: `deploy/postgres/tuning.conf` → the cluster's `conf.d`
(stock `shared_buffers=128MB` is the biggest quick win). PgBouncer
(`deploy/pgbouncer/pgbouncer.ini`) is the scale-out path, not needed yet.

---

## 10. Corpus pipeline (Python)

Full detail — court codes, tuning knobs, RAG internals — in
[pipeline/PIPELINE.md](pipeline/PIPELINE.md). Its **Deployment** and **Nginx** sections are
out of date; this file supersedes them.

```bash
# download
python pipeline/download_sc.py --year 2024            # or --all
python pipeline/download_hc.py --year 2024 --court 32_4   # or --all-courts

# process + load (extract text, upload PDFs to R2, insert rows, chunk + embed)
python pipeline/process_and_load.py --source sc --year 2024
python pipeline/process_and_load.py --source hc --year 2024 --court 32_4

# structured field extraction (regex tier 1 → Claude Haiku tier 2)
python pipeline/extract_fields.py --source sc --limit 10       # test batch
python pipeline/extract_fields.py --source sc --all
python pipeline/extract_fields.py --source sc --reprocess --limit 100
python pipeline/verify_extraction.py --source sc               # coverage report

# embeddings (voyage-law-2, 1024d) — run AFTER extraction, resumable
python pipeline/reembed_all.py                       # SC + HC, all years
python pipeline/reembed_all.py --source sc --batch-size 64

# everything, end to end
python pipeline/run_all.py --source all --start-year 2020 --end-year 2024
python pipeline/run_all.py --source sc --skip-download --skip-extract
```

Weekly corpus refresh cron: `bash pipeline/cron_setup.sh`
(Sundays 02:00 → `/var/log/nyayasearch-pipeline.log`).

---

## 10b. Logs — where to actually look

Three places, for three different questions.

| Question | Where |
|---|---|
| What is happening right now? | `pm2 logs nyayasearch` on the box |
| What happened to *this account*, last week? | Grafana Cloud → Explore → Loki |
| What happened three months ago? | R2, `logs/<host>/YYYY/MM/DD/` |
| Which errors are unresolved? | `/admin/errors` (staff only) |

### Grafana Cloud (Loki)

The app writes **structured JSON** to stdout (`src/lib/logger.ts`); Grafana
Alloy tails pm2 + nginx + journald and ships it. Every `logError` call also
emits a line here — deliberately *before* the DB insert, so an error survives
the Postgres outage that would otherwise swallow it.

```bash
sudo bash scripts/install-alloy.sh     # install/reconfigure; idempotent
systemctl status alloy
journalctl -u alloy -n 50 --no-pager   # Alloy's own complaints
alloy validate /etc/alloy/config.alloy # after editing deploy/alloy/config.alloy
```

Queries — `userId` and `requestId` are **structured metadata**, not labels
(one label value per user would shard Loki into uselessness):

```logql
{job="nyayasearch"}                                  # everything from the app
{job="nyayasearch"} | userId=`937`                   # one account
{job="nyayasearch", level="error", category="payment"}
{job="nyayasearch"} | requestId=`3f2a…`              # one request, end to end
{job="nginx"} |= " 502 "                             # what never reached the app
{job="systemd", unit=~"nyayasearch-.*"}              # the timers
```

Pick the time window in Explore. Free tier: 50GB/month, **14-day retention** —
which is what the R2 archive below is for.

### R2 archive (long retention)

```bash
pm2 install pm2-logrotate                     # REQUIRED — without it nothing rotates
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:retain 14

ENV_FILE=.env.production.local bash scripts/archive-logs.sh            # dry run
ENV_FILE=.env.production.local bash scripts/archive-logs.sh --upload --prune
```

Only ever touches **rotated** files, never the one being written to, and only
deletes a local copy after re-reading the uploaded object back with `head-object`.
Gzipped JSON compresses ~10x, so this is expected to sit inside R2's free 10GB
for a long time. Set a lifecycle rule on `logs/` if it ever stops being free.

### Rules

Never log user content — no judgment text, no chat messages, no documents.
Logs leave the box. Ids, counts, durations and enums only; `logger.ts` redacts
credential-shaped keys as a backstop, not a licence.

---

## 10c. Chat latency — the knobs that matter

A research turn is dominated by **output-token generation**, not by the box
(prod sits at ~0.01 load while a turn runs; a bigger server buys nothing here).
Measured 2026-08-21 on a 226s turn: 149s of it was writing the answer *twice*,
because the grounding patch silently fell back to a full rewrite on every turn.

Per-phase numbers come from `rag_pipeline_steps` — `turn_total` carries the
end-to-end time and a `phase_ms` rollup:

```sql
SELECT s.duration_ms, s.data->'phase_ms'
FROM   rag_pipeline_steps s
JOIN   chat_messages m ON m.id = s.message_id
WHERE  s.step = 'turn_total'
ORDER  BY s.duration_ms DESC LIMIT 10;
```

| Env var | Default | What it does |
|---|---|---|
| `CHAT_MODEL` | `claude-sonnet-5` | Chat model. **Shared with doc chat.** Must have a row in `RATES` (`src/lib/billing/cost.ts`) or turns meter as **free**. |
| `PROGRESSIVE_GROUNDING` | `on` | Verify + release the answer a paragraph at a time. `off` restores generate-all → grade-all → reveal. |
| `AGENT_EFFORT` | unset (thinking off) | `low`\|`medium`\|`high`\|`max` enables adaptive thinking. Costs critical-path latency — change it with the evals. |
| `GROUNDING_PARAGRAPH_CONCURRENCY` | `3` | Paragraphs verified at once. |

**Thinking gotcha:** on Sonnet 4.6 omitting `thinking` meant *no* thinking; on
Sonnet 5 omitting it runs **adaptive**. Both the research agent and doc chat now
pass `thinking: {type:"disabled"}` explicitly, so a model swap is a speed change
and not a silent behaviour change. Don't remove those.

---

## 11. Git

```bash
git tag | grep prod- | tail -5      # release history
git log --oneline -20
```

Golden rules: secrets never enter git; if one leaks, rotate it. `NEXT_PUBLIC_*` changes
need a rebuild, not a reload. Always verify a deploy with `verify-prod.sh` — don't assume
the reload happened.
