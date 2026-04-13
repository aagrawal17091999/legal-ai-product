# Pipeline & Operations Guide

All commands across the project — what they do, when to run them, and why.

---

## Table of Contents

- [Initial Setup](#initial-setup)
- [Next.js App](#nextjs-app)
- [Database Migrations](#database-migrations)
- [Data Download](#data-download)
- [Data Processing & Loading](#data-processing--loading)
- [Extraction Pipeline](#extraction-pipeline)
- [Embedding Generation](#embedding-generation)
- [RAG Chat Pipeline](#rag-chat-pipeline)
- [Cron / Automation](#cron--automation)
- [Deployment](#deployment)
- [Nginx](#nginx)
- [Environment Variables](#environment-variables)
- [End-to-End Workflows](#end-to-end-workflows)

---

## Initial Setup

### Install Node.js dependencies

```bash
npm install
```

**When:** After cloning the repo, or after pulling changes that modify `package.json`.
**Why:** Installs Next.js, React, Anthropic SDK, Firebase, Razorpay, pg, pgvector, and all other JS dependencies.

### Install Python pipeline dependencies

```bash
pip install -r pipeline/requirements.txt
```

**When:** Before running any Python pipeline script for the first time, or after pulling changes that update `requirements.txt`.
**Why:** Installs pandas, pyarrow, psycopg2, pymupdf, boto3, voyageai, pgvector, anthropic, python-dotenv, tqdm, numpy, sqlalchemy.

### Configure environment

```bash
cp .env.local.example .env.local
# Edit .env.local with actual values
```

**When:** Once, after cloning. Update whenever credentials change.
**Why:** All scripts (both Node.js and Python) read secrets from `.env.local`. Python scripts load it via `python-dotenv`; Next.js loads it natively.

---

## Next.js App

### Start development server

```bash
npm run dev
```

**When:** During local development.
**Why:** Starts Next.js at http://localhost:3000 with hot reload. Reads env from `.env.local`.

### Build for production

```bash
npm run build
```

**When:** Before deploying, or to verify the app compiles without errors.
**Why:** Creates an optimized production build in `.next/`.

### Start production server

```bash
npm run start
```

**When:** After `npm run build`, to run the production build locally or on a server.
**Why:** Serves the compiled app on port 3000 (no hot reload, optimized for performance).

### Lint code

```bash
npm run lint
```

**When:** Before committing, or in CI.
**Why:** Runs ESLint to catch code quality issues.

---

## Database Migrations

All migration files live in `migrations/` and are numbered sequentially.

### Run all migrations

```bash
bash scripts/migrate.sh
```

**When:** On initial setup, or after adding new migration files. Safe to re-run — all statements use `IF NOT EXISTS` / `IF NOT EXISTS`.
**Why:** Applies every `migrations/*.sql` file in order against the PostgreSQL database. Loads `DATABASE_URL` from `.env.local` automatically.

### Run a single migration

```bash
psql "$DATABASE_URL" -f migrations/005_extraction_fields.sql
```

**When:** When you only need to apply one specific migration (e.g., after pulling a new migration file).
**Why:** Faster than running all migrations when only one is new.

### Migration inventory

| File | What it creates |
|------|----------------|
| `001_case_law_tables.sql` | `supreme_court_cases` and `high_court_cases` tables, enables pgvector |
| `002_user_tables.sql` | `users` table (Firebase sync, Razorpay subscriptions, query limits) |
| `003_chat_tables.sql` | `chat_sessions`, `chat_messages`, `case_chunks` (vector embeddings) |
| `004_indexes.sql` | FTS indexes on case text, HNSW vector index on chunks, B-tree indexes on filters |
| `005_extraction_fields.sql` | 17 extraction columns + GIN indexes on both case tables |
| `006_extraction_timestamps.sql` | Extraction timestamp column |
| `007_chat_message_tracing.sql` | `chat_messages` tracing columns (model, token_usage, context_sent, response_time_ms) |
| `008_error_logs.sql` | `error_logs` table |
| `009_embeddings_v2.sql` | **DESTRUCTIVE** — truncates `case_chunks`, enforces `vector(1024)`, adds chunk-level FTS GIN index, rebuilds HNSW, creates `reembed_progress` tracking table. Required before switching to the `voyage-law-2` RAG pipeline. |
| `010_chat_rag_trace.sql` | Adds `chat_messages.rag_trace JSONB` for per-message RAG pipeline tracing (rewritten queries, reranked chunk ids, per-stage timings) |
| `011_rag_audit_tables.sql` | Adds `rag_pipeline_steps` (one row per pipeline stage per message) and `rag_query_embeddings` (query-side `vector(1024)` for each rewritten/HyDE query). Used for per-stage drill-down debugging. |

---

## Data Download

Downloads raw judgment data (metadata parquets + PDF tars) from public S3 buckets. No AWS credentials needed.

**Prerequisite:** AWS CLI installed (`aws` command available).

### Download Supreme Court data

```bash
# Single year
python pipeline/download_sc.py --year 2024

# All years (1950 to current)
python pipeline/download_sc.py --all
```

**When:** When loading a new year's data, or building the initial corpus.
**Why:** Downloads metadata parquet + PDF tar for each year from `s3://indian-supreme-court-judgments`. Stores in `data/supreme-court/year={year}/`. Skips already-downloaded files.

### Download High Court data

```bash
# Single court + year
python pipeline/download_hc.py --year 2024 --court 32_4

# All 24 courts for a year
python pipeline/download_hc.py --year 2024 --all-courts
```

**When:** After SC data is set up, or when expanding to High Court coverage.
**Why:** Downloads from `s3://indian-high-court-judgments`. Stores in `data/high-courts/court={code}/year={year}/`.

**Court codes:**

| Code | Court | Code | Court |
|------|-------|------|-------|
| `32_1` | Allahabad | `32_13` | Kerala |
| `32_2` | Andhra Pradesh | `32_14` | Madhya Pradesh |
| `32_3` | Chhattisgarh | `32_15` | Manipur |
| `32_4` | Delhi | `32_16` | Meghalaya |
| `32_5` | Bombay | `32_17` | Orissa |
| `32_6` | Calcutta | `32_18` | Patna |
| `32_7` | Madras | `32_19` | Punjab & Haryana |
| `32_8` | Gujarat | `32_20` | Rajasthan |
| `32_9` | Himachal Pradesh | `32_21` | Sikkim |
| `32_10` | Jammu & Kashmir | `32_22` | Telangana |
| `32_11` | Jharkhand | `32_23` | Tripura |
| `32_12` | Karnataka | `32_24` | Uttarakhand |

---

## Data Processing & Loading

Reads downloaded parquets + PDFs, extracts text, uploads PDFs to R2, inserts into PostgreSQL, and creates vector embeddings.

**Env vars required:** `DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET_NAME`, `VOYAGE_API_KEY`

### Process Supreme Court

```bash
python pipeline/process_and_load.py --source sc --year 2024
```

**When:** After downloading SC data for that year.
**Why:** For each case in the parquet: extracts text from PDF via PyMuPDF, uploads PDF to Cloudflare R2, inserts row into `supreme_court_cases`, chunks text and generates Voyage AI embeddings into `case_chunks`. Skips duplicates (checks by `cnr`/`path`). Commits per row.

### Process High Court

```bash
python pipeline/process_and_load.py --source hc --year 2024 --court 32_4
```

**When:** After downloading HC data for that court/year.
**Why:** Same flow as SC but for `high_court_cases` table. `--court` is required for HC.

**Output:** Prints summary — `{inserted} inserted, {skipped} skipped, {failed} failed, {chunks_created} chunks`.

---

## Extraction Pipeline

Extracts structured metadata (citation, parties, judges, keywords, cited cases/acts, etc.) from `judgment_text` already in the database.

**Tier 1 (regex):** Pattern matching for SCR-formatted Supreme Court judgments — free, fast.
**Tier 2 (LLM):** Claude Haiku fallback for non-standard formats — ~₹0.25/doc.
Threshold: Tier 1 succeeds if 8+ of 15 fields are extracted.

**Env vars required:** `DATABASE_URL`, `ANTHROPIC_API_KEY` (for Tier 2)

### Setup (one-time)

```bash
psql "$DATABASE_URL" -f migrations/005_extraction_fields.sql
```

**When:** Once, before running extraction. Safe to re-run.
**Why:** Adds 17 columns (`extracted_citation`, `judge_names`, `keywords`, etc.) and GIN indexes.

### Extract a small test batch

```bash
python pipeline/extract_fields.py --source sc --limit 10
```

**When:** First time running, or after changing regex patterns.
**Why:** Processes 10 pending cases to sanity-check output before a full run.

### Extract a single case by ID

```bash
python pipeline/extract_fields.py --source sc --id 42
```

**When:** Debugging a specific case or spot-checking quality.
**Why:** Processes only that one row.

### Extract all pending cases

```bash
python pipeline/extract_fields.py --source sc --all
python pipeline/extract_fields.py --source hc --all
```

**When:** After the test batch looks good. Run SC first, then HC.
**Why:** Processes every case where `extraction_status = 'pending'`. Crash-safe — each row committed individually.

### Re-extract previously completed cases

```bash
python pipeline/extract_fields.py --source sc --reprocess --limit 100
```

**When:** After improving regex patterns or the LLM prompt.
**Why:** Ignores `extraction_status` and re-runs on all cases with judgment text.

### Run LLM-only extraction (skip regex)

```bash
python pipeline/extract_fields.py --source sc --tier2-only --limit 50
```

**When:** For non-SCR judgments where regex consistently fails, or to compare LLM vs regex quality.
**Why:** Skips Tier 1 regex entirely and sends every case to Claude Haiku.

### Verify extraction quality

```bash
python pipeline/verify_extraction.py --source sc
python pipeline/verify_extraction.py --source hc
```

**When:** After any extraction run.
**Why:** Prints per-field coverage table, status/method distribution, 5 random samples for spot-checking, and failed cases with text previews.

---

## Embedding Generation

Generates vector embeddings for cases and stores them in `case_chunks`. The chat RAG pipeline ([src/lib/rag/pipeline.ts](../src/lib/rag/pipeline.ts)) depends on these being up to date.

**Current model:** `voyage-law-2` — Voyage AI's legal-domain specialized model, 1024 dimensions. Must match the `vector(1024)` column on `case_chunks` (enforced by `migrations/009_embeddings_v2.sql`).

**Env vars required:** `DATABASE_URL`, `VOYAGE_API_KEY`

**Chunking strategy:** Each chunk is prefixed with a structured metadata header built from the case's **extraction columns** (title, citation, court, judges, parties, acts_cited, keywords, headnotes, issue_for_consideration, etc.) so the embedding vector captures semantic signal from both the judgment prose and the structured metadata. A user searching "Section 304A cases" gets high cosine similarity even if the chunk body only says "rash and negligent act", because the header includes the act name. See [pipeline/chunk_utils.py](chunk_utils.py) for the full header builder and column list.

**Important:** Run `extract_fields.py` **before** embedding. If extraction columns are NULL, the header is empty and retrieval quality is significantly worse.

**Config** (from `pipeline/config.py`):
- Chunk size: 2000 characters (~500 tokens) — this is the judgment text body per chunk; the metadata header adds ~300-800 chars on top
- Chunk overlap: 200 characters
- Voyage batch size: 128 embeddings per API call
- Rate limit: 0.5s delay between batches (incremental scripts); 0.1s per case (full re-embed)

### Full re-embed (voyage-law-2 migration)

```bash
# 1. Apply the destructive schema change
psql "$DATABASE_URL" -f migrations/009_embeddings_v2.sql

# 2. Run the resumable re-embed
python pipeline/reembed_all.py                      # SC + HC, all years
python pipeline/reembed_all.py --source sc          # SC only
python pipeline/reembed_all.py --source hc --court "Delhi High Court"
python pipeline/reembed_all.py --batch-size 64      # smaller Voyage batches
```

**When:** Once, after pulling the RAG upgrade. Chat + vector search are **broken** from the moment `009_embeddings_v2.sql` runs until this script finishes — `TRUNCATE case_chunks` is part of that migration.
**Why:** The previous embeddings were produced by `voyage-3-lite` at an inconsistent dimension (runtime queries used 512d, column was `vector(1024)`). `voyage-law-2` is specialized on legal text and produces 1024d vectors that match the column.
**Resumability:** The script writes to `reembed_progress (source_table, source_id)` after every case. `Ctrl-C` is safe — re-running skips already-completed cases. On Voyage API errors it retries with exponential backoff (3 attempts) before giving up on that case.

Sanity check after completion:
```sql
SELECT COUNT(*) FROM case_chunks WHERE embedding IS NULL;  -- should be 0
SELECT COUNT(*) FROM reembed_progress;                     -- should equal your case count
```

### Incremental embed (new cases only)

```bash
# Supreme Court
python pipeline/embed_existing.py --source sc

# High Court (optionally filter by court name)
python pipeline/embed_existing.py --source hc --court Delhi

# Custom batch size
python pipeline/embed_existing.py --source sc --batch-size 100
```

**When:** After loading new cases via `process_and_load.py` if embeddings were skipped (e.g., Voyage API was down), or if cases were inserted by other means.
**Why:** Finds cases with `judgment_text` but no `case_chunks` rows, chunks, embeds via `voyage-law-2`, stores in `case_chunks`. Does NOT touch `reembed_progress` — that table is only for the full-corpus migration.

**Note:** `process_and_load.py` already runs the embed step inline for new cases, so `embed_existing.py` is only needed for recovery / backfill.

---

## RAG Chat Pipeline

The chat endpoint `/api/chat/sessions/[id]/messages` runs a multi-stage RAG pipeline ([src/lib/rag/pipeline.ts](../src/lib/rag/pipeline.ts)) and streams responses via SSE. There's nothing to *run* here — this section documents what's wired up so you know how to reason about it.

### Flow per user message

1. **Query understanding** ([src/lib/rag/queryUnderstanding.ts](../src/lib/rag/queryUnderstanding.ts)) — Claude Haiku rewrites the user's message into 1–3 standalone search queries, produces a HyDE passage, extracts implicit filters (court, year, act, judge), and classifies pure chitchat (skip retrieval). Session filters always win over implicit ones on conflict.
2. **Hybrid retrieval** ([src/lib/search.ts](../src/lib/search.ts) `retrieveChunks`) — For every rewritten query + HyDE passage: chunk-level FTS (`to_tsvector(chunk_text)`) and chunk-level vector search (`ch.embedding <=> query`). All hits are RRF-fused keyed on `chunk_id`. Top 40 chunks returned.
3. **Rerank** ([src/lib/voyage.ts](../src/lib/voyage.ts) `rerank`) — Voyage `rerank-2` cross-encoder scores `(original user message, chunk_text)`. Top 12 kept. Failure falls back to RRF order.
4. **Context assembly** ([src/lib/rag/contextBuilder.ts](../src/lib/rag/contextBuilder.ts)) — Groups chunks by case (sorted by `chunk_index`), batch-fetches extraction metadata (headnotes, `issue_for_consideration`, `acts_cited`, `extracted_citation`, bench size, result), presigns SC PDFs, enforces a 60k-char total / 12k-per-case budget, assigns 1-based `[n]` indices.
5. **Generation** ([src/lib/claude.ts](../src/lib/claude.ts) `streamChatResponse`) — Claude Sonnet 4.5 streams the answer. The system prompt requires inline `[^n]` citations and forbids referencing cases that aren't in the retrieved set.
6. **Streaming to client** ([src/app/api/chat/sessions/\[id\]/messages/route.ts](../src/app/api/chat/sessions/%5Bid%5D/messages/route.ts)) — SSE events: `meta`, `cases`, `token`, `title`, `done`, `error`.

### Tuning knobs

All in code, no env vars:

| Knob | File | Default |
|------|------|---------|
| Candidate pool size (pre-rerank) | `src/lib/rag/pipeline.ts` `CANDIDATE_POOL` | 40 |
| Top-K after rerank | `src/lib/rag/pipeline.ts` `TOP_AFTER_RERANK` | 12 |
| Per-case context budget | `src/lib/rag/contextBuilder.ts` `PER_CASE_CHAR_BUDGET` | 12000 chars |
| Total context budget | `src/lib/rag/contextBuilder.ts` `TOTAL_CONTEXT_CHAR_BUDGET` | 60000 chars |
| History turns sent to query-rewriter | `src/lib/rag/queryUnderstanding.ts` `MAX_HISTORY_TURNS` | 6 |
| History turns sent to Claude | `src/lib/claude.ts` `streamChatResponse` slice | 10 |
| RRF constant | `src/lib/search.ts` `RRF_K` | 60 |

### Per-stage audit tables

Every assistant message writes detailed per-stage data to two tables (created by `migrations/011_rag_audit_tables.sql`, written by [src/lib/rag/trace.ts](../src/lib/rag/trace.ts) after the stream closes):

**`rag_pipeline_steps`** — one row per stage per message. Six stages per message: `understand`, `embed_queries`, `retrieve`, `rerank`, `context_build`, `generate`. Columns:

| Column | Purpose |
|---|---|
| `message_id` | FK to `chat_messages.id` |
| `step_order` | 1..6, monotonic within a message |
| `step` | stage name |
| `status` | `success` / `error` / `fallback` / `skipped` |
| `duration_ms` | stage wall time |
| `error` | error message when status ≠ `success` |
| `data` | stage-specific JSONB payload (schema below) |
| `created_at` | stage start timestamp |

Stage-specific `data` shapes:

| Stage | `data` fields |
|---|---|
| `understand` | `model`, `input_tokens`, `output_tokens`, `needs_retrieval`, `rewritten_queries`, `hyde_passage_length`, `implicit_filters`, `history_turns_sent`, `user_message_length`, `raw_response_preview` |
| `embed_queries` | `model`, `query_count`, `total_tokens`, `queries`, `hyde_included` |
| `retrieve` | `effective_filters`, `candidates_per_query`, `per_query` (fts_sc/fts_hc/vec_sc/vec_hc per rewritten query), `fused_count`, `top_candidates` (chunk_id, source, rrf_score, `found_in` provenance tags like `fts_q0`/`vec_q1`) |
| `rerank` | `model`, `input_count`, `kept_count`, `total_tokens`, `query`, `scored` ([{chunk_id, rerank_score, prev_rrf_rank, new_rank}]). `status='fallback'` if Voyage errored and we fell back to RRF order. |
| `context_build` | `reranked_chunks_in`, `cases_candidate`, `cases_used`, `cases_dropped_budget`, `total_chars`, `per_case` (chunk_count, chunk_indices, chars, extraction_present, pdf_signed), `extraction_missing_for` |
| `generate` | `model`, `input_tokens`, `output_tokens`, `content_chars`, `first_token_ms`, `stop_reason`, `context_chars`, `history_turns_sent` |

**`rag_query_embeddings`** — the raw query-side embeddings (rewritten + HyDE) as `vector(1024)`. Separate from the steps table because vectors are fat and we may later want to cluster user questions via pgvector.

| Column | Purpose |
|---|---|
| `message_id` | FK to `chat_messages.id` |
| `query_index` | position in `rewritten_queries` |
| `query_type` | `rewritten` or `hyde` |
| `query_text` | the query as sent to Voyage |
| `embedding` | `vector(1024)` |

Both tables `ON DELETE CASCADE` from `chat_messages` so deleting a session wipes everything.

### Debugging a specific chat message

Every assistant message persists a full trace:

```sql
SELECT
  id,
  response_time_ms,
  model,
  token_usage,
  rag_trace->'rewritten_queries'        AS rewritten_queries,
  rag_trace->'implicit_filters'         AS implicit_filters,
  rag_trace->'effective_filters'        AS effective_filters,
  rag_trace->'timings'                  AS timings,
  jsonb_array_length(rag_trace->'candidate_chunk_ids')  AS candidates,
  jsonb_array_length(rag_trace->'reranked_chunks')      AS reranked,
  rag_trace->'case_count'               AS cases_used
FROM chat_messages
WHERE role = 'assistant'
ORDER BY created_at DESC
LIMIT 10;
```

The `search_results` column holds the reranked chunk list (compact form) and `context_sent` holds the exact prompt Claude saw.

For per-stage drill-down, join to `rag_pipeline_steps`:

```sql
-- Full trace for one message
SELECT step_order, step, status, duration_ms, error, data
  FROM rag_pipeline_steps
 WHERE message_id = '<uuid>'
 ORDER BY step_order;

-- "Which messages had the reranker fall back?"
SELECT message_id, created_at, error
  FROM rag_pipeline_steps
 WHERE step = 'rerank' AND status = 'fallback'
 ORDER BY created_at DESC LIMIT 50;

-- Average latency per stage over the last day
SELECT step, COUNT(*), AVG(duration_ms)::int AS avg_ms, MAX(duration_ms) AS p100_ms
  FROM rag_pipeline_steps
 WHERE created_at > NOW() - INTERVAL '1 day'
 GROUP BY step
 ORDER BY step;

-- Slowest generate steps (Claude latency)
SELECT message_id, duration_ms, data->>'first_token_ms' AS ttfb_ms,
       data->>'output_tokens' AS out_toks
  FROM rag_pipeline_steps
 WHERE step = 'generate'
 ORDER BY duration_ms DESC LIMIT 20;

-- Messages where a chunk was found by both FTS and vector for at least one query
SELECT message_id, jsonb_path_query_array(data->'top_candidates', '$[*].found_in')
  FROM rag_pipeline_steps
 WHERE step = 'retrieve';
```

---

## Cron / Automation

### Install weekly SC update cron job

```bash
bash pipeline/cron_setup.sh
```

**When:** On the production server, once.
**Why:** Installs a cron job that runs **every Sunday at 2:00 AM** to download the current year's SC data and load it into the database. Keeps the corpus up to date automatically.

**What it runs:** `download_sc.py --year {CURRENT_YEAR}` → `process_and_load.py --source sc --year {CURRENT_YEAR}`

### Check/manage the cron job

```bash
# View installed cron jobs
crontab -l

# View pipeline logs
tail -f /var/log/nyayasearch-pipeline.log
```

---

## Deployment

### Automated deploy (production server)

```bash
bash scripts/deploy.sh
```

**When:** To deploy the latest code to production.
**Why:** Pulls from `origin main`, runs `npm install` + `npm run build`, restarts the app via PM2. Assumes the production directory is `/opt/nyayasearch`.

**What it does (step by step):**
1. `cd /opt/nyayasearch`
2. `git pull origin main`
3. `npm install`
4. `npm run build`
5. `pm2 restart nyayasearch`

### Manual deploy (if not using the script)

```bash
cd /opt/nyayasearch
git pull origin main
npm install
npm run build
pm2 restart nyayasearch
```

---

## Nginx

### Production reverse proxy config

**File:** `nginx/nyayasearch.conf`

```bash
# Copy to nginx sites directory
sudo cp nginx/nyayasearch.conf /etc/nginx/sites-available/nyayasearch
sudo ln -s /etc/nginx/sites-available/nyayasearch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**When:** On initial server setup. Update `server_name` from `yourdomain.com` to the actual domain.
**Why:** Proxies port 80 traffic to the Next.js app on `localhost:3000`. Handles WebSocket upgrades and sets proper forwarding headers (`X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`).

---

## Environment Variables

All variables go in `.env.local` (copy from `.env.local.example`):

| Variable | Used by | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | Everything | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Extraction pipeline, chat API | Claude API for LLM extraction + chat |
| `VOYAGE_API_KEY` | process_and_load, embed_existing | Vector embeddings via Voyage AI |
| `R2_ACCESS_KEY_ID` | process_and_load | Cloudflare R2 (PDF storage) |
| `R2_SECRET_ACCESS_KEY` | process_and_load | Cloudflare R2 |
| `R2_ENDPOINT` | process_and_load | Cloudflare R2 endpoint URL |
| `R2_BUCKET_NAME` | process_and_load | R2 bucket name (default: `legal-judgments`) |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Next.js client | Firebase auth (client-side) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Next.js client | Firebase auth |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Next.js client | Firebase auth |
| `FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY` | Next.js server | Firebase admin (JSON string) |
| `RAZORPAY_KEY_ID` | Next.js server | Payment processing |
| `RAZORPAY_KEY_SECRET` | Next.js server | Payment processing |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Next.js client | Payment processing (client-side) |
| `RAZORPAY_WEBHOOK_SECRET` | Next.js server | Razorpay webhook verification |
| `NEXT_PUBLIC_APP_URL` | Next.js | App base URL (default: `http://localhost:3000`) |

---

## End-to-End Workflows

### A. First-time setup (new machine)

```bash
# 1. Dependencies
npm install
pip install -r pipeline/requirements.txt

# 2. Environment
cp .env.local.example .env.local
# Fill in DATABASE_URL, API keys, etc.

# 3. Database
bash scripts/migrate.sh

# 4. Start app
npm run dev
```

### B. Load a new year of data (full pipeline)

```bash
# 1. Download
python pipeline/download_sc.py --year 2024
python pipeline/download_hc.py --year 2024 --all-courts

# 2. Process, upload PDFs to R2, insert into DB, create embeddings
python pipeline/process_and_load.py --source sc --year 2024
python pipeline/process_and_load.py --source hc --year 2024 --court 32_4
# Repeat --court for each court code

# 3. Extract structured metadata
python pipeline/extract_fields.py --source sc --all
python pipeline/extract_fields.py --source hc --all

# 4. Verify quality
python pipeline/verify_extraction.py --source sc
python pipeline/verify_extraction.py --source hc
```

### C. Backfill embeddings for existing cases

```bash
python pipeline/embed_existing.py --source sc
python pipeline/embed_existing.py --source hc
```

### C2. RAG upgrade — full re-embed with voyage-law-2

Run this once after pulling the RAG upgrade (migrations 009 + 010, `voyage-law-2`). This is destructive: chat + vector search are **broken** from step 2 until step 3 completes.

```bash
# 1. Apply schema migrations
psql "$DATABASE_URL" -f migrations/009_embeddings_v2.sql    # truncates case_chunks, vector(1024), FTS+HNSW, reembed_progress
psql "$DATABASE_URL" -f migrations/010_chat_rag_trace.sql   # adds chat_messages.rag_trace summary
psql "$DATABASE_URL" -f migrations/011_rag_audit_tables.sql # adds rag_pipeline_steps + rag_query_embeddings

# 2. Full resumable re-embed (Voyage cost scales with corpus size; run during off-hours)
python pipeline/reembed_all.py

# 3. Sanity check
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM case_chunks WHERE embedding IS NULL;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM reembed_progress;"

# 4. End-to-end smoke test: open the chat UI, ask a multi-turn question,
#    confirm tokens stream and citations render as [n] chips with working PDFs.

# 5. Inspect a recent message's RAG trace
psql "$DATABASE_URL" -c "SELECT rag_trace->'timings', rag_trace->'rewritten_queries' \
    FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1;"
```

If step 2 is interrupted (`Ctrl-C`, API outage, power loss), just re-run the same command — `reembed_progress` tracks completed cases per `(source_table, source_id)` and already-embedded cases are skipped.

### D. Improve extraction quality (iterate)

```bash
# 1. Test regex changes on a single known case
python pipeline/extract_fields.py --source sc --id 42

# 2. Test on a batch
python pipeline/extract_fields.py --source sc --reprocess --limit 20

# 3. Check coverage
python pipeline/verify_extraction.py --source sc

# 4. Full re-run once satisfied
python pipeline/extract_fields.py --source sc --reprocess
```

### E. Production deploy

```bash
bash scripts/deploy.sh
# Or manually: git pull, npm install, npm run build, pm2 restart nyayasearch
```
