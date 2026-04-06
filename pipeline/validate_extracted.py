#!/usr/bin/env python3
"""
Standalone audit/fix script for extracted data quality.

Scans existing DB rows, validates each field, reports stats,
and optionally auto-fixes or re-extracts failing fields.

Usage:
  python pipeline/validate_extracted.py --source sc --audit
  python pipeline/validate_extracted.py --source sc --fix
  python pipeline/validate_extracted.py --source sc --fix --reextract
  python pipeline/validate_extracted.py --source sc --audit --limit 50
"""

import argparse
import json
import logging
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extraction_validator import validate_and_fix, validation_report, VALIDATORS
from extraction_llm_reextract import reextract_fields

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

SOURCE_MAP = {"sc": "supreme_court_cases", "hc": "high_court_cases"}

EXTRACTION_FIELDS = [
    "extracted_citation", "extracted_petitioner", "extracted_respondent",
    "case_category", "case_number", "judge_names", "author_judge_name",
    "issue_for_consideration", "headnotes", "cases_cited", "acts_cited",
    "keywords", "case_arising_from", "bench_size", "result_of_case",
]

JSONB_FIELDS = {"judge_names", "cases_cited", "acts_cited", "keywords", "case_arising_from"}


def load_env():
    try:
        from dotenv import load_dotenv
        env_path = Path(__file__).resolve().parent.parent / ".env.local"
        if env_path.exists():
            load_dotenv(env_path)
        else:
            env_path = Path(__file__).resolve().parent.parent / ".env"
            if env_path.exists():
                load_dotenv(env_path)
    except ImportError:
        pass


def get_db_connection():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL not set.")
        sys.exit(1)
    return psycopg2.connect(db_url)


def get_anthropic_client():
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    return anthropic.Anthropic(api_key=api_key)


