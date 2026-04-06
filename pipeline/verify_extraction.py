#!/usr/bin/env python3
"""
Extraction Verification Script

Checks data quality after running the extraction pipeline.
Reports field coverage, extraction method distribution, and sample rows.

Usage:
  python pipeline/verify_extraction.py --source sc
  python pipeline/verify_extraction.py --source hc
"""

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

SOURCE_MAP = {
    "sc": "supreme_court_cases",
    "hc": "high_court_cases",
}

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

JSONB_FIELDS = {"judge_names", "cases_cited", "acts_cited", "keywords", "case_arising_from"}


def load_env():
    try:
        from dotenv import load_dotenv
        for name in [".env.local", ".env"]:
            env_path = Path(__file__).resolve().parent.parent / name
            if env_path.exists():
                load_dotenv(env_path)
                break
    except ImportError:
        pass


def get_db_connection():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set.")
        sys.exit(1)
    return psycopg2.connect(db_url)


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify(conn, table: str):
    assert table in SOURCE_MAP.values(), f"Invalid table: {table}"
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    # --- Overall counts ---
    print("\n" + "=" * 65)
    print(f"EXTRACTION VERIFICATION — {table}")
    print("=" * 65)

    cur.execute(f"SELECT COUNT(*) FROM {table}")
    total_rows = cur.fetchone()[0]

    cur.execute(f"SELECT COUNT(*) FROM {table} WHERE judgment_text IS NOT NULL")
    with_text = cur.fetchone()[0]

    print(f"\nTotal rows:          {total_rows}")
    print(f"With judgment_text:  {with_text}")

    # --- Status distribution ---
    print("\n--- Extraction Status ---")
    cur.execute(
        f"SELECT extraction_status, COUNT(*) FROM {table} "
        f"GROUP BY extraction_status ORDER BY COUNT(*) DESC"
    )
    for row in cur.fetchall():
        status = row[0] or "(null)"
        print(f"  {status:<25} {row[1]:>6}")

    # --- Method distribution ---
    print("\n--- Extraction Method ---")
    cur.execute(
        f"SELECT extraction_method, COUNT(*) FROM {table} "
        f"WHERE extraction_status = 'completed' "
        f"GROUP BY extraction_method ORDER BY COUNT(*) DESC"
    )
    for row in cur.fetchall():
        method = row[0] or "(null)"
        print(f"  {method:<25} {row[1]:>6}")

    # --- Per-field coverage ---
    cur.execute(
        f"SELECT COUNT(*) FROM {table} WHERE extraction_status = 'completed'"
    )
    completed = cur.fetchone()[0]

    if completed == 0:
        print("\nNo completed extractions to verify.")
        return

    print(f"\n--- Field Coverage (out of {completed} completed) ---")
    print(f"{'Field':<30} {'Populated':>10} {'Null/Empty':>10} {'Coverage':>10}")
    print("-" * 65)

    for field in EXTRACTION_FIELDS:
        if field in JSONB_FIELDS:
            # JSONB: check for non-empty arrays/objects
            if field == "case_arising_from":
                cur.execute(
                    f"SELECT COUNT(*) FROM {table} "
                    f"WHERE extraction_status = 'completed' "
                    f"AND {field} IS NOT NULL AND {field} != '{{}}'::jsonb"
                )
            else:
                cur.execute(
                    f"SELECT COUNT(*) FROM {table} "
                    f"WHERE extraction_status = 'completed' "
                    f"AND {field} IS NOT NULL AND {field} != '[]'::jsonb"
                )
        elif field == "bench_size":
            cur.execute(
                f"SELECT COUNT(*) FROM {table} "
                f"WHERE extraction_status = 'completed' "
                f"AND {field} IS NOT NULL AND {field} > 0"
            )
        else:
            cur.execute(
                f"SELECT COUNT(*) FROM {table} "
                f"WHERE extraction_status = 'completed' "
                f"AND {field} IS NOT NULL AND {field} != ''"
            )

        populated = cur.fetchone()[0]
        null_count = completed - populated
        coverage = (populated / completed * 100) if completed > 0 else 0
        print(f"  {field:<28} {populated:>8} {null_count:>10} {coverage:>9.1f}%")

    # --- Sample rows ---
    print(f"\n--- 5 Random Completed Samples ---")
    cur.execute(
        f"SELECT id, extracted_citation, extracted_petitioner, extracted_respondent, "
        f"case_category, case_number, judge_names, author_judge_name, bench_size, "
        f"result_of_case, extraction_method "
        f"FROM {table} WHERE extraction_status = 'completed' "
        f"ORDER BY RANDOM() LIMIT 5"
    )
    samples = cur.fetchall()
    for row in samples:
        print(f"\n  Case ID: {row['id']}")
        print(f"    Citation:    {row['extracted_citation']}")
        print(f"    Petitioner:  {row['extracted_petitioner']}")
        print(f"    Respondent:  {row['extracted_respondent']}")
        print(f"    Category:    {row['case_category']}")
        print(f"    Case No:     {row['case_number']}")
        judges = row['judge_names']
        if isinstance(judges, str):
            judges = json.loads(judges)
        print(f"    Judges:      {judges}")
        print(f"    Author:      {row['author_judge_name']}")
        print(f"    Bench Size:  {row['bench_size']}")
        print(f"    Result:      {row['result_of_case']}")
        print(f"    Method:      {row['extraction_method']}")

    # --- Failed cases ---
    cur.execute(
        f"SELECT COUNT(*) FROM {table} WHERE extraction_status = 'failed'"
    )
    failed_count = cur.fetchone()[0]

    if failed_count > 0:
        print(f"\n--- Failed Extractions ({failed_count} total, showing first 5) ---")
        cur.execute(
            f"SELECT id, LEFT(judgment_text, 200) as text_preview "
            f"FROM {table} WHERE extraction_status = 'failed' "
            f"ORDER BY id LIMIT 5"
        )
        for row in cur.fetchall():
            print(f"\n  Case ID: {row['id']}")
            preview = row['text_preview'] or "(empty)"
            print(f"    Preview: {preview[:200]}...")

    print("\n" + "=" * 65)
    cur.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Verify extraction quality")
    parser.add_argument("--source", required=True, choices=["sc", "hc"],
                        help="Source: sc (Supreme Court) or hc (High Court)")
    args = parser.parse_args()

    load_env()
    conn = get_db_connection()
    table = SOURCE_MAP[args.source]

    verify(conn, table)
    conn.close()


if __name__ == "__main__":
    main()
