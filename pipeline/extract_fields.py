#!/usr/bin/env python3
"""
Judgment Extraction Pipeline — Main Orchestrator

Reads judgment_text from PostgreSQL, extracts structured metadata using
Tier 1 (regex) and Tier 2 (Claude Haiku), writes results back to the database.

Usage:
  python pipeline/extract_fields.py --source sc --limit 100
  python pipeline/extract_fields.py --source sc --all
  python pipeline/extract_fields.py --source hc --limit 100
  python pipeline/extract_fields.py --source sc --reprocess
  python pipeline/extract_fields.py --source sc --id 42
  python pipeline/extract_fields.py --source sc --tier2-only
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

# Add parent dir to path so we can import pipeline modules when run from project root
sys.path.insert(0, str(Path(__file__).resolve().parent))

from extraction_utils import extract_all_regex
from extraction_llm import extract_via_haiku
from extraction_validator import validate_and_fix
from extraction_llm_reextract import reextract_fields
from error_logger import log_error

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

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

TIER1_THRESHOLD = 15  # require all fields — always go to Tier 2 if any field is missing

# All extraction fields that get written to DB
EXTRACTION_FIELDS = [
    "extracted_citation",
    "extracted_petitioner",
    "extracted_respondent",
    "case_category",
    "case_number",
    "judge_names",
    "author_judge_name",
    "issue_for_consideration",
    "headnotes",
    "cases_cited",
    "acts_cited",
    "keywords",
    "case_arising_from",
    "bench_size",
    "result_of_case",
]

# Fields stored as JSONB in PostgreSQL
JSONB_FIELDS = {"judge_names", "cases_cited", "acts_cited", "keywords", "case_arising_from"}


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

def load_env():
    """Load environment variables from .env.local."""
    try:
        from dotenv import load_dotenv
        env_path = Path(__file__).resolve().parent.parent / ".env.local"
        if env_path.exists():
            load_dotenv(env_path)
            logger.info(f"Loaded env from {env_path}")
        else:
            # Try .env
            env_path = Path(__file__).resolve().parent.parent / ".env"
            if env_path.exists():
                load_dotenv(env_path)
                logger.info(f"Loaded env from {env_path}")
    except ImportError:
        logger.warning("python-dotenv not installed, using existing environment variables")


def get_db_connection():
    """Create a PostgreSQL connection from DATABASE_URL."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL not set. Check your .env.local file.")
        sys.exit(1)
    return psycopg2.connect(db_url)


def get_anthropic_client():
    """Create an Anthropic client."""
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY not set — Tier 2 LLM extraction will not be available.")
        return None
    return anthropic.Anthropic(api_key=api_key)


# ---------------------------------------------------------------------------
# Database operations
# ---------------------------------------------------------------------------

def fetch_cases(conn, table: str, limit: int | None, reprocess: bool, case_id: int | None):
    """Fetch cases needing extraction."""
    assert table in SOURCE_MAP.values(), f"Invalid table: {table}"

    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    if case_id:
        cur.execute(
            f"SELECT id, judgment_text FROM {table} WHERE id = %s",
            (case_id,)
        )
    elif reprocess:
        query = f"SELECT id, judgment_text FROM {table} WHERE judgment_text IS NOT NULL ORDER BY id"
        if limit:
            query += f" LIMIT {int(limit)}"
        cur.execute(query)
    else:
        query = (
            f"SELECT id, judgment_text FROM {table} "
            f"WHERE judgment_text IS NOT NULL "
            f"AND (extraction_status = 'pending' OR extraction_status IS NULL) "
            f"ORDER BY id"
        )
        if limit:
            query += f" LIMIT {int(limit)}"
        cur.execute(query)

    rows = cur.fetchall()
    cur.close()
    return rows


def write_results(conn, table: str, case_id: int, results: dict, method: str):
    """Write extracted fields back to the database row."""
    assert table in SOURCE_MAP.values(), f"Invalid table: {table}"

    cur = conn.cursor()
    set_clauses = []
    params = []

    for field in EXTRACTION_FIELDS:
        value = results.get(field)
        if value is None:
            set_clauses.append(f"{field} = NULL")
        elif field in JSONB_FIELDS:
            set_clauses.append(f"{field} = %s::jsonb")
            params.append(json.dumps(value))
        elif field == "bench_size":
            set_clauses.append(f"{field} = %s")
            params.append(int(value) if value else None)
        else:
            set_clauses.append(f"{field} = %s")
            params.append(str(value))

    # Metadata
    now = datetime.now(timezone.utc)
    set_clauses.append("extraction_status = %s")
    params.append("completed")
    set_clauses.append("extraction_method = %s")
    params.append(method)
    # Only set extracted_at on first extraction (preserve original timestamp)
    set_clauses.append("extracted_at = COALESCE(extracted_at, %s)")
    params.append(now)
    # Always update extraction_updated_at
    set_clauses.append("extraction_updated_at = %s")
    params.append(now)

    params.append(case_id)

    sql = f"UPDATE {table} SET {', '.join(set_clauses)} WHERE id = %s"
    cur.execute(sql, params)
    conn.commit()
    cur.close()


