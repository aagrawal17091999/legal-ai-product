#!/usr/bin/env python3
"""
Sample 50 random rows, run the full acts_cited consensus pipeline, and print
a diff against the currently-stored value. Read-only: never writes to DB.

Usage:
  python scripts/test_acts_50.py                  # 50 random SC rows
  python scripts/test_acts_50.py --source hc      # 50 random HC rows
  python scripts/test_acts_50.py --count 100      # different sample size
  python scripts/test_acts_50.py --id 1234        # single specific row
  python scripts/test_acts_50.py --only-diffs     # suppress unchanged rows
  python scripts/test_acts_50.py --with-llm       # include LLM vote
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

from extraction_utils import extract_acts_cited, extract_acts_cited_layout
from acts_consensus import decide_acts_cited
from pdf_resolver import resolve_pdf

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

SOURCE_MAP = {"sc": "supreme_court_cases", "hc": "high_court_cases"}


def load_env():
    try:
        from dotenv import load_dotenv
        for name in (".env.local", ".env"):
            p = ROOT / name
            if p.exists():
                load_dotenv(p)
                return
    except ImportError:
        pass


def get_db_connection():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set")
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


def _resolve_layout(source, row):
    try:
        if source == "sc":
            with resolve_pdf("sc", year=row["year"], path=row["path"]) as p:
                return extract_acts_cited_layout(p) if p else None
        with resolve_pdf(
            "hc", year=row["year"], court_name=row["court_name"], pdf_link=row["pdf_link"]
        ) as p:
            return extract_acts_cited_layout(p) if p else None
    except Exception as e:
        logger.debug(f"layout failed: {e}")
        return None


def _llm_vote(text, client):
    if client is None or not text:
        return None
    try:
        from extraction_llm import extract_via_haiku
        result = extract_via_haiku(text, client)
        val = result.get("acts_cited")
        return val if isinstance(val, list) else None
    except Exception as e:
        logger.debug(f"LLM failed: {e}")
        return None


def sample_rows(conn, source, count, case_id=None):
    table = SOURCE_MAP[source]
    cols = "id, judgment_text, acts_cited, year, path" if source == "sc" \
        else "id, judgment_text, acts_cited, year, court_name, pdf_link"
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    if case_id:
        cur.execute(f"SELECT {cols} FROM {table} WHERE id = %s", (case_id,))
    else:
        cur.execute(
            f"SELECT {cols} FROM {table} "
            f"WHERE judgment_text IS NOT NULL "
            f"ORDER BY random() LIMIT %s",
            (count,),
        )
    return cur.fetchall()


def format_list(items):
    if not items:
        return "  (empty)"
    return "\n".join(f"  - {it}" for it in items)


def main():
    parser = argparse.ArgumentParser(description="Dry-run acts_cited consensus on sample rows")
    parser.add_argument("--source", choices=["sc", "hc"], default="sc")
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--id", type=int, default=None, help="Single row ID")
    parser.add_argument("--only-diffs", action="store_true",
                        help="Skip rows where stored matches new consensus")
    parser.add_argument("--with-llm", action="store_true",
                        help="Include LLM vote (uses ANTHROPIC_API_KEY)")
    args = parser.parse_args()

    load_env()
    conn = get_db_connection()

    client = None
    if args.with_llm:
        try:
            import anthropic
            key = os.environ.get("ANTHROPIC_API_KEY")
            client = anthropic.Anthropic(api_key=key) if key else None
        except ImportError:
            pass

    rows = sample_rows(conn, args.source, args.count, args.id)
    print(f"Sampled {len(rows)} rows from {SOURCE_MAP[args.source]}\n")

    stats = {
        "total": len(rows),
        "same": 0,
        "diff": 0,
        "layout_hits": 0,
        "empty_before": 0,
        "empty_after": 0,
        "by_method": {},
        "by_conf_bucket": {"1.0": 0, "0.85+": 0, "0.7+": 0, "0.5+": 0, "<0.5": 0},
    }

    for row in rows:
        stored = _as_list(row["acts_cited"])
        text = row["judgment_text"] or ""

        layout_acts = _resolve_layout(args.source, row)
        text_acts = extract_acts_cited(text)
        llm_acts = _llm_vote(text, client) if args.with_llm else None

        if layout_acts is not None:
            stats["layout_hits"] += 1

        consensus = decide_acts_cited(layout_acts, text_acts or None, llm_acts)
        if not stored:
            stats["empty_before"] += 1
        if not consensus.acts:
            stats["empty_after"] += 1

        stats["by_method"][consensus.method] = stats["by_method"].get(consensus.method, 0) + 1

        conf = consensus.confidence
        if conf >= 1.0:
            stats["by_conf_bucket"]["1.0"] += 1
        elif conf >= 0.85:
            stats["by_conf_bucket"]["0.85+"] += 1
        elif conf >= 0.7:
            stats["by_conf_bucket"]["0.7+"] += 1
        elif conf >= 0.5:
            stats["by_conf_bucket"]["0.5+"] += 1
        else:
            stats["by_conf_bucket"]["<0.5"] += 1

        same = consensus.acts == stored
        if same:
            stats["same"] += 1
        else:
            stats["diff"] += 1

        if args.only_diffs and same:
            continue

        print("=" * 72)
        print(f"id={row['id']}  method={consensus.method}  conf={consensus.confidence:.2f}  "
              f"layout={'✓' if layout_acts is not None else '—'}")
        print("-- STORED --")
        print(format_list(stored))
        print("-- NEW CONSENSUS --")
        print(format_list(consensus.acts))
        if not same and consensus.alternatives.get("unmatched", {}).get("layout"):
            print(f"-- layout unmatched: {consensus.alternatives['unmatched']['layout']}")
        print()

    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)
    for k, v in stats.items():
        if isinstance(v, dict):
            print(f"{k}:")
            for sk, sv in v.items():
                print(f"  {sk}: {sv}")
        else:
            print(f"{k}: {v}")


if __name__ == "__main__":
    main()
