#!/usr/bin/env python3
"""Full re-embed of every case in the database with voyage-law-2 (1024d).

Run this ONCE after applying migrations/009_embeddings_v2.sql. The migration
truncates case_chunks, so chat + vector search will be broken until this
finishes. The script is resumable: it skips cases recorded in reembed_progress
so you can Ctrl-C and restart without losing work.

IMPORTANT: Run extract_fields.py BEFORE this script. Each chunk is prefixed
with a metadata header built from the extraction columns (headnotes, acts_cited,
judge_names, etc.). If extraction hasn't run, the header will be empty and
retrieval quality will be significantly worse.

Usage:
    python pipeline/reembed_all.py                  # SC + HC, all years
    python pipeline/reembed_all.py --source sc      # SC only
    python pipeline/reembed_all.py --source hc --court Delhi
    python pipeline/reembed_all.py --batch-size 64  # smaller Voyage batches
"""

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
    chunk_text_with_header,
    batch_chunks_by_tokens,
    SC_METADATA_COLUMNS,
    HC_METADATA_COLUMNS,
)

EMBED_MODEL = "voyage-law-2"


def fetch_pending_cases(cur, source_table: str, court_filter: str | None):
    """Return list of dicts for cases that still need embedding."""
    params: list = []
    where_court = ""
    if source_table == "high_court_cases" and court_filter:
        where_court = " AND c.court_name = %s"
        params.append(court_filter)

    if source_table == "supreme_court_cases":
        meta_cols = SC_METADATA_COLUMNS
    else:
        meta_cols = HC_METADATA_COLUMNS

    query = f"""
        SELECT c.id, c.judgment_text, {meta_cols}
        FROM {source_table} c
        LEFT JOIN reembed_progress p
               ON p.source_table = %s AND p.source_id = c.id
        WHERE c.judgment_text IS NOT NULL
          AND c.judgment_text != ''
          AND p.source_id IS NULL
          {where_court}
        ORDER BY c.id
    """
    cur.execute(query, [source_table, *params])
    columns = [desc[0] for desc in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def embed_one_case(
    conn, cur, voyage_client, source_table: str, case: dict, batch_size: int
) -> int:
    case_id = case["id"]
    judgment_text = case["judgment_text"]

    header = build_metadata_header(case, source_table)
    chunks = chunk_text_with_header(judgment_text, header)
    if not chunks:
        cur.execute(
            """INSERT INTO reembed_progress (source_table, source_id, chunks_inserted)
               VALUES (%s, %s, 0)
               ON CONFLICT (source_table, source_id) DO NOTHING""",
            (source_table, case_id),
        )
        conn.commit()
        return 0

    # Use token-aware batching so we never exceed Voyage's 120k token limit.
    batches = batch_chunks_by_tokens(chunks)

    inserted = 0
    chunk_offset = 0
    for batch in batches:
        attempt = 0
        while True:
            try:
                result = voyage_client.embed(batch, model=EMBED_MODEL, input_type="document")
                embeddings = result.embeddings
                break
            except Exception as e:
                attempt += 1
                if attempt >= 3:
                    print(f"  giving up on case {case_id} after 3 attempts: {e}")
                    conn.rollback()
                    return inserted
                sleep_s = 2 ** attempt
                print(f"  voyage error on case {case_id}: {e} (retry in {sleep_s}s)")
                time.sleep(sleep_s)

        for j, (chunk_text_item, embedding) in enumerate(zip(batch, embeddings)):
            cur.execute(
                """INSERT INTO case_chunks (source_table, source_id, chunk_index, chunk_text, embedding)
                   VALUES (%s, %s, %s, %s, %s::vector)""",
                (source_table, case_id, chunk_offset + j, chunk_text_item, str(embedding)),
            )
            inserted += 1
        chunk_offset += len(batch)

    cur.execute(
        """INSERT INTO reembed_progress (source_table, source_id, chunks_inserted)
           VALUES (%s, %s, %s)
           ON CONFLICT (source_table, source_id)
           DO UPDATE SET chunks_inserted = EXCLUDED.chunks_inserted,
                         completed_at = NOW()""",
        (source_table, case_id, inserted),
    )
    conn.commit()
    return inserted


def run(source: str, court_filter: str | None, batch_size: int):
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    voyage_client = voyageai.Client(api_key=VOYAGE_API_KEY)

    tables: list[str] = []
    if source in ("sc", "all"):
        tables.append("supreme_court_cases")
    if source in ("hc", "all"):
        tables.append("high_court_cases")

    grand_total_cases = 0
    grand_total_chunks = 0
    start_ts = time.time()

    for source_table in tables:
        cases = fetch_pending_cases(cur, source_table, court_filter)
        print(f"\n{source_table}: {len(cases)} cases pending")
        if not cases:
            continue

        for case in tqdm(cases, desc=source_table):
            inserted = embed_one_case(
                conn, cur, voyage_client, source_table, case, batch_size
            )
            grand_total_cases += 1
            grand_total_chunks += inserted
            time.sleep(0.1)

    cur.close()
    conn.close()

    elapsed = time.time() - start_ts
    print(
        f"\nDone. {grand_total_cases} cases, {grand_total_chunks} chunks, "
        f"{elapsed:.0f}s elapsed"
    )


def main():
    parser = argparse.ArgumentParser(description="Full re-embed with voyage-law-2")
    parser.add_argument("--source", choices=["sc", "hc", "all"], default="all")
    parser.add_argument("--court", type=str, help="High Court name filter (when --source hc)")
    parser.add_argument("--batch-size", type=int, default=VOYAGE_BATCH_SIZE)
    args = parser.parse_args()

    if args.source != "hc" and args.court:
        print("--court only applies to --source hc", file=sys.stderr)
        sys.exit(2)

    run(args.source, args.court, args.batch_size)


if __name__ == "__main__":
    main()
