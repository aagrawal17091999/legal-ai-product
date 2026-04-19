"""
Judge Registry — canonical list of Supreme Court & High Court judges for
fuzzy normalization of extracted judge names.

Normalization fixes common inconsistencies:
  - initials/full-name variants: "P.S. Narasimha" vs "Pamidighantam Sri Narasimha"
  - title handling: "Dr D.Y. Chandrachud" vs "Dhananjaya Y Chandrachud"
  - honorifics: "Hon'ble Justice X" → "X"

Build full registry from existing DB:
  python scripts/build_judge_registry.py

Until the build script runs, the pipeline boots with a seed of ~25 recent
SCI judges. Unknown names are kept verbatim (HC judges + historical SC
judges will land in the low-confidence review queue).
"""

import json
import logging
import re
from functools import lru_cache
from pathlib import Path

try:
    from rapidfuzz import fuzz, process
    _HAVE_FUZZ = True
except ImportError:
    _HAVE_FUZZ = False

logger = logging.getLogger(__name__)

REGISTRY_PATH = Path(__file__).resolve().parent / "data" / "indian_judges.json"

_STRONG_MATCH = 90
_WEAK_MATCH = 82


def _normalize(name: str) -> str:
    n = name.strip()
    # Strip honorifics + titles
    n = re.sub(
        r"^(?:Hon'?ble\s+)?(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Justice|Shri|Sri|CJI)\s+",
        '', n, flags=re.IGNORECASE,
    )
    n = re.sub(r',?\s*(?:CJI|J\.?|C\.J\.?)\s*$', '', n, flags=re.IGNORECASE)
    n = re.sub(r'[.,]', ' ', n)
    n = re.sub(r'\s+', ' ', n).strip().lower()
    return n


@lru_cache(maxsize=1)
def _load_registry() -> tuple[list[str], dict[str, str]]:
    if not REGISTRY_PATH.exists():
        logger.warning(f"Judge registry not found at {REGISTRY_PATH}")
        return [], {}
    data = json.loads(REGISTRY_PATH.read_text())
    judges = data.get("judges", [])
    search_keys: list[str] = []
    key_to_canonical: dict[str, str] = {}
    for j in judges:
        canonical = j["canonical"]
        aliases = j.get("aliases", [])
        for name in [canonical] + aliases:
            n = _normalize(name)
            if n:
                search_keys.append(n)
                key_to_canonical[n] = canonical
    logger.info(f"Loaded {len(judges)} judges ({len(search_keys)} keys)")
    return search_keys, key_to_canonical


def match_judge(name: str) -> tuple[str | None, float]:
    """Fuzzy match a judge name against the canonical registry."""
    if not name or not isinstance(name, str) or not _HAVE_FUZZ:
        return None, 0.0
    search_keys, mapping = _load_registry()
    if not search_keys:
        return None, 0.0
    q = _normalize(name)
    if not q:
        return None, 0.0
    result = process.extractOne(q, search_keys, scorer=fuzz.token_sort_ratio)
    if not result:
        return None, 0.0
    best_key, score, _ = result
    if score >= _WEAK_MATCH:
        return mapping[best_key], score / 100.0
    return None, score / 100.0


def normalize_judges(names: list[str]) -> tuple[list[str], list[dict]]:
    """Normalize a list of judge names. Returns (canonical_list, unmatched_details)."""
    out: list[str] = []
    seen: set[str] = set()
    unmatched: list[dict] = []
    for n in names:
        canonical, score = match_judge(n)
        key = canonical if canonical else n
        if key not in seen:
            seen.add(key)
            out.append(key)
        if not canonical:
            unmatched.append({"name": n, "best_score": round(score, 3)})
    return out, unmatched


def normalize_one_judge(name: str) -> tuple[str, float]:
    """Normalize a single judge name. Returns (canonical_or_original, score)."""
    canonical, score = match_judge(name)
    return (canonical if canonical else name), score
