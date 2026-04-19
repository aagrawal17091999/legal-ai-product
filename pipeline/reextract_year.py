#!/usr/bin/env python3
"""
Re-extract judgment_text from PDFs for a single (source, year) cohort,
using the new vision-OCR-aware extractor in process_and_load.py.

Designed for the 1950s Supreme Court backfill where the original PyMuPDF
pass returned empty/garbage text on scanned and handwritten judgments.

What it does, per case:
  1. Locate the PDF — local data dir first, then download from R2.
  2. Re-extract text via extract_text_from_pdf (PyMuPDF → vision-OCR fallback).
  3. UPDATE judgment_text and reset extraction_status='pending'.
  4. Wipe old chunks + reembed_progress so reembed_all picks the row up.

After this finishes, run extract_fields.py and reembed_all.py — neither
has a --year filter, but they'll naturally process the rows we just reset.

Usage:
    python pipeline/reextract_year.py --source sc --year 1950
    python pipeline/reextract_year.py --source sc --year 1950 --limit 5     # smoke test
    python pipeline/reextract_year.py --source sc --year 1950 --no-ocr      # PyMuPDF only
"""

import argparse
import os
import tempfile

import boto3
import psycopg2
from tqdm import tqdm

from config import (
    DATABASE_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
    R2_ENDPOINT, R2_BUCKET_NAME, SC_DATA_DIR, HC_DATA_DIR,
)
from process_and_load import extract_text_from_pdf, find_pdf_in_dir


def get_r2_client():
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto',
    )


def fetch_pdf(source: str, year: int, row: dict, r2_client) -> tuple[str | None, bool]:
    """Return (pdf_path, is_temp). Caller deletes if is_temp."""
    if source == 'sc':
        path = row['path']
        local_dir = os.path.join(SC_DATA_DIR, f'year={year}', 'pdfs')
        local = find_pdf_in_dir(local_dir, path) if os.path.isdir(local_dir) else None
        if local:
            return local, False
        r2_key = f'supreme-court/{year}/{path}_EN.pdf'
    else:
        pdf_link = row['pdf_link'] or ''
        court_name = row['court_name'] or row['court_code']
        pdf_filename = os.path.basename(pdf_link)
        local_dir = os.path.join(HC_DATA_DIR, f'court={row["court_code"]}', f'year={year}', 'pdfs')
        local = os.path.join(local_dir, pdf_filename) if pdf_filename else None
        if local and os.path.exists(local):
            return local, False
        r2_key = f'hc/{court_name}/{year}/{pdf_filename}'

    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
    tmp.close()
    try:
        r2_client.download_file(R2_BUCKET_NAME, r2_key, tmp.name)
        return tmp.name, True
    except Exception as e:
        print(f'  R2 download failed for {r2_key}: {e}')
        os.unlink(tmp.name)
        return None, False


def reextract(source: str, year: int, limit: int | None, allow_ocr: bool):
    table = 'supreme_court_cases' if source == 'sc' else 'high_court_cases'
    cols = 'id, path' if source == 'sc' else 'id, court_code, court_name, pdf_link'

    conn = psycopg2.connect(DATABASE_URL)
    r2 = get_r2_client()
    cur = conn.cursor()

    sql = f'SELECT {cols} FROM {table} WHERE year = %s ORDER BY id'
    params: list = [year]
    if limit:
        sql += ' LIMIT %s'
        params.append(limit)
    cur.execute(sql, params)
    rows = cur.fetchall()
    col_names = [d.name for d in cur.description]

    print(f'{table} year={year}: {len(rows)} rows to re-extract (allow_ocr={allow_ocr})')

    updated = ocr_used = unchanged = no_pdf = 0
    for row_tuple in tqdm(rows, desc=f'{source} {year}'):
        row = dict(zip(col_names, row_tuple))
        case_id = row['id']

        pdf_path, is_temp = fetch_pdf(source, year, row, r2)
        if not pdf_path:
            no_pdf += 1
            continue

        try:
            new_text = extract_text_from_pdf(pdf_path, allow_ocr=allow_ocr)
        finally:
            if is_temp:
                try:
                    os.unlink(pdf_path)
                except OSError:
                    pass

        if not new_text:
            unchanged += 1
            continue

        cur.execute(f'SELECT COALESCE(LENGTH(judgment_text), 0) FROM {table} WHERE id = %s', (case_id,))
        old_len = cur.fetchone()[0]
        if len(new_text) > old_len:
            ocr_used += 1

        cur.execute(
            f"""UPDATE {table}
                   SET judgment_text = %s,
                       extraction_status = 'pending'
                 WHERE id = %s""",
            (new_text, case_id),
        )
        cur.execute(
            'DELETE FROM case_chunks WHERE source_table = %s AND source_id = %s',
            (table, case_id),
        )
        cur.execute(
            'DELETE FROM reembed_progress WHERE source_table = %s AND source_id = %s',
            (table, case_id),
        )
        conn.commit()
        updated += 1

    cur.close()
    conn.close()

    print(
        f'\nDone. updated={updated}, '
        f'longer_text_after_ocr={ocr_used}, '
        f'no_text_extracted={unchanged}, '
        f'pdf_missing={no_pdf}'
    )
    print('Next steps:')
    print('  python pipeline/extract_fields.py --source', source, '--all')
    print('  python pipeline/reembed_all.py --source', source)


def main():
    p = argparse.ArgumentParser(description='Re-extract judgment_text for one year with vision OCR fallback')
    p.add_argument('--source', required=True, choices=['sc', 'hc'])
    p.add_argument('--year', type=int, required=True)
    p.add_argument('--limit', type=int, default=None, help='Cap rows (smoke test)')
    p.add_argument('--no-ocr', action='store_true', help='Disable vision OCR fallback (PyMuPDF only)')
    args = p.parse_args()
    reextract(args.source, args.year, args.limit, allow_ocr=not args.no_ocr)


if __name__ == '__main__':
    main()
