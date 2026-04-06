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

def _clean_pdf_artifacts(text: str) -> str:
    """Remove SCR page headers, footers, page numbers, and control chars from extracted text."""
    # Remove backspace and other control characters
    text = re.sub(r'[\x08]', '', text)
    # Remove SCR page headers: [YYYY] N S.C.R. NNN (with optional surrounding whitespace/newlines)
    text = re.sub(r'\[?\d{4}\]?\s+\d+\s+S\.C\.R\.?\s*\n?', '', text)
    # Remove "Digital Supreme Court Reports" header
    text = re.sub(r'Digital Supreme Court Reports\s*\n?', '', text)
    # Remove bare page numbers on their own line
    text = re.sub(r'\n\s*\d{1,4}\s*\n', '\n', text)
    # Remove "* Author" markers (author judge artifacts)
    text = re.sub(r'\*\s*Author\b', '', text)
    # Remove case title lines that leak in (Name v. Name pattern on its own line after header removal)
    text = re.sub(r'\n[A-Z][A-Za-z\s.@]+\s+v\.\s+[A-Z][A-Za-z\s.@]+\n', '\n', text)
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


def _extract_section(text: str, start_heading: str, end_headings: list[str]) -> str | None:
    """Extract text between start_heading and the first occurrence of any end_heading."""
    # Build pattern: heading may have optional †, *, etc. after it
    start_pat = re.escape(start_heading) + r'[†*]?'
    start_match = re.search(start_pat, text, re.IGNORECASE)
    if not start_match:
        return None

    after_start = text[start_match.end():]

    # Find the earliest end heading
    earliest_pos = len(after_start)
    for eh in end_headings:
        eh_pat = re.escape(eh) + r'[†*]?'
        eh_match = re.search(eh_pat, after_start, re.IGNORECASE)
        if eh_match and eh_match.start() < earliest_pos:
            earliest_pos = eh_match.start()

    section = after_start[:earliest_pos].strip()
    if not section:
        return None
    section = _clean_pdf_artifacts(section)
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
            # Stop if this looks like a citation/header line
            if re.search(r'S\.C\.R\.|INSC|\[\d{4}\]|SUPREME COURT|REPORTABLE', line_stripped, re.IGNORECASE):
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
    """Extract acts from 'List of Acts' section."""
    try:
        section = _extract_section(
            text,
            "List of Acts",
            ["List of Keywords", "Case Arising From", "Appearances for Parties"]
        )
        if not section:
            return []

        # Split on newlines, semicolons, or numbered entries
        entries = re.split(r'\s*;\s*|\s*\n\s*|\s*\d+\.\s*', section)
        acts = []
        for entry in entries:
            entry = _collapse_newlines(entry).strip('–').strip('-').strip()
            if entry and len(entry) > 3:
                acts.append(entry)

        return acts
    except Exception as e:
        logger.debug(f"extract_acts_cited failed: {e}")
        return []


# ---------------------------------------------------------------------------
# 13. Keywords
# ---------------------------------------------------------------------------

def extract_keywords(text: str) -> list[str]:
    """Extract keywords from 'List of Keywords' section."""
    try:
        section = _extract_section(
            text,
            "List of Keywords",
            ["Case Arising From", "Appearances for Parties", "Judgment"]
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