def mark_skipped(conn, table: str, case_id: int, reason: str):
    """Mark a case as skipped."""
    assert table in SOURCE_MAP.values(), f"Invalid table: {table}"
    cur = conn.cursor()
    cur.execute(
        f"UPDATE {table} SET extraction_status = %s WHERE id = %s",
        (reason, case_id)
    )
    conn.commit()
    cur.close()


def mark_failed(conn, table: str, case_id: int, error: str):
    """Mark a case as failed."""
    assert table in SOURCE_MAP.values(), f"Invalid table: {table}"
    cur = conn.cursor()
    cur.execute(
        f"UPDATE {table} SET extraction_status = 'failed' WHERE id = %s",
        (case_id,)
    )
    conn.commit()
    cur.close()


# ---------------------------------------------------------------------------
# Merge strategy
# ---------------------------------------------------------------------------

def merge_results(regex_results: dict, llm_results: dict) -> dict:
    """
    Merge Tier 1 regex results with Tier 2 LLM results.
    LLM takes priority; regex fills gaps where LLM returned null.
    """
    merged = {}
    for field in EXTRACTION_FIELDS:
        llm_val = llm_results.get(field)
        regex_val = regex_results.get(field)

        # LLM takes priority
        if llm_val is not None:
            # But skip empty lists/dicts from LLM if regex has data
            if isinstance(llm_val, (list, dict)) and not llm_val and regex_val:
                merged[field] = regex_val
            else:
                merged[field] = llm_val
        elif regex_val is not None:
            merged[field] = regex_val
        else:
            merged[field] = None

    return merged


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------

