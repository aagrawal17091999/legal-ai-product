"""
Extraction Validator — Per-field validation rules and auto-fix logic.

Validates extracted fields for quality and format correctness.
Can auto-fix common issues (strip artifacts, filter bad entries)
and reports which fields need LLM re-extraction.
"""

import re
import logging
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VALID_CATEGORIES = {
    "Civil", "Criminal", "Constitutional", "Tax", "Motor Vehicles",
    "Land & Property", "Industrial & Labour", "Financial", "Family",
    "Writ", "Arbitration", "Transfer", "Consumer", "Contempt",
    "Review", "Other",
}

# Patterns that indicate PDF page header/footer noise
ARTIFACT_PATTERNS = [
    re.compile(r'\[\d{4}\]\s+\d+\s+S\.C\.R\.', re.IGNORECASE),
    re.compile(r'\d{4}\s+INSC\s+\d+'),
    re.compile(r'Digital Supreme Court Reports', re.IGNORECASE),
    re.compile(r'\x08'),  # backspace char
]

# Section headings that should never appear in petitioner/respondent
SECTION_HEADINGS = [
    "Issue for Consideration", "Headnotes", "Case Law Cited",
    "List of Acts", "List of Keywords", "Case Arising From",
    "Appearances for Parties", "Judgment", "SUPREME COURT RULES",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _has_artifacts(text: str) -> bool:
    """Check if text contains known PDF artifacts."""
    for pat in ARTIFACT_PATTERNS:
        if pat.search(text):
            return True
    return False


def _strip_artifacts(text: str) -> str:
    """Remove known PDF artifacts from text."""
    # Remove backspace and control characters
    text = re.sub(r'[\x08]', '', text)
    # Remove SCR page headers
    text = re.sub(r'\[?\d{4}\]?\s+\d+\s+S\.C\.R\.?\s*\n?', '', text)
    # Remove "Digital Supreme Court Reports"
    text = re.sub(r'Digital Supreme Court Reports\s*\n?', '', text, flags=re.IGNORECASE)
    # Remove bare page numbers on their own line
    text = re.sub(r'\n\s*\d{1,4}\s*\n', '\n', text)
    # Remove "* Author" markers
    text = re.sub(r'\*\s*Author\b', '', text)
    # Remove leaked case title lines (Name v. Name on its own line)
    text = re.sub(r'\n[A-Z][A-Za-z\s.@]+\s+v\.\s+[A-Z][A-Za-z\s.@]+\n', '\n', text)
    # Collapse multiple whitespace
    text = re.sub(r'[ \t]+', ' ', text)
    # Collapse multiple newlines
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _has_section_heading(text: str) -> bool:
    """Check if text contains section headings (indicates boundary failure)."""
    for heading in SECTION_HEADINGS:
        if heading.lower() in text.lower():
            return True
    return False


# ---------------------------------------------------------------------------
# Per-field validators
# Each returns (is_valid: bool, fixed_value: Any | None)
# If is_valid is True, fixed_value is the (possibly cleaned) value.
# If is_valid is False and fixed_value is not None, it's an auto-fix attempt.
# If is_valid is False and fixed_value is None, LLM re-extraction needed.
# ---------------------------------------------------------------------------

def _validate_citation(value: Any, results: dict) -> tuple[bool, Any]:
    if not value or not isinstance(value, str):
        return False, None
    has_scr = bool(re.search(r'\[\d{4}\]\s+\d+\s+S\.C\.R\.', value))
    has_insc = bool(re.search(r'\d{4}\s+INSC\s+\d+', value))
    if has_scr or has_insc:
        return True, value
    return False, None


def _validate_petitioner(value: Any, results: dict) -> tuple[bool, Any]:
    if not value or not isinstance(value, str):
        return False, None
    if len(value) > 500:
        return False, None  # Boundary failure — captured too much
    if _has_section_heading(value):
        return False, None
    if _has_artifacts(value):
        fixed = _strip_artifacts(value)
        if fixed and 2 <= len(fixed) <= 500 and not _has_section_heading(fixed):
            return True, fixed
        return False, None
    if len(value) < 2:
        return False, None
    return True, value


def _validate_respondent(value: Any, results: dict) -> tuple[bool, Any]:
    # Same rules as petitioner
    return _validate_petitioner(value, results)


def _validate_case_category(value: Any, results: dict) -> tuple[bool, Any]:
    if not value or not isinstance(value, str):
        return False, None
    if value in VALID_CATEGORIES:
        return True, value
    # Try case-insensitive match
    for cat in VALID_CATEGORIES:
        if value.lower() == cat.lower():
            return True, cat
    return False, None


def _validate_case_number(value: Any, results: dict) -> tuple[bool, Any]:
    if not value or not isinstance(value, str):
        return False, None
    # Must contain a case type keyword + number pattern
    has_type = bool(re.search(
        r'(?:Appeal|Petition|Case|Writ|SLP|Application|Suo Motu|Transfer|Review|Contempt)',
        value, re.IGNORECASE
    ))
    has_number = bool(re.search(r'No(?:\(s\))?s?\.?\s*[\d\-/\s]+', value, re.IGNORECASE))
    if has_type and has_number:
        return True, value
    return False, None


def _validate_judge_names(value: Any, results: dict) -> tuple[bool, Any]:
    if not isinstance(value, list):
        return False, None
    if len(value) == 0:
        return False, None
    # Filter out bad entries
    cleaned = []
    for name in value:
        if not isinstance(name, str):
            continue
        name = name.strip()
        if len(name) < 3 or len(name) > 100:
            continue
        if name.isdigit():
            continue
        if _has_artifacts(name):
            continue
        cleaned.append(name)
    if len(cleaned) == 0:
        return False, None
    if len(cleaned) != len(value):
        return True, cleaned  # Auto-fixed by filtering
    return True, value


def _validate_author_judge(value: Any, results: dict) -> tuple[bool, Any]:
    if value is None:
        return False, None  # Missing — needs re-extraction
    if not isinstance(value, str):
        return False, None
    value = value.strip()
    if len(value) < 3 or len(value) > 100:
        return False, None
    if _has_artifacts(value):
        return False, None
    return True, value


def _validate_bench_size(value: Any, results: dict) -> tuple[bool, Any]:
    judge_names = results.get("judge_names", [])
    if isinstance(judge_names, list) and len(judge_names) > 0:
        expected = len(judge_names)
        if value == expected:
            return True, value
        return True, expected  # Auto-fix
    if value and isinstance(value, int) and value > 0:
        return True, value
    return False, None


def _validate_issue(value: Any, results: dict) -> tuple[bool, Any]:
    if not value or not isinstance(value, str):
        return False, None
    if len(value) < 30:
        return False, None
    if _has_artifacts(value):
        fixed = _strip_artifacts(value)
        if fixed and len(fixed) >= 30:
            return True, fixed
        return False, None
    return True, value


def _validate_headnotes(value: Any, results: dict) -> tuple[bool, Any]:
    if not value or not isinstance(value, str):
        return False, None
    if len(value) < 100:
        return False, None
    if _has_artifacts(value):
        fixed = _strip_artifacts(value)
        if fixed and len(fixed) >= 100:
            return True, fixed
        return False, None
    return True, value


def _validate_cases_cited(value: Any, results: dict) -> tuple[bool, Any]:
    if not isinstance(value, list):
        return False, None
    if len(value) == 0:
        return True, value  # Empty is valid — some cases cite nothing
    cleaned = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name = item.get("name", "")
        if not name or len(str(name).strip()) < 3:
            continue
        cleaned.append(item)
    if len(cleaned) != len(value):
        return True, cleaned  # Auto-fixed by filtering
    return True, value


def _validate_acts_cited(value: Any, results: dict) -> tuple[bool, Any]:
    if not isinstance(value, list):
        return False, None
    if len(value) == 0:
        return True, value  # Empty is valid
    cleaned = []
    for act in value:
        if not isinstance(act, str):
            continue
        act = re.sub(r'\s*\n\s*', ' ', act).strip()  # Collapse newlines
        if len(act) < 4:
            continue
        if _has_artifacts(act):
            continue
        if re.search(r'\bv\.\s', act):  # Case name, not an act
            continue
        cleaned.append(act)
    if len(cleaned) != len(value):
        return True, cleaned  # Auto-fixed
    return True, value


def _validate_keywords(value: Any, results: dict) -> tuple[bool, Any]:
    if not isinstance(value, list):
        return False, None
    if len(value) == 0:
        return False, None
    cleaned = []
    for kw in value:
        if not isinstance(kw, str):
            continue
        kw = re.sub(r'\s*\n\s*', ' ', kw).strip()  # Collapse newlines
        if len(kw) < 2 or len(kw) > 200:
            continue
        if _has_artifacts(kw):
            continue
        if re.search(r'\bv\.\s', kw):  # Case citation leaked in
            continue
        cleaned.append(kw)
    if len(cleaned) == 0:
        return False, None
    if len(cleaned) != len(value):
        return True, cleaned  # Auto-fixed
    return True, value


def _validate_case_arising_from(value: Any, results: dict) -> tuple[bool, Any]:
    if not isinstance(value, dict):
        return False, None
    if len(value) == 0:
        return True, value  # Empty is acceptable
    has_jurisdiction = bool(value.get("jurisdiction"))
    has_primary = bool(value.get("primary_case"))
    if has_jurisdiction or has_primary:
        return True, value
    return False, None


def _validate_result_of_case(value: Any, results: dict) -> tuple[bool, Any]:
    if not value or not isinstance(value, str):
        return False, None
    if len(value) < 5:
        return False, None
    if _has_artifacts(value):
        fixed = _strip_artifacts(value)
        if fixed and len(fixed) >= 5:
            return True, fixed
        return False, None
    return True, value


# ---------------------------------------------------------------------------
# Field → validator mapping
# ---------------------------------------------------------------------------

VALIDATORS = {
    "extracted_citation": _validate_citation,
    "extracted_petitioner": _validate_petitioner,
    "extracted_respondent": _validate_respondent,
    "case_category": _validate_case_category,
    "case_number": _validate_case_number,
    "judge_names": _validate_judge_names,
    "author_judge_name": _validate_author_judge,
    "bench_size": _validate_bench_size,
    "issue_for_consideration": _validate_issue,
    "headnotes": _validate_headnotes,
    "cases_cited": _validate_cases_cited,
    "acts_cited": _validate_acts_cited,
    "keywords": _validate_keywords,
    "case_arising_from": _validate_case_arising_from,
    "result_of_case": _validate_result_of_case,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def validate_and_fix(results: dict) -> tuple[dict, list[str]]:
    """
    Validate all fields in an extraction result.
    Auto-fixes where possible.

    Returns:
        (fixed_results, failed_fields)
        - fixed_results: dict with auto-fixed values applied
        - failed_fields: list of field names that need LLM re-extraction
    """
    fixed = dict(results)
    failed = []

    for field, validator_fn in VALIDATORS.items():
        value = results.get(field)
        is_valid, fixed_value = validator_fn(value, results)

        if is_valid:
            if fixed_value is not None:
                fixed[field] = fixed_value
        else:
            if fixed_value is not None:
                # Auto-fix was attempted but field is still somewhat valid
                fixed[field] = fixed_value
            else:
                failed.append(field)

    # Re-sync bench_size after judge_names may have been cleaned
    if isinstance(fixed.get("judge_names"), list) and len(fixed["judge_names"]) > 0:
        fixed["bench_size"] = len(fixed["judge_names"])

    return fixed, failed


def validation_report(results: dict) -> dict[str, dict]:
    """
    Generate a detailed validation report for a single case's extraction results.

    Returns dict of {field_name: {valid: bool, issue: str | None}}
    """
    report = {}
    for field, validator_fn in VALIDATORS.items():
        value = results.get(field)
        is_valid, fixed_value = validator_fn(value, results)
        if is_valid:
            report[field] = {"valid": True, "issue": None}
        else:
            if value is None:
                report[field] = {"valid": False, "issue": "missing"}
            elif isinstance(value, str) and _has_artifacts(value):
                report[field] = {"valid": False, "issue": "contains_artifacts"}
            elif isinstance(value, str) and _has_section_heading(value):
                report[field] = {"valid": False, "issue": "boundary_failure"}
            elif isinstance(value, str) and len(value) > 500:
                report[field] = {"valid": False, "issue": "too_long"}
            else:
                report[field] = {"valid": False, "issue": "invalid_format"}
    return report
