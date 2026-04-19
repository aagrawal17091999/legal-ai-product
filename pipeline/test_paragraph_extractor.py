"""Unit tests for the paragraph extractor + paragraph-aware chunker.

Run with: python3 -m unittest pipeline/test_paragraph_extractor.py

These tests cover the three strategy paths the extractor can take (numbered,
para-word, synthetic) and the false-positive defence against plain line-start
integers ("14 days later..."), plus the chunker's coalescing + long-paragraph
splitting behavior.
"""

from __future__ import annotations

import unittest
from paragraph_extractor import extract_paragraphs
from chunk_utils import chunk_text_by_paragraph


NUMBERED_SAMPLE = """IN THE SUPREME COURT OF INDIA

1. This is the opening paragraph. The appeal arises from a Delhi High Court order.

2. The facts are undisputed. The appellant was arrested under Section 3 of the PMLA.

3. Counsel for the appellant argued the right to speedy trial is fundamental.

4.1 Sub-point. The first sub-issue concerns Section 45 PMLA twin conditions.

4.2 Sub-point. The second sub-issue concerns Article 21.

5. Accordingly we hold prolonged incarceration is a sufficient ground for bail.

6. Appeal allowed. Bail granted.
"""

PARA_WORD_SAMPLE = """Judgment delivered by JUSTICE ABC.

Para 1. The appeal is directed against an order of the High Court.

Para 2. We have heard counsel for both sides and perused the record.

Para 3. Article 21 guarantees the right to life and personal liberty.

Para 4. For the reasons set out we allow the appeal and grant bail.

Para 5. Ordered accordingly.
"""

UNSTRUCTURED_SAMPLE = (
    "This is a single long paragraph without any numbering whatsoever. " * 40
)

FALSE_POSITIVE_SAMPLE = """Brief order.

14 days after arrest, the appellant was produced before the magistrate.

15 minutes later the magistrate granted bail.
"""


class ExtractorTests(unittest.TestCase):
    def test_numbered_strategy_captures_sub_paras(self):
        r = extract_paragraphs(NUMBERED_SAMPLE)
        self.assertEqual(r.strategy, "numbered")
        labels = [p.paragraph_number for p in r.paragraphs]
        # Sub-paragraphs 4.1 / 4.2 must both be extracted.
        self.assertIn("4.1", labels)
        self.assertIn("4.2", labels)
        self.assertEqual(len(r.paragraphs), 7)

    def test_para_word_strategy(self):
        r = extract_paragraphs(PARA_WORD_SAMPLE)
        self.assertEqual(r.strategy, "para_word")
        self.assertEqual(len(r.paragraphs), 5)
        self.assertEqual([p.paragraph_number for p in r.paragraphs], ["1", "2", "3", "4", "5"])

    def test_synthetic_fallback_for_unstructured(self):
        r = extract_paragraphs(UNSTRUCTURED_SAMPLE)
        self.assertEqual(r.strategy, "synthetic")
        self.assertGreaterEqual(len(r.paragraphs), 1)
        for p in r.paragraphs:
            self.assertEqual(p.kind, "synthetic")
            self.assertTrue(p.paragraph_number.startswith("s"))

    def test_false_positive_bare_numbers_not_matched(self):
        # Lines starting "14 days" / "15 minutes" — plain numbers without a
        # trailing dot/paren. Must NOT be parsed as numbered paragraphs.
        r = extract_paragraphs(FALSE_POSITIVE_SAMPLE)
        self.assertEqual(r.strategy, "synthetic")

    def test_empty_input(self):
        r = extract_paragraphs("")
        self.assertEqual(len(r.paragraphs), 0)

    def test_offsets_are_monotonic(self):
        r = extract_paragraphs(NUMBERED_SAMPLE)
        prev_end = -1
        for p in r.paragraphs:
            self.assertGreaterEqual(p.start_char, prev_end - 10)
            self.assertLess(p.start_char, p.end_char)
            prev_end = p.end_char


class ChunkerTests(unittest.TestCase):
    def test_short_paragraphs_coalesce_into_one_chunk(self):
        r = extract_paragraphs(NUMBERED_SAMPLE)
        chunks = chunk_text_by_paragraph(r.paragraphs, header="", target_size=5000)
        self.assertEqual(len(chunks), 1)
        # All 7 paragraph numbers appear on the single chunk.
        self.assertEqual(len(chunks[0]["paragraph_numbers"]), 7)

    def test_long_paragraph_splits_with_letter_suffixes(self):
        # One huge paragraph → must split into sub-chunks, each pointing at
        # the same parent paragraph number.
        huge = "x " * 1500  # ~3000 chars
        fake_paras = [
            type("P", (), {"paragraph_number": "14", "paragraph_text": huge})()
        ]
        chunks = chunk_text_by_paragraph(fake_paras, header="", target_size=1000)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertEqual(c["paragraph_numbers"], ["14"])

    def test_header_is_prepended_to_every_chunk(self):
        r = extract_paragraphs(NUMBERED_SAMPLE)
        chunks = chunk_text_by_paragraph(
            r.paragraphs, header="Title: Test v. State\nCourt: SC\n\n", target_size=5000
        )
        for c in chunks:
            self.assertTrue(c["chunk_text"].startswith("Title: Test v. State"))

    def test_paragraph_marker_emitted_in_chunk_text(self):
        r = extract_paragraphs(NUMBERED_SAMPLE)
        chunks = chunk_text_by_paragraph(r.paragraphs, header="", target_size=5000)
        body = chunks[0]["chunk_text"]
        # Every captured paragraph number should appear as `¶N` in the body so
        # the model sees the pinpoint markers.
        for label in ["1", "2", "3", "4.1", "4.2", "5", "6"]:
            self.assertIn(f"¶{label}", body)


if __name__ == "__main__":
    unittest.main()
