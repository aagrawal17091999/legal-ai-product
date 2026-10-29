#!/usr/bin/env python3
"""High Court ingestion: s3://indian-high-court-judgments -> high_court_cases.

Runs in batches so the cost of each step is visible before committing to the
next. One batch = the N newest documents not yet loaded:

  1. select   newest-first from the manifest (a local SQLite list of all ~19M
              upstream PDFs), minus anything already in the DB
  2. text     download each PDF individually; text layer where it is good,
              free Tesseract OCR per page where it is not (hc_text.py)
  3. load     one high_court_cases row per PDF, with text provenance
  4. fields   from upstream metadata for every row (free); Claude Haiku for
              documents of >= HC_LLM_MIN_PAGES pages, via Message Batches
  5. embed    voyage-law-2 chunks for every document with >= HC_EMBED_MIN_CHARS
              characters of text (copies of an already-loaded judgment skipped)
  6. record   counts, OCR quality and exact API cost in hc_ingest_batches

Documents the free OCR could not read reliably are flagged; `second-pass`
re-reads only their bad pages with Claude vision, under a spending cap.
Every Claude call goes through the Message Batches API (claude_batch): half
price, results usually within minutes.

Commands:
  python pipeline/ingest_hc.py manifest                 # build / refresh the file list
  python pipeline/ingest_hc.py batch --size 1000        # next 1,000 newest
  python pipeline/ingest_hc.py batch --size 200 --court 29_3   # one court
  python pipeline/ingest_hc.py sync                     # weekly: refresh + new judgments
  python pipeline/ingest_hc.py second-pass --max-cost-usd 5
  python pipeline/ingest_hc.py calibrate --n 40         # measure free-OCR accuracy
  python pipeline/ingest_hc.py status
  python pipeline/ingest_hc.py report [--batch ID]

Exit codes: 0 ok, 1 some documents failed (the rest were loaded), 2 refused
to run (lock held, low disk, or sync found more than --max-docs).
"""

import argparse
import concurrent.futures as cf
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import logging

import psycopg2
import psycopg2.extras

from config import DATABASE_URL, HC_DATA_DIR, VOYAGE_API_KEY, VOYAGE_BATCH_SIZE
from error_logger import log_error
import hc_source
import hc_text

# The SDKs log every HTTP request at INFO; thousands per batch drown the report.
# anthropic 2.x logs through its own 'httpx2' client, voyageai through 'httpx'.
for _name in ('httpx', 'httpx2'):
    logging.getLogger(_name).setLevel(logging.WARNING)

TABLE = 'high_court_cases'
MANIFEST = os.path.join(HC_DATA_DIR, 'manifest.sqlite')

WORKERS = int(os.getenv('HC_WORKERS', '2'))                 # parallel PDFs (OCR is 1 core each)
LLM_MIN_PAGES = int(os.getenv('HC_LLM_MIN_PAGES', '5'))     # Haiku field extraction
# Embed every document with real text, short orders included (a one-page bail
# or quashing order carries reasoning). Below this it is "list after two weeks".
EMBED_MIN_CHARS = int(os.getenv('HC_EMBED_MIN_CHARS', '500'))
MIN_FREE_GB = float(os.getenv('HC_MIN_FREE_GB', '15'))

# USD per token. Costs are recorded from reported token counts at these rates.
RATES = {
    'claude-haiku-4-5': (1.00 / 1e6, 5.00 / 1e6),
    'claude-sonnet-4-6': (3.00 / 1e6, 15.00 / 1e6),
    'voyage-law-2': 0.12 / 1e6,
}
EXTRACT_MODEL = 'claude-haiku-4-5'        # extraction_llm.extract_via_haiku pins this
EXTRACT_MODEL_ID = 'claude-haiku-4-5-20251001'
# Every Claude call goes through Message Batches (claude_batch): half price.
LLM_BATCH_TIMEOUT_S = 24 * 3600
BATCH_DISCOUNT = 0.5


def claude_rate(model: str) -> tuple[float, float]:
    for prefix, rate in RATES.items():
        if model.startswith(prefix):
            return rate
    return RATES['claude-sonnet-4-6']      # unknown model: assume the dearer one


def log(msg: str) -> None:
    print(f'[{datetime.datetime.now():%H:%M:%S}] {msg}', flush=True)


# ---------------------------------------------------------------------------
# Metering wrappers: count what every API call reports
# ---------------------------------------------------------------------------

class MeteredVoyage:
    def __init__(self, client):
        self._client = client
        self.tokens = 0

    def embed(self, *args, **kwargs):
        result = self._client.embed(*args, **kwargs)
        self.tokens += getattr(result, 'total_tokens', 0) or 0
        return result


def anthropic_client():
    import anthropic
    key = os.getenv('ANTHROPIC_API_KEY')
    if not key:
        raise RuntimeError('ANTHROPIC_API_KEY is not set')
    return anthropic.Anthropic(api_key=key)


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

def acquire_lock():
    os.makedirs(HC_DATA_DIR, exist_ok=True)
    fh = open(os.path.join(HC_DATA_DIR, '.ingest.lock'), 'w')
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return None
    return fh


def disk_ok() -> bool:
    # The pipeline runs on the DB box, so the root volume is the one that
    # fills: every 1,000 embedded judgments is roughly 0.2-0.4 GB of chunks.
    free_gb = shutil.disk_usage('/').free / 1e9
    if free_gb < MIN_FREE_GB:
        msg = f'only {free_gb:.1f} GB free (< HC_MIN_FREE_GB={MIN_FREE_GB}); refusing to load more'
        log(msg)
        log_error('pipeline', f'ingest_hc: {msg}', severity='critical')
        return False
    return True


# ---------------------------------------------------------------------------
# Step 2: text (runs in worker processes)
# ---------------------------------------------------------------------------

