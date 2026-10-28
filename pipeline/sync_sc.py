#!/usr/bin/env python3
"""Incremental Supreme Court sync: index judgments added upstream since the last run.

Upstream (s3://indian-supreme-court-judgments) rewrites each year's
metadata.parquet and english.tar IN PLACE as new SCR volumes come out — small
batches every week or two, and the previous year keeps growing for months after
it ends (2025 gained rows until April 2026). download_sc.py skips a year whose
files are already on disk, so it can never see those additions. This script:

  1. For each year in the window (default: previous + current), downloads the
     parquet (<= 1 MB) and diffs it against supreme_court_cases on path/cnr.
  2. If anything is new, re-downloads english.tar and extracts only those PDFs.
  3. Inserts the new rows — text + R2 upload — via process_and_load.insert_sc_case.
  4. Runs field extraction on pending cases in the window (extract_fields).
  5. Embeds cases in the window with no reembed_progress row (reembed_all).
  6. Checks every case inserted this run now has chunks, i.e. is searchable.

Steps 4 and 5 select from the DB rather than from this run's inserts, so a run
that dies halfway is finished by the next one. A row whose PDF is not in the
tar yet is NOT inserted (it would sit there with no text, and the path/cnr
dedup would stop it ever being retried); it is reported and picked up later.

Usage:
  python pipeline/sync_sc.py                    # previous + current year
  python pipeline/sync_sc.py --dry-run          # report what is new, change nothing
  python pipeline/sync_sc.py --years 2026 --limit 3 --skip-r2   # local test run

Exit codes: 0 ok, 1 some cases failed (rest were indexed), 2 refused to run
(lock held, or more new rows than --max-new).
"""

import argparse
import datetime
import fcntl
import json
import os
import sys
import tarfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import boto3
import pandas as pd
import psycopg2
import psycopg2.extras
import voyageai
from botocore import UNSIGNED
from botocore.config import Config

from config import DATABASE_URL, SC_DATA_DIR, VOYAGE_API_KEY, VOYAGE_BATCH_SIZE
from process_and_load import (
    find_pdf_in_dir, get_r2_client, insert_sc_case, sc_case_exists,
)
from error_logger import log_error

SOURCE_BUCKET = 'indian-supreme-court-judgments'
SOURCE_REGION = 'ap-south-1'
TABLE = 'supreme_court_cases'

# A normal upstream drop is 3-20 judgments. Hundreds at once means upstream
# re-keyed paths/cnrs or the DB is not the one we think — either way a blind
# run would re-ingest (and pay to extract + embed) a whole year.
DEFAULT_MAX_NEW = 300


def source_client():
    return boto3.client('s3', region_name=SOURCE_REGION,
                        config=Config(signature_version=UNSIGNED))


