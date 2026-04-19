"""
Per-field consensus orchestrator.

Generalizes the layout → text → LLM → registry pattern established in
acts_consensus.py to every extracted field. Each `decide_*` function takes
up to three independent extractor outputs and returns a FieldConsensus
bundling (value, method, confidence, alternatives).

Field-type specific behavior:
  - list[str] (acts_cited, keywords):      Jaccard on sets
  - list[dict] (cases_cited):              Jaccard on normalized case names
  - dict (case_arising_from):              key-by-key agreement
  - str long-form (headnotes, issue_...):  substring match + length ratio
  - str short-form (author_judge, ...):    exact or fuzzy match

Confidence buckets (same scale across fields):
  1.00  layout present and non-empty; all extractors agree
  0.90  layout present and non-empty; two of three agree
  0.85  layout present and non-empty; layout alone
  0.80  layout present and empty (trusted as 'no such section')
  0.75  no layout; text + LLM agree
  0.60  no layout; text or LLM alone
  0.50  no layout; text and LLM disagree — LLM preferred
  0.00  nothing usable
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class FieldConsensus:
    value: Any
    method: str  # "layout" | "text" | "llm" | "consensus" | "none"
    confidence: float
    alternatives: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Similarity helpers
# ---------------------------------------------------------------------------

def _jaccard_strings(a: list[str], b: list[str]) -> float:
    if not a and not b:
        return 1.0
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _normalize_case_name(name: str) -> str:
    n = name.lower().strip()
    n = re.sub(r'\s+v(?:s|\.)?\s+', ' v ', n)
    n = re.sub(r'[.,]', '', n)
    n = re.sub(r'\s+', ' ', n)
    return n


def _jaccard_cases(a: list[dict], b: list[dict]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    sa = {_normalize_case_name(c.get("name", "")) for c in a if c.get("name")}
    sb = {_normalize_case_name(c.get("name", "")) for c in b if c.get("name")}
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _string_similarity(a: str, b: str) -> float:
    """Cheap substring + length-ratio similarity for long-form text."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    a_norm = re.sub(r'\s+', ' ', a).strip().lower()
    b_norm = re.sub(r'\s+', ' ', b).strip().lower()
    if a_norm == b_norm:
        return 1.0
    # Substring containment
    shorter, longer = (a_norm, b_norm) if len(a_norm) <= len(b_norm) else (b_norm, a_norm)
    if shorter in longer:
        return len(shorter) / len(longer)
    # Token overlap
    ta, tb = set(a_norm.split()), set(b_norm.split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _is_empty(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, (list, dict, str)) and not v:
        return True
    return False


# ---------------------------------------------------------------------------
# Decision functions — one per field family
# ---------------------------------------------------------------------------

def decide_list_of_strings(
    layout: list[str] | None,
    text: list[str] | None,
    llm: list[str] | None,
    normalize=None,
) -> FieldConsensus:
    """Consensus for list-of-string fields (acts_cited, keywords).
    If normalize is provided it's called per candidate (for registry fixup)."""
    def norm(xs):
        if xs is None:
            return None
        if normalize:
            out, _ = normalize(xs)
            return out
        # Dedupe preserving order.
        seen, out = set(), []
        for x in xs:
            if x not in seen:
                seen.add(x); out.append(x)
        return out

    layout_n = norm(layout)
    text_n = norm(text)
    llm_n = norm(llm)
    alts = {"layout": layout_n, "text": text_n, "llm": llm_n}

    # Empty layout trusted
    if layout is not None and not layout_n:
        return FieldConsensus([], "layout", 0.8, alts)

    if layout_n:
        lt = _jaccard_strings(layout_n, text_n) if text_n is not None else None
        ll = _jaccard_strings(layout_n, llm_n) if llm_n is not None else None
        agreed = max(x for x in (lt, ll) if x is not None) if (lt or ll) else 0.0
        if agreed >= 0.8:
            return FieldConsensus(layout_n, "consensus", 1.0, alts)
        return FieldConsensus(layout_n, "layout", 0.85, alts)

    if text_n and llm_n:
        if _jaccard_strings(text_n, llm_n) >= 0.8:
            merged = list(dict.fromkeys(text_n + llm_n))
            return FieldConsensus(merged, "consensus", 0.75, alts)
        return FieldConsensus(llm_n, "llm", 0.5, alts)

    if text_n:
        return FieldConsensus(text_n, "text", 0.6, alts)
    if llm_n:
        return FieldConsensus(llm_n, "llm", 0.6, alts)
    return FieldConsensus([], "none", 0.0, alts)


def decide_list_of_cases(
    layout: list[dict] | None,
    text: list[dict] | None,
    llm: list[dict] | None,
) -> FieldConsensus:
    """Consensus for list-of-{name,citation} fields (cases_cited)."""
    alts = {"layout": layout, "text": text, "llm": llm}

    if layout is not None and not layout:
        return FieldConsensus([], "layout", 0.8, alts)

    if layout:
        lt = _jaccard_cases(layout, text or [])
        ll = _jaccard_cases(layout, llm or [])
        agreed = max(lt, ll)
        if agreed >= 0.8:
            return FieldConsensus(layout, "consensus", 1.0, alts)
        return FieldConsensus(layout, "layout", 0.85, alts)

    if text and llm:
        if _jaccard_cases(text, llm) >= 0.8:
            # Merge by normalized name.
            seen, merged = set(), []
            for c in text + llm:
                key = _normalize_case_name(c.get("name", ""))
                if key and key not in seen:
                    seen.add(key); merged.append(c)
            return FieldConsensus(merged, "consensus", 0.75, alts)
        return FieldConsensus(llm, "llm", 0.5, alts)

    if text:
        return FieldConsensus(text, "text", 0.6, alts)
    if llm:
        return FieldConsensus(llm, "llm", 0.6, alts)
    return FieldConsensus([], "none", 0.0, alts)


def decide_dict(
    layout: dict | None,
    text: dict | None,
    llm: dict | None,
) -> FieldConsensus:
    """Consensus for dict fields (case_arising_from). Key-by-key merge:
    layout wins per-key when present; text/llm fill in missing keys."""
    alts = {"layout": layout, "text": text, "llm": llm}

    if _is_empty(layout) and _is_empty(text) and _is_empty(llm):
        return FieldConsensus({}, "none", 0.0, alts)

    merged = {}
    contributors = set()
    for source_name, source in (("layout", layout), ("text", text), ("llm", llm)):
        if not isinstance(source, dict):
            continue
        for k, v in source.items():
            if _is_empty(v):
                continue
            if k not in merged:
                merged[k] = v
                contributors.add(source_name)

    if not merged:
        return FieldConsensus({}, "none", 0.0, alts)

    # Confidence based on overlap
    if "layout" in contributors and len(contributors) >= 2:
        conf, method = 0.9, "consensus"
    elif "layout" in contributors:
        conf, method = 0.85, "layout"
    elif len(contributors) >= 2:
        conf, method = 0.7, "consensus"
    else:
        conf, method = 0.55, next(iter(contributors))
    return FieldConsensus(merged, method, conf, alts)


def decide_long_string(
    layout: str | None,
    text: str | None,
    llm: str | None,
    min_len: int = 30,
) -> FieldConsensus:
    """Consensus for long-form string fields (headnotes, issue_for_consideration)."""
    alts = {"layout": layout, "text": text, "llm": llm}

    def ok(s):
        return isinstance(s, str) and len(s.strip()) >= min_len

    if layout is not None and not ok(layout):
        if layout == "" or (isinstance(layout, str) and len(layout.strip()) == 0):
            return FieldConsensus("", "layout", 0.8, alts)

    if ok(layout):
        sim_text = _string_similarity(layout, text) if ok(text) else 0.0
        sim_llm = _string_similarity(layout, llm) if ok(llm) else 0.0
        agreed = max(sim_text, sim_llm)
        if agreed >= 0.7:
            return FieldConsensus(layout, "consensus", 1.0, alts)
        return FieldConsensus(layout, "layout", 0.85, alts)

    if ok(text) and ok(llm):
        if _string_similarity(text, llm) >= 0.6:
            # Prefer the longer one.
            chosen = text if len(text) >= len(llm) else llm
            return FieldConsensus(chosen, "consensus", 0.75, alts)
        return FieldConsensus(llm, "llm", 0.5, alts)

    if ok(text):
        return FieldConsensus(text, "text", 0.6, alts)
    if ok(llm):
        return FieldConsensus(llm, "llm", 0.6, alts)
    return FieldConsensus(None, "none", 0.0, alts)


def decide_short_string(
    text: str | None,
    llm: str | None,
    layout: str | None = None,
    normalize=None,
) -> FieldConsensus:
    """Consensus for short structured string fields (author_judge_name,
    extracted_citation, case_number, case_category, result_of_case,
    petitioner, respondent). Layout rarely applies."""
    alts = {"layout": layout, "text": text, "llm": llm}

    def norm(v):
        if not isinstance(v, str) or not v.strip():
            return None
        out = v.strip()
        if normalize:
            out2, _score = normalize(out)
            if out2:
                return out2
        return out

    t, l, ly = norm(text), norm(llm), norm(layout)
    if ly and (t or l):
        same = (ly == t) or (ly == l)
        return FieldConsensus(ly, "consensus" if same else "layout",
                              1.0 if same else 0.85, alts)
    if ly:
        return FieldConsensus(ly, "layout", 0.85, alts)
    if t and l:
        if t.lower() == l.lower():
            return FieldConsensus(t, "consensus", 0.8, alts)
        # Prefer LLM for short strings (semantic), text otherwise for structured.
        return FieldConsensus(l, "llm", 0.5, alts)
    if t:
        return FieldConsensus(t, "text", 0.6, alts)
    if l:
        return FieldConsensus(l, "llm", 0.6, alts)
    return FieldConsensus(None, "none", 0.0, alts)


def decide_list_judges(
    text: list[str] | None,
    llm: list[str] | None,
    layout: list[str] | None = None,
    normalize=None,
) -> FieldConsensus:
    """Consensus for judge-name lists (judge_names). Same shape as
    decide_list_of_strings but judges have their own registry/normalizer."""
    return decide_list_of_strings(layout, text, llm, normalize=normalize)
