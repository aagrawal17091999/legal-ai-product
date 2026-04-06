"""
Tier 2: LLM-based extraction using Claude Haiku for non-SCR judgments.

Used when Tier 1 regex extraction fails to extract enough fields (< 8 out of 15).
Sends the first 12,000 characters of the judgment text to Haiku with a structured
extraction prompt.
"""

import json
import time
import logging

import anthropic

from error_logger import log_error

logger = logging.getLogger(__name__)

EXTRACTION_SYSTEM_PROMPT = """You are a legal document parser. Extract the following fields from this Indian court judgment. Return ONLY valid JSON, no other text, no markdown backticks.

{
  "extracted_citation": "The official citation if present, or null",
  "extracted_petitioner": "Name of the petitioner/appellant ONLY — just the party name, not case details",
  "extracted_respondent": "Name of the respondent ONLY — just the party name, not case details",
  "case_category": "One of: Criminal, Civil, Constitutional, Tax, Motor Vehicles, Land & Property, Industrial & Labour, Financial, Family, Writ, Arbitration, Transfer, Consumer, Contempt, Review, Other",
  "case_number": "The case number",
  "judge_names": ["Array of ALL judge names who heard the case"],
  "author_judge_name": "Name of the judge who wrote the judgment (marked with * in bench line, or first name after JUDGMENT heading)",
  "issue_for_consideration": "Brief summary of the main legal issue (1-3 sentences)",
  "cases_cited": [{"name": "Case name", "citation": "Citation reference"}],
  "acts_cited": ["Array of full act/statute names with year"],
  "keywords": ["Array of 5-15 short legal keywords/phrases (2-10 words each)"],
  "case_arising_from": {
    "jurisdiction": "e.g., CRIMINAL APPELLATE JURISDICTION",
    "primary_case": "The main case number",
    "lower_court_details": "Which lower court's order is being challenged",
    "connected_cases": ["Related case numbers"]
  },
  "bench_size": "Number of judges (integer)",
  "result_of_case": "The outcome/result of the case"
}

EXAMPLES OF CORRECT OUTPUT FOR EACH FIELD:

extracted_citation:
  "[2024] 10 S.C.R. 108 : 2024 INSC 735"
  "[2024] 3 S.C.R. 627 : 2024 INSC 199"
  "2024 INSC 893"

extracted_petitioner:
  "Vijay Singh @ Vijay Kr. Sharma"
  "Mahanadi Coalfields Ltd."
  "State Bank of India"
  "Dr Balram Singh and Others"
  "Haresh Shantilal Avlani & Anr."

extracted_respondent:
  "The State of Bihar"
  "Brajrajnagar Coal Mines Workers' Union"
  "The New India Assurance Co. Ltd."
  "India Power Corporation Limited"
  "The State of Karnataka & Anr."

case_category:
  "Criminal"
  "Civil"
  "Motor Vehicles"
  "Constitutional"

case_number:
  "Criminal Appeal No. 1031 of 2015"
  "Civil Appeal No. 4092-4093 of 2024"
  "Writ Petition (Civil) No. 645 of 2020"
  "Special Leave Petition (C) No. 4049 of 2020"
  "Civil Appeal Nos. 10046-10047 of 2024"

judge_names:
  ["Bela M. Trivedi", "Satish Chandra Sharma"]
  ["Sudhanshu Dhulia", "Prasanna B. Varale"]
  ["Pamidighantam Sri Narasimha", "Sandeep Mehta"]

author_judge_name:
  "Satish Chandra Sharma"
  "Hima Kohli"
  "Sudhanshu Dhulia"

issue_for_consideration:
  "Whether the High Court was justified in refusing to quash criminal proceedings arising out of a civil transaction, where a settlement has been reached between the parties."
  "Whether the Tribunal was justified in entertaining the reference of an industrial dispute when a binding settlement was arrived at between the parties."

acts_cited:
  ["Indian Penal Code, 1860", "Code of Criminal Procedure, 1973"]
  ["Industrial Dispute Act, 1947", "Constitution of India"]
  ["Insolvency and Bankruptcy Code, 2016"]

keywords:
  ["Quashing of FIR", "Section 482 Criminal Procedure Code", "Criminal breach of trust", "Civil dispute", "Settlement and compromise"]
  ["Abduction", "Murder", "Circumstantial evidence", "Reversal of acquittal", "Burden of proof"]
  ["Settlement", "Back Wages", "Regularisation", "Industrial Dispute"]

result_of_case:
  "Appeal allowed. Impugned order of the High Court set aside."
  "Appeals disposed of."
  "Writ petitions dismissed."
  "Appeal allowed; delay of three days in filing the appeal shall stand condoned."

IMPORTANT RULES:
- Extract ONLY from the text provided. Do not fabricate any information.
- For petitioner/respondent, return ONLY the party name. Never include case details, headnotes, or judgment text.
- For cases_cited, only include cases explicitly named in the judgment. Do not invent citations.
- For acts_cited, include the full act name with year (e.g., "Indian Penal Code, 1860" not just "IPC").
- For keywords, use short legal phrases (2-10 words each). Not full sentences.
- For case_category, infer from the case number, jurisdiction line, or the subject matter.
- If a field cannot be determined from the text, use null for strings, [] for arrays, {} for objects.
- For judge_names, list ALL judges, not just the author.
- For bench_size, return an integer, not a string.
- Do NOT include PDF page headers like "[2024] 8 S.C.R." or "Digital Supreme Court Reports" in any field."""