def download(s3, key: str, dest: str) -> None:
    """Download to a temp name and rename, so a killed run never leaves a
    truncated file that a later run would trust."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + '.part'
    s3.download_file(SOURCE_BUCKET, key, part)
    os.replace(part, dest)


def read_parquet(path: str) -> pd.DataFrame:
    df = pd.read_parquet(path)
    df = df.drop(columns=[c for c in ('raw_html', 'scraped_at') if c in df.columns])
    # psycopg2 can't adapt pd.NA; coerce every NA/NaN to None (SQL NULL).
    return df.astype(object).where(pd.notna(df), None)


def find_new_rows(cur, df: pd.DataFrame) -> list[dict]:
    new = []
    for _, row in df.iterrows():
        cnr = row.get('cnr') or ''
        path = row.get('path') or ''
        if not (cnr or path):
            continue
        if not sc_case_exists(cur, cnr, path):
            new.append(row.to_dict())
    return new


def ensure_pdfs(s3, year: int, year_dir: str, pdfs_dir: str, rows: list[dict]) -> None:
    """Make sure every new row's PDF is on disk, refreshing the tar if not.

    Extracts only the members we need: the year's other PDFs are either
    already loaded or never will be.
    """
    missing = [r['path'] for r in rows if r.get('path') and not find_pdf_in_dir(pdfs_dir, r['path'])]
    if not missing:
        return
    tar_path = os.path.join(year_dir, 'english.tar')
    tar_key = f'data/tar/year={year}/english/english.tar'
    # The tar is 50-180 MB. Only fetch it when upstream has changed it since
    # our copy — otherwise a row upstream lists before publishing its PDF
    # would cost a full re-download on every run until the PDF lands.
    etag_path = tar_path + '.etag'
    remote_etag = s3.head_object(Bucket=SOURCE_BUCKET, Key=tar_key)['ETag']
    local_etag = open(etag_path).read() if os.path.exists(etag_path) else None
    if os.path.exists(tar_path) and local_etag == remote_etag:
        print(f'  {year}: {len(missing)} PDFs not on disk; english.tar unchanged upstream', flush=True)
    else:
        print(f'  {year}: {len(missing)} PDFs not on disk, refreshing english.tar', flush=True)
        download(s3, tar_key, tar_path)
        with open(etag_path, 'w') as f:
            f.write(remote_etag)
    wanted = set()
    for p in missing:
        wanted.update({p, f'{p}.pdf', f'{p}_EN.pdf'})
    os.makedirs(pdfs_dir, exist_ok=True)
    with tarfile.open(tar_path, 'r') as tar:
        members = [m for m in tar.getmembers() if os.path.basename(m.name) in wanted]
        tar.extractall(pdfs_dir, members=members, filter='data')
    print(f'  {year}: extracted {len(members)} PDFs', flush=True)


def load_year(conn, s3, r2, year: int, rows: list[dict], stats: dict) -> list[int]:
    year_dir = os.path.join(SC_DATA_DIR, f'year={year}')
    pdfs_dir = os.path.join(year_dir, 'pdfs')
    ensure_pdfs(s3, year, year_dir, pdfs_dir, rows)

    inserted_ids = []
    cur = conn.cursor()
    for row in rows:
        path = row.get('path') or ''
        pdf_file = find_pdf_in_dir(pdfs_dir, path)
        if not pdf_file:
            stats['awaiting_pdf'].append(path)
            continue
        try:
            case_id = insert_sc_case(cur, row, year, pdf_file, r2, require_r2=r2 is not None)
            conn.commit()
            inserted_ids.append(case_id)
            print(f'  + {path} -> id {case_id}', flush=True)
        except Exception as e:
            conn.rollback()
            stats['failed_load'].append(path)
            print(f'  ! load failed for {path}: {e}', flush=True)
            log_error('pipeline', f'sync_sc: load failed for {path}: {e}', error=e,
                      metadata={'path': path, 'year': year})
    cur.close()
    return inserted_ids


def extract_pending(conn, years: list[int], stats: dict) -> None:
    # Imported here: extract_fields pulls in the whole extraction stack.
    from extract_fields import get_anthropic_client, process_case

    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(
        f"""SELECT id, judgment_text, year, path FROM {TABLE}
            WHERE judgment_text IS NOT NULL
              AND (extraction_status = 'pending' OR extraction_status IS NULL)
              AND year = ANY(%s)
            ORDER BY id""",
        (years,),
    )
    rows = cur.fetchall()
    cur.close()
    if not rows:
        return
    print(f'Extracting fields for {len(rows)} cases', flush=True)
    anthropic_client = get_anthropic_client()
    for row in rows:
        try:
            result = process_case(conn, TABLE, row['id'], row['judgment_text'],
                                  tier2_only=False, anthropic_client=anthropic_client,
                                  row=row)
            status = result.get('status')
        except Exception as e:
            conn.rollback()
            status = 'failed'
            print(f'  ! extraction crashed for id {row["id"]}: {e}', flush=True)
        if status == 'completed':
            stats['extracted'] += 1
        else:
            stats['failed_extract'].append(row['id'])


def embed_pending(conn, years: list[int], stats: dict) -> None:
    from reembed_all import embed_one_case, fetch_pending_cases

    cur = conn.cursor()
    cases = fetch_pending_cases(cur, TABLE, None, years)
    if cases:
        print(f'Embedding {len(cases)} cases', flush=True)
        voyage_client = voyageai.Client(api_key=VOYAGE_API_KEY)
        for case in cases:
            n = embed_one_case(conn, cur, voyage_client, TABLE, case, VOYAGE_BATCH_SIZE)
            stats['chunks'] += n
    # embed_one_case reports partial counts when it gives up, so judge success
    # by what is left pending rather than by its return value.
    stats['failed_embed'] = [c['id'] for c in fetch_pending_cases(cur, TABLE, None, years)]
    stats['embedded'] = len(cases) - len(stats['failed_embed'])
    cur.close()


def unsearchable(conn, ids: list[int]) -> list[int]:
    """Cases inserted this run that still have no chunks (vector search and
    chat retrieval can't reach them)."""
    if not ids:
        return []
    cur = conn.cursor()
    cur.execute(
        """SELECT c.id FROM supreme_court_cases c
           WHERE c.id = ANY(%s) AND NOT EXISTS (
             SELECT 1 FROM case_chunks k
             WHERE k.source_table = 'supreme_court_cases' AND k.source_id = c.id)""",
        (ids,),
    )
    out = [r[0] for r in cur.fetchall()]
    cur.close()
    return out


def acquire_lock():
    os.makedirs(SC_DATA_DIR, exist_ok=True)
    fh = open(os.path.join(SC_DATA_DIR, '.sync.lock'), 'w')
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return None
    return fh


def main() -> int:
    this_year = datetime.date.today().year
    ap = argparse.ArgumentParser(description='Incremental Supreme Court sync')
    ap.add_argument('--years', type=int, nargs='+', default=[this_year - 1, this_year])
    ap.add_argument('--dry-run', action='store_true',
                    help='Report new rows per year; download no PDFs, write nothing')
    ap.add_argument('--limit', type=int, default=None,
                    help='Insert at most N new rows per year (testing)')
    ap.add_argument('--max-new', type=int, default=DEFAULT_MAX_NEW,
                    help='Refuse to run if more new rows than this (default %(default)s)')
    ap.add_argument('--skip-r2', action='store_true',
                    help='Do not upload PDFs to R2 (local test runs only)')
    ap.add_argument('--skip-extract', action='store_true')
    ap.add_argument('--skip-embed', action='store_true')
    args = ap.parse_args()

    lock = acquire_lock()
    if lock is None:
        print('Another sync_sc run holds the lock; exiting.', file=sys.stderr)
        return 2

    started = time.time()
    stats = {
        'years': args.years, 'new_upstream': {}, 'inserted': 0, 'extracted': 0,
        'embedded': 0, 'chunks': 0, 'awaiting_pdf': [], 'failed_load': [],
        'failed_extract': [], 'failed_embed': [], 'unsearchable': [],
    }

    s3 = source_client()
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    pending: dict[int, list[dict]] = {}
    for year in args.years:
        meta = os.path.join(SC_DATA_DIR, f'year={year}', 'metadata.parquet')
        try:
            download(s3, f'metadata/parquet/year={year}/metadata.parquet', meta)
        except Exception as e:
            # A year upstream hasn't started yet (early January) has no parquet.
            print(f'{year}: no upstream metadata ({e}); skipping', flush=True)
            continue
        rows = find_new_rows(cur, read_parquet(meta))
        stats['new_upstream'][year] = len(rows)
        print(f'{year}: {len(rows)} new upstream', flush=True)
        if rows:
            pending[year] = rows[:args.limit] if args.limit else rows
    cur.close()

    total_new = sum(stats['new_upstream'].values())
    if total_new > args.max_new and not args.limit:
        msg = (f'{total_new} new rows exceeds --max-new {args.max_new}; refusing to '
               f'ingest. Check upstream and DATABASE_URL, then rerun with a higher --max-new.')
        print(msg, file=sys.stderr)
        log_error('pipeline', f'sync_sc: {msg}', severity='critical')
        conn.close()
        return 2

    if args.dry_run:
        print('SYNC_SUMMARY ' + json.dumps(stats, default=str))
        conn.close()
        return 0

    r2 = None if args.skip_r2 else get_r2_client()
    inserted_ids: list[int] = []
    for year, rows in pending.items():
        inserted_ids += load_year(conn, s3, r2, year, rows, stats)
    stats['inserted'] = len(inserted_ids)

    if not args.skip_extract:
        extract_pending(conn, args.years, stats)
    if not args.skip_embed:
        embed_pending(conn, args.years, stats)
        stats['unsearchable'] = unsearchable(conn, inserted_ids)
    conn.close()

    stats['elapsed_s'] = round(time.time() - started)
    print('SYNC_SUMMARY ' + json.dumps(stats, default=str), flush=True)

    failed = (stats['failed_load'] or stats['failed_extract']
              or stats['failed_embed'] or stats['unsearchable'])
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
