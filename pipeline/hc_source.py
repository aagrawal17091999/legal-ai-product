"""Upstream access for High Court ingestion: s3://indian-high-court-judgments.

Layout (measured 2026-10-28):
  data/tar/year=Y/court=C/bench=B/data.index.json   file list for that folder
  data/pdf/year=Y/court=C/bench=B/<file>.pdf        every PDF, individually
  metadata/parquet/year=Y/court=C/bench=B/metadata.parquet

Facts that shaped this module:
  - `year=` is NOT the decision year (Delhi's year=2015 holds 2018-2020
    decisions). The decision date is in the filename: CNR_ORDERNO_YYYY-MM-DD.pdf.
  - `pdf_exists` in the metadata is False/NULL on every row. The index files
    are the only reliable list of PDFs that exist.
  - Courts have several benches (Madurai, Lucknow, Nagpur, ...), each its own
    folder. Older code that took the first bench missed most of them.
  - Recent folders hold several part-*.tar files; the index lists them all.
    We never touch the tars: PDFs are fetched one by one from data/pdf/, which
    is what makes 1,000-document batches cheap.

The manifest is a SQLite file, not a DataFrame: 19M filenames are ~2 GB as
pandas strings, too much next to Postgres and the app on the prod box.
"""

import datetime
import json
import os
import re
import sqlite3
import time
import urllib.request

BUCKET = 'indian-high-court-judgments'
REGION = 'ap-south-1'
BASE_URL = f'https://{BUCKET}.s3.{REGION}.amazonaws.com/'

# Courts the pipeline may load. Delhi only until its batches are reviewed;
# HC_COURTS=7_26,29_3 widens it, HC_COURTS=all lifts it.
_courts = os.getenv('HC_COURTS', '7_26').strip()
ALLOWED_COURTS = None if _courts == 'all' else [c.strip() for c in _courts.split(',') if c.strip()]

# court_key (the court= folder) -> the name stored in high_court_cases.court_name.
# Upstream spells some of these inconsistently ('High Court Of Rajasthan',
# 'High Court  for State of Telangana'); the filter dropdown shows these values.
COURT_NAMES = {
    '9_13': 'Allahabad High Court',
    '28_2': 'High Court of Andhra Pradesh',
    '27_1': 'Bombay High Court',
    '19_16': 'Calcutta High Court',
    '22_18': 'High Court of Chhattisgarh',
    '7_26': 'High Court of Delhi',
    '18_6': 'Gauhati High Court',
    '24_17': 'High Court of Gujarat',
    '2_5': 'High Court of Himachal Pradesh',
    '1_12': 'High Court of Jammu and Kashmir and Ladakh',
    '20_7': 'High Court of Jharkhand',
    '29_3': 'High Court of Karnataka',
    '32_4': 'High Court of Kerala',
    '23_23': 'High Court of Madhya Pradesh',
    '33_10': 'Madras High Court',
    '14_25': 'High Court of Manipur',
    '17_21': 'High Court of Meghalaya',
    '21_11': 'Orissa High Court',
    '10_8': 'Patna High Court',
    '3_22': 'High Court of Punjab and Haryana',
    '8_9': 'High Court of Rajasthan',
    '11_24': 'High Court of Sikkim',
    '36_29': 'High Court for the State of Telangana',
    '16_20': 'High Court of Tripura',
    '5_15': 'High Court of Uttarakhand',
}

_FILE_DATE = re.compile(r'_(\d{4})-(\d{2})-(\d{2})\.pdf$', re.I)
_FOLDER = re.compile(r'year=(\d+)/court=([^/]+)/bench=([^/]+)/')


def decision_date_from_file(name: str) -> str | None:
    """ISO date from the filename, or None when missing or implausible.

    About 5% of upstream names carry no date, and a few hundred carry typo
    years (2101, 2913, ...). Those sort last instead of first.
    """
    m = _FILE_DATE.search(name)
    if not m:
        return None
    try:
        d = datetime.date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None
    if d.year < 1947 or d > datetime.date.today() + datetime.timedelta(days=1):
        return None
    return d.isoformat()