def _text_job(doc: dict) -> dict:
    try:
        pdf = hc_source.download_pdf(doc['folder_year'], doc['court_key'], doc['bench'], doc['source_file'])
        t = hc_text.extract(pdf, doc['court_key'])
        return {'doc': doc, 'text': t, 'bytes': len(pdf), 'error': None}
    except Exception as e:
        return {'doc': doc, 'text': None, 'error': f'{type(e).__name__}: {e}'[:500]}


# ---------------------------------------------------------------------------
# Step 3: load
# ---------------------------------------------------------------------------

def _date(v):
    if v is None or v == '':
        return None
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.date() if isinstance(v, datetime.datetime) else v
    try:
        return datetime.date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def content_hash(text: str) -> str | None:
    norm = re.sub(r'\s+', ' ', text).strip().lower()
    return hashlib.sha256(norm.encode()).hexdigest()[:32] if norm else None


def insert_doc(cur, batch_id: int, doc: dict, meta: dict | None, t: 'hc_text.DocText') -> tuple[int, bool]:
    """Insert one document. Returns (id or 0 if already present, is_duplicate)."""
    meta = meta or {}
    source_file = doc['source_file']
    decision = _date(meta.get('decision_date')) or _date(doc.get('decision_date'))
    cnr = meta.get('cnr') or source_file.split('_')[0]
    chash = content_hash(t.text)
    duplicate_of = None
    if chash:
        cur.execute(f'SELECT id FROM {TABLE} WHERE content_hash = %s AND duplicate_of IS NULL LIMIT 1', (chash,))
        hit = cur.fetchone()
        duplicate_of = hit[0] if hit else None
    cur.execute(
        f"""INSERT INTO {TABLE}
            (court_code, title, description, judge, pdf_link, cnr, date_of_registration,
             decision_date, disposal_nature, court_name, year, bench, judgment_text, pdf_url,
             source_file, page_count, text_source, text_class, ocr_pages, ocr_confidence,
             needs_second_pass, poor_pages, ingest_batch_id, content_hash, duplicate_of,
             extraction_status)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending')
            ON CONFLICT (source_file) WHERE source_file IS NOT NULL DO NOTHING
            RETURNING id""",
        (
            meta.get('court_code') or doc['court_key'], meta.get('title'), meta.get('description'),
            meta.get('judge') or None, meta.get('pdf_link'), cnr, meta.get('date_of_registration'),
            decision, (meta.get('disposal_nature') or '').strip() or None,
            hc_source.COURT_NAMES.get(doc['court_key'], doc['court_key']),
            decision.year if decision else None, doc['bench'],
            t.text or None,
            # The public upstream URL: CC-BY, AWS-sponsored, so no R2 copy of 1.5 TB.
            hc_source.pdf_url(doc['folder_year'], doc['court_key'], doc['bench'], source_file),
            source_file, t.page_count, t.text_source, t.text_class, t.ocr_pages, t.ocr_confidence,
            bool(t.poor_pages) or (not t.text and t.page_count > 0),
            t.poor_pages or None, batch_id, chash, duplicate_of,
        ),
    )
    row = cur.fetchone()
    return (row[0] if row else 0), duplicate_of is not None


def record_failure(cur, source_file: str, error: str, batch_id: int) -> int:
    cur.execute(
        """INSERT INTO hc_ingest_failures (source_file, attempts, last_error, last_batch_id)
           VALUES (%s, 1, %s, %s)
           ON CONFLICT (source_file) DO UPDATE
             SET attempts = hc_ingest_failures.attempts + 1, last_error = EXCLUDED.last_error,
                 last_batch_id = EXCLUDED.last_batch_id, updated_at = NOW()
           RETURNING attempts""",
        (source_file, error, batch_id),
    )
    return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# Step 4: fields
# ---------------------------------------------------------------------------

_HONORIFIC = re.compile(
    r"^(?:the\s+)?(?:hon'?ble|honourable|honorable)?\s*(?:the\s+)?(?:chief\s+)?(?:mr\.?|mrs\.?|ms\.?|smt\.?|dr\.?)?\s*"
    r"(?:acting\s+chief\s+|chief\s+)?(?:justice|judge)?\s*[.:]?\s*", re.I)
_VS = re.compile(r'\s+(?:vs\.?|v/s\.?|v\.|versus)\s+', re.I)


def judge_list(judge: str | None) -> list[str]:
    if not judge:
        return []
    out = []
    for part in re.split(r',|\band\b|&|;', judge, flags=re.I):
        name = _HONORIFIC.sub('', part.strip()).strip(' .,:')
        if len(name) >= 3 and any(c.isalpha() for c in name):
            out.append(name.title())
    return list(dict.fromkeys(out))


def fields_from_metadata(row: dict) -> dict:
    """What upstream metadata already says, for free. The portal title is
    'WP(C)/1164/2007 of THOMAS Vs STATE OF KERALA'."""
    title = (row.get('title') or '').strip()
    case_number = petitioner = respondent = None
    m = re.match(r'^(.+?)\s+of\s+(.+)$', title)
    rest = title
    if m and '/' in m.group(1):
        case_number, rest = m.group(1).strip(), m.group(2)
    parts = _VS.split(rest, maxsplit=1)
    if len(parts) == 2:
        petitioner, respondent = (p.strip(' ,.') or None for p in parts)
    judges = judge_list(row.get('judge'))
    disposal = (row.get('disposal_nature') or '').strip()
    return {
        'extracted_citation': None,
        'extracted_petitioner': petitioner,
        'extracted_respondent': respondent,
        'case_category': None,
        'case_number': case_number,
        'judge_names': judges,
        'author_judge_name': judges[0] if len(judges) == 1 else None,
        'issue_for_consideration': None,
        'headnotes': None,
        'cases_cited': [],
        'acts_cited': [],
        'keywords': [],
        'case_arising_from': {},
        'bench_size': len(judges) or None,
        'result_of_case': disposal.capitalize() if disposal else None,
    }


def composed_title(fields: dict) -> str | None:
    pet, res, num = fields.get('extracted_petitioner'), fields.get('extracted_respondent'), fields.get('case_number')
    parties = f'{pet} Vs {res}' if pet and res else None
    if num and parties:
        return f'{num} of {parties}'
    return parties or num


