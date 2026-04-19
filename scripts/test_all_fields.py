#!/usr/bin/env python3
"""
Run the full layout + text + (optional) LLM extraction pipeline on a single
SC PDF (by path or row id) and print every field's consensus result.

Usage:
  # By SC path (e.g. 2024_1_211_240)
  python scripts/test_all_fields.py --path 2024_1_211_240

  # By DB row id
  python scripts/test_all_fields.py --id 1234

  # With LLM vote (costs API quota)
  python scripts/test_all_fields.py --path 2024_1_211_240 --with-llm

Read-only: never writes to DB.
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))


def load_env():
    try:
        from dotenv import load_dotenv
        for n in (".env.local", ".env"):
            p = ROOT / n
            if p.exists():
                load_dotenv(p); return
    except ImportError:
        pass


def download_pdf(path_stub: str) -> str:
    """Download SC PDF from R2 to a temp file, return the path."""
    import boto3
    from config import R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_NAME
    # Derive year from path stub (e.g., "2024_1_211_240" → 2024)
    year = path_stub.split("_")[0]
    key = f"supreme-court/{year}/{path_stub}_EN.pdf"
    r2 = boto3.client("s3", endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID, aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto")
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False); tmp.close()
    r2.download_file(R2_BUCKET_NAME, key, tmp.name)
    return tmp.name


def print_field(name: str, fc, truncate: int | None = None):
    print(f"\n── {name} ──")
    print(f"  method:     {fc.method}")
    print(f"  confidence: {fc.confidence:.2f}")
    val = fc.value
    if isinstance(val, str):
        if truncate and len(val) > truncate:
            print(f"  value:      {val[:truncate]!r}...({len(val)} chars total)")
        else:
            print(f"  value:      {val!r}")
    elif isinstance(val, list):
        if not val:
            print("  value:      []")
        else:
            print(f"  value ({len(val)} items):")
            for item in val[:10]:
                print(f"    - {item}")
            if len(val) > 10:
                print(f"    ... and {len(val) - 10} more")
    elif isinstance(val, dict):
        print(f"  value:      {json.dumps(val, indent=2)}")
    else:
        print(f"  value:      {val}")


def main():
    parser = argparse.ArgumentParser()
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--path", help="SC path stub, e.g. 2024_1_211_240")
    grp.add_argument("--id", type=int, help="DB row id")
    grp.add_argument("--pdf", help="Local PDF path")
    parser.add_argument("--with-llm", action="store_true")
    args = parser.parse_args()

    load_env()

    # Resolve PDF
    pdf_path = None
    judgment_text = ""
    source = "sc"
    row = None
    temp_pdf = False

    if args.pdf:
        pdf_path = args.pdf
    elif args.path:
        pdf_path = download_pdf(args.path)
        temp_pdf = True
    else:
        import psycopg2, psycopg2.extras
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cur.execute("SELECT id, judgment_text, year, path FROM supreme_court_cases WHERE id = %s", (args.id,))
        row = cur.fetchone()
        if not row:
            print(f"No row with id={args.id}"); return
        judgment_text = row["judgment_text"] or ""
        pdf_path = download_pdf(row["path"])
        temp_pdf = True
        conn.close()

    # Extract judgment text from PDF if not already fetched
    if not judgment_text:
        import fitz
        doc = fitz.open(pdf_path)
        judgment_text = "".join(p.get_text() for p in doc)
        doc.close()

    # Run layout extractors (one pass)
    from extraction_utils import (
        extract_headnote_blocks,
        _split_and_validate_acts, _split_keywords,
        _parse_cases_cited, _parse_case_arising_from,
        _collapse_newlines,
    )
    import re as _re

    blocks = extract_headnote_blocks(pdf_path) or {}
    print(f"\nHeadnote blocks found: {list(blocks.keys())}")

    layout_fields = {
        "acts_cited": _split_and_validate_acts(blocks["List of Acts"])
            if "List of Acts" in blocks else None,
        "keywords": _split_keywords(blocks["Keywords"])
            if "Keywords" in blocks else None,
        "issue_for_consideration": _collapse_newlines(blocks["Issue for Consideration"])
            if "Issue for Consideration" in blocks else None,
        "headnotes": _re.sub(r'\n{3,}', '\n\n', blocks["Headnotes"]).strip()
            if "Headnotes" in blocks else None,
        "cases_cited": _parse_cases_cited(blocks["Case Law Cited"])
            if "Case Law Cited" in blocks else None,
        "case_arising_from": _parse_case_arising_from(
            blocks.get("Case Arising From")
            or blocks.get("Other Case Details")
            or blocks.get("Appearances for Parties")
            or ""
        ) if any(k in blocks for k in ("Case Arising From", "Other Case Details", "Appearances for Parties")) else None,
    }

    # Run regex extractors on full text
    from extraction_utils import extract_all_regex
    text_results = extract_all_regex(judgment_text) if judgment_text else {}

    # Optional LLM vote
    llm_results = {}
    if args.with_llm:
        from extraction_llm import extract_via_haiku
        import anthropic
        key = os.environ.get("ANTHROPIC_API_KEY")
        if key:
            client = anthropic.Anthropic(api_key=key)
            try:
                llm_results = extract_via_haiku(judgment_text, client)
            except Exception as e:
                print(f"LLM extraction failed: {e}")
        else:
            print("ANTHROPIC_API_KEY not set — skipping LLM vote")

    # Compute consensus for every field
    from extract_fields import _decide_consensus_fields
    from acts_consensus import decide_acts_cited

    acts = decide_acts_cited(
        layout_result=layout_fields["acts_cited"],
        text_result=text_results.get("acts_cited") or None,
        llm_result=llm_results.get("acts_cited") or None,
    )
    fc = _decide_consensus_fields(layout_fields, text_results, llm_results)

    print("\n" + "=" * 72)
    print("CONSENSUS RESULTS")
    print("=" * 72)

    print("\n── acts_cited ──")
    print(f"  method:     {acts.method}")
    print(f"  confidence: {acts.confidence:.2f}")
    print(f"  value ({len(acts.acts)} items):")
    for a in acts.acts:
        print(f"    - {a}")

    for field_name, consensus in fc.items():
        if consensus is None:
            continue
        truncate = 200 if field_name in ("headnotes",) else 500
        print_field(field_name, consensus, truncate=truncate)

    # Cleanup
    if temp_pdf:
        try: os.unlink(pdf_path)
        except OSError: pass


if __name__ == "__main__":
    main()
