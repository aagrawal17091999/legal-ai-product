#!/usr/bin/env python3
"""Generate embeddings for cases already in the database that don't have chunks yet.

Each chunk is prefixed with a metadata header from extraction columns.
Run extract_fields.py before this for best quality.
"""

import argparse
import time

import psycopg2
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


def embed_existing(source: str, court_filter: str | None, batch_size: int):
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    voyage_client = voyageai.Client(api_key=VOYAGE_API_KEY)

    if source == 'sc':
        table = 'supreme_court_cases'
        source_table = 'supreme_court_cases'
        meta_cols = SC_METADATA_COLUMNS
    else:
        table = 'high_court_cases'
        source_table = 'high_court_cases'
        meta_cols = HC_METADATA_COLUMNS

    # Find cases without chunks
    query = f"""
        SELECT c.id, c.judgment_text, {meta_cols}
        FROM {table} c
        LEFT JOIN case_chunks ch ON ch.source_table = %s AND ch.source_id = c.id
        WHERE c.judgment_text IS NOT NULL
          AND c.judgment_text != ''
          AND ch.id IS NULL
    """
    params: list = [source_table]

    if court_filter and source == 'hc':
        query += " AND c.court_name = %s"
        params.append(court_filter)

    query += f" LIMIT {batch_size * 10}"

    cur.execute(query, params)
    columns = [desc[0] for desc in cur.description]
    cases = [dict(zip(columns, row)) for row in cur.fetchall()]
    print(f'Found {len(cases)} cases without embeddings')

    processed = 0
    total_chunks = 0

    for case in tqdm(cases, desc='Embedding'):
        case_id = case['id']
        judgment_text = case['judgment_text']

        header = build_metadata_header(case, source_table)
        chunks = chunk_text_with_header(judgment_text, header)
        if not chunks:
            continue

        batches = batch_chunks_by_tokens(chunks)
        chunk_offset = 0
        for batch in batches:
            try:
                result = voyage_client.embed(batch, model=EMBED_MODEL, input_type='document')
                embeddings = result.embeddings

                for j, (chunk_text_item, embedding) in enumerate(zip(batch, embeddings)):
                    cur.execute(
                        """INSERT INTO case_chunks (source_table, source_id, chunk_index, chunk_text, embedding)
                           VALUES (%s, %s, %s, %s, %s::vector)""",
                        (source_table, case_id, chunk_offset + j, chunk_text_item, str(embedding))
                    )
                    total_chunks += 1

                conn.commit()
                chunk_offset += len(batch)
                time.sleep(0.5)
            except Exception as e:
                conn.rollback()
                print(f'  Error embedding case {case_id}: {e}')

        processed += 1
        if processed % 50 == 0:
            print(f'  Progress: {processed} cases, {total_chunks} chunks')

    cur.close()
    conn.close()
    print(f'\nDone: {processed} cases processed, {total_chunks} chunks created')


def main():
    parser = argparse.ArgumentParser(description='Embed existing cases')
    parser.add_argument('--source', required=True, choices=['sc', 'hc'])
    parser.add_argument('--court', type=str, help='Court name filter for HC')
    parser.add_argument('--batch-size', type=int, default=50)
    args = parser.parse_args()

    embed_existing(args.source, args.court, args.batch_size)


if __name__ == '__main__':
    main()