def merge_fields(base: dict, llm: dict) -> dict:
    out = dict(base)
    for k, v in llm.items():
        if v not in (None, '', [], {}) and k in out:
            out[k] = v
    # Upstream's own case number and bench are authoritative; the model reads
    # them off the first page and sometimes picks a connected matter instead.
    if base.get('case_number'):
        out['case_number'] = base['case_number']
    if base.get('judge_names') and not llm.get('judge_names'):
        out['judge_names'] = base['judge_names']
    return out


def claude_batch(requests: list[dict], label: str) -> tuple[dict, int, int]:
    """Run Claude requests through the Message Batches API, the only way this
    pipeline calls Claude: half price, and nothing here waits on an answer.
    Usually minutes; the API allows up to 24 h.

    requests: [{'custom_id': str, 'params': {...messages.create kwargs}}].
    Returns ({custom_id: Message} for the ones that succeeded, input tokens,
    output tokens). Callers decide what to do with the ones that didn't.
    Splits into several batches below the API's 100k-request / 256 MB caps
    (page images make OCR requests large)."""
    import json as _json

    if not requests:
        return {}, 0, 0
    client = anthropic_client()
    chunks, cur, size = [], [], 0
    for r in requests:
        n = len(_json.dumps(r['params']))
        if cur and (len(cur) >= 50_000 or size + n > 180_000_000):
            chunks.append(cur)
            cur, size = [], 0
        cur.append(r)
        size += n
    chunks.append(cur)

    batches = [client.messages.batches.create(requests=c) for c in chunks]
    log(f'{label}: {len(requests)} requests in message batch(es) {", ".join(b.id for b in batches)}')
    started = last_log = time.time()
    cancelled: set[str] = set()
    while any(b.processing_status != 'ended' for b in batches):
        time.sleep(20)
        for i, b in enumerate(batches):
            if b.processing_status == 'ended':
                continue
            if b.id not in cancelled and time.time() - started > LLM_BATCH_TIMEOUT_S:
                log(f'{label}: {b.id} still running after {LLM_BATCH_TIMEOUT_S // 3600} h; cancelling')
                client.messages.batches.cancel(b.id)     # finished requests still come back
                cancelled.add(b.id)
            batches[i] = client.messages.batches.retrieve(b.id)
        if time.time() - last_log > 300:
            done = sum(b.request_counts.succeeded for b in batches)
            log(f'{label}: {done}/{len(requests)} done after {time.time() - started:.0f}s')
            last_log = time.time()

    out: dict = {}
    in_tok = out_tok = 0
    for b in batches:
        for item in client.messages.batches.results(b.id):
            if item.result.type == 'succeeded':
                msg = item.result.message
                in_tok += msg.usage.input_tokens
                out_tok += msg.usage.output_tokens
                out[item.custom_id] = msg
    log(f'{label}: ended after {time.time() - started:.0f}s, {len(out)}/{len(requests)} succeeded')
    return out, in_tok, out_tok


def message_text(msg) -> str:
    return ''.join(b.text for b in msg.content if getattr(b, 'type', None) == 'text')


def haiku_fields(rows: list[dict], stats: dict) -> dict[int, dict]:
    """Field extraction with the same prompt and model as
    extraction_llm.extract_via_haiku, through claude_batch. A request that
    fails or returns unparseable JSON gets one more try in a follow-up batch;
    after that the document keeps its metadata fields."""
    from extraction_llm import EXTRACTION_SYSTEM_PROMPT, MAX_INPUT_CHARS, _parse_json_response, _validate_result

    results: dict[int, dict] = {}
    todo = rows
    for attempt in (1, 2):
        msgs, in_tok, out_tok = claude_batch([{
            'custom_id': str(r['id']),
            'params': {
                'model': EXTRACT_MODEL_ID, 'max_tokens': 4096, 'system': EXTRACTION_SYSTEM_PROMPT,
                'messages': [{'role': 'user', 'content': 'Extract structured fields from this Indian court '
                              f"judgment.\n\nJUDGMENT TEXT:\n{r['judgment_text'][:MAX_INPUT_CHARS]}"}],
            },
        } for r in todo], f'fields (try {attempt})')
        stats['claude_in'] += in_tok
        stats['claude_out'] += out_tok
        rate_in, rate_out = claude_rate(EXTRACT_MODEL)
        stats['cost_extract'] += (in_tok * rate_in + out_tok * rate_out) * BATCH_DISCOUNT
        for cid, msg in msgs.items():
            try:
                results[int(cid)] = _validate_result(_parse_json_response(message_text(msg)))
            except Exception as e:
                log(f'  ! unparseable extraction for id {cid}: {e}')
        todo = [r for r in todo if r['id'] not in results]
        if not todo:
            break
    if todo:
        log(f'fields: {len(todo)} documents keep metadata-only fields after 2 tries')
    return results