def pdf_url(folder_year: int, court_key: str, bench: str, source_file: str) -> str:
    return f'{BASE_URL}data/pdf/year={folder_year}/court={court_key}/bench={bench}/{source_file}'


def _get(url: str, timeout: int = 120, attempts: int = 4) -> bytes:
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network blips and S3 503 SlowDown both retry
            last = e
            time.sleep(2 ** i)
    raise RuntimeError(f'GET {url} failed after {attempts} attempts: {last}')


def download_pdf(folder_year: int, court_key: str, bench: str, source_file: str) -> bytes:
    return _get(pdf_url(folder_year, court_key, bench, source_file), timeout=90, attempts=3)


def _s3_client():
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config
    return boto3.client('s3', region_name=REGION, config=Config(signature_version=UNSIGNED))


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    source_file   TEXT PRIMARY KEY,
    folder_year   INTEGER NOT NULL,
    court_key     TEXT NOT NULL,
    bench         TEXT NOT NULL,
    decision_date TEXT,                 -- ISO, NULL sorts last
    status        TEXT NOT NULL DEFAULT 'todo'    -- todo | done | failed
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS files_queue ON files (status, decision_date DESC);
CREATE TABLE IF NOT EXISTS index_files (
    key  TEXT PRIMARY KEY,
    etag TEXT NOT NULL,
    file_count INTEGER
);
"""


def open_manifest(path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path, timeout=60)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=NORMAL')
    # 128 MB page cache: 19M random-order primary keys slow to a crawl on the
    # 2 MB default once the B-tree outgrows it (the first build took 28 min).
    db.execute('PRAGMA cache_size=-131072')
    db.executescript(SCHEMA)
    return db


def list_index_files() -> list[tuple[str, str]]:
    """(key, etag) for every data.index.json upstream (~3,000 objects)."""
    s3 = _s3_client()
    out = []
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix='data/tar/'):
        for obj in page.get('Contents', []):
            if obj['Key'].endswith('data.index.json'):
                out.append((obj['Key'], obj['ETag']))
    return out


def refresh_manifest(db: sqlite3.Connection, workers: int = 16, log=print) -> dict:
    """Add files from every index that is new or changed since the last refresh.

    The first run reads all ~3,000 indexes (~865 MB) and writes ~19M rows.
    Later runs only re-read folders upstream has touched, so a weekly refresh
    is a few dozen. INSERT OR IGNORE keeps the status of files already known.
    """
    import concurrent.futures as cf

    known = dict(db.execute('SELECT key, etag FROM index_files'))
    upstream = list_index_files()
    changed = [(k, e) for k, e in upstream if known.get(k) != e]
    log(f'manifest: {len(upstream)} upstream indexes, {len(changed)} new or changed')
    before = db.execute('SELECT COUNT(*) FROM files').fetchone()[0]
    first_build = before == 0
    if first_build:
        # Maintaining the queue index row by row doubles the write cost of a
        # bulk load; building it once at the end is far cheaper.
        db.execute('DROP INDEX IF EXISTS files_queue')

    def fetch(item):
        key, etag = item
        j = json.loads(_get(BASE_URL + key))
        files = [f for p in j.get('parts', []) for f in p.get('files', [])]
        return key, etag, files

    def fetched():
        # Bounded: ex.map would queue all ~3,000 downloads at once and hold
        # their file lists in RAM (1.5 GB measured) while SQLite catches up.
        with cf.ThreadPoolExecutor(workers) as ex:
            for s in range(0, len(changed), workers * 2):
                yield from ex.map(fetch, changed[s:s + workers * 2])

    done = 0
    for key, etag, files in fetched():
        m = _FOLDER.search(key)
        fy, court, bench = int(m[1]), m[2], m[3]
        # Same filename in two folders happens (~67k of 19M): first wins.
        db.executemany(
            'INSERT OR IGNORE INTO files (source_file, folder_year, court_key, bench, decision_date) '
            'VALUES (?,?,?,?,?)',
            ((f, fy, court, bench, decision_date_from_file(f)) for f in files if f.lower().endswith('.pdf')),
        )
        db.execute('INSERT OR REPLACE INTO index_files (key, etag, file_count) VALUES (?,?,?)',
                   (key, etag, len(files)))
        db.commit()
        done += 1
        if done % 250 == 0:
            log(f'manifest: {done}/{len(changed)} indexes read')
    if first_build:
        log('manifest: building queue index')
        db.executescript(SCHEMA)
    after = db.execute('SELECT COUNT(*) FROM files').fetchone()[0]
    return {'indexes_read': len(changed), 'files_added': after - before, 'files_total': after}


def select_queue(db: sqlite3.Connection, limit: int, court: str | None = None,
                 since: str | None = None, until: str | None = None) -> list[dict]:
    """The newest `limit` files not yet done, optionally for one court / from a date.

    Newest-first is both the backfill order and the weekly-sync order: new
    judgments land at the head of the same queue, so one mechanism serves both.
    """
    sql = 'SELECT source_file, folder_year, court_key, bench, decision_date FROM files WHERE status = ?'
    params: list = ['todo']
    if court and ALLOWED_COURTS is not None and court not in ALLOWED_COURTS:
        raise ValueError(f'court {court} is not in HC_COURTS ({",".join(ALLOWED_COURTS)})')
    if court:
        sql += ' AND court_key = ?'
        params.append(court)
    elif ALLOWED_COURTS is not None:
        sql += f' AND court_key IN ({",".join("?" * len(ALLOWED_COURTS))})'
        params += ALLOWED_COURTS
    if since:
        sql += ' AND decision_date >= ?'
        params.append(since)
    if until:
        sql += ' AND decision_date <= ?'
        params.append(until)
    sql += ' ORDER BY decision_date IS NULL, decision_date DESC LIMIT ?'
    params.append(limit)
    cols = ['source_file', 'folder_year', 'court_key', 'bench', 'decision_date']
    return [dict(zip(cols, r)) for r in db.execute(sql, params)]


def mark(db: sqlite3.Connection, files: list[str], status: str) -> None:
    db.executemany('UPDATE files SET status = ? WHERE source_file = ?', ((status, f) for f in files))
    db.commit()


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------

META_COLUMNS = ['court_code', 'title', 'description', 'judge', 'pdf_link', 'cnr',
                'date_of_registration', 'decision_date', 'disposal_nature']


def fetch_metadata(docs: list[dict], log=print) -> dict[str, dict]:
    """Upstream metadata for these files, keyed by source_file.

    Reads only the needed columns of only the needed folders' parquets (S3
    range reads), skipping raw_html, which is ~95% of the 8 GB of metadata.
    A file with no metadata row (some mobile-backfilled ones) is simply absent
    from the result; the loader falls back to what the filename says.
    """
    import pyarrow as pa
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq

    fs = pafs.S3FileSystem(anonymous=True, region=REGION)
    wanted: dict[tuple, set] = {}
    for d in docs:
        wanted.setdefault((d['folder_year'], d['court_key'], d['bench']), set()).add(d['source_file'])

    out: dict[str, dict] = {}
    for (fy, court, bench), names in wanted.items():
        path = f'{BUCKET}/metadata/parquet/year={fy}/court={court}/bench={bench}/metadata.parquet'
        try:
            schema = pq.read_schema(path, filesystem=fs)
            cols = [c for c in META_COLUMNS if c in schema.names]
            table = pq.read_table(path, columns=cols, filesystem=fs)
        except Exception as e:
            log(f'  metadata unavailable for {fy}/{court}/{bench}: {e}')
            continue
        # Match on pdf_link first and materialise only those rows: a recent
        # folder can hold 300k rows, and to_pylist() on all of it is ~1 GB.
        links = table.column('pdf_link').to_pylist()
        idx = [i for i, l in enumerate(links) if l and os.path.basename(l) in names]
        if not idx:
            log(f'  no metadata rows for {len(names)} files in {fy}/{court}/{bench}')
            continue
        for row in table.take(pa.array(idx, type=pa.int64())).to_pylist():
            out[os.path.basename(row['pdf_link'])] = row
    return out
