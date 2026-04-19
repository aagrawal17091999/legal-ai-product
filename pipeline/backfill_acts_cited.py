#!/usr/bin/env python3
"""
Backfill `acts_cited` for existing rows using the consensus pipeline.

For each row:
  1. Resolve the PDF (local first, else download from R2) and run the
     layout-aware extractor → layout_acts.
  2. Run the tightened text-regex extractor on judgment_text → text_acts.
  3. Reuse any stored LLM-extracted acts as the LLM vote (no new LLM call
     unless --with-llm is passed, which re-runs Haiku).
  4. Combine via decide_acts_cited(); write acts_cited + acts_cited_method
     + acts_cited_confidence + acts_cited_alternatives.

Usage:
  python pipeline/backfill_acts_cited.py                 # both SC + HC
  python pipeline/backfill_acts_cited.py --source sc     # SC only
  python pipeline/backfill_acts_cited.py --limit 50      # first 50 rows
  python pipeline/backfill_acts_cited.py --dry-run       # compute, no writes
  python pipeline/backfill_acts_cited.py --with-llm      # re-run LLM too
  python pipeline/backfill_acts_cited.py --min-confidence 0.7  # only write if
                                                         # new confidence >= 0.7

Prereqs: apply migrations/006_extraction_confidence.sql before running.
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

from extraction_utils import extract_acts_cited, extract_acts_cited_layout
from acts_consensus import decide_acts_cited
from pdf_resolver import resolve_pdf

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


def _as_list(val):
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return []


def _resolve_layout_acts(source: str, row) -> list[str] | None:
    """Locate the PDF and run the layout extractor. Returns None if unavailable."""
    try:
        if source == "sc":
            year = row["year"]
            path = row["path"]
            if not year or not path:
                return None
            with resolve_pdf("sc", year=year, path=path) as pdf_path:
                if not pdf_path:
                    return None
                return extract_acts_cited_layout(pdf_path)
        else:
            year = row["year"]
            court_name = row["court_name"]
            pdf_link = row["pdf_link"]
            if not year or not court_name or not pdf_link:
                return None
            with resolve_pdf(
                "hc", year=year, court_name=court_name, pdf_link=pdf_link
            ) as pdf_path:
                if not pdf_path:
                    return None
                return extract_acts_cited_layout(pdf_path)
    except Exception as e:
        logger.debug(f"Layout extraction failed for row {row['id']}: {e}")
        return None


def _maybe_rerun_llm(judgment_text: str, client) -> list[str] | None:
    """Re-run Haiku just for acts_cited. Only called when --with-llm is set."""
    if client is None:
        return None
    try:
        from extraction_llm import extract_via_haiku
        result = extract_via_haiku(judgment_text, client)
        val = result.get("acts_cited")
        return val if isinstance(val, list) else None
    except Exception as e:
        logger.debug(f"LLM re-run failed: {e}")
        return None


def backfill_table(
    conn,
    table: str,
    source: str,
    limit: int | None,
    dry_run: bool,
    with_llm: bool,
    min_confidence: float,
):
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    if table == "supreme_court_cases":
        cols = "id, judgment_text, acts_cited, year, path"
    else:
        cols = "id, judgment_text, acts_cited, year, court_name, pdf_link"

    query = (
        f"SELECT {cols} FROM {table} "
        f"WHERE judgment_text IS NOT NULL ORDER BY id"
    )
    if limit:
        query += f" LIMIT {int(limit)}"
    cur.execute(query)
    rows = cur.fetchall()
    cur.close()

    logger.info(f"[{table}] loaded {len(rows)} rows")

    client = None
    if with_llm:
        try:
            import anthropic
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if api_key:
                client = anthropic.Anthropic(api_key=api_key)
            else:
                logger.warning("ANTHROPIC_API_KEY not set; --with-llm ignored")
        except ImportError:
            logger.warning("anthropic package not installed; --with-llm ignored")

    write_cur = conn.cursor()
    updated = 0
    unchanged = 0
    skipped_low_conf = 0
    layout_hits = 0
    text_hits = 0

    for i, row in enumerate(rows):
        case_id = row["id"]
        text = row["judgment_text"] or ""
        stored_acts = _as_list(row["acts_cited"])

        layout_acts = _resolve_layout_acts(source, row)
        text_acts = extract_acts_cited(text) if text else []
        llm_acts = _maybe_rerun_llm(text, client) if with_llm else stored_acts

        if layout_acts:
            layout_hits += 1
        if text_acts:
            text_hits += 1

        consensus = decide_acts_cited(
            layout_result=layout_acts,
            text_result=text_acts if text_acts else None,
            llm_result=llm_acts if llm_acts else None,
        )

        if consensus.confidence < min_confidence and stored_acts:
            skipped_low_conf += 1
            continue

        if consensus.acts == stored_acts and not dry_run:
            # Still update method/confidence/alternatives — first backfill run
            # after migration, row may be missing them.
            write_cur.execute(
                f"UPDATE {table} SET acts_cited_method = %s, "
                f"acts_cited_confidence = %s, "
                f"acts_cited_alternatives = %s::jsonb WHERE id = %s",
                (
                    consensus.method,
                    float(consensus.confidence),
                    json.dumps(consensus.alternatives),
                    case_id,
                ),
            )
            unchanged += 1
            continue

        updated += 1
        if dry_run:
            logger.info(
                f"[{table}] id={case_id} method={consensus.method} "
                f"conf={consensus.confidence:.2f} "
                f"before={len(stored_acts)} after={len(consensus.acts)}"
            )
            if updated <= 5:
                logger.info(f"  before: {stored_acts}")
                logger.info(f"  after:  {consensus.acts}")
            continue

        write_cur.execute(
            f"UPDATE {table} SET "
            f"acts_cited = %s::jsonb, "
            f"acts_cited_method = %s, "
            f"acts_cited_confidence = %s, "
            f"acts_cited_alternatives = %s::jsonb "
            f"WHERE id = %s",
            (
                json.dumps(consensus.acts),
                consensus.method,
                float(consensus.confidence),
                json.dumps(consensus.alternatives),
                case_id,
            ),
        )

        if (i + 1) % 100 == 0:
            conn.commit()
            logger.info(f"[{table}] checkpoint at {i + 1}/{len(rows)}")

    if not dry_run:
        conn.commit()
    write_cur.close()

    logger.info(
        f"[{table}] done: updated={updated} unchanged={unchanged} "
        f"skipped_low_conf={skipped_low_conf} "
        f"layout_hits={layout_hits} text_hits={text_hits} "
        f"{'(dry-run, no writes)' if dry_run else ''}"
    )
    return updated


def main():
    parser = argparse.ArgumentParser(description="Backfill acts_cited via consensus pipeline")
    parser.add_argument("--source", choices=["sc", "hc", "both"], default="both")
    parser.add_argument("--limit", type=int, default=None, help="Limit rows per table")
    parser.add_argument("--dry-run", action="store_true", help="Compute but do not write")
    parser.add_argument("--with-llm", action="store_true",
                        help="Re-run Haiku for the LLM vote (costs API quota)")
    parser.add_argument("--min-confidence", type=float, default=0.0,
                        help="Only overwrite stored acts_cited if new confidence >= this")
    args = parser.parse_args()

    load_env()
    conn = get_db_connection()

    try:
        targets = []
        if args.source in ("sc", "both"):
            targets.append(("sc", SOURCE_MAP["sc"]))
        if args.source in ("hc", "both"):
            targets.append(("hc", SOURCE_MAP["hc"]))

        total = 0
        for source, table in targets:
            total += backfill_table(
                conn, table, source, args.limit,
                args.dry_run, args.with_llm, args.min_confidence,
            )

        logger.info(f"TOTAL updated: {total} {'(dry-run)' if args.dry_run else ''}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
