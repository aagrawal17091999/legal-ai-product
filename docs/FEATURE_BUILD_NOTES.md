# Build Notes — Document Workspace & Legal Translation

Two new features, kept modular and **separate from the existing case-law agentic chat**. This log records the judgment calls and their tradeoffs, per the spec.

## Pre-work findings
- **pgvector: already installed.** `vector` v0.6.0 on Postgres 16.14; both `hnsw` and `ivfflat` access methods available. The existing `case_chunks` already uses `vector(1024)` + HNSW cosine + GIN FTS. No install needed. (Caveat: 0.6.0 lacks 0.7+ niceties like iterative scans / `halfvec`; not required here.)
- **Existing Claude integration** (matched for consistency): `@anthropic-ai/sdk` used directly with hand-rolled SSE (not the Vercel AI SDK). Chat `claude-sonnet-4-6`; Haiku for light tasks. Prompt caching via `src/lib/rag/promptCache.ts`. Embeddings: Voyage `voyage-law-2` (1024d) + `rerank-2`. Storage: Cloudflare R2. Auth: Firebase. DB: `pg` Pool.

## Shared extraction (`src/lib/extract/`)
- **OCR engine — Claude vision (decision: confirmed with Ansh).** Digital PDFs use the embedded text layer (cheap, via `unpdf`); DOCX via `mammoth`; scanned PDFs / images go to Claude (`document`/`image` block), same approach & model as the offline `pipeline/pdf_ocr.py`. *Tradeoff:* higher per-page cost on scans vs Tesseract/Textract, but materially better on degraded/handwritten Indian documents — the codebase already made this call.
- **OCR detection thresholds** ported verbatim from `pdf_ocr.py`: needs OCR if <500 total chars or <50 chars/page.
- **PDF page cap for OCR = 100** (Claude document-block limit). Larger scans error clearly rather than truncating silently.

## Feature 1 — Document Workspace (scoped RAG)
- **Isolation:** new tables `workspaces`, `workspace_documents`, `document_chunks`, `workspace_messages` (migration `018`). `document_chunks.embedding vector(1024)` with HNSW cosine + GIN FTS + **btree on `workspace_id`**. Every retrieval query is `WHERE workspace_id = $1` — scope enforced in SQL, never cross-workspace.
- **Chunking = 2000 chars / 200 overlap** (ported from the corpus pipeline). *Tradeoff:* generous overlap keeps a clause and its qualifier together for legal cross-references, at a modest storage cost. Page numbers tracked best-effort for citations (null for OCR'd docs).
- **Retrieval:** hybrid vector + FTS, RRF-fused, then Voyage `rerank-2`. **Defaults: 40 candidates/lane → rerank to top 8**, with a **rerank relevance floor of 0.3** (if everything is below it, keep the single best so the model can still answer/deny). Flagged as tunable.
- **Grounding:** a single streaming Claude call with a strict system prompt — answers ONLY from retrieved excerpts; if absent, says "I couldn't find that in your uploaded documents"; cites every claim `[n]`. This is deliberately simpler than the case-law agent (no corpus tools — it cannot reach beyond the user's documents).
- **Citations (default on):** the message returns the sources actually referenced (`[n]`), each with document name + page + snippet, shown in the chat UI.
- **Ingestion is async** (`after()` from `next/server`): upload → R2 → row `status=pending` → background extract/chunk/embed → `ready`/`failed`; the UI polls. OCR+embed of a multi-page scan won't fit one request.

## Feature 2 — Legal Translation → .docx
- **Source language auto-detected** (open-ended; the model reports it) — no hardcoded list. **Target language is free-text.**
- **Segment-wise translation** with per-segment `{ source, translation, flagged, note }`. The model MUST flag illegible/ambiguous/uncertain sections rather than guess; flagged segments render a visible **`[⚠ NEEDS HUMAN REVIEW]`** marker in the .docx. *Rationale:* for legal docs a flagged gap is safer than a confident wrong translation.
- **.docx via the `docx` package**, driven by a configurable template (`src/lib/translate/template.ts`):
  - Confirmed: **margins 2.5 cm** (= 1417 twips, verified), **Times New Roman**, **14pt**, **line spacing 2.0**.
  - **TODO placeholders (Ansh to provide)** — rendered as clearly-marked `[… — TO BE PROVIDED]` blocks, NOT guessed: cause-title block, header, footer note, clause/paragraph numbering, page-number placement, optional binding margin. All are template fields; filling them needs no renderer change.
- **Certification framing kept (default):** UI banner + a docx footer notice stating the AI translation is a draft requiring human certification before filing.
- **Async** like Feature 1: upload → job `processing` → background extract/translate/render → output `.docx` in R2 → job `ready` with a presigned download URL; UI polls.

## Migration / ops note
`scripts/migrate.sh` had never populated its `schema_migrations` ledger, so it tried to re-run older non-idempotent migrations (008's `CREATE TYPE`) and failed. Backfilled the ledger for 001–017 (their schema already exists on the live DB) and applied 018. `migrate.sh` now works going forward.

## Verification done
- `tsc --noEmit`: 0 errors across new code. ESLint: clean.
- Migration 018 applied to the live DB; verified all 5 tables + HNSW/GIN/btree indexes on `document_chunks`.
- Smoke-tested chunking (page mapping + monotonic indices) and the `.docx` renderer (valid OOXML zip; Times New Roman, double spacing, 14pt, 2.5 cm margins, flag markers, TODO placeholders, certification footer all present).

## Still owed by Ansh (non-blocking)
- The 5 court-filing format specifics above (placeholders are live in the output).
- Confirm whether non-English **doc-chat** is expected; if so, switch only `document_chunks` to `voyage-3` (also 1024d). Default stays `voyage-law-2`.

## New env / deps
- Deps added: `unpdf`, `mammoth`, `docx`.
- Optional env overrides: `OCR_MODEL`, `TRANSLATE_MODEL` (both default to `CHAT_MODEL` / `claude-sonnet-4-6`). No new required secrets — reuses `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, R2, `DATABASE_URL`.
