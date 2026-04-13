#!/usr/bin/env python3
"""
Backfill `acts_cited` for existing rows.

Strategy per row:
  1. Re-run the regex extractor (`extract_acts_cited`) on judgment_text. If it
     returns a non-empty list, that's the new value (benefits from the new
     semicolon-based splitter).
  2. Otherwise, keep the existing stored `acts_cited` list but run it through
     the updated validator — this strips bare years and non-act fragments
     from whatever the LLM tier produced previously.

Usage:
  python pipeline/backfill_acts_cited.py                 # both SC + HC
  python pipeline/backfill_acts_cited.py --source sc     # SC only
  python pipeline/backfill_acts_cited.py --source hc     # HC only
  python pipeline/backfill_acts_cited.py --dry-run       # no writes
  python pipeline/backfill_acts_cited.py --limit 50      # first 50 rows
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extraction_utils import extract_acts_cited
from extraction_validator import _validate_acts_cited

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

SOURCE_MAP = {
    "sc": "supreme_court_cases",
    "hc": "high_court_cases",
}


def load_env():
    try:
        from dotenv import load_dotenv
        for name in (".env.local", ".env"):
            p = Path(__file__).resolve().parent.parent / name
            if p.exists():
                load_dotenv(p)
                logger.info(f"Loaded env from {p}")
                return
    except ImportError:
        logger.warning("python-dotenv not installed, using existing env vars")


def get_db_connection():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL not set. Check your .env.local file.")
        sys.exit(1)
    return psycopg2.connect(db_url)


def clean_existing(existing):
    """Run the updated validator over a stored acts_cited list."""
    if not isinstance(existing, list):
        return []
    _, fixed = _validate_acts_cited(existing, {})
    return fixed if isinstance(fixed, list) else []


def backfill_table(conn, table: str, limit: int | None, dry_run: bool):
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    query = (
        f"SELECT id, judgment_text, acts_cited FROM {table} "
        f"WHERE judgment_text IS NOT NULL ORDER BY id"
    )
    if limit:
        query += f" LIMIT {int(limit)}"
    cur.execute(query)
    rows = cur.fetchall()
    cur.close()

    logger.info(f"[{table}] loaded {len(rows)} rows")

    write_cur = conn.cursor()
    updated = 0
    regex_hits = 0
    validator_only = 0
    unchanged = 0
    cleared = 0

    for row in rows:
        case_id = row["id"]
        text = row["judgment_text"] or ""
        existing = row["acts_cited"]
        if isinstance(existing, str):
            try:
                existing = json.loads(existing)
            except Exception:
                existing = []
        if existing is None:
            existing = []

        # 1. Try fresh regex extraction
        fresh = extract_acts_cited(text)

        if fresh:
            new_value = fresh
            regex_hits += 1
        else:
            # 2. Fall back to validator-cleaned existing value
            new_value = clean_existing(existing)
            if new_value != existing:
                validator_only += 1

        if new_value == existing:
            unchanged += 1
            continue

        if not new_value and existing:
            cleared += 1

        updated += 1
        if dry_run:
            logger.info(
                f"[{table}] id={case_id} "
                f"before={len(existing)} after={len(new_value)}"
            )
            if len(rows) <= 20 or updated <= 5:
                logger.info(f"  before: {existing}")
                logger.info(f"  after:  {new_value}")
            continue

        write_cur.execute(
            f"UPDATE {table} SET acts_cited = %s::jsonb WHERE id = %s",
            (json.dumps(new_value), case_id),
        )

    if not dry_run:
        conn.commit()
    write_cur.close()

    logger.info(
        f"[{table}] done: updated={updated} unchanged={unchanged} "
        f"regex_hits={regex_hits} validator_only_fixes={validator_only} "
        f"cleared_to_empty={cleared} "
        f"{'(dry-run, no writes)' if dry_run else ''}"
    )
    return updated


def main():
    parser = argparse.ArgumentParser(description="Backfill acts_cited using updated extractor + validator")
    parser.add_argument("--source", choices=["sc", "hc", "both"], default="both")
    parser.add_argument("--limit", type=int, default=None, help="Limit rows per table (for testing)")
    parser.add_argument("--dry-run", action="store_true", help="Compute changes but do not write")
    args = parser.parse_args()

    load_env()
    conn = get_db_connection()

    try:
        tables = []
        if args.source in ("sc", "both"):
            tables.append(SOURCE_MAP["sc"])
        if args.source in ("hc", "both"):
            tables.append(SOURCE_MAP["hc"])

        total = 0
        for table in tables:
            total += backfill_table(conn, table, args.limit, args.dry_run)

        logger.info(f"TOTAL updated: {total} {'(dry-run)' if args.dry_run else ''}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
