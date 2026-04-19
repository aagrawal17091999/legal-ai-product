"""
Acts Cited Consensus Orchestrator.

Runs up to three independent extractors for acts_cited and combines them:
  1. Layout (PDF rectangles — primary, highest-accuracy when available)
  2. Text regex (tightened, from judgment_text)
  3. LLM (from the full-field Haiku extraction, which already ran)

Each candidate is normalized through the canonical Indian-Acts registry
(fuzzy match). The final decision + confidence + alternates dict is written
to `acts_cited`, `acts_cited_method`, `acts_cited_confidence`, and
`acts_cited_alternatives`.

Confidence scale (0.0–1.0):
  1.00  two or three methods agree on the same set, all entries registry-matched
  0.85  two methods agree, all entries registry-matched
  0.75  one method only (layout) with registry matches
  0.65  one method only, some entries unmatched (likely state acts)
  0.50  layout N/A, text+LLM disagree — pick LLM, flag
  0.30  everything disagrees or only LLM available
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ActsConsensus:
    acts: list[str]
    method: str  # "layout", "text", "llm", "consensus", "none"
    confidence: float
    alternatives: dict = field(default_factory=dict)


def _normalize_list(candidates: list[str]) -> tuple[list[str], list[dict]]:
    """Return (canonical_list, unmatched_details)."""
    try:
        from act_registry import normalize_acts
    except ImportError:
        return list(dict.fromkeys(candidates)), []

    clean: list[str] = []
    unmatched: list[dict] = []
    seen: set[str] = set()

    for cand in candidates:
        from act_registry import match_act
        canonical, score = match_act(cand)
        key = canonical if canonical else cand
        if key in seen:
            continue
        seen.add(key)
        clean.append(key)
        if canonical is None:
            unmatched.append({"name": cand, "best_score": round(score, 3)})
    return clean, unmatched


def _agreement(a: list[str], b: list[str]) -> float:
    """Jaccard similarity of two canonicalized lists."""
    if not a and not b:
        return 1.0
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def decide_acts_cited(
    layout_result: list[str] | None,
    text_result: list[str] | None,
    llm_result: list[str] | None,
) -> ActsConsensus:
    """
    Combine up to three extractor outputs into a single decision.

    Inputs:
      - layout_result: list from layout extractor, or None if unavailable
      - text_result: list from tightened regex, or None
      - llm_result: list from LLM, or None

    Output: ActsConsensus with the chosen list, method label, confidence, and
    an alternatives dict capturing what each method returned (for SQL review).
    """
    layout_norm, layout_unmatched = ([], [])
    text_norm, text_unmatched = ([], [])
    llm_norm, llm_unmatched = ([], [])

    if layout_result is not None:
        layout_norm, layout_unmatched = _normalize_list(layout_result)
    if text_result is not None:
        text_norm, text_unmatched = _normalize_list(text_result)
    if llm_result is not None:
        llm_norm, llm_unmatched = _normalize_list(llm_result)

    alternatives = {
        "layout": layout_norm if layout_result is not None else None,
        "text": text_norm if text_result is not None else None,
        "llm": llm_norm if llm_result is not None else None,
        "unmatched": {
            "layout": layout_unmatched,
            "text": text_unmatched,
            "llm": llm_unmatched,
        },
    }

    # ---- Decision tree ----

    # Layout ran and explicitly returned empty — trust that there's no
    # "List of Acts" box in this PDF. Do NOT fall through to text/LLM, since
    # those can hallucinate acts from body prose.
    if layout_result is not None and not layout_norm:
        return ActsConsensus([], "layout", 0.8, alternatives)

    # If layout is available and non-empty, it wins. Accuracy is near-perfect
    # when the PDF has the headnote box.
    if layout_result is not None and layout_norm:
        lt_agree = _agreement(layout_norm, text_norm) if text_result is not None else None
        ll_agree = _agreement(layout_norm, llm_norm) if llm_result is not None else None

        agrees = [a for a in (lt_agree, ll_agree) if a is not None]
        max_agree = max(agrees) if agrees else 0.0

        # All entries found in registry?
        fully_matched = len(layout_unmatched) == 0

        if max_agree >= 0.8 and fully_matched:
            confidence = 1.0
            method = "consensus"
        elif max_agree >= 0.8:
            confidence = 0.9
            method = "consensus"
        elif fully_matched:
            confidence = 0.85
            method = "layout"
        else:
            confidence = 0.7
            method = "layout"
        return ActsConsensus(layout_norm, method, confidence, alternatives)

    # Layout N/A or empty. Fall through to text + LLM.
    if text_result is not None and text_norm and llm_result is not None and llm_norm:
        agree = _agreement(text_norm, llm_norm)
        if agree >= 0.8:
            # They agree — take the union (LLM often misses a few, text
            # sometimes has extras). Confidence high.
            merged = list(dict.fromkeys(text_norm + llm_norm))
            unmatched_all = text_unmatched + llm_unmatched
            fully_matched = len(unmatched_all) == 0
            return ActsConsensus(
                merged,
                "consensus",
                0.9 if fully_matched else 0.75,
                alternatives,
            )
        # Disagree: prefer LLM (more semantic) but flag.
        return ActsConsensus(llm_norm, "llm", 0.5, alternatives)

    # Only one source has results.
    if text_result is not None and text_norm:
        conf = 0.7 if not text_unmatched else 0.55
        return ActsConsensus(text_norm, "text", conf, alternatives)
    if llm_result is not None and llm_norm:
        conf = 0.6 if not llm_unmatched else 0.45
        return ActsConsensus(llm_norm, "llm", conf, alternatives)

    # Nothing usable.
    return ActsConsensus([], "none", 0.0, alternatives)
