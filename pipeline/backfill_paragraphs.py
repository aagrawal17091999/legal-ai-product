#!/usr/bin/env python3
"""Paragraph-aware re-chunk + re-embed backfill.

For every case with a non-empty judgment_text, this script:
  1. Extracts paragraphs via paragraph_extractor.extract_paragraphs.
  2. Inserts them into case_paragraphs (delete-first for idempotency).
  3. Re-chunks by paragraph via chunk_utils.chunk_text_by_paragraph.
  4. Embeds the new chunks with Voyage (voyage-law-2, 1024d).
  5. Replaces the case's rows in case_chunks with the paragraph-aware chunks,
     populating case_chunks.paragraph_numbers.
  6. Marks paragraph_backfill_progress so re-runs skip the case.

EXPECTED COST:
  This re-embeds every SC + HC judgment. Running across the full corpus is
  a one-time Voyage bill. Always test with --limit first.

Usage:
    python pipeline/backfill_paragraphs.py --limit 10               # small sample
    python pipeline/backfill_paragraphs.py --source sc --limit 50
    python pipeline/backfill_paragraphs.py                          # full backfill (expensive!)
    python pipeline/backfill_paragraphs.py --force                  # re-do cases already backfilled

Run migrations/013_paragraphs.sql first.
"""

from __future__ import annotations

import argparse
import sys
import time

import psycopg2
import psycopg2.extras
import voyageai
from tqdm import tqdm

from config import DATABASE_URL, VOYAGE_API_KEY, VOYAGE_BATCH_SIZE
from chunk_utils import (
    build_metadata_header,
    chunk_text_by_paragraph,
    batch_chunks_by_tokens,
    SC_METADATA_COLUMNS,
    HC_METADATA_COLUMNS,
)
from paragraph_extractor import extract_paragraphs, ExtractionResult

EMBED_MODEL = "voyage-law-2"


