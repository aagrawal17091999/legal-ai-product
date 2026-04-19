"""
Vision-LLM OCR fallback for scanned / handwritten PDFs.

PyMuPDF only reads the embedded text layer. Older Indian SC judgments
(especially the 1950s) are page-scans of typed or hand-marked paper with
no text layer, so PyMuPDF returns near-empty text. This module sends
those PDFs to Claude Sonnet, which handles handwriting and degraded
scans noticeably better than Tesseract or Textract.

Public API:
    needs_ocr(text, page_count) -> bool
    extract_text_with_vision(pdf_path) -> str
"""

import base64
import logging
import os
import time

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

VISION_MODEL = "claude-sonnet-4-6"
MAX_PAGES_PER_CALL = 50      # API limit is 100; leave headroom
MIN_CHARS_PER_PAGE = 50      # below this → assume scanned
MIN_TOTAL_CHARS = 500        # absolute floor regardless of page count
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0

OCR_PROMPT = """This is a page-scan of an Indian court judgment. Extract every word of text from these pages, including handwritten annotations, stamps, and marginalia. Preserve paragraph breaks. Do not summarise, do not add commentary, do not wrap in code fences. Output the raw transcribed text only."""


def needs_ocr(text: str, page_count: int) -> bool:
    """True when the PyMuPDF extraction is too sparse to be a real text layer."""
    if not text or not text.strip():
        return True
    chars = len(text.strip())
    if chars < MIN_TOTAL_CHARS:
        return True
    if page_count > 0 and (chars / page_count) < MIN_CHARS_PER_PAGE:
        return True
    return False


def _split_pdf_into_chunks(pdf_path: str, max_pages: int = MAX_PAGES_PER_CALL) -> list[bytes]:
    """Split a PDF into byte-blob chunks of ≤ max_pages each."""
    src = fitz.open(pdf_path)
    chunks: list[bytes] = []
    try:
        for start in range(0, src.page_count, max_pages):
            end = min(start + max_pages, src.page_count) - 1
            sub = fitz.open()
            sub.insert_pdf(src, from_page=start, to_page=end)
            chunks.append(sub.tobytes())
            sub.close()
    finally:
        src.close()
    return chunks


def _ocr_one_chunk(client, pdf_bytes: bytes) -> str:
    b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = client.messages.create(
                model=VISION_MODEL,
                max_tokens=16000,
                messages=[{
                    "role": "user",
                    "content": [
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": b64,
                            },
                        },
                        {"type": "text", "text": OCR_PROMPT},
                    ],
                }],
            )
            return "".join(block.text for block in resp.content if getattr(block, "type", None) == "text")
        except Exception as e:
            last_err = e
            delay = RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning("Vision OCR attempt %d/%d failed: %s — retrying in %.1fs", attempt + 1, MAX_RETRIES, e, delay)
            time.sleep(delay)
    raise RuntimeError(f"Vision OCR failed after {MAX_RETRIES} attempts: {last_err}")


def extract_text_with_vision(pdf_path: str) -> str:
    """Run Claude Sonnet over the PDF and return the concatenated transcribed text."""
    import anthropic

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set; cannot run vision OCR")

    client = anthropic.Anthropic(api_key=api_key)
    parts: list[str] = []
    for i, chunk_bytes in enumerate(_split_pdf_into_chunks(pdf_path)):
        logger.info("OCR chunk %d for %s (%d bytes)", i + 1, os.path.basename(pdf_path), len(chunk_bytes))
        parts.append(_ocr_one_chunk(client, chunk_bytes))
    return "\n\n".join(p.strip() for p in parts if p.strip())
