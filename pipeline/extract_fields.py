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

from extraction_utils import (
    extract_all_regex,
    extract_acts_cited_layout,
    extract_headnote_blocks,
    extract_keywords_layout,
    extract_issue_for_consideration_layout,
    extract_headnotes_layout,
    extract_cases_cited_layout,
    extract_case_arising_from_layout,
)
from extraction_llm import extract_via_haiku
from extraction_validator import validate_and_fix
from extraction_llm_reextract import reextract_fields
from acts_consensus import decide_acts_cited, ActsConsensus
from extraction_consensus import (
    FieldConsensus,
    decide_list_of_strings,
    decide_list_of_cases,
    decide_dict,
    decide_long_string,
    decide_short_string,
    decide_list_judges,
)
from pdf_resolver import resolve_pdf
from error_logger import log_error

# Fields for which we compute per-field consensus (method + confidence + alternatives).
# Must match columns added in migrations/007_field_confidence.sql.
CONSENSUS_FIELDS = [
    "issue_for_consideration",
    "headnotes",
    "cases_cited",
    "keywords",
    "case_arising_from",
    "judge_names",
    "author_judge_name",
    "extracted_petitioner",
    "extracted_respondent",
    "case_category",
    "case_number",
    "extracted_citation",
    "result_of_case",
]

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
    """Fetch cases needing extraction. Selects the columns needed to locate
    the source PDF for the layout-aware acts extractor."""
    assert table in SOURCE_MAP.values(), f"Invalid table: {table}"

    # SC needs (year, path); HC needs (year, court_name, pdf_link).
    if table == "supreme_court_cases":
        cols = "id, judgment_text, year, path"
    else:
        cols = "id, judgment_text, year, court_name, pdf_link"

    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    if case_id:
        cur.execute(
            f"SELECT {cols} FROM {table} WHERE id = %s",
            (case_id,)
        )
    elif reprocess:
        query = f"SELECT {cols} FROM {table} WHERE judgment_text IS NOT NULL ORDER BY id"
        if limit:
            query += f" LIMIT {int(limit)}"
        cur.execute(query)
    else:
        query = (
            f"SELECT {cols} FROM {table} "
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


def _json_safe(value):
    """Sanitize a value for JSON serialization (sets → lists, etc.)."""
    if isinstance(value, set):
        return sorted(value)
    return value


def write_results(
    conn,
    table: str,
    case_id: int,
    results: dict,
    method: str,
    acts_consensus: ActsConsensus | None = None,
    field_consensus: dict[str, FieldConsensus] | None = None,
):
    """Write extracted fields back to the database row, including per-field
    consensus metadata (method, confidence, alternatives) when provided."""
    assert table in SOURCE_MAP.values(), f"Invalid table: {table}"

    cur = conn.cursor()
    set_clauses = []
    params = []

    for fld in EXTRACTION_FIELDS:
        value = results.get(fld)
        if value is None:
            set_clauses.append(f"{fld} = NULL")
        elif fld in JSONB_FIELDS:
            set_clauses.append(f"{fld} = %s::jsonb")
            params.append(json.dumps(value))
        elif fld == "bench_size":
            set_clauses.append(f"{fld} = %s")
            params.append(int(value) if value else None)
        else:
            set_clauses.append(f"{fld} = %s")
            params.append(str(value))

    # Metadata
    now = datetime.now(timezone.utc)
    set_clauses.append("extraction_status = %s")
    params.append("completed")
    set_clauses.append("extraction_method = %s")
    params.append(method)
    set_clauses.append("extracted_at = COALESCE(extracted_at, %s)")
    params.append(now)
    set_clauses.append("extraction_updated_at = %s")
    params.append(now)

    # acts_cited provenance (migration 006)
    if acts_consensus is not None:
        set_clauses.append("acts_cited_method = %s")
        params.append(acts_consensus.method)
        set_clauses.append("acts_cited_confidence = %s")
        params.append(float(acts_consensus.confidence))
        set_clauses.append("acts_cited_alternatives = %s::jsonb")
        params.append(json.dumps(acts_consensus.alternatives, default=_json_safe))

    # Per-field provenance for every other consensus field (migration 007)
    if field_consensus:
        for fld, fc in field_consensus.items():
            if fc is None:
                continue
            set_clauses.append(f"{fld}_method = %s")
            params.append(fc.method)
            set_clauses.append(f"{fld}_confidence = %s")
            params.append(float(fc.confidence))
            set_clauses.append(f"{fld}_alternatives = %s::jsonb")
            params.append(json.dumps(fc.alternatives, default=_json_safe))

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

def _finalize_and_write(
    conn,
    table: str,
    case_id: int,
    results: dict,
    method: str,
    layout_acts: list[str] | None,
    text_acts_raw: list[str] | None,
    llm_acts_raw: list[str] | None,
    *,
    layout_fields: dict | None = None,
    text_results: dict | None = None,
    llm_results: dict | None = None,
) -> ActsConsensus:
    """Compute consensus for acts_cited AND every field in CONSENSUS_FIELDS,
    overwrite results with the consensus values, and persist.

    Returns the ActsConsensus (acts_cited is the canonical field for which the
    pipeline historically reports tier stats)."""
    # --- acts_cited (specialized, uses act registry)
    acts = decide_acts_cited(layout_acts, text_acts_raw, llm_acts_raw)
    results["acts_cited"] = acts.acts

    # --- every other consensus field
    fc = _decide_consensus_fields(
        layout_fields or {},
        text_results or {},
        llm_results or {},
    )
    for fld, decision in fc.items():
        if decision is None:
            continue
        # Override the merged value with the consensus choice.
        results[fld] = decision.value

    # Keep bench_size consistent with resolved judge_names.
    if isinstance(results.get("judge_names"), list) and results["judge_names"]:
        results["bench_size"] = len(results["judge_names"])

    write_results(
        conn, table, case_id, results, method,
        acts_consensus=acts,
        field_consensus=fc,
    )
    return acts


def _decide_consensus_fields(
    layout_fields: dict,
    text_results: dict,
    llm_results: dict,
) -> dict[str, FieldConsensus]:
    """Run per-field consensus for every CONSENSUS_FIELD. Returns a dict
    of field_name → FieldConsensus."""
    # Lazy imports keep top-of-file clean.
    try:
        from judge_registry import normalize_judges, normalize_one_judge
    except ImportError:
        normalize_judges = None
        normalize_one_judge = None

    out: dict[str, FieldConsensus] = {}

    def _get(d, k):
        if not isinstance(d, dict):
            return None
        v = d.get(k)
        return v if v is not None else None

    # List-of-string fields (no registry)
    out["keywords"] = decide_list_of_strings(
        layout=layout_fields.get("keywords"),
        text=_get(text_results, "keywords"),
        llm=_get(llm_results, "keywords"),
    )

    # Judge names — registry fuzzy normalizer when available
    def _judge_norm(xs):
        if normalize_judges is None:
            return list(dict.fromkeys(xs)), []
        return normalize_judges(xs)

    out["judge_names"] = decide_list_judges(
        text=_get(text_results, "judge_names"),
        llm=_get(llm_results, "judge_names"),
        layout=None,  # not boxed
        normalize=_judge_norm,
    )

    # List-of-dict
    out["cases_cited"] = decide_list_of_cases(
        layout=layout_fields.get("cases_cited"),
        text=_get(text_results, "cases_cited"),
        llm=_get(llm_results, "cases_cited"),
    )

    # Dict
    out["case_arising_from"] = decide_dict(
        layout=layout_fields.get("case_arising_from"),
        text=_get(text_results, "case_arising_from"),
        llm=_get(llm_results, "case_arising_from"),
    )

    # Long-form strings
    out["issue_for_consideration"] = decide_long_string(
        layout=layout_fields.get("issue_for_consideration"),
        text=_get(text_results, "issue_for_consideration"),
        llm=_get(llm_results, "issue_for_consideration"),
        min_len=30,
    )
    out["headnotes"] = decide_long_string(
        layout=layout_fields.get("headnotes"),
        text=_get(text_results, "headnotes"),
        llm=_get(llm_results, "headnotes"),
        min_len=100,
    )

    # Short strings (no layout)
    def _author_norm(s):
        return normalize_one_judge(s) if normalize_one_judge else (s, 1.0)

    out["author_judge_name"] = decide_short_string(
        text=_get(text_results, "author_judge_name"),
        llm=_get(llm_results, "author_judge_name"),
        normalize=_author_norm,
    )
    for fld in ("extracted_petitioner", "extracted_respondent",
                "case_category", "case_number",
                "extracted_citation", "result_of_case"):
        out[fld] = decide_short_string(
            text=_get(text_results, fld),
            llm=_get(llm_results, fld),
        )

    return out


def _run_all_layout_extractors(table: str, row) -> dict:
    """Open the source PDF once, run extract_headnote_blocks, then parse every
    layout-derivable field from the shared block dict. Returns:
      {
        'acts_cited':               list[str] | None,
        'keywords':                 list[str] | None,
        'issue_for_consideration':  str | None,
        'headnotes':                str | None,
        'cases_cited':              list[dict] | None,
        'case_arising_from':        dict | None,
      }
    Missing-key / None values mean "layout N/A"; [] / "" / {} mean "layout
    confirms this section is empty".
    """
    empty: dict = {
        "acts_cited": None, "keywords": None,
        "issue_for_consideration": None, "headnotes": None,
        "cases_cited": None, "case_arising_from": None,
    }

    try:
        if table == "supreme_court_cases":
            year, path = row["year"], row["path"]
            if not year or not path:
                return empty
            cm = resolve_pdf("sc", year=year, path=path)
        else:
            year = row["year"]
            court_name = row["court_name"]
            pdf_link = row["pdf_link"]
            if not year or not court_name or not pdf_link:
                return empty
            cm = resolve_pdf("hc", year=year, court_name=court_name, pdf_link=pdf_link)

        with cm as pdf_path:
            if not pdf_path:
                return empty
            blocks = extract_headnote_blocks(pdf_path)
            if blocks is None:
                return empty

            # Import parsers lazily to keep the top of extract_fields.py tidy.
            from extraction_utils import (
                _split_and_validate_acts,
                _split_keywords,
                _parse_cases_cited,
                _parse_case_arising_from,
                _collapse_newlines,
            )
            import re as _re

            def _parse_block(key, parser):
                content = blocks.get(key)
                if content is None:
                    return None
                if not content.strip():
                    return []
                return parser(content)

            acts = _parse_block("List of Acts", _split_and_validate_acts)
            kws = _parse_block("Keywords", _split_keywords)
            issue = blocks.get("Issue for Consideration")
            issue = _collapse_newlines(issue) if issue else (None if issue is None else "")
            headnotes = blocks.get("Headnotes")
            if headnotes is not None and headnotes.strip():
                headnotes = _re.sub(r'\n{3,}', '\n\n', headnotes).strip()
            elif headnotes is not None:
                headnotes = ""
            cases = _parse_block("Case Law Cited", _parse_cases_cited)

            # Case arising from: prefer dedicated block, else fall back to
            # "Other Case Details" (modern SCR), else "Appearances for Parties".
            caf_content = (
                blocks.get("Case Arising From")
                or blocks.get("Other Case Details")
                or blocks.get("Appearances for Parties")
            )
            if caf_content is None:
                caf = None
            elif not caf_content.strip():
                caf = {}
            else:
                caf = _parse_case_arising_from(caf_content)

            return {
                "acts_cited": acts,
                "keywords": kws,
                "issue_for_consideration": issue,
                "headnotes": headnotes,
                "cases_cited": cases,
                "case_arising_from": caf,
            }
    except Exception as e:
        logger.debug(f"  Layout pass failed: {e}")
        return empty


# Back-compat shim used by existing call sites.
def _run_layout_acts(table: str, row) -> list[str] | None:
    return _run_all_layout_extractors(table, row).get("acts_cited")


def _merge_layout_into_results(results: dict, layout_fields: dict) -> dict:
    """Overwrite fields in results with layout-extracted values where layout
    produced a non-empty, valid value. Regex output is retained for fields
    that layout doesn't cover or where layout returned empty/None.

    Mutates and returns results."""
    if not isinstance(layout_fields, dict):
        return results
    for fld, lv in layout_fields.items():
        if lv is None:
            continue  # layout N/A
        # Treat empty [] / "" / {} as "layout confirms empty" — still a valid vote
        # but don't overwrite existing regex data with it. Only promote non-empty.
        if isinstance(lv, (list, str, dict)) and not lv:
            # If regex also has nothing, accept layout's empty vote
            if not results.get(fld):
                results[fld] = lv
            continue
        results[fld] = lv
    return results


def process_case(
    conn,
    table: str,
    case_id: int,
    judgment_text: str,
    tier2_only: bool,
    anthropic_client,
    row=None,
) -> dict:
    """
    Process a single case with validation. Returns a stats dict.

    Flow:
      1. Tier 1 regex (unless --tier2-only)
      2. Layout-aware acts extraction (PDF-based, primary for acts_cited)
      3. Validate + auto-fix
      4. If all fields valid → consensus + write, done
      5. If failing fields → Tier 2 full LLM → merge → validate again
      6. If still failing → targeted LLM re-extract just those fields
      7. Build acts_cited consensus, final write
    """
    if not judgment_text or not judgment_text.strip():
        mark_skipped(conn, table, case_id, "skipped_no_text")
        return {"status": "skipped", "reason": "no_text"}

    # Step 1: Tier 1 Regex
    if tier2_only:
        regex_results = {"_fields_extracted": 0}
    else:
        regex_results = extract_all_regex(judgment_text)

    # Step 1b: Layout-aware extraction for ALL boxed fields (one PDF pass).
    layout_fields = _run_all_layout_extractors(table, row) if row is not None else {}
    layout_acts = layout_fields.get("acts_cited") if isinstance(layout_fields, dict) else None

    # Step 2: Validate + auto-fix regex results
    if not tier2_only and regex_results.get("_fields_extracted", 0) > 0:
        fixed_results, failed_fields = validate_and_fix(regex_results)

        # Step 2b: Layout fills gaps. Merge layout-extracted values into the
        # regex output, then re-validate. If layout covers every regex failure,
        # we can skip the LLM entirely.
        if failed_fields and isinstance(layout_fields, dict):
            _merge_layout_into_results(fixed_results, layout_fields)
            fixed_results, failed_fields = validate_and_fix(fixed_results)
            if not failed_fields:
                logger.info("  Layout filled every regex gap — skipping LLM")

        if not failed_fields:
            # All fields valid after regex (+ optional layout)
            method = "regex_layout" if isinstance(layout_fields, dict) and any(
                layout_fields.get(f) for f in ("acts_cited", "keywords", "issue_for_consideration",
                                               "headnotes", "cases_cited", "case_arising_from")
            ) else "regex"
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if fixed_results.get(f) is not None
                and not (isinstance(fixed_results[f], (list, dict)) and not fixed_results[f])
            )
            consensus = _finalize_and_write(
                conn, table, case_id, fixed_results, method,
                layout_acts=layout_acts,
                text_acts_raw=regex_results.get("acts_cited"),
                llm_acts_raw=None,
                layout_fields=layout_fields,
                text_results=regex_results,
                llm_results=None,
            )
            return {"status": "completed", "tier": 1, "fields": valid_count, "failed": 0, "acts_method": consensus.method, "acts_conf": consensus.confidence}

        logger.info(f"  Regex+layout: {len(failed_fields)} fields still failing: {failed_fields}")
    else:
        fixed_results = regex_results
        failed_fields = EXTRACTION_FIELDS.copy()

    # Step 3: Tier 2 full LLM
    if anthropic_client is None:
        if fixed_results.get("_fields_extracted", 0) > 0:
            consensus = _finalize_and_write(
                conn, table, case_id, fixed_results, "regex_partial",
                layout_acts=layout_acts,
                text_acts_raw=regex_results.get("acts_cited"),
                llm_acts_raw=None,
                layout_fields=layout_fields,
                text_results=regex_results,
                llm_results=None,
            )
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if fixed_results.get(f) is not None
                and not (isinstance(fixed_results[f], (list, dict)) and not fixed_results[f])
            )
            return {"status": "completed", "tier": 1, "fields": valid_count, "note": "partial_no_llm"}
        else:
            mark_skipped(conn, table, case_id, "skipped_no_llm_key")
            return {"status": "skipped", "reason": "no_llm_key"}

    # Fast-path: when only a handful of fields are missing, skip the full
    # 15-field Haiku extraction and go straight to targeted re-extraction
    # for just the failing fields. Saves ~14/15 of the token cost when
    # regex+layout already covered most of the document.
    TARGETED_ONLY_THRESHOLD = 3
    if len(failed_fields) <= TARGETED_ONLY_THRESHOLD:
        logger.info(
            f"  Only {len(failed_fields)} fields need LLM; going direct "
            f"to targeted re-extract (skip full Haiku call)"
        )
        try:
            reextracted = reextract_fields(judgment_text, failed_fields, anthropic_client)
            for field, value in reextracted.items():
                if value is not None:
                    fixed_results[field] = value
            final_fixed, final_failed = validate_and_fix(fixed_results)
            if final_failed:
                logger.warning(
                    f"  {len(final_failed)} fields still invalid after targeted re-extract: {final_failed}"
                )
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if final_fixed.get(f) is not None
                and not (isinstance(final_fixed[f], (list, dict)) and not final_fixed[f])
            )
            consensus = _finalize_and_write(
                conn, table, case_id, final_fixed, "targeted_llm",
                layout_acts=layout_acts,
                text_acts_raw=regex_results.get("acts_cited"),
                llm_acts_raw=None,  # targeted extract doesn't give a full LLM vote
                layout_fields=layout_fields,
                text_results=regex_results,
                llm_results=reextracted,
            )
            return {
                "status": "completed", "tier": 2,
                "fields": valid_count, "failed": len(final_failed),
                "acts_method": consensus.method, "acts_conf": consensus.confidence,
                "note": "targeted_only",
            }
        except Exception as e:
            logger.warning(
                f"  Targeted-only re-extract failed: {e} — falling back to full Haiku"
            )
            log_error(
                "extraction",
                f"Targeted-only re-extract failed for case {case_id}: {e}",
                error=e, metadata={"case_id": case_id, "table": table, "tier": "targeted_only"},
            )
            # Fall through to the full-LLM branch below.

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
            consensus = _finalize_and_write(
                conn, table, case_id, merged_fixed, "llm_haiku",
                layout_acts=layout_acts,
                text_acts_raw=regex_results.get("acts_cited"),
                llm_acts_raw=llm_results.get("acts_cited"),
                layout_fields=layout_fields,
                text_results=regex_results,
                llm_results=llm_results,
            )
            return {"status": "completed", "tier": 2, "fields": valid_count, "failed": 0, "acts_method": consensus.method, "acts_conf": consensus.confidence}

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
            consensus = _finalize_and_write(
                conn, table, case_id, final_fixed, "llm_haiku_reextract",
                layout_acts=layout_acts,
                text_acts_raw=regex_results.get("acts_cited"),
                llm_acts_raw=llm_results.get("acts_cited"),
                layout_fields=layout_fields,
                text_results=regex_results,
                llm_results=llm_results,
            )
            return {"status": "completed", "tier": 2, "fields": valid_count, "failed": len(final_failed), "acts_method": consensus.method, "acts_conf": consensus.confidence}

        except Exception as e:
            logger.warning(f"  Targeted re-extraction failed: {e}")
            log_error("extraction", f"Targeted re-extraction failed for case {case_id}: {e}", error=e, metadata={"case_id": case_id, "table": table, "tier": "reextract"})
            # Write what we have
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if merged_fixed.get(f) is not None
                and not (isinstance(merged_fixed[f], (list, dict)) and not merged_fixed[f])
            )
            consensus = _finalize_and_write(
                conn, table, case_id, merged_fixed, "llm_haiku",
                layout_acts=layout_acts,
                text_acts_raw=regex_results.get("acts_cited"),
                llm_acts_raw=llm_results.get("acts_cited"),
                layout_fields=layout_fields,
                text_results=regex_results,
                llm_results=llm_results,
            )
            return {"status": "completed", "tier": 2, "fields": valid_count, "failed": len(still_failed), "acts_method": consensus.method, "acts_conf": consensus.confidence}

    except Exception as e:
        logger.error(f"  Tier 2 failed for case {case_id}: {e}")
        log_error("extraction", f"Tier 2 LLM extraction failed for case {case_id}: {e}", error=e, metadata={"case_id": case_id, "table": table, "tier": 2})
        if fixed_results.get("_fields_extracted", 0) > 0:
            consensus = _finalize_and_write(
                conn, table, case_id, fixed_results, "regex_partial",
                layout_acts=layout_acts,
                text_acts_raw=regex_results.get("acts_cited"),
                llm_acts_raw=None,
                layout_fields=layout_fields,
                text_results=regex_results,
                llm_results=None,
            )
            valid_count = sum(
                1 for f in EXTRACTION_FIELDS
                if fixed_results.get(f) is not None
                and not (isinstance(fixed_results[f], (list, dict)) and not fixed_results[f])
            )
            return {"status": "completed", "tier": 1, "fields": valid_count, "note": "llm_failed", "acts_method": consensus.method, "acts_conf": consensus.confidence}
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
                row=row,
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
            acts_method = result.get("acts_method", "—")
            acts_conf = result.get("acts_conf")
            acts_str = f"acts:{acts_method}@{acts_conf:.2f}" if acts_conf is not None else f"acts:{acts_method}"
            logger.info(f"  → {status} (tier {tier}, {fields} fields, {failed} failed, {acts_str})")

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