MAX_INPUT_CHARS = 12000
MAX_RETRIES = 3
RETRY_BASE_DELAY = 1.0  # seconds
INTER_CALL_DELAY = 0.5  # seconds


def _parse_json_response(raw: str) -> dict:
    """Parse JSON from LLM response, handling markdown code fences."""
    text = raw.strip()

    # Strip markdown code fences
    if '```json' in text:
        text = text.split('```json', 1)[1].split('```', 1)[0]
    elif '```' in text:
        text = text.split('```', 1)[1].split('```', 1)[0]

    text = text.strip()

    # Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fallback: find first { and last }
    first_brace = text.find('{')
    last_brace = text.rfind('}')
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        try:
            return json.loads(text[first_brace:last_brace + 1])
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse JSON from LLM response: {raw[:200]}")


def _validate_result(result: dict) -> dict:
    """Ensure result has the expected structure and types."""
    validated = {}

    # String fields
    for field in ["extracted_citation", "extracted_petitioner", "extracted_respondent",
                  "case_category", "case_number", "author_judge_name",
                  "issue_for_consideration", "result_of_case"]:
        val = result.get(field)
        validated[field] = str(val) if val is not None else None

    # List of strings
    for field in ["acts_cited", "keywords"]:
        val = result.get(field)
        if isinstance(val, list):
            validated[field] = [str(v) for v in val if v]
        else:
            validated[field] = []

    # List of strings (judge_names)
    val = result.get("judge_names")
    if isinstance(val, list):
        validated["judge_names"] = [str(v) for v in val if v]
    else:
        validated["judge_names"] = []

    # List of dicts (cases_cited)
    val = result.get("cases_cited")
    if isinstance(val, list):
        cases = []
        for item in val:
            if isinstance(item, dict):
                cases.append({
                    "name": str(item.get("name", "")),
                    "citation": str(item.get("citation", ""))
                })
        validated["cases_cited"] = cases
    else:
        validated["cases_cited"] = []

    # Dict (case_arising_from)
    val = result.get("case_arising_from")
    if isinstance(val, dict):
        validated["case_arising_from"] = {
            "jurisdiction": val.get("jurisdiction"),
            "primary_case": val.get("primary_case"),
            "lower_court_details": val.get("lower_court_details"),
            "connected_cases": val.get("connected_cases", [])
        }
    else:
        validated["case_arising_from"] = {}

    # Integer (bench_size)
    val = result.get("bench_size")
    try:
        validated["bench_size"] = int(val) if val is not None else len(validated["judge_names"])
    except (ValueError, TypeError):
        validated["bench_size"] = len(validated["judge_names"])

    # Headnotes — not in the LLM prompt (too long to extract via LLM) but keep the key
    validated["headnotes"] = None

    return validated


def extract_via_haiku(judgment_text: str, client: anthropic.Anthropic) -> dict:
    """
    Send a single judgment to Claude Haiku for extraction.
    Returns a validated dict of extracted fields.
    """
    truncated = judgment_text[:MAX_INPUT_CHARS]

    for attempt in range(MAX_RETRIES):
        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=4096,
                system=EXTRACTION_SYSTEM_PROMPT,
                messages=[{
                    "role": "user",
                    "content": f"Extract structured fields from this Indian court judgment.\n\nJUDGMENT TEXT:\n{truncated}"
                }],
            )

            raw = response.content[0].text
            parsed = _parse_json_response(raw)
            return _validate_result(parsed)

        except anthropic.RateLimitError:
            delay = RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning(f"Rate limited, retrying in {delay}s (attempt {attempt + 1}/{MAX_RETRIES})")
            time.sleep(delay)
        except anthropic.APIError as e:
            logger.error(f"Anthropic API error: {e}")
            log_error("fetching", f"Anthropic API error in extraction: {e}", error=e, severity="critical", metadata={"model": "claude-haiku-4-5-20251001"})
            raise
        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"JSON parse error: {e}")
            log_error("extraction", f"LLM response parse error: {e}", error=e, metadata={"model": "claude-haiku-4-5-20251001"})
            raise

    log_error("fetching", f"Failed after {MAX_RETRIES} retries due to rate limiting", severity="critical", metadata={"model": "claude-haiku-4-5-20251001", "retries": MAX_RETRIES})
    raise RuntimeError(f"Failed after {MAX_RETRIES} retries due to rate limiting")


def batch_extract_via_haiku(
    cases: list[dict],
    client: anthropic.Anthropic
) -> list[dict]:
    """
    Process a list of cases through Haiku extraction.

    Each case dict must have 'id' and 'judgment_text' keys.
    Returns a list of dicts with 'id' and 'result' (extracted fields) or 'error'.
    """
    results = []

    for i, case in enumerate(cases):
        case_id = case["id"]
        judgment_text = case["judgment_text"]

        logger.info(f"  LLM extracting case {case_id} ({i + 1}/{len(cases)})")

        try:
            extracted = extract_via_haiku(judgment_text, client)
            results.append({"id": case_id, "result": extracted})
        except Exception as e:
            logger.error(f"  LLM extraction failed for case {case_id}: {e}")
            results.append({"id": case_id, "error": str(e)})

        # Rate limiting delay between calls
        if i < len(cases) - 1:
            time.sleep(INTER_CALL_DELAY)

    return results