def fetch_extracted_cases(conn, table: str, limit: int | None):
    """Fetch cases that have been extracted (status = completed)."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    fields = ", ".join(["id", "judgment_text"] + EXTRACTION_FIELDS)
    query = (
        f"SELECT {fields} FROM {table} "
        f"WHERE extraction_status = 'completed' "
        f"ORDER BY id"
    )
    if limit:
        query += f" LIMIT {int(limit)}"
    cur.execute(query)
    rows = cur.fetchall()
    cur.close()
    return rows


def update_fields(conn, table: str, case_id: int, updates: dict):
    """Write fixed fields back to the database."""
    cur = conn.cursor()
    set_clauses = []
    params = []

    for field, value in updates.items():
        if field not in EXTRACTION_FIELDS:
            continue
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

    if not set_clauses:
        return

    # Track when fixes were applied
    set_clauses.append("extraction_updated_at = %s")
    params.append(datetime.now(timezone.utc))

    params.append(case_id)
    sql = f"UPDATE {table} SET {', '.join(set_clauses)} WHERE id = %s"
    cur.execute(sql, params)
    conn.commit()
    cur.close()


def main():
    parser = argparse.ArgumentParser(description="Validate extracted data quality")
    parser.add_argument("--source", required=True, choices=["sc", "hc"])
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--audit", action="store_true",
                        help="Audit only — report stats, no changes")
    parser.add_argument("--fix", action="store_true",
                        help="Apply auto-fixes to DB")
    parser.add_argument("--reextract", action="store_true",
                        help="LLM re-extract fields that can't be auto-fixed (requires --fix)")
    args = parser.parse_args()

    if not args.audit and not args.fix:
        parser.error("Must specify --audit and/or --fix")

    load_env()

    table = SOURCE_MAP[args.source]
    conn = get_db_connection()
    anthropic_client = get_anthropic_client() if args.reextract else None

    if args.reextract and not anthropic_client:
        logger.error("ANTHROPIC_API_KEY required for --reextract")
        sys.exit(1)

    cases = fetch_extracted_cases(conn, table, args.limit)
    total = len(cases)
    logger.info(f"Auditing {total} cases from {table}")

    # Stats tracking
    field_pass = defaultdict(int)
    field_fail = defaultdict(int)
    field_issues = defaultdict(lambda: defaultdict(int))  # field → issue → count
    cases_with_issues = []
    fixed_count = 0
    reextract_count = 0

    for i, row in enumerate(cases):
        case_id = row["id"]
        results = {f: row[f] for f in EXTRACTION_FIELDS}

        report = validation_report(results)

        has_issue = False
        for field, info in report.items():
            if info["valid"]:
                field_pass[field] += 1
            else:
                field_fail[field] += 1
                field_issues[field][info["issue"]] += 1
                has_issue = True

        if has_issue:
            failed_names = [f for f, info in report.items() if not info["valid"]]
            cases_with_issues.append({"id": case_id, "failed": failed_names})

            if args.fix:
                fixed_results, still_failed = validate_and_fix(results)

                # Write auto-fixes
                changes = {}
                for field in EXTRACTION_FIELDS:
                    old_val = results.get(field)
                    new_val = fixed_results.get(field)
                    if new_val != old_val and new_val is not None:
                        changes[field] = new_val

                if changes:
                    update_fields(conn, table, case_id, changes)
                    fixed_count += 1

                # LLM re-extract for unfixable fields
                if still_failed and args.reextract and anthropic_client:
                    judgment_text = row["judgment_text"]
                    if judgment_text:
                        try:
                            reextracted = reextract_fields(
                                judgment_text, still_failed, anthropic_client
                            )
                            if reextracted:
                                update_fields(conn, table, case_id, reextracted)
                                reextract_count += 1
                        except Exception as e:
                            logger.warning(f"  Re-extraction failed for case {case_id}: {e}")

        if (i + 1) % 100 == 0:
            logger.info(f"  Processed {i + 1}/{total} cases...")

    # Print report
    print("\n" + "=" * 70)
    print("VALIDATION REPORT")
    print("=" * 70)
    print(f"Table: {table}")
    print(f"Cases audited: {total}")
    print(f"Cases with issues: {len(cases_with_issues)} ({len(cases_with_issues)/max(total,1)*100:.1f}%)")
    if args.fix:
        print(f"Cases auto-fixed: {fixed_count}")
    if args.reextract:
        print(f"Cases re-extracted: {reextract_count}")

    print("\n" + "-" * 70)
    print(f"{'Field':<30} {'Pass':>6} {'Fail':>6} {'Rate':>7}")
    print("-" * 70)

    for field in EXTRACTION_FIELDS:
        p = field_pass.get(field, 0)
        f = field_fail.get(field, 0)
        rate = p / max(p + f, 1) * 100
        marker = " ✗" if f > 0 else ""
        print(f"{field:<30} {p:>6} {f:>6} {rate:>6.1f}%{marker}")

    # Show issue breakdown for failing fields
    failing_fields = {f for f in EXTRACTION_FIELDS if field_fail.get(f, 0) > 0}
    if failing_fields:
        print("\n" + "-" * 70)
        print("ISSUE BREAKDOWN")
        print("-" * 70)
        for field in EXTRACTION_FIELDS:
            if field not in failing_fields:
                continue
            issues = field_issues[field]
            print(f"\n  {field}:")
            for issue, count in sorted(issues.items(), key=lambda x: -x[1]):
                print(f"    {issue}: {count}")

    # Show first 10 failing case IDs
    if cases_with_issues:
        print("\n" + "-" * 70)
        print(f"SAMPLE FAILING CASES (first 10 of {len(cases_with_issues)})")
        print("-" * 70)
        for entry in cases_with_issues[:10]:
            print(f"  Case {entry['id']}: {', '.join(entry['failed'])}")

    print("\n" + "=" * 70)
    conn.close()


if __name__ == "__main__":
    main()
