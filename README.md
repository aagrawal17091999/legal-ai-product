# Legal Brain

AI legal research for Indian advocates: ask questions of Supreme Court and High
Court case law and get cited, verifiable answers; chat with your own case files;
and translate or OCR scanned documents into court-ready Word and PDF output.

Production: [getlegalbrain.com](https://getlegalbrain.com)

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), React 19, Tailwind 4 |
| Database | Postgres 16 + pgvector (HNSW), co-located on the app box |
| AI | Anthropic Claude (answers, structuring), Voyage (`voyage-law-2` embeddings + `rerank-2`), Sarvam (OCR reading + translation) |
| Storage | Cloudflare R2 |
| Auth | Firebase (httpOnly session cookie) |
| Payments | Razorpay (subscriptions + one-time credit top-ups) |
| Hosting | Hetzner box, pm2 cluster mode behind nginx. **Not Vercel.** |

## Local development

```bash
npm install
cp .env.production.local.example .env.local   # then fill in real values
npm run dev                                    # http://localhost:3000
```

You need at minimum `DATABASE_URL`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, and
the Firebase keys. Without `SARVAM_API_KEY` / `SARVAM_OCR_ENABLED=on`, OCR and
translation still work but read every page with Claude vision, which costs more.

Apply migrations with:

```bash
bash scripts/migrate.sh        # each migrations/*.sql runs exactly once
```

## Commands

```bash
npm run dev              # dev server
npm run build            # production build
npm test                 # unit tests (rag, sarvam, billing)
npm run lint             # eslint
npm run eval:docchat     # doc-chat quality + cost eval
npm run eval:retrieval   # retrieval eval
npm run eval:research    # case-law research cost eval
```

## Background jobs

OCR and translation do **not** run in the request. An upload splits the document
into page-range units in `job_batches`; the worker at
`/api/cron/process-batches` drains them, and assembles the document once every
unit is done. That endpoint is driven by a systemd timer on the box — if it
isn't running, uploads sit in `pending` forever. See `deploy/systemd/`.

Scheduled jobs, all via `scripts/cron-tick.sh`:

| Timer | Endpoint | Schedule |
|---|---|---|
| `nyayasearch-process-batches` | `/api/cron/process-batches` | continuous (15s after each run) |
| `nyayasearch-credit-refill` | `/api/cron/credit-refill` | daily 04:00 |
| `nyayasearch-rag-retention` | `/api/cron/rag-retention` | daily 03:00 |
| `nyayasearch-backup` | `scripts/backup-app-data.sh` | daily 02:30 |
| `nyayasearch-disk-alert` | `scripts/disk-alert.sh` | every 15 min |

## Billing

Work is metered in **credits** (1 credit ≈ ₹0.80 of measured AI cost). Free
accounts get a one-time 100; Pro gets 1,000 per month; top-up packs never
expire. `BILLING_ENFORCE=on` is what actually debits wallets — anything else is
shadow mode, where usage is recorded but nobody is charged or blocked. See
`src/lib/billing/`.

## Deploying

Pushing to GitHub is **not** a deploy — the box does not auto-pull. See
[docs/deploying-changes.md](docs/deploying-changes.md). Verify any deploy with
`bash scripts/verify-prod.sh` on the box.

## Docs

- [docs/deploying-changes.md](docs/deploying-changes.md) — how to ship a change
- [docs/deployment.md](docs/deployment.md) — box architecture and setup
- [docs/LAUNCH_PLAN.md](docs/LAUNCH_PLAN.md) — pre-launch checklist and status
- [docs/FEATURE_BUILD_NOTES.md](docs/FEATURE_BUILD_NOTES.md) — design decisions for workspaces + translation