def process_case(
    conn,
    table: str,
    case_id: int,
    judgment_text: str,
    tier2_only: bool,
    anthropic_client,
) -> dict:
    """
    Process a single case with validation. Returns a stats dict.

    Flow:
      1. Tier 1 regex (unless --tier2-only)
      2. Validate + auto-fix
      3. If all fields valid → write as 'regex', done
      4. If failing fields → Tier 2 full LLM → merge → validate again
      5. If still failing → targeted LLM re-extract just those fields
      6. Final write
    """
    if not judgment_text or not judgment_text.strip():
        mark_skipped(conn, table, case_id, "skipped_no_text")
        return {"status": "skipped", "reason": "no_text"}

    # Step 1: Tier 1 Regex
    if tier2_only:
        regex_results = {"_fields_extracted": 0}
    else:
        regex_results = extract_all_regex(judgment_text)

    # Step 2: Validate + auto-fix regex results
    if not tier2_only and regex_results.get("_fields_extracted", 0) > 0:
        fixed_results, failed_fields = validate_and_fix(regex_results)

        if not failed_fields:
            # All fields valid after regex + auto-fix
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if fixed_results.get(f) is not None
                and not (isinstance(fixed_results[f], (list, dict)) and not fixed_results[f])
            )
            write_results(conn, table, case_id, fixed_results, method="regex")
            return {"status": "completed", "tier": 1, "fields": valid_count, "failed": 0}

        logger.info(f"  Regex: {len(failed_fields)} fields failed validation: {failed_fields}")
    else:
        fixed_results = regex_results
        failed_fields = EXTRACTION_FIELDS.copy()

    # Step 3: Tier 2 full LLM
    if anthropic_client is None:
        if fixed_results.get("_fields_extracted", 0) > 0:
            write_results(conn, table, case_id, fixed_results, method="regex_partial")
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if fixed_results.get(f) is not None
                and not (isinstance(fixed_results[f], (list, dict)) and not fixed_results[f])
            )
            return {"status": "completed", "tier": 1, "fields": valid_count, "note": "partial_no_llm"}
        else:
            mark_skipped(conn, table, case_id, "skipped_no_llm_key")
            return {"status": "skipped", "reason": "no_llm_key"}

    try:
        llm_results = extract_via_haiku(judgment_text, anthropic_client)
        merged = merge_results(fixed_results, llm_results)

        # Step 4: Validate merged results
        merged_fixed, still_failed = validate_and_fix(merged)

        if not still_failed:
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if merged_fixed.get(f) is not None
                and not (isinstance(merged_fixed[f], (list, dict)) and not merged_fixed[f])
            )
            write_results(conn, table, case_id, merged_fixed, method="llm_haiku")
            return {"status": "completed", "tier": 2, "fields": valid_count, "failed": 0}

        # Step 5: Targeted re-extraction for still-failing fields
        logger.info(f"  LLM: {len(still_failed)} fields still failing: {still_failed}")
        try:
            reextracted = reextract_fields(judgment_text, still_failed, anthropic_client)
            for field, value in reextracted.items():
                if value is not None:
                    merged_fixed[field] = value

            # Final validation pass
            final_fixed, final_failed = validate_and_fix(merged_fixed)
            if final_failed:
                logger.warning(f"  {len(final_failed)} fields still invalid after re-extraction: {final_failed}")

            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if final_fixed.get(f) is not None
                and not (isinstance(final_fixed[f], (list, dict)) and not final_fixed[f])
            )
            write_results(conn, table, case_id, final_fixed, method="llm_haiku_reextract")
            return {"status": "completed", "tier": 2, "fields": valid_count, "failed": len(final_failed)}

        except Exception as e:
            logger.warning(f"  Targeted re-extraction failed: {e}")
            log_error("extraction", f"Targeted re-extraction failed for case {case_id}: {e}", error=e, metadata={"case_id": case_id, "table": table, "tier": "reextract"})
            # Write what we have
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if merged_fixed.get(f) is not None
                and not (isinstance(merged_fixed[f], (list, dict)) and not merged_fixed[f])
            )
            write_results(conn, table, case_id, merged_fixed, method="llm_haiku")
            return {"status": "completed", "tier": 2, "fields": valid_count, "failed": len(still_failed)}

    except Exception as e:
        logger.error(f"  Tier 2 failed for case {case_id}: {e}")
        log_error("extraction", f"Tier 2 LLM extraction failed for case {case_id}: {e}", error=e, metadata={"case_id": case_id, "table": table, "tier": 2})
        if fixed_results.get("_fields_extracted", 0) > 0:
            write_results(conn, table, case_id, fixed_results, method="regex_partial")
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if fixed_results.get(f) is not None
                and not (isinstance(fixed_results[f], (list, dict)) and not fixed_results[f])
            )
            return {"status": "completed", "tier": 1, "fields": valid_count, "note": "llm_failed"}
        else:
            mark_failed(conn, table, case_id, str(e))
            return {"status": "failed", "error": str(e)}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Judgment Extraction Pipeline")
    parser.add_argument("--source", required=True, choices=["sc", "hc"],
                        help="Source: sc (Supreme Court) or hc (High Court)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Max number of cases to process")
    parser.add_argument("--all", action="store_true",
                        help="Process all pending cases (same as omitting --limit)")
    parser.add_argument("--reprocess", action="store_true",
                        help="Re-extract all cases, even previously completed ones")
    parser.add_argument("--id", type=int, default=None,
                        help="Process a single case by ID")
    parser.add_argument("--tier2-only", action="store_true",
                        help="Skip Tier 1 regex, use LLM only")
    args = parser.parse_args()

    load_env()

    table = SOURCE_MAP[args.source]
    limit = args.limit

    logger.info(f"Extraction pipeline starting — table: {table}")

    conn = get_db_connection()
    anthropic_client = get_anthropic_client()

    # Fetch cases
    cases = fetch_cases(conn, table, limit, args.reprocess, args.id)
    total = len(cases)
    logger.info(f"Found {total} cases to process")

    if total == 0:
        logger.info("Nothing to process. Exiting.")
        conn.close()
        return

    # Process
    stats = {"completed": 0, "skipped": 0, "failed": 0, "tier1": 0, "tier2": 0}
    start_time = time.time()

    try:
        for i, row in enumerate(cases):
            case_id = row["id"]
            judgment_text = row["judgment_text"]

            logger.info(f"[{i + 1}/{total}] Processing case {case_id}...")

            result = process_case(
                conn, table, case_id, judgment_text,
                tier2_only=args.tier2_only,
                anthropic_client=anthropic_client,
            )

            status = result.get("status")
            stats[status] = stats.get(status, 0) + 1

            tier = result.get("tier")
            if tier == 1:
                stats["tier1"] += 1
            elif tier == 2:
                stats["tier2"] += 1

            fields = result.get("fields", 0)
            failed = result.get("failed", 0)
            logger.info(f"  → {status} (tier {tier}, {fields} fields, {failed} failed validation)")

            # Checkpoint every 100 cases
            if (i + 1) % 100 == 0:
                elapsed_so_far = time.time() - start_time
                rate = elapsed_so_far / (i + 1)
                logger.info(
                    f"\n  === CHECKPOINT {i + 1}/{total} ===\n"
                    f"  Completed: {stats['completed']} | Tier1: {stats['tier1']} | Tier2: {stats['tier2']}\n"
                    f"  Skipped: {stats['skipped']} | Failed: {stats['failed']}\n"
                    f"  Rate: {rate:.2f}s/case | ETA: {rate * (total - i - 1):.0f}s\n"
                )

    except KeyboardInterrupt:
        logger.warning("\nInterrupted by user. Printing progress...")

    elapsed = time.time() - start_time

    # Summary
    print("\n" + "=" * 60)
    print("EXTRACTION SUMMARY")
    print("=" * 60)
    print(f"Table:     {table}")
    print(f"Total:     {total}")
    print(f"Completed: {stats['completed']}")
    print(f"  Tier 1:  {stats['tier1']}")
    print(f"  Tier 2:  {stats['tier2']}")
    print(f"Skipped:   {stats['skipped']}")
    print(f"Failed:    {stats['failed']}")
    print(f"Time:      {elapsed:.1f}s ({elapsed / max(stats['completed'], 1):.2f}s/case)")
    print("=" * 60)

    conn.close()


if __name__ == "__main__":
    main()
