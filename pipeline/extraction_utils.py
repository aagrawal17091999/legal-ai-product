"""
Tier 1: Regex/pattern-based extraction for SCR-formatted Supreme Court judgments.

Each function takes the full judgment_text and returns the extracted value or None.
The SCR template has clearly labeled sections in a standard order:
  Citation → Petitioner v. Respondent → Case Number → Date → Judges →
  Issue for Consideration → Headnotes → Case Law Cited → List of Acts →
  List of Keywords → Case Arising From → Appearances → Judgment → Result
"""

import re
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# PDF artifact cleanup
# ---------------------------------------------------------------------------

def clean_pdf_artifacts(text: str, collapse_whitespace: bool = False) -> str:
    """Remove SCR page headers, footers, page numbers, and control chars from extracted text.

    When collapse_whitespace=True, also collapses runs of spaces/tabs into a single
    space, runs of 3+ newlines into two, and strips the result — the shape expected
    by extraction_validator when cleaning petitioner/respondent fields.
    """
    text = re.sub(r'[\x08]', '', text)
    text = re.sub(r'\[?\d{4}\]?\s+\d+\s+S\.C\.R\.?\s*\n?', '', text)
    text = re.sub(r'Digital Supreme Court Reports\s*\n?', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\n\s*\d{1,4}\s*\n', '\n', text)
    text = re.sub(r'\*\s*Author\b', '', text)
    text = re.sub(r'\n[A-Z][A-Za-z\s.@]+\s+v\.\s+[A-Z][A-Za-z\s.@]+\n', '\n', text)
    if collapse_whitespace:
        text = re.sub(r'[ \t]+', ' ', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()
    return text




def _collapse_newlines(text: str) -> str:
    """Collapse internal newlines into spaces for single-value fields."""
    return re.sub(r'\s*\n\s*', ' ', text).strip()


# ---------------------------------------------------------------------------
# Section heading patterns (used to extract text between consecutive headings)
# ---------------------------------------------------------------------------

SECTION_HEADINGS = [
    "Issue for Consideration",
    "Headnotes",
    "Case Law Cited",
    "List of Acts",
    "List of Keywords",
    "Case Arising From",
    "Appearances for Parties",
    "Judgment / Order of the Supreme Court",
    "Judgment",
]


# Max bytes of a section when no end-heading is found. Real SCR sections are
# short; a multi-KB span almost always means we fell off the end into body text.
_SECTION_MAX_FALLBACK = 1500

# Only look for headnote-area headings within the first portion of the doc.
# Actual headnote pages are ~10–50 KB, never past the first judgment marker.
_HEADNOTE_WINDOW = 30000

_JUDGMENT_START_RE = re.compile(
    r'\n\s*(?:JUDGMENT\s*/\s*ORDER\s+OF\s+THE\s+SUPREME\s+COURT|JUDGMENT\b|ORDER\b)\s*\n',
    re.IGNORECASE,
)


def _headnote_region(text: str) -> str:
    """Return the headnote portion of the judgment — everything before the
    first JUDGMENT / ORDER marker. Falls back to a char cap if no marker found.
    """
    m = _JUDGMENT_START_RE.search(text)
    if m:
        return text[: m.start()]
    return text[: _HEADNOTE_WINDOW]


def _extract_section(
    text: str,
    start_heading: str,
    end_headings: list[str],
    within_headnote: bool = True,
) -> str | None:
    """Extract text between start_heading and the first occurrence of any
    end_heading. By default restricts the search to the headnote region so a
    stray "list of acts" inside body prose can't anchor the extractor.

    The start heading must sit on its own line (with optional †/* marker)
    or at document start — substring matches in running text no longer win.
    """
    search_text = _headnote_region(text) if within_headnote else text

    # Heading must begin a line (or open the document) and end a line.
    # Tolerates trailing †/*, and a single trailing colon.
    start_pat = (
        r'(?:^|\n)[ \t]*' + re.escape(start_heading) + r'[†*]?[ \t]*:?[ \t]*(?:\n|$)'
    )
    start_match = re.search(start_pat, search_text, re.IGNORECASE)
    if not start_match:
        return None

    after_start = search_text[start_match.end():]

    # Find the earliest end heading (also anchored to a line boundary).
    earliest_pos = None
    for eh in end_headings:
        eh_pat = r'(?:^|\n)[ \t]*' + re.escape(eh) + r'[†*]?'
        eh_match = re.search(eh_pat, after_start, re.IGNORECASE)
        if eh_match and (earliest_pos is None or eh_match.start() < earliest_pos):
            earliest_pos = eh_match.start()

    if earliest_pos is None:
        # No end heading found — don't swallow the rest of the document.
        # Cap to a sane section length.
        earliest_pos = min(_SECTION_MAX_FALLBACK, len(after_start))

    section = after_start[:earliest_pos].strip()
    if not section:
        return None
    section = clean_pdf_artifacts(section)
    return section.strip() if section.strip() else None


# ---------------------------------------------------------------------------
# 1. Citation
# ---------------------------------------------------------------------------

def extract_citation(text: str) -> str | None:
    """Extract SCR citation and INSC number from the beginning of the text."""
    try:
        header = text[:2000]
        scr_match = re.search(r'\[(\d{4})\]\s+(\d+)\s+S\.C\.R\.\s+(\d+)', header)
        insc_match = re.search(r'(\d{4})\s+INSC\s+(\d+)', header)

        if scr_match and insc_match:
            scr = f"[{scr_match.group(1)}] {scr_match.group(2)} S.C.R. {scr_match.group(3)}"
            insc = f"{insc_match.group(1)} INSC {insc_match.group(2)}"
            return f"{scr} : {insc}"
        elif scr_match:
            return f"[{scr_match.group(1)}] {scr_match.group(2)} S.C.R. {scr_match.group(3)}"
        elif insc_match:
            return f"{insc_match.group(1)} INSC {insc_match.group(2)}"
        return None
    except Exception as e:
        logger.debug(f"extract_citation failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 2. Petitioner
# ---------------------------------------------------------------------------

def extract_petitioner(text: str) -> str | None:
    """Extract petitioner name — text after citation, before 'v.' or 'versus'."""
    try:
        header = text[:3000]

        # Find the "v." or "versus" line
        v_match = re.search(r'\n\s*(v\.|versus)\s*\n', header, re.IGNORECASE)
        if not v_match:
            # Try inline v.
            v_match = re.search(r'\s+v\.\s+', header, re.IGNORECASE)
        if not v_match:
            return None

        before_v = header[:v_match.start()]

        # Skip past citation lines (lines with S.C.R., INSC, or starting with [)
        lines = before_v.strip().split('\n')
        # Work backwards from the end to find name lines (skip empty lines)
        name_lines = []
        for line in reversed(lines):
            line_stripped = line.strip()
            if not line_stripped:
                if name_lines:
                    break
                continue
            # Stop if this looks like a citation line, a section label from
            # the modern SCR header (e.g. "Case Details"), or a non-content
            # artifact (e.g. "* Author", "DIGITAL SUPREME COURT REPORTS").
            if re.search(
                r'S\.C\.R\.|INSC|\[\d{4}\]|SUPREME COURT|REPORTABLE|'
                r'^\s*(?:Other\s+)?Case\s+Details\s*$|'
                r'^\s*\*\s*Author\b|'
                r'DIGITAL SUPREME COURT REPORTS',
                line_stripped,
                re.IGNORECASE,
            ):
                break
            name_lines.insert(0, line_stripped)

        if name_lines:
            petitioner = ' '.join(name_lines)
            # Clean up extra whitespace
            petitioner = re.sub(r'\s+', ' ', petitioner).strip()
            return petitioner if petitioner else None
        return None
    except Exception as e:
        logger.debug(f"extract_petitioner failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 3. Respondent
# ---------------------------------------------------------------------------

def extract_respondent(text: str) -> str | None:
    """Extract respondent name — text after 'v.'/'versus', before case number in parens."""
    try:
        header = text[:3000]

        # Find the "v." or "versus" line
        v_match = re.search(r'\n\s*(v\.|versus)\s*\n', header, re.IGNORECASE)
        if not v_match:
            v_match = re.search(r'\s+v\.\s+', header, re.IGNORECASE)
        if not v_match:
            return None

        after_v = header[v_match.end():]

        # Find the case number line in parentheses
        case_num_match = re.search(
            r'\(.*(Appeal|Petition|Case|Writ|SLP|Application|Suo Motu).*No',
            after_v, re.IGNORECASE
        )

        if case_num_match:
            respondent_text = after_v[:case_num_match.start()]
        else:
            # Take up to the next line that looks like a date or parenthetical
            date_match = re.search(r'\n\s*\[?\d{1,2}[./\-]', after_v)
            paren_match = re.search(r'\n\s*\(', after_v)
            end_pos = len(after_v)
            if date_match:
                end_pos = min(end_pos, date_match.start())
            if paren_match:
                end_pos = min(end_pos, paren_match.start())
            respondent_text = after_v[:end_pos]

        # Clean up
        respondent = ' '.join(respondent_text.strip().split('\n'))
        respondent = re.sub(r'\s+', ' ', respondent).strip()
        return respondent if respondent else None
    except Exception as e:
        logger.debug(f"extract_respondent failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 4. Case Number
# ---------------------------------------------------------------------------

def extract_case_number(text: str) -> str | None:
    """Extract case number from parenthetical after respondent name."""
    try:
        header = text[:3000]
        match = re.search(
            r'\((.{0,10}(?:Appeal|Petition|Case|Writ|SLP|Application|Suo Motu)'
            r'(?:\s*\([^)]*\))?\s*No\.?\s*[\d\-/]+\s*(?:of|OF)\s*\d{4})\)',
            header, re.IGNORECASE
        )
        if match:
            return match.group(1).strip()

        # Fallback: look for common patterns without strict parentheses
        match = re.search(
            r'((?:Criminal|Civil|Writ|Transfer|Review|Contempt|Special Leave)\s+'
            r'(?:Appeal|Petition|Case|Application)'
            r'(?:\s*\([^)]*\))?\s*No\.?\s*[\d\-/]+\s*(?:of|OF)\s*\d{4})',
            header, re.IGNORECASE
        )
        if match:
            return match.group(1).strip()
        return None
    except Exception as e:
        logger.debug(f"extract_case_number failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 5. Case Category
# ---------------------------------------------------------------------------

def extract_case_category(text: str) -> str | None:
    """Derive case category from case number or case arising from section."""
    try:
        # Look at first 5000 chars for category signals
        header = text[:5000].upper()

        if 'CRIMINAL' in header or 'SLP(CRL)' in header or 'SLP (CRL)' in header:
            return 'Criminal'
        if 'CIVIL' in header or 'SLP(C)' in header or 'SLP (C)' in header:
            return 'Civil'
        if 'WRIT PETITION' in header:
            return 'Constitutional'
        if 'TAX' in header or 'INCOME TAX' in header:
            return 'Tax'
        if 'TRANSFER' in header and 'PETITION' in header:
            return 'Transfer'
        if 'CONTEMPT' in header:
            return 'Contempt'
        if 'REVIEW' in header:
            return 'Review'

        # Check the case_arising_from section too
        arising = _extract_section(text, "Case Arising From", ["Appearances for Parties", "Judgment"])
        if arising:
            arising_upper = arising.upper()
            if 'CRIMINAL' in arising_upper:
                return 'Criminal'
            if 'CIVIL' in arising_upper:
                return 'Civil'

        return 'Other'
    except Exception as e:
        logger.debug(f"extract_case_category failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 6. Judge Names
# ---------------------------------------------------------------------------

def extract_judge_names(text: str) -> list[str]:
    """Extract judge names from the bench line (contains JJ.] or J.])."""
    try:
        header = text[:2000]

        # Look for lines containing JJ.] or J.] — the bench composition line
        # Pattern: [Name1 and Name2,* JJ.] or [Name, J.]
        bench_match = re.search(
            r'\[([^\]]*(?:JJ\.|J\.))\s*\]',
            header, re.IGNORECASE
        )
        if not bench_match:
            # Try without brackets
            bench_match = re.search(
                r'(?:CORAM|HON\'?BLE)[:\s]+(.*?)(?:\n\n|\n(?=[A-Z]{2,}))',
                header, re.IGNORECASE | re.DOTALL
            )

        if not bench_match:
            return []

        bench_text = bench_match.group(1)

        # Remove JJ., J., asterisks, and clean up
        bench_text = re.sub(r',?\s*JJ\.?', '', bench_text)
        bench_text = re.sub(r',?\s*J\.?', '', bench_text)
        bench_text = bench_text.replace('*', '').replace('[', '').replace(']', '')

        # Split on " and " or ", "
        judges = re.split(r'\s+and\s+|,\s*', bench_text)
        judges = [j.strip() for j in judges if j.strip()]

        # Filter out non-name entries
        judges = [j for j in judges if len(j) > 2 and not j.isdigit()]

        return judges
    except Exception as e:
        logger.debug(f"extract_judge_names failed: {e}")
        return []


# ---------------------------------------------------------------------------
# 7. Author Judge
# ---------------------------------------------------------------------------

def extract_author_judge(text: str) -> str | None:
    """Extract the author judge — marked with * in bench line, or first 'Name, J.' after Judgment heading."""
    try:
        header = text[:2000]

        # Method 1: Look for asterisk-marked judge in bench line
        bench_match = re.search(r'\[([^\]]*(?:JJ\.|J\.))\s*\]', header, re.IGNORECASE)
        if bench_match:
            bench_text = bench_match.group(1)
            # Find the name followed by * or ,*
            star_match = re.search(r'(?:.*\band\b\s+|.*,\s*)?([A-Z][A-Za-z.\s]+?)\s*,?\s*\*', bench_text)
            if star_match:
                return star_match.group(1).strip()

        # Method 2: First "Name, J." after "Judgment" heading
        judgment_match = re.search(r'(?:J\s*U\s*D\s*G\s*M\s*E\s*N\s*T|JUDGMENT)', text, re.IGNORECASE)
        if judgment_match:
            after_judgment = text[judgment_match.end():judgment_match.end() + 500]
            author_match = re.search(r'([A-Z][A-Za-z\s.]+?)\s*,?\s*J\.', after_judgment)
            if author_match:
                return author_match.group(1).strip()

        return None
    except Exception as e:
        logger.debug(f"extract_author_judge failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 8. Bench Size
# ---------------------------------------------------------------------------

def extract_bench_size(judge_names: list[str]) -> int:
    """Count judges. Returns 0 if no judges found."""
    return len(judge_names)


# ---------------------------------------------------------------------------
# 9. Issue for Consideration
# ---------------------------------------------------------------------------

def extract_issue_for_consideration(text: str) -> str | None:
    """Extract text between 'Issue for Consideration' and 'Headnotes' headings."""
    try:
        return _extract_section(
            text,
            "Issue for Consideration",
            ["Headnotes", "Case Law Cited", "List of Acts"]
        )
    except Exception as e:
        logger.debug(f"extract_issue_for_consideration failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 10. Headnotes
# ---------------------------------------------------------------------------

def extract_headnotes(text: str) -> str | None:
    """Extract text between 'Headnotes' and 'Case Law Cited' headings."""
    try:
        return _extract_section(
            text,
            "Headnotes",
            ["Case Law Cited", "List of Acts", "List of Keywords"]
        )
    except Exception as e:
        logger.debug(f"extract_headnotes failed: {e}")
        return None


# ---------------------------------------------------------------------------
# 11. Cases Cited
# ---------------------------------------------------------------------------

def extract_cases_cited(text: str) -> list[dict]:
    """Extract cited cases from 'Case Law Cited' section."""
    try:
        section = _extract_section(
            text,
            "Case Law Cited",
            ["List of Acts", "List of Keywords", "Case Arising From"]
        )
        if not section:
            return []

        # Split on semicolons or numbered entries
        entries = re.split(r'\s*;\s*|\n\s*\d+\.\s*', section)
        cases = []

        for entry in entries:
            entry = entry.strip()
            if not entry or len(entry) < 10:
                continue

            # Try to separate name from citation
            # Pattern: Name (YYYY) N SCC NNN or Name [YYYY] N SCR NNN
            citation_match = re.search(
                r'(.*?)\s*(\[?\(?\d{4}\)?\]?\s+\d+\s+(?:S\.?C\.?R\.?|S\.?C\.?C\.?|SCC|SCR).*)',
                entry, re.IGNORECASE
            )
            if citation_match:
                name = citation_match.group(1).strip().rstrip(',').rstrip(':')
                citation = citation_match.group(2).strip()
                if name:
                    cases.append({"name": name, "citation": citation})
                else:
                    cases.append({"name": entry, "citation": citation})
            else:
                # No recognizable citation pattern — store the whole entry as name
                cases.append({"name": entry, "citation": ""})

        return cases
    except Exception as e:
        logger.debug(f"extract_cases_cited failed: {e}")
        return []


# ---------------------------------------------------------------------------
# 12. Acts Cited
# ---------------------------------------------------------------------------

def extract_acts_cited(text: str) -> list[str]:
    """Extract acts from the 'List of Acts' section of judgment_text.

    Tightened behaviour:
      - heading must sit on its own line (no substring matches in body prose)
      - search is confined to the headnote region
      - falls back to a 1.5KB cap instead of end-of-document
      - entries must pass the case-sensitive act-shape filter

    For highest accuracy use extract_acts_cited_layout(pdf_path) instead —
    this text-based path is the fallback for when the PDF isn't available.
    """
    try:
        section = _extract_section(
            text,
            "List of Acts",
            [
                "Keywords",            # modern SCR format
                "List of Keywords",    # older SCR format
                "Case Arising From",
                "Appearances for Parties",
            ],
        )
        if not section:
            return []
        return _split_and_validate_acts(section)
    except Exception as e:
        logger.debug(f"extract_acts_cited failed: {e}")
        return []


# Keywords that indicate a string is an act/statute/regulation name.
# Case-SENSITIVE: genuine act names always capitalize these tokens. Body prose
# ("any other act whatsoever", "the court ordered…") uses lowercase and must
# not pass this filter.
_ACT_KEYWORD_RE = re.compile(
    r'\b(Act|Code|Rules?|Regulations?|Constitution|Ordinance|'
    r'Bill|Order|Scheme|Notification|Bye[- ]?laws?|Statute|'
    r'Sanhita|Adhiniyam)\b'
)

# Max plausible length for a single act-name entry. Long strings indicate a
# semicolon-split failed and captured paragraph prose.
_ACT_MAX_LEN = 200


def _looks_like_act(entry: str) -> bool:
    """Return True if entry plausibly names an act/statute."""
    if not entry or len(entry) < 5 or len(entry) > _ACT_MAX_LEN:
        return False
    # Bare year (e.g., "2018") or bare number.
    if re.fullmatch(r'\d{2,4}', entry):
        return False
    # Must contain an act-shaped keyword (case-sensitive, see _ACT_KEYWORD_RE).
    if not _ACT_KEYWORD_RE.search(entry):
        return False
    # Reject case citations that accidentally leaked in.
    if re.search(r'\bv\.\s', entry):
        return False
    # Reject sentence-like fragments: contain lowercase "any", "which",
    # "means", "whether" — common in statutory definitions copied into
    # judgment body text.
    if re.search(r'\b(means|whether|which—|scandalises|any other|tends to)\b', entry):
        return False
    return True


# ---------------------------------------------------------------------------
# Generic headnote-block extractor
#
# SCR headnote pages are segmented by PyMuPDF into discrete text blocks. A
# heading block ("List of Acts", "Keywords", "Case Law Cited", ...) is
# followed by zero or more content blocks, then the next heading block. This
# single-pass function walks the first N pages, groups content under the
# preceding heading, and returns a dict keyed by the canonical heading label.
#
# Every layout-aware field extractor below shares this walk — one PDF open
# per case, not one-per-field.
# ---------------------------------------------------------------------------

# Recognized SCR headnote headings. Keys are canonical labels used by callers;
# each value is a regex (case-insensitive) that matches block text for that heading.
#
# SCR formats varied over the years and both old and new labels coexist in
# the corpus. Each regex tolerates the known variants:
#   - Case Law Cited ≡ List of Citations [and Other References]
#   - Keywords ≡ List of Keywords
#   - Case Arising From is a separate block in older judgments; in modern
#     judgments that information lives inside the "Appearances" section.
HEADNOTE_HEADINGS = {
    "Issue for Consideration": re.compile(
        r'^\s*Issue[s]?\s+for\s+Consideration[†*]?\s*$', re.IGNORECASE),
    "Headnotes": re.compile(r'^\s*Headnotes[†*]?\s*$', re.IGNORECASE),
    "Case Law Cited": re.compile(
        r'^\s*(?:Case\s+Law\s+Cited|List\s+of\s+Citations(?:\s+and\s+Other\s+References)?)[†*]?\s*$',
        re.IGNORECASE),
    "List of Acts": re.compile(r'^\s*List\s+of\s+Acts[†*]?\s*$', re.IGNORECASE),
    "Keywords": re.compile(r'^\s*(?:List\s+of\s+)?Keywords[†*]?\s*$', re.IGNORECASE),
    "Case Arising From": re.compile(
        r'^\s*Case\s+Arising\s+From[†*]?\s*$', re.IGNORECASE),
    # Modern SCR wraps arising-from + appearances in a single block titled
    # "Other Case Details Including Impugned Order and Appearances".
    "Other Case Details": re.compile(
        r'^\s*Other\s+Case\s+Details(?:\s+Including\s+Impugned\s+Order\s+and\s+Appearances)?[†*]?\s*$',
        re.IGNORECASE | re.DOTALL),
    "Appearances for Parties": re.compile(
        r'^\s*Appearances(?:\s+for\s+(?:the\s+)?Parties)?[†*]?\s*:?\s*$',
        re.IGNORECASE),
    "Judgment": re.compile(
        r'^\s*(?:JUDGMENT(?:\s*/\s*ORDER.*)?|ORDER)\s*$', re.IGNORECASE),
}


def _match_heading(block_text: str) -> str | None:
    """Return the canonical heading name if block_text matches any known
    heading, else None."""
    for name, pat in HEADNOTE_HEADINGS.items():
        if pat.match(block_text):
            return name
    return None


def extract_headnote_blocks(pdf_path: str, max_pages: int = 8) -> dict[str, str] | None:
    """Walk the first max_pages of the PDF and return a dict
    {heading_name: content_text} for every recognized headnote section.
    Returns None if the PDF can't be opened, {} if no headings found at all.
    Caller distinguishes "not present" (key missing) from "empty" (key → "")
    from "layout N/A" (return None)."""
    try:
        import fitz
    except ImportError:
        logger.debug("PyMuPDF not installed; layout extraction unavailable")
        return None

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        logger.debug(f"Could not open PDF {pdf_path}: {e}")
        return None

    result: dict[str, list[str]] = {}
    current_heading: str | None = None

    try:
        for page in doc[:max_pages]:
            try:
                blocks = page.get_text("blocks")
            except Exception:
                continue
            text_blocks = [b for b in blocks if len(b) >= 7 and b[6] == 0]
            # Sort top-to-bottom, then left-to-right (within ~2pt tolerance).
            text_blocks.sort(key=lambda b: (round(b[1], 0), b[0]))

            for b in text_blocks:
                text = (b[4] or "").strip()
                if not text:
                    continue

                heading = _match_heading(text)
                if heading:
                    # Stop scanning once we hit the judgment body.
                    if heading == "Judgment":
                        doc.close()
                        return {k: "\n".join(v).strip() for k, v in result.items()}
                    current_heading = heading
                    result.setdefault(current_heading, [])
                    continue

                if current_heading is not None:
                    result[current_heading].append(text)
    finally:
        try:
            doc.close()
        except Exception:
            pass

    return {k: "\n".join(v).strip() for k, v in result.items()}


# ---------------------------------------------------------------------------
# 12b. Layout-aware Acts Cited extractor (primary path)
#
# SCR headnote "boxes" are visual only — they aren't represented as vector
# rectangles in the PDF (the on-page strokes are just line segments). What
# IS reliable: PyMuPDF segments the headnote page into discrete text blocks
# via page.get_text("blocks"), one per paragraph/heading. The block whose
# text is "List of Acts" is followed by exactly one content block with the
# semicolon-separated acts list, then the next heading block (e.g.
# "Keywords"). We walk this sequence.
#
# Returns None (not []) when the method is inapplicable (no such heading
# block found), so the caller can distinguish "layout says empty" from
# "layout N/A".
# ---------------------------------------------------------------------------

def extract_acts_cited_layout(pdf_path: str) -> list[str] | None:
    """Extract acts from the 'List of Acts' headnote block. Thin wrapper
    around extract_headnote_blocks + acts-specific parsing."""
    blocks = extract_headnote_blocks(pdf_path)
    if blocks is None:
        return None
    content = blocks.get("List of Acts")
    if content is None:
        return None
    if not content.strip():
        return []
    return _split_and_validate_acts(content)


def _split_and_validate_acts(body: str) -> list[str]:
    """Split semicolon-delimited acts list and filter to act-shaped entries."""
    flat = _collapse_newlines(body)
    entries = [e.strip() for e in flat.split(';')]
    acts = []
    for entry in entries:
        entry = entry.strip('–').strip('-').strip().rstrip('.').strip()
        if _looks_like_act(entry):
            acts.append(entry)
    return acts


# ---------------------------------------------------------------------------
# 12c. Layout-aware extractors for other boxed headnote fields
# ---------------------------------------------------------------------------

def extract_keywords_layout(pdf_path: str) -> list[str] | None:
    """Extract keywords from the 'Keywords' headnote block."""
    blocks = extract_headnote_blocks(pdf_path)
    if blocks is None:
        return None
    content = blocks.get("Keywords")
    if content is None:
        return None
    return _split_keywords(content)


def extract_issue_for_consideration_layout(pdf_path: str) -> str | None:
    """Extract issue text from the 'Issue for Consideration' headnote block.
    Returns None if layout unavailable, empty string if block empty, else the
    collapsed text."""
    blocks = extract_headnote_blocks(pdf_path)
    if blocks is None:
        return None
    content = blocks.get("Issue for Consideration")
    if content is None:
        return None
    return _collapse_newlines(content)


def extract_headnotes_layout(pdf_path: str) -> str | None:
    """Extract headnotes body from the 'Headnotes' block (long text, newlines preserved)."""
    blocks = extract_headnote_blocks(pdf_path)
    if blocks is None:
        return None
    content = blocks.get("Headnotes")
    if content is None:
        return None
    # Collapse multi-blank lines but keep paragraph structure.
    content = re.sub(r'\n{3,}', '\n\n', content)
    return content.strip()


def extract_cases_cited_layout(pdf_path: str) -> list[dict] | None:
    """Extract cases list from the 'Case Law Cited' headnote block.
    Returns list of {"name": str, "citation": str} dicts."""
    blocks = extract_headnote_blocks(pdf_path)
    if blocks is None:
        return None
    content = blocks.get("Case Law Cited")
    if content is None:
        return None
    if not content.strip():
        return []
    return _parse_cases_cited(content)


def extract_case_arising_from_layout(pdf_path: str) -> dict | None:
    """Extract jurisdiction/primary/lower-court info. Older SCR format has a
    dedicated 'Case Arising From' block; newer format embeds this information
    inside the 'Appearances for Parties' block. We prefer the dedicated block
    when available, else fall back to the appearances block."""
    blocks = extract_headnote_blocks(pdf_path)
    if blocks is None:
        return None
    content = blocks.get("Case Arising From")
    if content is None or not content.strip():
        # Fall back to the container used by modern SCR.
        content = blocks.get("Other Case Details")
    if content is None or not content.strip():
        content = blocks.get("Appearances for Parties")
    if content is None:
        return None
    if not content.strip():
        return {}
    return _parse_case_arising_from(content)


def _split_keywords(body: str) -> list[str]:
    """Split semicolon-delimited keywords, validate each."""
    flat = _collapse_newlines(body)
    entries = re.split(r'\s*;\s*', flat)
    keywords = []
    for entry in entries:
        entry = entry.strip('–').strip('-').strip().rstrip('.').strip()
        if 2 <= len(entry) <= 200:
            # Reject obvious artifacts
            if re.search(r'\bv\.\s', entry):
                continue
            keywords.append(entry)
    return keywords


_CASE_CITATION_RE = re.compile(
    r'(?:'
    # Reporter citation: "(2021) 7 SCC 806" or "[2009] 15 SCR 317"
    r'[\[\(]\d{4}[\]\)]\s*\d*\s*(?:SCC|SCR|S\.C\.C|S\.C\.R|INSC|AIR|SCALE|Cri LJ|JT)[^;]*'
    r'|'
    # Case-number citation: "Writ Petition (Civil) No. 521/2002",
    #                       "Contempt Petition (Civil) Nos. 425-426 of 2015"
    r'(?:Writ|Criminal|Civil|Special Leave|Contempt|Transfer|Review|Arbitration)\s+'
    r'(?:Appeal|Petition|Application)[^;]*?'
    r'Nos?\.?(?:\(s\))?\s*[\d\-/,\s]+(?:of\s*\d{4})?'
    r')',
    re.IGNORECASE,
)
_CASE_OUTCOME_RE = re.compile(
    r'\s+[–\-]\s+(?:referred to|relied on|followed|distinguished|overruled|'
    r'applied|approved|cited|not followed|reversed|affirmed)\b.*$',
    re.IGNORECASE,
)


def _parse_cases_cited(body: str) -> list[dict]:
    """Parse the 'Case Law Cited' block into [{name, citation}, ...].

    Per-entry SCR format (separator is `;`):
      <Party1> v. <Party2> <citation> [– <outcome>]

    Citation can be either a reporter cite ("(2021) 7 SCC 806") or a case-number
    cite ("Writ Petition (Civil) No. 521/2002"). Trailing outcome phrases
    ("– referred to", "– relied on") are stripped since they aren't part of
    the citation identity.
    """
    flat = _collapse_newlines(body)
    raw_entries = [e.strip() for e in flat.split(';') if e.strip()]

    cases = []
    for raw in raw_entries:
        entry = _CASE_OUTCOME_RE.sub('', raw).strip()
        if len(entry) < 8:
            continue
        m = _CASE_CITATION_RE.search(entry)
        if m:
            citation = m.group(0).strip().rstrip('.,:;').strip()
            name = entry[:m.start()].strip().rstrip(',').strip()
        else:
            # No citation found — keep only if entry has "v." (a case name)
            if not re.search(r'\bv(?:s|\.)?\s', entry, re.IGNORECASE):
                continue
            citation = ""
            name = entry
        if name and len(name) >= 3:
            cases.append({"name": name, "citation": citation})
    return cases


def _parse_case_arising_from(body: str) -> dict:
    """Parse 'Case Arising From' content into structured dict.

    Typical content is 2–4 lines, e.g.:
      CRIMINAL APPELLATE JURISDICTION : Criminal Appeal No. 123 of 2024
      Arising out of Judgment and Order dated ... in ...

    In modern SCR, this content is embedded within 'Other Case Details
    Including Impugned Order and Appearances' — so truncate at the
    'Appearances:' sub-heading if present.
    """
    # Strip the counsel/appearances portion when we're reading a combined block.
    body = re.split(r'\n\s*Appearances\s*:\s*\n', body, maxsplit=1)[0]

    flat = _collapse_newlines(body)
    result: dict = {
        "jurisdiction": None,
        "primary_case": None,
        "lower_court_details": None,
        "connected_cases": [],
    }

    # Jurisdiction is usually the first ALL-CAPS phrase ending in "JURISDICTION".
    m = re.search(
        r'([A-Z][A-Z\s]+?JURISDICTION)',
        flat,
    )
    if m:
        result["jurisdiction"] = m.group(1).strip()
        remainder = flat[m.end():].lstrip(' :–-').strip()
    else:
        remainder = flat

    # Primary case — first "<CaseType> Appeal/Petition No(s). <number> of <year>".
    # Lookahead `(?=[\s.,]|$)` prevents the regex from swallowing subsequent
    # sentences ("From the Judgment and Order dated ...").
    m = re.search(
        r'((?:Criminal|Civil|Special Leave|Writ|Transfer|Review|Contempt|Arbitration)\s+'
        r'(?:Appeal|Petition|Case|Application)s?\.?\s*'
        r'No[s\.]{0,3}\s*\(?\w?\)?\s*[\d\-/,\s]+?of\s+\d{4})'
        r'(?=[\s.,]|$)',
        remainder, re.IGNORECASE,
    )
    if m:
        result["primary_case"] = re.sub(r'\s+', ' ', m.group(1)).strip()

    # Lower court details — both old ("Arising out of ...") and new
    # ("From the Judgment and Order dated ...") phrasings.
    m = re.search(
        r'(?:Arising\s+out\s+of|From\s+the\s+(?:Judgment|Order|Final\s+Order))[^\n]+',
        flat, re.IGNORECASE,
    )
    if m:
        result["lower_court_details"] = re.sub(r'\s+', ' ', m.group(0)).strip()

    return result


# ---------------------------------------------------------------------------
# 13. Keywords
# ---------------------------------------------------------------------------

def extract_keywords(text: str) -> list[str]:
    """Extract keywords from 'Keywords' / 'List of Keywords' section."""
    try:
        # Modern SCR format uses "Keywords" (no prefix); older uses "List of Keywords".
        # Try both — first match wins.
        section = _extract_section(
            text,
            "Keywords",
            ["Case Arising From", "Appearances for Parties", "Judgment"],
        )
        if not section:
            section = _extract_section(
                text,
                "List of Keywords",
                ["Case Arising From", "Appearances for Parties", "Judgment"],
            )
        if not section:
            return []

        # Split on semicolons (primary delimiter for keywords)
        entries = re.split(r'\s*;\s*', section)
        keywords = []
        for entry in entries:
            entry = _collapse_newlines(entry).strip('–').strip('-').strip()
            if entry and len(entry) > 1:
                keywords.append(entry)

        return keywords
    except Exception as e:
        logger.debug(f"extract_keywords failed: {e}")
        return []


# ---------------------------------------------------------------------------
# 14. Case Arising From
# ---------------------------------------------------------------------------

def extract_case_arising_from(text: str) -> dict:
    """Extract structured info from 'Case Arising From' section."""
    try:
        section = _extract_section(
            text,
            "Case Arising From",
            ["Appearances for Parties", "Judgment / Order", "Judgment"]
        )
        if not section:
            return {}

        result = {
            "jurisdiction": None,
            "primary_case": None,
            "lower_court_details": None,
            "connected_cases": []
        }

        lines = [l.strip() for l in section.strip().split('\n') if l.strip()]

        # First line is often the jurisdiction
        if lines:
            first_line = lines[0].upper()
            if 'JURISDICTION' in first_line or 'APPELLATE' in first_line or 'ORIGINAL' in first_line:
                result["jurisdiction"] = lines[0].strip()

        # Look for primary case number
        for line in lines:
            case_match = re.search(
                r'((?:Criminal|Civil|Writ|Transfer|Review|Contempt|Special Leave)\s+'
                r'(?:Appeal|Petition|Case|Application)'
                r'(?:\s*\([^)]*\))?\s*No\.?\s*[\d\-/]+\s*(?:of|OF)\s*\d{4})',
                line, re.IGNORECASE
            )
            if case_match and not result["primary_case"]:
                result["primary_case"] = case_match.group(1).strip()
            elif case_match:
                result["connected_cases"].append(case_match.group(1).strip())

        # Look for lower court details ("From the Judgment and Order dated...")
        for line in lines:
            if re.search(r'From the (?:Judgment|Order|Final)', line, re.IGNORECASE):
                result["lower_court_details"] = line.strip()
                break

        # Also look for "with" connected cases
        for line in lines:
            with_match = re.search(r'(?:with|W/)\s*(.*(?:Appeal|Petition|Case).*No.*\d{4})', line, re.IGNORECASE)
            if with_match:
                connected = with_match.group(1).strip()
                if connected not in result["connected_cases"]:
                    result["connected_cases"].append(connected)

        return result
    except Exception as e:
        logger.debug(f"extract_case_arising_from failed: {e}")
        return {}


# ---------------------------------------------------------------------------
# 15. Result of Case
# ---------------------------------------------------------------------------

def extract_result_of_case(text: str) -> str | None:
    """Extract 'Result of the Case:' from near the end of the text."""
    try:
        tail = text[-1000:]
        match = re.search(r'Result\s+of\s+the\s+[Cc]ase\s*:\s*(.+)', tail, re.IGNORECASE)
        if match:
            result = match.group(1).strip()
            # Clean up — take only the first line/sentence
            result = result.split('\n')[0].strip()
            return result if result else None
        return None
    except Exception as e:
        logger.debug(f"extract_result_of_case failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

FIELD_EXTRACTORS = {
    "extracted_citation": extract_citation,
    "extracted_petitioner": extract_petitioner,
    "extracted_respondent": extract_respondent,
    "case_number": extract_case_number,
    "case_category": extract_case_category,
    "issue_for_consideration": extract_issue_for_consideration,
    "headnotes": extract_headnotes,
    "cases_cited": extract_cases_cited,
    "acts_cited": extract_acts_cited,
    "keywords": extract_keywords,
    "case_arising_from": extract_case_arising_from,
    "result_of_case": extract_result_of_case,
}


def extract_all_regex(text: str) -> dict:
    """
    Run all regex extractors on the judgment text.
    Returns a dict with extracted values and a '_fields_extracted' count.

    judge_names, author_judge_name, and bench_size are handled specially
    since they depend on each other.
    """
    results = {}

    # Run independent extractors
    for field, fn in FIELD_EXTRACTORS.items():
        try:
            value = fn(text)
            results[field] = value
        except Exception as e:
            logger.warning(f"Extractor {field} raised: {e}")
            results[field] = None

    # Judge-related fields (interdependent)
    try:
        judges = extract_judge_names(text)
        results["judge_names"] = judges
    except Exception as e:
        logger.warning(f"extract_judge_names raised: {e}")
        judges = []
        results["judge_names"] = []

    try:
        results["author_judge_name"] = extract_author_judge(text)
    except Exception as e:
        logger.warning(f"extract_author_judge raised: {e}")
        results["author_judge_name"] = None

    results["bench_size"] = extract_bench_size(judges)

    # Count non-null/non-empty fields
    count = 0
    for k, v in results.items():
        if k.startswith('_'):
            continue
        if v is None:
            continue
        if isinstance(v, (list, dict)) and len(v) == 0:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        if isinstance(v, int) and v == 0:
            continue
        count += 1

    results["_fields_extracted"] = count
    return results
