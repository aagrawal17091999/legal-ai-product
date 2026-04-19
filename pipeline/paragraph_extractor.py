"""Paragraph extractor for Indian judgment text.

Indian Supreme Court and High Court judgments use a small set of numbering
conventions. This module tries them in priority order and falls back to a
synthetic sentence-group split only when nothing else yields a reasonable
number of paragraphs. Every paragraph is tagged with:

    - paragraph_number: the label as it appears in the text ("14", "14.1",
      "14A"). Or "s1", "s2", ... when we had to synthesize.
    - paragraph_order:  monotonic 0-based position in the judgment, so the
      reading sequence is always unambiguous even when numbering does odd
      things (14A before 15, sub-paragraphs interleaved, etc.).
    - start_char / end_char: offsets into the original judgment_text so the
      paragraph can be rehydrated without re-running the extractor.
    - kind: 'numbered' or 'synthetic'.

Strategy:
    1. Line-anchored numbering:  ^(14|14.1|14A).  — the dominant SC format.
    2. Line-anchored "Para 14":  older judgments / High Court style.
    3. Synthetic fallback: split on blank lines into sentence groups.

If strategy 1 yields at least MIN_NUMBERED paragraphs that span most of the
text, we accept it. Otherwise strategy 2 is tried. If both fall below the
threshold, we synthesize — every case gets SOMETHING addressable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Tuning knobs.
# Minimum number of numbered paragraphs to accept strategy 1 or 2. Short
# judgments (orders, dismissals) may legitimately have just 3–4 paragraphs.
MIN_NUMBERED_PARAGRAPHS = 3
# If the numbered paragraphs collectively cover less than this fraction of the
# judgment, we treat the numbering as noise and fall back.
MIN_NUMBERED_COVERAGE = 0.4
# Bodies shorter than this are dropped as likely false positives (stray line
# starting with a number). Set to catch "The appeal is dismissed." but not
# single-word line artefacts.
MIN_PARAGRAPH_BODY_CHARS = 15
SYNTHETIC_TARGET_CHARS = 1500


@dataclass
class ExtractedParagraph:
    paragraph_number: str
    paragraph_order: int
    start_char: int
    end_char: int
    paragraph_text: str
    kind: str  # 'numbered' | 'synthetic'


@dataclass
class ExtractionResult:
    paragraphs: list[ExtractedParagraph]
    strategy: str  # 'numbered' | 'para_word' | 'synthetic'


# Strategy 1: line-anchored numbered paragraphs. Accepts the SC conventions:
#   "14.",  "14. ",  "14)"
#   "14.1", "14.1.", "14.1)"
#   "14A",  "14A.",  "14a)"
# The trailing separator is optional ONLY when the number is compound
# (internal dot or alpha suffix) — that avoids false positives on plain
# "14 days later..." lines. For plain integers we require a trailing '.' or ')'.
_NUMBERED_RE = re.compile(
    r"""
    ^[ \t]*                              # line start + optional horizontal whitespace
    (?P<num>
        \d+\.\d+[A-Za-z]?                # 14.1, 14.1a  — no terminator required
      | \d+[A-Za-z]                      # 14A         — no terminator required
      | \d+\.                            # 14.         — terminator part of token
      | \d+\)                            # 14)         — terminator part of token
    )
    [ \t]+(?=\S)                         # at least one space, then non-whitespace prose
    """,
    re.MULTILINE | re.VERBOSE,
)

# Strategy 2: "Para 14" / "Paragraph 14" at line start.
_PARA_WORD_RE = re.compile(
    r"^\s*(?:Para|Paragraph)\s+(?P<num>\d+(?:\.\d+)?[A-Za-z]?)\b\s*[.:\-]?\s*",
    re.IGNORECASE | re.MULTILINE,
)


def extract_paragraphs(judgment_text: str) -> ExtractionResult:
    """Main entry point. Tries strategies in order and returns the first one
    that produces a reasonable set of paragraphs."""

    if not judgment_text or not judgment_text.strip():
        return ExtractionResult(paragraphs=[], strategy="synthetic")

    text = judgment_text
    total_len = len(text)

    # Strategy 1.
    numbered = _extract_with_regex(text, _NUMBERED_RE, kind="numbered")
    if _is_reasonable(numbered, total_len):
        return ExtractionResult(paragraphs=numbered, strategy="numbered")

    # Strategy 2.
    para_word = _extract_with_regex(text, _PARA_WORD_RE, kind="numbered")
    if _is_reasonable(para_word, total_len):
        return ExtractionResult(paragraphs=para_word, strategy="para_word")

    # Strategy 3: synthetic. Split on blank lines; group short adjacent groups
    # up to ~SYNTHETIC_TARGET_CHARS so we don't create a paragraph for every
    # one-line header.
    synthetic = _synthesize(text)
    return ExtractionResult(paragraphs=synthetic, strategy="synthetic")


def _extract_with_regex(
    text: str, pattern: re.Pattern[str], kind: str
) -> list[ExtractedParagraph]:
    """Find every match of `pattern`; each match opens a paragraph that runs
    until the next match (or end of text)."""
    matches = list(pattern.finditer(text))
    if not matches:
        return []

    paras: list[ExtractedParagraph] = []
    seen_labels: dict[str, int] = {}

    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        raw = text[start:end].strip()
        # Strip the leading number token from the paragraph body so the stored
        # text doesn't duplicate the label. Keep one newline for readability.
        body = pattern.sub("", raw, count=1).strip()
        if len(body) < MIN_PARAGRAPH_BODY_CHARS:
            continue
        # Strip trailing separators the capture may have swallowed (14. / 14))
        # so the stored paragraph_number is a clean label.
        num = m.group("num").strip().rstrip(".)")
        # Disambiguate accidental duplicates (e.g. judgment re-uses "14" later).
        # Keep the original label but attach a "#2" suffix after the second
        # occurrence so paragraph_number stays unique per (source_id, number).
        count = seen_labels.get(num, 0)
        seen_labels[num] = count + 1
        label = num if count == 0 else f"{num}#{count + 1}"

        paras.append(
            ExtractedParagraph(
                paragraph_number=label,
                paragraph_order=len(paras),
                start_char=start,
                end_char=end,
                paragraph_text=body,
                kind=kind,
            )
        )
    return paras


def _is_reasonable(paras: list[ExtractedParagraph], total_len: int) -> bool:
    """Heuristic acceptance test."""
    if len(paras) < MIN_NUMBERED_PARAGRAPHS:
        return False
    covered = sum(p.end_char - p.start_char for p in paras)
    if total_len > 0 and covered / total_len < MIN_NUMBERED_COVERAGE:
        return False
    return True


def _synthesize(text: str) -> list[ExtractedParagraph]:
    """Fallback paragraph split based on blank-line groups, coalesced to
    ~SYNTHETIC_TARGET_CHARS each. Labels are s1, s2, ... and kind='synthetic'
    so the context builder can avoid pinpointing with [^n, ¶s3] in citations."""
    # Split on runs of whitespace that include at least one blank line.
    blocks = re.split(r"(?:\r?\n\s*){2,}", text)
    # Re-attach offsets by scanning forward through the original text.
    cursor = 0
    raw: list[tuple[int, int, str]] = []
    for b in blocks:
        stripped = b.strip()
        if not stripped:
            cursor += len(b)
            continue
        idx = text.find(stripped, cursor)
        if idx < 0:
            idx = cursor
        raw.append((idx, idx + len(stripped), stripped))
        cursor = idx + len(stripped)

    # Coalesce.
    paras: list[ExtractedParagraph] = []
    pending_start: int | None = None
    pending_end: int = 0
    pending_body: list[str] = []
    pending_chars = 0

    def flush() -> None:
        nonlocal pending_start, pending_end, pending_body, pending_chars
        if pending_start is None or not pending_body:
            pending_start = None
            pending_body = []
            pending_chars = 0
            return
        body = "\n\n".join(pending_body)
        idx = len(paras)
        paras.append(
            ExtractedParagraph(
                paragraph_number=f"s{idx + 1}",
                paragraph_order=idx,
                start_char=pending_start,
                end_char=pending_end,
                paragraph_text=body,
                kind="synthetic",
            )
        )
        pending_start = None
        pending_body = []
        pending_chars = 0

    for start, end, body in raw:
        if pending_start is None:
            pending_start = start
        pending_body.append(body)
        pending_end = end
        pending_chars += len(body)
        if pending_chars >= SYNTHETIC_TARGET_CHARS:
            flush()

    flush()
    return paras
