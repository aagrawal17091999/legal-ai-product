"""
Act Registry — canonical list of Indian Central Acts with fuzzy matching.

Used by the consensus extractor to:
  - normalize extracted act names (OCR typos, abbreviations, missing years)
  - score confidence: a match in the registry is high-confidence
  - reject non-acts that slipped past the heuristic filter

Build full registry:
  python scripts/build_act_registry.py
"""

import json
import logging
import re
from functools import lru_cache
from pathlib import Path

from rapidfuzz import fuzz, process

logger = logging.getLogger(__name__)

REGISTRY_PATH = Path(__file__).resolve().parent / "data" / "indian_acts.json"

# Use token_sort_ratio: sorts tokens then character-compares. This avoids the
# WRatio/partial_ratio substring trap where short aliases like "evidence act"
# falsely match long prose like "any other act whatsoever".
_SCORER = fuzz.token_sort_ratio

# Match score thresholds (0-100 from rapidfuzz).
STRONG_MATCH = 92   # confident: treat as canonical (exact alias, minor typos)
WEAK_MATCH = 85     # plausible: accept as canonical (missing year, reordered words)
REJECT_BELOW = 85   # below this: unmatched, caller decides (may be a state act)


def _normalize(name: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation for matching."""
    name = name.lower()
    name = re.sub(r'[.,;:()]', ' ', name)
    name = re.sub(r'\s+', ' ', name)
    return name.strip()


@lru_cache(maxsize=1)
def _load_registry() -> tuple[list[str], dict[str, str]]:
    """Load registry. Returns (search_keys, key_to_canonical)."""
    if not REGISTRY_PATH.exists():
        logger.warning(f"Act registry not found at {REGISTRY_PATH}")
        return [], {}

    data = json.loads(REGISTRY_PATH.read_text())
    acts = data.get("acts", [])

    search_keys: list[str] = []
    key_to_canonical: dict[str, str] = {}

    for entry in acts:
        canonical = entry["canonical"]
        aliases = entry.get("aliases", [])
        for name in [canonical] + aliases:
            norm = _normalize(name)
            if norm:
                search_keys.append(norm)
                key_to_canonical[norm] = canonical

    logger.info(f"Loaded {len(acts)} acts ({len(search_keys)} search keys) from registry")
    return search_keys, key_to_canonical


def match_act(name: str) -> tuple[str | None, float]:
    """
    Fuzzy-match a candidate act name against the registry.

    Returns (canonical_name, score) where score is 0.0-1.0.
      - score >= 0.9  → STRONG match, use canonical
      - score >= 0.75 → WEAK match, still use canonical but flag
      - score < 0.75  → unmatched, return (None, score)
    """
    if not name or not isinstance(name, str):
        return None, 0.0

    search_keys, key_to_canonical = _load_registry()
    if not search_keys:
        return None, 0.0

    query = _normalize(name)
    if not query:
        return None, 0.0

    result = process.extractOne(query, search_keys, scorer=_SCORER)
    if not result:
        return None, 0.0

    best_key, score, _ = result
    score_0_1 = score / 100.0

    if score >= WEAK_MATCH:
        return key_to_canonical[best_key], score_0_1
    return None, score_0_1


def normalize_acts(candidates: list[str]) -> tuple[list[str], list[dict]]:
    """
    Normalize a list of candidate act names.

    Returns (clean_acts, unmatched_details) where:
      - clean_acts: deduplicated list of canonical names for strong/weak matches
      - unmatched_details: list of {name, best_score} for rejected items

    Caller uses unmatched_details to decide confidence and populate
    acts_cited_alternatives for SQL review.
    """
    clean: list[str] = []
    seen: set[str] = set()
    unmatched: list[dict] = []

    for cand in candidates:
        if not cand:
            continue
        canonical, score = match_act(cand)
        if canonical:
            if canonical not in seen:
                clean.append(canonical)
                seen.add(canonical)
        else:
            unmatched.append({"name": cand, "best_score": round(score, 3)})

    return clean, unmatched


def registry_size() -> int:
    search_keys, _ = _load_registry()
    return len(search_keys)
