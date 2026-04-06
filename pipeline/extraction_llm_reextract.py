"""
Targeted LLM re-extraction for specific failing fields.

When validation fails for certain fields and auto-fix can't help,
this module sends just those fields back to Claude Haiku for
focused re-extraction — cheaper than a full re-extraction.
"""

import json
import time
import logging

import anthropic

logger = logging.getLogger(__name__)

MAX_INPUT_CHARS = 12000
MAX_RETRIES = 3
RETRY_BASE_DELAY = 1.0

# Field descriptions and examples for targeted prompts
FIELD_DESCRIPTIONS = {
    "extracted_citation": 'The official citation, or null. Examples: "[2024] 10 S.C.R. 108 : 2024 INSC 735", "[2024] 3 S.C.R. 627 : 2024 INSC 199"',
    "extracted_petitioner": 'Name of the petitioner/appellant ONLY — just the party name. Examples: "Vijay Singh @ Vijay Kr. Sharma", "Mahanadi Coalfields Ltd.", "State Bank of India", "Dr Balram Singh and Others"',
    "extracted_respondent": 'Name of the respondent ONLY — just the party name. Examples: "The State of Bihar", "The New India Assurance Co. Ltd.", "India Power Corporation Limited"',
    "case_category": 'One of: Criminal, Civil, Constitutional, Tax, Motor Vehicles, Land & Property, Industrial & Labour, Financial, Family, Writ, Arbitration, Transfer, Consumer, Contempt, Review, Other',
    "case_number": 'The case number. Examples: "Criminal Appeal No. 1031 of 2015", "Civil Appeal Nos. 10046-10047 of 2024", "Writ Petition (Civil) No. 645 of 2020"',
    "judge_names": 'Array of ALL judge names. Examples: ["Bela M. Trivedi", "Satish Chandra Sharma"], ["Sudhanshu Dhulia", "Prasanna B. Varale"]',
    "author_judge_name": 'Name of the judge who authored the judgment. Examples: "Satish Chandra Sharma", "Hima Kohli", "Sudhanshu Dhulia"',
    "issue_for_consideration": 'Brief summary of the main legal issue (1-3 sentences). Example: "Whether the High Court was justified in refusing to quash criminal proceedings arising out of a civil transaction."',
    "headnotes": "The headnotes section summarizing the legal holdings",
    "cases_cited": 'Array of cases cited: [{"name": "Kesavananda Bharati v. State of Kerala", "citation": "[1973] Supp. 1 SCR 1"}]',
    "acts_cited": 'Array of full act/statute names with year. Examples: ["Indian Penal Code, 1860", "Code of Criminal Procedure, 1973", "Constitution of India"]',
    "keywords": 'Array of 5-15 short legal phrases (2-10 words each). Examples: ["Quashing of FIR", "Criminal breach of trust", "Civil dispute", "Settlement and compromise"]',
    "case_arising_from": '{"jurisdiction": "CRIMINAL APPELLATE JURISDICTION", "primary_case": "Criminal Appeal No. 1031 of 2015", "lower_court_details": "From the Judgment dated...", "connected_cases": []}',
    "bench_size": "Number of judges (integer). Examples: 2, 3, 5",
    "result_of_case": 'The outcome. Examples: "Appeal allowed.", "Appeals disposed of.", "Writ petitions dismissed.", "Appeal allowed; impugned order set aside."',
}


def reextract_fields(
    judgment_text: str,
    field_names: list[str],
    client: anthropic.Anthropic,
) -> dict:
    """
    Re-extract only the specified fields from the judgment text via Claude Haiku.

    Returns a dict with only the requested fields.
    """
    if not field_names:
        return {}

    truncated = judgment_text[:MAX_INPUT_CHARS]

    # Build a targeted prompt with only the failing fields
    field_specs = {}
    for field in field_names:
        desc = FIELD_DESCRIPTIONS.get(field, f"Extract the {field} field")
        field_specs[field] = desc

    fields_json = json.dumps(field_specs, indent=2)

    system_prompt = f"""You are a legal document parser. Extract ONLY the following fields from this Indian court judgment. Return ONLY valid JSON with these exact keys, no other text, no markdown backticks.

Fields to extract:
{fields_json}

IMPORTANT RULES:
- Extract ONLY from the text provided. Do not fabricate any information.
- For act names, include the full name with year (e.g., "Indian Penal Code, 1860").
- For keywords, use short legal phrases (2-10 words each), not full sentences.
- For petitioner/respondent, return ONLY the party name, not case details or headnotes.
- If a field cannot be determined, use null for strings, [] for arrays, {{}} for objects.
- Return an integer for bench_size, not a string.
- Do NOT include PDF page headers like "[2024] 8 S.C.R." or "Digital Supreme Court Reports" in any field."""

    for attempt in range(MAX_RETRIES):
        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=4096,
                system=system_prompt,
                messages=[{
                    "role": "user",
                    "content": f"Extract the specified fields from this judgment.\n\nJUDGMENT TEXT:\n{truncated}"
                }],
            )

            raw = response.content[0].text
            parsed = _parse_json(raw)

            # Only return the fields we asked for
            result = {}
            for field in field_names:
                if field in parsed:
                    result[field] = parsed[field]

            return result

        except anthropic.RateLimitError:
            delay = RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning(f"Rate limited, retrying in {delay}s (attempt {attempt + 1}/{MAX_RETRIES})")
            time.sleep(delay)
        except anthropic.APIError as e:
            logger.error(f"Anthropic API error during re-extraction: {e}")
            raise
        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"JSON parse error during re-extraction: {e}")
            raise

    raise RuntimeError(f"Re-extraction failed after {MAX_RETRIES} retries")


def _parse_json(raw: str) -> dict:
    """Parse JSON from LLM response."""
    text = raw.strip()
    if '```json' in text:
        text = text.split('```json', 1)[1].split('```', 1)[0]
    elif '```' in text:
        text = text.split('```', 1)[1].split('```', 1)[0]
    text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    first = text.find('{')
    last = text.rfind('}')
    if first != -1 and last > first:
        return json.loads(text[first:last + 1])

    raise ValueError(f"Could not parse JSON: {raw[:200]}")