def extract_fields_for(conn, ids: list[int], use_llm: bool, stats: dict) -> None:
    from extract_fields import write_results

    if not ids:
        return
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(f"""SELECT id, title, judge, disposal_nature, judgment_text, page_count, duplicate_of
                    FROM {TABLE} WHERE id = ANY(%s) AND extraction_status = 'pending'""", (ids,))
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    if not rows:
        return

    llm_rows = [r for r in rows if use_llm and r['judgment_text'] and r['duplicate_of'] is None
                and (r['page_count'] or 0) >= LLM_MIN_PAGES]
    llm_results: dict[int, dict] = {}
    if llm_rows:
        log(f'fields: Haiku on {len(llm_rows)} documents of >= {LLM_MIN_PAGES} pages')
        llm_results = haiku_fields(llm_rows, stats)
    stats['llm_docs'] += len(llm_results)

    for r in rows:
        base = fields_from_metadata(r)
        if r['id'] in llm_results:
            fields = merge_fields(base, llm_results[r['id']])
            write_results(conn, TABLE, r['id'], fields, 'hc_metadata+llm_haiku')
        else:
            fields = base
            write_results(conn, TABLE, r['id'], fields, 'hc_metadata')
        if r['duplicate_of'] is not None:
            # Same judgment as another case: share what was read from its text.
            # Case number, parties and bench stay this case's own (metadata).
            c = conn.cursor()
            c.execute(f"""UPDATE {TABLE} d SET case_category = o.case_category,
                               issue_for_consideration = o.issue_for_consideration,
                               headnotes = o.headnotes, acts_cited = o.acts_cited,
                               cases_cited = o.cases_cited, keywords = o.keywords,
                               extracted_citation = o.extracted_citation,
                               extraction_method = 'hc_metadata+copied'
                           FROM {TABLE} o WHERE d.id = %s AND o.id = d.duplicate_of
                             AND o.extraction_status = 'completed'""", (r['id'],))
            conn.commit()
            c.close()
        if not (r['title'] or '').strip():
            # No upstream metadata row: build the title the portal would have shown.
            title = composed_title(fields)
            if title:
                c = conn.cursor()
                c.execute(f'UPDATE {TABLE} SET title = %s WHERE id = %s', (title, r['id']))
                conn.commit()
                c.close()


# ---------------------------------------------------------------------------
# Step 5: embed
# ---------------------------------------------------------------------------

def embed_for(conn, ids: list[int], stats: dict) -> None:
    import voyageai
    from chunk_utils import HC_METADATA_COLUMNS
    from reembed_all import embed_one_case

    if not ids:
        return
    cur = conn.cursor()
    cur.execute(
        f"""SELECT c.id, c.judgment_text, {HC_METADATA_COLUMNS}
            FROM {TABLE} c
            LEFT JOIN reembed_progress p ON p.source_table = %s AND p.source_id = c.id
            WHERE c.id = ANY(%s) AND p.source_id IS NULL
              AND length(c.judgment_text) >= %s AND c.duplicate_of IS NULL
            ORDER BY c.id""",
        (TABLE, ids, EMBED_MIN_CHARS),
    )
    cols = [d[0] for d in cur.description]
    cases = [dict(zip(cols, r)) for r in cur.fetchall()]
    if cases:
        log(f'embed: {len(cases)} documents with >= {EMBED_MIN_CHARS} characters of text')
        voyage = MeteredVoyage(voyageai.Client(api_key=VOYAGE_API_KEY))
        for case in cases:
            stats['chunks'] += embed_one_case(conn, cur, voyage, TABLE, case, VOYAGE_BATCH_SIZE)
            stats['embedded'] += 1
        stats['voyage_tokens'] += voyage.tokens
        stats['cost_embed'] += voyage.tokens * RATES['voyage-law-2']
    cur.close()


def unsearchable(conn, ids: list[int]) -> list[int]:
    """Embed-eligible documents that still have no chunks."""
    if not ids:
        return []
    cur = conn.cursor()
    cur.execute(
        f"""SELECT c.id FROM {TABLE} c
            WHERE c.id = ANY(%s) AND length(c.judgment_text) >= %s AND c.duplicate_of IS NULL
              AND NOT EXISTS (SELECT 1 FROM case_chunks k
                              WHERE k.source_table = %s AND k.source_id = c.id)""",
        (ids, EMBED_MIN_CHARS, TABLE),
    )
    out = [r[0] for r in cur.fetchall()]
    cur.close()
    return out


# ---------------------------------------------------------------------------
# Batch bookkeeping
# ---------------------------------------------------------------------------

def new_stats() -> dict:
    return {k: 0 for k in (
        'selected', 'inserted', 'failed', 'pages', 'pages_ocr_free', 'pages_ocr_paid', 'flagged',
        'llm_docs', 'embedded', 'chunks', 'claude_in', 'claude_out', 'voyage_tokens', 'duplicates',
        'ocr_seconds', 'pdf_bytes')} | {
        'cost_extract': 0.0, 'cost_embed': 0.0, 'cost_ocr': 0.0,
        'classes': {}, 'sources': {}, 'errors': [], 'unsearchable': []}


def start_batch(conn, kind: str, args: dict) -> int:
    cur = conn.cursor()
    cur.execute('INSERT INTO hc_ingest_batches (kind, args) VALUES (%s, %s) RETURNING id',
                (kind, json.dumps(args, default=str)))
    bid = cur.fetchone()[0]
    conn.commit()
    cur.close()
    return bid


def finish_batch(conn, bid: int, stats: dict, status: str) -> None:
    cost = stats['cost_extract'] + stats['cost_embed'] + stats['cost_ocr']
    summary = {k: stats[k] for k in ('classes', 'sources', 'unsearchable', 'pdf_bytes', 'duplicates')}
    summary['errors'] = stats['errors'][:50]
    summary['cost_breakdown_usd'] = {k: round(stats[k], 4) for k in ('cost_ocr', 'cost_extract', 'cost_embed')}
    cur = conn.cursor()
    cur.execute(
        """UPDATE hc_ingest_batches SET finished_at = NOW(), status = %s,
             docs_selected = %s, docs_inserted = %s, docs_failed = %s, pages_total = %s,
             pages_ocr_free = %s, pages_ocr_paid = %s, docs_flagged = %s, docs_llm_extracted = %s,
             docs_embedded = %s, chunks_created = %s, claude_input_tokens = %s,
             claude_output_tokens = %s, voyage_tokens = %s, ocr_cpu_seconds = %s,
             cost_usd = %s, summary = %s
           WHERE id = %s""",
        (status, stats['selected'], stats['inserted'], stats['failed'], stats['pages'],
         stats['pages_ocr_free'], stats['pages_ocr_paid'], stats['flagged'], stats['llm_docs'],
         stats['embedded'], stats['chunks'], stats['claude_in'], stats['claude_out'],
         stats['voyage_tokens'], round(stats['ocr_seconds'], 1), round(cost, 4),
         json.dumps(summary, default=str), bid),
    )
    conn.commit()
    cur.close()


