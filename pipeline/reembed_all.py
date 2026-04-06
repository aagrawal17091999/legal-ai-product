#!/usr/bin/env python3
"""Full re-embed of every case in the database with voyage-law-2 (1024d).

Run this ONCE after applying migrations/009_embeddings_v2.sql. The migration
truncates case_chunks, so chat + vector search will be broken until this
finishes. The script is resumable: it skips cases recorded in reembed_progress
so you can Ctrl-C and restart without losing work.

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
import voyageai
from tqdm import tqdm

from config import DATABASE_URL, VOYAGE_API_KEY, CHUNK_SIZE, CHUNK_OVERLAP, VOYAGE_BATCH_SIZE

EMBED_MODEL = "voyage-law-2"


def chunk_text(text: str) -> list[str]:
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - CHUNK_OVERLAP
    return chunks


def fetch_pending_cases(cur, source_table: str, court_filter: str | None):
    """Return [(case_id, judgment_text), ...] for cases that still need embedding."""
    params: list = [source_table]
    where_court = ""
    if source_table == "high_court_cases" and court_filter:
        where_court = " AND c.court_name = %s"
        params.append(court_filter)

    query = f"""
        SELECT c.id, c.judgment_text
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
    return cur.fetchall()


def embed_one_case(
    conn, cur, voyage_client, source_table: str, case_id: int, judgment_text: str, batch_size: int
) -> int:
    chunks = chunk_text(judgment_text)
    if not chunks:
        # Record as completed with 0 chunks so we don't re-check it next run.
        cur.execute(
            """INSERT INTO reembed_progress (source_table, source_id, chunks_inserted)
               VALUES (%s, %s, 0)
               ON CONFLICT (source_table, source_id) DO NOTHING""",
            (source_table, case_id),
        )
        conn.commit()
        return 0

    inserted = 0
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        # Retry a couple of times on transient API errors before giving up on this case.
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
                (source_table, case_id, i + j, chunk_text_item, str(embedding)),
            )
            inserted += 1

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

        for case_id, judgment_text in tqdm(cases, desc=source_table):
            inserted = embed_one_case(
                conn, cur, voyage_client, source_table, case_id, judgment_text, batch_size
            )
            grand_total_cases += 1
            grand_total_chunks += inserted
            # Gentle rate limit between cases.
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
