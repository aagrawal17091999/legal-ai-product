"""Shared chunking utilities for the embedding pipeline.

Every chunk is prefixed with a structured metadata header built from the
case's extraction columns. This means the embedding vector captures signal
from title, citation, parties, judges, acts, keywords, headnotes, etc. —
not just the raw judgment prose. A user searching "Section 304A cases" will
get high cosine similarity even if the chunk body only says "rash and
negligent act", because the header mentions "Indian Penal Code Section 304A".

The header is built from EXTRACTED (clean) columns only. If an extraction
column is NULL/empty, that line is omitted.
"""

import json
from config import CHUNK_SIZE, CHUNK_OVERLAP


def build_metadata_header(row: dict, source_table: str) -> str:
    """Build a metadata header string from a case's extraction columns.

    Args:
        row: dict with column names as keys (from a psycopg2 DictCursor or
             a dict built from positional columns).
        source_table: 'supreme_court_cases' or 'high_court_cases'.

    Returns:
        A multi-line string ending with a blank line, ready to prepend to
        each chunk. Empty string if no metadata is available.
    """
    lines: list[str] = []

    def add(label: str, value) -> None:
        if value and str(value).strip():
            lines.append(f"{label}: {str(value).strip()}")

    def add_list(label: str, value) -> None:
        """Handle JSONB array columns (may arrive as str, list, or None)."""
        items = _parse_jsonb_list(value)
        if items:
            lines.append(f"{label}: {'; '.join(items)}")

    # --- Fields common to both SC and HC ---
    add("Title", row.get("title"))
    add("Citation", row.get("extracted_citation"))

    if source_table == "supreme_court_cases":
        add("Court", row.get("court") or "Supreme Court of India")
    else:
        add("Court", row.get("court_name"))

    add("Date", row.get("decision_date"))

    # Judge names (JSONB array)
    add_list("Judges", row.get("judge_names"))
    add("Author", row.get("author_judge_name"))

    # Parties (extracted)
    pet = row.get("extracted_petitioner")
    resp = row.get("extracted_respondent")
    if pet and resp:
        add("Parties", f"{pet} v. {resp}")
    elif pet:
        add("Petitioner", pet)
    elif resp:
        add("Respondent", resp)

    add("Category", row.get("case_category"))
    add("Disposal", row.get("disposal_nature"))
    add("Result", row.get("result_of_case"))

    add_list("Acts cited", row.get("acts_cited"))
    add_list("Keywords", row.get("keywords"))
    add_list("Cases cited", row.get("cases_cited"))

    # Issue and headnotes — can be long. Cap headnotes at 1500 chars to
    # keep the header reasonable relative to the 2000-char chunk body.
    issue = row.get("issue_for_consideration")
    if issue and str(issue).strip():
        lines.append(f"Issue: {str(issue).strip()[:500]}")

    headnotes = row.get("headnotes")
    if headnotes and str(headnotes).strip():
        h = str(headnotes).strip()
        lines.append(f"Headnotes: {h[:800]}")

    if not lines:
        return ""

    return "\n".join(lines) + "\n\n"


def chunk_text_with_header(
    judgment_text: str,
    header: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """Split judgment text into overlapping chunks, each prefixed with the
    metadata header.

    The header is prepended to every chunk so that each embedding carries
    the full metadata signal regardless of which chunk is retrieved.
    """
    if not judgment_text:
        return []

    chunks: list[str] = []
    start = 0
    text = judgment_text.strip()

    while start < len(text):
        end = start + chunk_size
        body = text[start:end].strip()
        if body:
            chunks.append(header + body if header else body)
        start = end - overlap

    return chunks


def chunk_text_plain(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """Fallback: chunk without any header (used when extraction metadata
    is unavailable, e.g. process_and_load.py before extract_fields runs)."""
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
    return chunks


# --- JSONB helpers ---

def _parse_jsonb_list(value) -> list[str]:
    """Normalize a JSONB array column to a list of non-empty strings.

    The value may be: None, a Python list (psycopg2 auto-parses JSONB),
    a JSON string, or a list of dicts with a 'name' key.
    """
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return [value] if value.strip() else []
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            # acts_cited can be [{"name": "...", ...}]
            name = item.get("name") or item.get("title") or ""
            if isinstance(name, str) and name.strip():
                out.append(name.strip())
    return out


def estimate_tokens(text: str) -> int:
    """Rough token count — legal text with citations and proper nouns tokenizes
    at ~2.5 chars per token (worse than the typical ~4 for plain English)."""
    return int(len(text) / 2.5)


VOYAGE_MAX_BATCH_TOKENS = 100_000  # stay well under 120k limit


def batch_chunks_by_tokens(
    chunks: list[str],
    max_tokens: int = VOYAGE_MAX_BATCH_TOKENS,
) -> list[list[str]]:
    """Split a list of chunks into batches that each fit within the Voyage
    token limit. Falls back to single-chunk batches for very large chunks."""
    batches: list[list[str]] = []
    current_batch: list[str] = []
    current_tokens = 0

    for chunk in chunks:
        chunk_tokens = estimate_tokens(chunk)
        if chunk_tokens > max_tokens:
            # Single chunk exceeds the limit — send it alone and let Voyage
            # truncate if needed (better than skipping the entire case).
            if current_batch:
                batches.append(current_batch)
                current_batch = []
                current_tokens = 0
            batches.append([chunk])
            continue

        if current_tokens + chunk_tokens > max_tokens:
            batches.append(current_batch)
            current_batch = []
            current_tokens = 0

        current_batch.append(chunk)
        current_tokens += chunk_tokens

    if current_batch:
        batches.append(current_batch)

    return batches


# --- SQL column lists for fetching extraction metadata ---

# These match the columns read by build_metadata_header. Used by the
# embedding scripts to SELECT exactly the columns needed.
SC_METADATA_COLUMNS = """
    c.title, c.court, c.decision_date, c.disposal_nature,
    c.extracted_citation, c.extracted_petitioner, c.extracted_respondent,
    c.case_category, c.author_judge_name, c.judge_names,
    c.result_of_case, c.acts_cited, c.keywords, c.cases_cited,
    c.issue_for_consideration, c.headnotes
""".strip()

HC_METADATA_COLUMNS = """
    c.title, c.court_name, c.decision_date::text AS decision_date, c.disposal_nature,
    c.extracted_citation, c.extracted_petitioner, c.extracted_respondent,
    c.case_category, c.author_judge_name, c.judge_names,
    c.result_of_case, c.acts_cited, c.keywords, c.cases_cited,
    c.issue_for_consideration, c.headnotes
""".strip()