def fetch_pending_cases(
    cur, source_table: str, limit: int | None, force: bool
):
    meta_cols = SC_METADATA_COLUMNS if source_table == "supreme_court_cases" else HC_METADATA_COLUMNS

    progress_clause = (
        ""
        if force
        else """
        LEFT JOIN paragraph_backfill_progress pbp
               ON pbp.source_table = %s AND pbp.source_id = c.id
         WHERE c.judgment_text IS NOT NULL
           AND c.judgment_text != ''
           AND pbp.source_id IS NULL
        """
    )
    force_clause = (
        """
         WHERE c.judgment_text IS NOT NULL
           AND c.judgment_text != ''
        """
        if force
        else ""
    )

    query = f"""
        SELECT c.id, c.judgment_text, {meta_cols}
          FROM {source_table} c
          {progress_clause if not force else force_clause}
         ORDER BY c.id
    """
    params: list = []
    if not force:
        params.append(source_table)
    if limit is not None:
        query += " LIMIT %s"
        params.append(limit)

    cur.execute(query, params)
    columns = [desc[0] for desc in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def replace_case_paragraphs(cur, source_table: str, source_id: int, result: ExtractionResult) -> int:
    """Replace all case_paragraphs rows for this case. Returns paragraphs inserted."""
    cur.execute(
        "DELETE FROM case_paragraphs WHERE source_table = %s AND source_id = %s",
        (source_table, source_id),
    )
    if not result.paragraphs:
        return 0

    rows = [
        (
            source_table,
            source_id,
            p.paragraph_number,
            p.paragraph_order,
            p.start_char,
            p.end_char,
            p.paragraph_text,
            p.kind,
        )
        for p in result.paragraphs
    ]
    psycopg2.extras.execute_values(
        cur,
        """INSERT INTO case_paragraphs
             (source_table, source_id, paragraph_number, paragraph_order,
              start_char, end_char, paragraph_text, kind)
           VALUES %s""",
        rows,
    )
    return len(rows)


def replace_case_chunks(
    cur, voyage_client, source_table: str, source_id: int, chunks: list[dict]
) -> int:
    """Replace all case_chunks rows for this case with paragraph-aware chunks.
    Returns chunks inserted."""
    cur.execute(
        "DELETE FROM case_chunks WHERE source_table = %s AND source_id = %s",
        (source_table, source_id),
    )
    if not chunks:
        return 0

    texts = [c["chunk_text"] for c in chunks]
    paragraph_number_lists = [c["paragraph_numbers"] for c in chunks]

    # Embed in token-safe batches.
    batches = batch_chunks_by_tokens(texts)
    all_embeddings: list[list[float]] = []
    cursor = 0
    for batch in batches:
        attempt = 0
        while True:
            try:
                result = voyage_client.embed(batch, model=EMBED_MODEL, input_type="document")
                all_embeddings.extend(result.embeddings)
                break
            except Exception as e:
                attempt += 1
                if attempt >= 3:
                    raise
                time.sleep(2**attempt)
        cursor += len(batch)

    inserted = 0
    for i, (text, embedding, paragraph_nums) in enumerate(
        zip(texts, all_embeddings, paragraph_number_lists)
    ):
        cur.execute(
            """INSERT INTO case_chunks
                 (source_table, source_id, chunk_index, chunk_text, embedding, paragraph_numbers)
               VALUES (%s, %s, %s, %s, %s::vector, %s)""",
            (source_table, source_id, i, text, str(embedding), paragraph_nums),
        )
        inserted += 1
    return inserted


def process_case(conn, cur, voyage_client, source_table: str, case: dict) -> tuple[int, int, str]:
    """Handle one case in a single transaction. Returns (paragraphs, chunks, strategy)."""
    case_id = case["id"]
    judgment_text = case["judgment_text"] or ""

    extraction = extract_paragraphs(judgment_text)
    if not extraction.paragraphs:
        # Nothing to do — mark as processed so we don't retry every run.
        cur.execute(
            """INSERT INTO paragraph_backfill_progress
                 (source_table, source_id, paragraphs_inserted, chunks_inserted, extractor_strategy)
               VALUES (%s, %s, 0, 0, %s)
               ON CONFLICT (source_table, source_id)
               DO UPDATE SET paragraphs_inserted = 0,
                             chunks_inserted = 0,
                             extractor_strategy = EXCLUDED.extractor_strategy,
                             completed_at = NOW()""",
            (source_table, case_id, "empty"),
        )
        conn.commit()
        return 0, 0, "empty"

    try:
        paragraphs_inserted = replace_case_paragraphs(
            cur, source_table, case_id, extraction
        )

        header = build_metadata_header(case, source_table)
        chunks = chunk_text_by_paragraph(extraction.paragraphs, header)
        chunks_inserted = replace_case_chunks(
            cur, voyage_client, source_table, case_id, chunks
        )

        cur.execute(
            """INSERT INTO paragraph_backfill_progress
                 (source_table, source_id, paragraphs_inserted, chunks_inserted, extractor_strategy)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (source_table, source_id)
               DO UPDATE SET paragraphs_inserted = EXCLUDED.paragraphs_inserted,
                             chunks_inserted = EXCLUDED.chunks_inserted,
                             extractor_strategy = EXCLUDED.extractor_strategy,
                             completed_at = NOW()""",
            (source_table, case_id, paragraphs_inserted, chunks_inserted, extraction.strategy),
        )
        conn.commit()
        return paragraphs_inserted, chunks_inserted, extraction.strategy
    except Exception:
        conn.rollback()
        raise


def run(source: str, limit: int | None, force: bool, batch_size: int, dry_run: bool):
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    voyage_client = voyageai.Client(api_key=VOYAGE_API_KEY) if not dry_run else None

    tables: list[str] = []
    if source in ("sc", "all"):
        tables.append("supreme_court_cases")
    if source in ("hc", "all"):
        tables.append("high_court_cases")

    totals = {"cases": 0, "paragraphs": 0, "chunks": 0, "by_strategy": {}}
    start_ts = time.time()

    for source_table in tables:
        # When --limit is set we apply it per table; when set globally, split it.
        per_table_limit = limit
        cases = fetch_pending_cases(cur, source_table, per_table_limit, force)
        print(f"\n{source_table}: {len(cases)} cases pending")
        if not cases:
            continue

        for case in tqdm(cases, desc=source_table):
            if dry_run:
                r = extract_paragraphs(case["judgment_text"] or "")
                totals["cases"] += 1
                totals["paragraphs"] += len(r.paragraphs)
                totals["by_strategy"][r.strategy] = totals["by_strategy"].get(r.strategy, 0) + 1
                continue

            try:
                paragraphs_inserted, chunks_inserted, strategy = process_case(
                    conn, cur, voyage_client, source_table, case
                )
            except Exception as e:
                print(f"  FAILED case {case['id']}: {e}")
                continue

            totals["cases"] += 1
            totals["paragraphs"] += paragraphs_inserted
            totals["chunks"] += chunks_inserted
            totals["by_strategy"][strategy] = totals["by_strategy"].get(strategy, 0) + 1
            # Gentle pacing — Voyage has rate limits.
            time.sleep(0.05)

    cur.close()
    conn.close()

    elapsed = time.time() - start_ts
    print(
        f"\nDone. {totals['cases']} cases, {totals['paragraphs']} paragraphs, "
        f"{totals['chunks']} chunks in {elapsed:.1f}s"
    )
    print(f"Strategies: {totals['by_strategy']}")
    if dry_run:
        print("(dry-run — no DB writes, no embeddings)")


def main():
    parser = argparse.ArgumentParser(
        description="Paragraph-aware re-chunk + re-embed backfill"
    )
    parser.add_argument("--source", choices=["sc", "hc", "all"], default="all")
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process at most this many cases per table (use for small-sample validation)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-process cases already recorded in paragraph_backfill_progress",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run the extractor only; do not write to DB and do not call Voyage",
    )
    parser.add_argument("--batch-size", type=int, default=VOYAGE_BATCH_SIZE)
    args = parser.parse_args()

    run(args.source, args.limit, args.force, args.batch_size, args.dry_run)


if __name__ == "__main__":
    main()
