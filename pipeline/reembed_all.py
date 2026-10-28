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
import json
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


def fetch_pending_cases(cur, source_table: str, court_filter: str | None,
                        years: list[int] | None = None):
    """Return list of dicts for cases that still need embedding.

    `years` scopes the scan (used by sync_sc.py so an incremental run never
    sweeps up unrelated backlog elsewhere in the corpus).
    """
    params: list = []
    where_court = ""
    if source_table == "high_court_cases" and court_filter:
        where_court = " AND c.court_name = %s"
        params.append(court_filter)
    if years:
        where_court += " AND c.year = ANY(%s)"
        params.append(list(years))

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
    while batches:
        batch = batches.pop(0)
        attempt = 0
        while True:
            try:
                result = voyage_client.embed(batch, model=EMBED_MODEL, input_type="document")
                embeddings = result.embeddings
                break
            except Exception as e:
                # The batcher only estimates tokens (chars / 2.5), and dense
                # text runs over: the 853k-char Jayalalithaa judgment came to
                # 120,572 tokens in a batch budgeted at 100k, failed all three
                # retries and was silently left unembedded. Splitting the
                # batch is the only retry that can succeed; order is kept.
                if "max allowed tokens per submitted batch" in str(e) and len(batch) > 1:
                    mid = len(batch) // 2
                    print(f"  case {case_id}: batch of {len(batch)} over Voyage's token limit, splitting")
                    batches[:0] = [batch[:mid], batch[mid:]]
                    batch = None
                    break
                attempt += 1
                if attempt >= 3:
                    print(f"  giving up on case {case_id} after 3 attempts: {e}")
                    conn.rollback()
                    return inserted
                sleep_s = 2 ** attempt
                print(f"  voyage error on case {case_id}: {e} (retry in {sleep_s}s)")
                time.sleep(sleep_s)
        if batch is None:
            continue

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


def replace_cases(source_table: str, ids: list[int], batch_size: int) -> None:
    """Re-embed specific cases whose metadata changed (the header is part of
    every chunk). Old chunks and the progress row are deleted in the same
    transaction embed_one_case commits, so a failed embed rolls back to the
    old chunks instead of leaving the case unsearchable."""
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    meta_cols = SC_METADATA_COLUMNS if source_table == "supreme_court_cases" else HC_METADATA_COLUMNS
    cur.execute(
        f"""SELECT c.id, c.judgment_text, {meta_cols} FROM {source_table} c
            WHERE c.id = ANY(%s) AND c.judgment_text IS NOT NULL AND c.judgment_text != ''
            ORDER BY c.id""",
        (ids,),
    )
    columns = [desc[0] for desc in cur.description]
    cases = [dict(zip(columns, row)) for row in cur.fetchall()]
    voyage_client = voyageai.Client(api_key=VOYAGE_API_KEY)
    ok = failed = 0
    for case in tqdm(cases, desc=f"replace {source_table}"):
        # A rollback restores the OLD progress row too, so success means a
        # progress row stamped inside this transaction, not merely a row.
        cur.execute("SELECT now()")
        started = cur.fetchone()[0]
        cur.execute("DELETE FROM case_chunks WHERE source_table = %s AND source_id = %s",
                    (source_table, case["id"]))
        cur.execute("DELETE FROM reembed_progress WHERE source_table = %s AND source_id = %s",
                    (source_table, case["id"]))
        embed_one_case(conn, cur, voyage_client, source_table, case, batch_size)
        cur.execute("SELECT 1 FROM reembed_progress WHERE source_table = %s AND source_id = %s "
                    "AND completed_at >= %s", (source_table, case["id"], started))
        if cur.fetchone():
            ok += 1
        else:
            failed += 1
            print(f"  case {case['id']}: re-embed failed, old chunks kept")
    cur.close()
    conn.close()
    print(f"\nReplaced {ok} cases, {failed} failed (kept old chunks), "
          f"{len(ids) - len(cases)} ids had no text")


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
    parser.add_argument("--replace-ids-file", type=str, default=None,
                        help="JSON list of ids to re-embed even if already done "
                             "(after their metadata changed); needs --source sc or hc")
    args = parser.parse_args()

    if args.source != "hc" and args.court:
        print("--court only applies to --source hc", file=sys.stderr)
        sys.exit(2)

    if args.replace_ids_file:
        if args.source == "all":
            print("--replace-ids-file needs --source sc or hc", file=sys.stderr)
            sys.exit(2)
        table = "supreme_court_cases" if args.source == "sc" else "high_court_cases"
        replace_cases(table, json.load(open(args.replace_ids_file)), args.batch_size)
        return

    run(args.source, args.court, args.batch_size)


if __name__ == "__main__":
    main()