def interrupted_batch_ids(conn) -> list[int]:
    """Rows from batches that died after loading but before extract/embed.
    Only one run holds the lock, so any batch still 'running' is dead."""
    cur = conn.cursor()
    cur.execute("UPDATE hc_ingest_batches SET status = 'failed', finished_at = NOW() "
                "WHERE status = 'running' RETURNING id")
    dead = [r[0] for r in cur.fetchall()]
    conn.commit()
    ids: list[int] = []
    if dead:
        cur.execute(f'SELECT id FROM {TABLE} WHERE ingest_batch_id = ANY(%s)', (dead,))
        ids = [r[0] for r in cur.fetchall()]
        log(f'resuming extract/embed for {len(ids)} rows from interrupted batches {dead}')
    cur.close()
    return ids


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_manifest(_args) -> int:
    db = hc_source.open_manifest(MANIFEST)
    log(f'manifest: {hc_source.refresh_manifest(db, log=log)}')
    return 0


def run_batch(kind: str, size: int, court: str | None, since: str | None,
              use_llm: bool, dry_run: bool, until: str | None = None) -> int:
    lock = acquire_lock()
    if lock is None:
        log('another ingest_hc run holds the lock; exiting')
        return 2
    if not dry_run and not disk_ok():
        return 2

    db = hc_source.open_manifest(MANIFEST)
    if kind == 'sync' or db.execute('SELECT COUNT(*) FROM files').fetchone()[0] == 0:
        log(f'manifest: {hc_source.refresh_manifest(db, log=log)}')

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Select: newest todo files, minus anything the DB already has (a crash
    # between the DB insert and the manifest update) or that keeps failing.
    picked: list[dict] = []
    seen: set[str] = set()
    while len(picked) < size:
        # Files already picked are still 'todo' and sit at the head of the
        # queue, so each re-query must reach past them.
        cand = hc_source.select_queue(db, len(seen) + (size - len(picked)) * 2 + 50, court, since, until)
        cand = [c for c in cand if c['source_file'] not in seen]
        if not cand:
            break
        seen.update(c['source_file'] for c in cand)
        names = [c['source_file'] for c in cand]
        cur.execute(f'SELECT source_file FROM {TABLE} WHERE source_file = ANY(%s)', (names,))
        have = {r[0] for r in cur.fetchall()}
        cur.execute('SELECT source_file FROM hc_ingest_failures WHERE source_file = ANY(%s) AND attempts >= 3',
                    (names,))
        dead = {r[0] for r in cur.fetchall()}
        hc_source.mark(db, list(have), 'done')
        hc_source.mark(db, list(dead), 'failed')
        picked += [c for c in cand if c['source_file'] not in have and c['source_file'] not in dead]
    picked = picked[:size]

    by_court: dict[str, int] = {}
    for d in picked:
        by_court[d['court_key']] = by_court.get(d['court_key'], 0) + 1
    dates = sorted(d['decision_date'] for d in picked if d['decision_date'])
    log(f'selected {len(picked)} documents'
        + (f', decided {dates[0]} .. {dates[-1]}' if dates else '')
        + f'; by court: {dict(sorted(by_court.items(), key=lambda x: -x[1]))}')
    if dry_run or not picked:
        conn.close()
        return 0

    resumed = interrupted_batch_ids(conn)     # before start_batch: it would count itself
    stats = new_stats()
    stats['selected'] = len(picked)
    # Record the allowlist as the court so `status` treats the run as targeted
    # and doesn't project a Delhi-only rate onto every court.
    scope = court or (','.join(hc_source.ALLOWED_COURTS) if hc_source.ALLOWED_COURTS else None)
    bid = start_batch(conn, kind, {'size': size, 'court': scope, 'since': since, 'until': until, 'llm': use_llm,
                                   'llm_min_pages': LLM_MIN_PAGES, 'embed_min_chars': EMBED_MIN_CHARS})
    log(f'batch {bid}: fetching metadata')
    meta = hc_source.fetch_metadata(picked, log=log)
    log(f'batch {bid}: metadata for {len(meta)}/{len(picked)}; extracting text with {WORKERS} workers')

    ids: list[int] = []
    done_files, failed_files = [], []
    t0 = time.time()
    with cf.ProcessPoolExecutor(WORKERS) as ex:
        futures = [ex.submit(_text_job, d) for d in picked]
        for n, fut in enumerate(cf.as_completed(futures), 1):
            r = fut.result()
            doc = r['doc']
            if r['error']:
                attempts = record_failure(cur, doc['source_file'], r['error'], bid)
                conn.commit()
                stats['failed'] += 1
                stats['errors'].append(f"{doc['source_file']}: {r['error']}")
                if attempts >= 3:
                    failed_files.append(doc['source_file'])
            else:
                t = r['text']
                try:
                    cid, is_dup = insert_doc(cur, bid, doc, meta.get(doc['source_file']), t)
                    conn.commit()
                except Exception as e:
                    conn.rollback()
                    record_failure(cur, doc['source_file'], f'insert: {e}'[:500], bid)
                    conn.commit()
                    stats['failed'] += 1
                    stats['errors'].append(f"{doc['source_file']}: insert: {e}"[:300])
                    continue
                done_files.append(doc['source_file'])
                if cid:
                    ids.append(cid)
                    stats['inserted'] += 1
                    stats['duplicates'] += int(is_dup)
                    stats['pages'] += t.page_count
                    stats['pages_ocr_free'] += t.ocr_pages
                    stats['ocr_seconds'] += t.ocr_seconds
                    stats['pdf_bytes'] += r['bytes']
                    stats['flagged'] += int(bool(t.poor_pages) or (not t.text and t.page_count > 0))
                    stats['classes'][t.text_class] = stats['classes'].get(t.text_class, 0) + 1
                    stats['sources'][t.text_source] = stats['sources'].get(t.text_source, 0) + 1
            if n % 100 == 0 or n == len(picked):
                hc_source.mark(db, done_files, 'done')
                hc_source.mark(db, failed_files, 'failed')
                done_files, failed_files = [], []
                rate = n / max(time.time() - t0, 1e-6)
                log(f'batch {bid}: text {n}/{len(picked)} ({rate:.1f} docs/s), '
                    f'{stats["pages_ocr_free"]} pages OCR\'d, {stats["flagged"]} flagged')

    try:
        extract_fields_for(conn, resumed + ids, use_llm, stats)
        embed_for(conn, resumed + ids, stats)
        stats['unsearchable'] = unsearchable(conn, ids)
        status = 'done'
    except Exception as e:
        conn.rollback()
        status = 'failed'
        stats['errors'].append(f'post-load: {type(e).__name__}: {e}'[:500])
        log(f'batch {bid}: FAILED after loading: {e} (the next run resumes extract/embed)')
        log_error('pipeline', f'ingest_hc batch {bid} failed: {e}', error=e, severity='critical')
    finish_batch(conn, bid, stats, status)
    print_report(conn, bid)
    conn.close()
    return 0 if status == 'done' and not stats['failed'] and not stats['unsearchable'] else 1


def cmd_batch(args) -> int:
    return run_batch('batch', args.size, args.court, args.since, not args.no_llm, args.dry_run, args.until)


def cmd_sync(args) -> int:
    """Weekly: refresh the manifest and load what upstream added recently.

    Recently = decided within --window-days. Newest-first is the same order
    the backfill uses, so until the backfill reaches the window this simply
    takes the head of the queue. --max-docs caps one run's spend; anything
    beyond it waits for the next run rather than failing.
    """
    since = (datetime.date.today() - datetime.timedelta(days=args.window_days)).isoformat()
    return run_batch('sync', args.max_docs, None, since, not args.no_llm, args.dry_run)


def cmd_second_pass(args) -> int:
    """Paid OCR for the pages the free pass could not read, in one Message
    Batch (half price). Plans pages until the estimated cost reaches
    --max-cost-usd; flagged documents beyond the cap wait for the next run.
    A document whose batch requests fail stays flagged and is retried then."""
    lock = acquire_lock()
    if lock is None:
        log('another ingest_hc run holds the lock; exiting')
        return 2
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(f"""SELECT id, pdf_url, source_file, poor_pages, page_count
                    FROM {TABLE} WHERE needs_second_pass AND second_pass_at IS NULL
                      AND duplicate_of IS NULL      -- copies are not embedded; fixing them buys nothing
                    ORDER BY id LIMIT %s""", (args.limit,))
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    if not rows:
        log('second pass: nothing flagged')
        conn.close()
        return 0
    stats = new_stats()
    bid = start_batch(conn, 'second_pass', {'limit': args.limit, 'max_cost_usd': args.max_cost_usd,
                                            'model': hc_text.PAID_OCR_MODEL})
    in_rate, out_rate = claude_rate(hc_text.PAID_OCR_MODEL)
    # ~1,600 image + ~100 prompt tokens in, ~600 out per page, at batch price.
    est_page = (1700 * in_rate + 600 * out_rate) * BATCH_DISCOUNT

    # 1. Plan: which pages of which documents, within the cap.
    plan: list[dict] = []
    requests: list[dict] = []
    est = 0.0
    for r in rows:
        try:
            pdf = hc_source._get(r['pdf_url'], timeout=90, attempts=3)
            cand = hc_text.ocr_candidates(pdf)
            # A document with no usable text has no poor_pages recorded: all candidates.
            pages = sorted(set(r['poor_pages'] or cand) & set(cand))
        except Exception as e:
            stats['failed'] += 1
            stats['errors'].append(f"{r['source_file']}: {e}"[:300])
            continue
        if not pages:
            continue
        if est + len(pages) * est_page > args.max_cost_usd:
            log(f'second pass: estimated cost would pass ${args.max_cost_usd}; '
                f'{len(rows) - len(plan)} flagged documents wait for the next run')
            break
        est += len(pages) * est_page
        url = r['pdf_url'] or ''
        court = re.search(r'/court=([^/]+)/', url)
        plan.append({'row': r, 'pdf': pdf, 'pages': pages, 'court': court.group(1) if court else ''})
        requests += hc_text.paid_ocr_requests(str(r['id']), hc_text.page_jpegs(pdf, pages))
    stats['selected'] = len(plan)
    log(f'second pass: {sum(len(p["pages"]) for p in plan)} pages of {len(plan)} documents, '
        f'estimated ${est:.2f}')

    # 2. One batch for all of them.
    try:
        msgs, in_tok, out_tok = claude_batch(requests, 'paid OCR')
    except Exception as e:
        log(f'second pass: batch failed: {e}')
        log_error('pipeline', f'ingest_hc second pass {bid}: {e}', error=e, severity='critical')
        stats['errors'].append(f'batch: {e}'[:500])
        finish_batch(conn, bid, stats, 'failed')
        conn.close()
        return 1
    stats['claude_in'] += in_tok
    stats['claude_out'] += out_tok
    stats['cost_ocr'] = (in_tok * in_rate + out_tok * out_rate) * BATCH_DISCOUNT

    # 3. Rebuild each document whose every request came back.
    fixed: list[int] = []
    for p in plan:
        r, pages = p['row'], p['pages']
        groups = range((len(pages) + hc_text.PAID_PAGES_PER_CALL - 1) // hc_text.PAID_PAGES_PER_CALL)
        keys = [f"{r['id']}-{g}" for g in groups]
        if not all(k in msgs for k in keys):
            stats['failed'] += 1
            stats['errors'].append(f"{r['source_file']}: paid OCR request failed; stays flagged")
            continue
        texts: list[str] = []
        for g, k in zip(groups, keys):
            n = len(pages[g * hc_text.PAID_PAGES_PER_CALL:(g + 1) * hc_text.PAID_PAGES_PER_CALL])
            texts += hc_text.split_pages(message_text(msgs[k]), n)
        t = hc_text.extract(p['pdf'], p['court'], paid_texts=dict(zip(pages, texts)))
        c2 = conn.cursor()
        c2.execute(
            f"""UPDATE {TABLE} SET judgment_text = %s, text_source = %s, text_class = %s,
                   ocr_pages = %s, ocr_confidence = %s, needs_second_pass = FALSE,
                   second_pass_at = NOW(), extraction_status = 'pending', content_hash = %s
                 WHERE id = %s""",
            (t.text or None, t.text_source, t.text_class, t.ocr_pages, t.ocr_confidence,
             content_hash(t.text), r['id']))
        # Old chunks were built from the unreliable text.
        c2.execute('DELETE FROM case_chunks WHERE source_table = %s AND source_id = %s', (TABLE, r['id']))
        c2.execute('DELETE FROM reembed_progress WHERE source_table = %s AND source_id = %s', (TABLE, r['id']))
        conn.commit()
        c2.close()
        fixed.append(r['id'])
        stats['inserted'] += 1
        stats['pages'] += t.page_count
        stats['pages_ocr_paid'] += t.paid_pages
        log(f"  fixed id {r['id']} ({t.paid_pages} pages via {hc_text.PAID_OCR_MODEL})")
    try:
        extract_fields_for(conn, fixed, not args.no_llm, stats)
        embed_for(conn, fixed, stats)
        stats['unsearchable'] = unsearchable(conn, fixed)
        status = 'done'
    except Exception as e:
        conn.rollback()
        status = 'failed'
        stats['errors'].append(f'post-fix: {e}'[:500])
    finish_batch(conn, bid, stats, status)
    print_report(conn, bid)
    conn.close()
    return 0 if status == 'done' and not stats['failed'] else 1


def cmd_calibrate(args) -> int:
    """Free-OCR accuracy, measured: OCR pages that HAVE a clean text layer and
    compare against it. The garbled-font pages are the same kind of clean
    computer render, so this is the error rate to expect on them."""
    from rapidfuzz.distance import Levenshtein
    import pymupdf

    db = hc_source.open_manifest(MANIFEST)
    n_files = db.execute('SELECT COUNT(*) FROM files').fetchone()[0]
    if n_files == 0:
        log('manifest is empty; run `manifest` first')
        return 2
    # A full-table random sort is ~15 s on 19M rows; fine for a manual command.
    sample = db.execute('SELECT source_file, folder_year, court_key, bench FROM files '
                        'ORDER BY random() LIMIT ?', (args.n * 4,)).fetchall()
    cers, secs, done = [], [], 0
    norm = lambda s: re.sub(r'\s+', ' ', re.sub(r'[^0-9a-z ]', ' ', s.lower())).strip()
    for name, fy, court, bench in sample:
        if done >= args.n:
            break
        try:
            pdf = hc_source.download_pdf(fy, court, bench, name)
            doc = pymupdf.open(stream=pdf, filetype='pdf')
            page = doc[0]
            layer = page.get_text()
            if hc_text.classify_page(layer, hc_text.image_cover(page)) != 'ok' or len(layer) < 800:
                continue
            o = hc_text.tesseract_png(hc_text.render_page(page).tobytes('png'), 'eng')
            doc.close()
        except Exception as e:
            log(f'  skip {name}: {e}')
            continue
        a, b = norm(layer), norm(o.text)
        cers.append(Levenshtein.normalized_distance(a, b))
        secs.append(o.seconds)
        done += 1
        log(f'  {court:6} {name}: CER {cers[-1]:.3f}, conf {o.conf:.0f}, {o.seconds:.1f}s')
    if not cers:
        log('no usable pages sampled')
        return 1
    cers.sort()
    out = {'pages': len(cers), 'median_cer': round(cers[len(cers) // 2], 4),
           'p90_cer': round(cers[int(len(cers) * 0.9) - 1 if len(cers) > 1 else 0], 4),
           'mean_cer': round(sum(cers) / len(cers), 4),
           'mean_seconds_per_page': round(sum(secs) / len(secs), 2)}
    print('CALIBRATE ' + json.dumps(out), flush=True)
    return 0


def cmd_status(_args) -> int:
    db = hc_source.open_manifest(MANIFEST)
    counts = dict(db.execute('SELECT status, COUNT(*) FROM files GROUP BY status'))
    total = sum(counts.values())
    print(f'manifest: {total:,} upstream PDFs  ' + '  '.join(f'{k}={v:,}' for k, v in sorted(counts.items())))
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute(f"""SELECT COUNT(*), COUNT(*) FILTER (WHERE needs_second_pass AND second_pass_at IS NULL),
                           COALESCE(SUM(page_count), 0)
                    FROM {TABLE} WHERE source_file IS NOT NULL""")
    n, flagged, pages = cur.fetchone()
    cur.execute('SELECT COALESCE(SUM(cost_usd), 0), COUNT(*) FROM hc_ingest_batches')
    spent, batches = cur.fetchone()
    # Project only from untargeted newest-first runs: those are what the
    # backfill does. Court/era-targeted runs and paid passes would skew it.
    cur.execute("""SELECT COALESCE(SUM(cost_usd), 0), COALESCE(SUM(docs_inserted), 0)
                   FROM hc_ingest_batches WHERE kind IN ('batch', 'sync') AND status = 'done'
                     AND args->>'court' IS NULL AND args->>'until' IS NULL AND args->>'since' IS NULL""")
    rep_cost, rep_docs = cur.fetchone()
    cur.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM hc_ingest_batches WHERE kind = 'second_pass'")
    paid = cur.fetchone()[0]
    print(f'loaded:   {n:,} documents, {pages:,} pages, {flagged:,} awaiting second pass')
    print(f'spent:    ${float(spent):,.2f} over {batches} runs (${float(paid):,.2f} of it on second passes)')
    if rep_docs and total:
        per = float(rep_cost) / rep_docs
        print(f'rate:     ${per * 1000:,.2f} per 1,000 documents over {rep_docs:,} from untargeted runs; '
              f'all {total:,} at this rate: ${per * total:,.0f} (+ second passes)')
    cur.execute("""SELECT id, kind, status, started_at::timestamp(0), docs_inserted, docs_failed,
                          pages_ocr_free, pages_ocr_paid, docs_flagged, cost_usd
                   FROM hc_ingest_batches ORDER BY id DESC LIMIT 10""")
    print('\nrecent runs: id kind status started inserted failed ocr_free ocr_paid flagged cost')
    for r in cur.fetchall():
        print('  ' + '  '.join(str(x) for x in r))
    conn.close()
    return 0


def print_report(conn, bid: int) -> None:
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute('SELECT * FROM hc_ingest_batches WHERE id = %s', (bid,))
    b = cur.fetchone()
    if not b:
        print(f'no batch {bid}')
        return
    cur.execute(f"""SELECT COUNT(*) AS n,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY ocr_confidence) AS med_conf,
                      MIN(ocr_confidence) AS min_conf
                    FROM {TABLE} WHERE ingest_batch_id = %s AND ocr_confidence IS NOT NULL""", (bid,))
    q = cur.fetchone()
    n = max(b['docs_inserted'], 1)
    s = b['summary'] or {}
    cost = float(b['cost_usd'])
    lines = [
        f"\n=== HC batch {bid} ({b['kind']}, {b['status']}) ===",
        f"documents  {b['docs_inserted']} loaded ({s.get('duplicates', 0)} copies of a judgment already loaded), "
        f"{b['docs_failed']} failed, {b['docs_selected']} selected",
        f"pages      {b['pages_total']} total, {b['pages_ocr_free']} free OCR, {b['pages_ocr_paid']} paid OCR",
        f"text       classes {s.get('classes')}  sources {s.get('sources')}",
        f"OCR        {q['n']} docs OCR'd, median confidence {q['med_conf'] and round(q['med_conf'])}, "
        f"min {q['min_conf'] and round(q['min_conf'])}; {b['docs_flagged']} flagged for second pass",
        f"fields     {b['docs_llm_extracted']} via Haiku (>= {LLM_MIN_PAGES} pages), rest from metadata",
        f"search     {b['docs_embedded']} embedded (>= {EMBED_MIN_CHARS} chars) -> {b['chunks_created']} chunks; "
        f"{len(s.get('unsearchable') or [])} eligible but unsearchable",
        f"cost       ${cost:.4f} total = ${cost / n * 1000:.2f} per 1,000 docs  {s.get('cost_breakdown_usd')}",
        f"           claude {b['claude_input_tokens']:,} in / {b['claude_output_tokens']:,} out, "
        f"voyage {b['voyage_tokens']:,}, OCR CPU {b['ocr_cpu_seconds']:.0f}s",
    ]
    print('\n'.join(lines), flush=True)
    print('BATCH_SUMMARY ' + json.dumps({k: b[k] for k in (
        'id', 'kind', 'status', 'docs_selected', 'docs_inserted', 'docs_failed', 'pages_total',
        'pages_ocr_free', 'pages_ocr_paid', 'docs_flagged', 'chunks_created')} | {'cost_usd': cost}),
        flush=True)
    cur.close()


def cmd_report(args) -> int:
    conn = psycopg2.connect(DATABASE_URL)
    bid = args.batch
    if bid is None:
        cur = conn.cursor()
        cur.execute('SELECT MAX(id) FROM hc_ingest_batches')
        bid = cur.fetchone()[0]
        cur.close()
    if bid is None:
        print('no batches yet')
        return 0
    print_report(conn, bid)
    if args.samples:
        cur = conn.cursor()
        cur.execute(f"""SELECT id, court_name, text_class, text_source, ocr_confidence, left(judgment_text, 400)
                        FROM {TABLE} WHERE ingest_batch_id = %s AND ocr_pages > 0
                        ORDER BY random() LIMIT %s""", (bid, args.samples))
        for r in cur.fetchall():
            print(f'\n--- id {r[0]} | {r[1]} | {r[2]}/{r[3]} | conf {r[4]}\n{r[5]}')
    conn.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description='High Court ingestion')
    sub = ap.add_subparsers(dest='cmd', required=True)

    sub.add_parser('manifest', help='build / refresh the upstream file list')

    b = sub.add_parser('batch', help='load the next N newest documents')
    b.add_argument('--size', type=int, default=1000)
    b.add_argument('--court', help='court key, e.g. 7_26 (Delhi), 29_3 (Karnataka)')
    b.add_argument('--since', help='only documents decided on/after this date (YYYY-MM-DD)')
    b.add_argument('--until', help='only documents decided on/before this date (YYYY-MM-DD)')
    b.add_argument('--no-llm', action='store_true', help='skip Haiku field extraction')
    b.add_argument('--dry-run', action='store_true', help='show what would be selected')

    s = sub.add_parser('sync', help='weekly: refresh manifest, load recent judgments')
    s.add_argument('--window-days', type=int, default=120)
    s.add_argument('--max-docs', type=int, default=40000)
    s.add_argument('--no-llm', action='store_true')
    s.add_argument('--dry-run', action='store_true')

    p = sub.add_parser('second-pass', help='paid OCR for documents the free pass could not read')
    p.add_argument('--limit', type=int, default=200)
    p.add_argument('--max-cost-usd', type=float, default=5.0)
    p.add_argument('--no-llm', action='store_true')

    c = sub.add_parser('calibrate', help='measure free-OCR error rate against clean text layers')
    c.add_argument('--n', type=int, default=40)

    sub.add_parser('status')
    r = sub.add_parser('report')
    r.add_argument('--batch', type=int)
    r.add_argument('--samples', type=int, default=0, help='print N random OCR\'d excerpts')

    args = ap.parse_args()
    return {
        'manifest': cmd_manifest, 'batch': cmd_batch, 'sync': cmd_sync,
        'second-pass': cmd_second_pass, 'calibrate': cmd_calibrate,
        'status': cmd_status, 'report': cmd_report,
    }[args.cmd](args)


if __name__ == '__main__':
    sys.exit(main())
