"""Text for one High Court PDF: text layer first, free OCR where it fails,
paid OCR only for the pages the free pass could not read.

Measured on a 3,076-PDF sample of the upstream corpus (2026-10-28):
  - 96% of documents have a clean text layer: PyMuPDF is all they need.
  - ~15% of PAGES have a text layer that exists but is garbage: a broken font
    encoding that extracts as `!"#$%`. Nearly all Karnataka 2010-2019, part of
    Rajasthan. pdf_ocr.needs_ocr() passes these (plenty of characters), so the
    old path would have indexed gibberish. They are clean computer renders, so
    Tesseract reads them almost perfectly once rendered to an image.
  - Rajasthan Hindi orders extract as broken Unicode (legacy-font conversion:
    Devanagari mixed with Latin-1 letters such as Í Û É). Also OCR'd.
  - Real image scans are only ~0.6% of pages.

Everything is decided PER PAGE, so a judgment with one scanned annexure
OCRs one page, not fifty.
"""

import base64
import os
import re
import subprocess
import time
from dataclasses import dataclass, field

import pymupdf

# Common English function words plus legal boilerplate. A real English page
# is ~35-40% these (sample median 0.396); a garbled layer is ~0.
STOPWORDS = frozenset(
    'the of and to in that is was for by on with be as this it not are an or at has '
    'have which from petitioner respondent court order state no high learned counsel '
    'said dated under section'.split()
)
DEVANAGARI = re.compile('[ऀ-ॿ]')
# Latin-1 Supplement + Latin Extended-A/B: what legacy Hindi fonts turn into
# when "converted" to Unicode (उÍ च, Û यायालय, संÉ या).
LEGACY_LATIN = re.compile('[À-ɏ]')
LATIN_WORD = re.compile(r'[A-Za-z]+')

OCR_DPI = int(os.getenv('HC_OCR_DPI', '300'))
MAX_RENDER_PX = 5000            # cap huge pages so one scan can't eat the RAM
GARBLED_SW = 0.08               # stopword ratio below this = garbled layer
POOR_CONF = float(os.getenv('HC_POOR_CONF', '70'))       # Tesseract word confidence
SURE_CONF = 85                  # at or above this, trust the page outright
POOR_SW = 0.10                  # OCR'd English below this = not real text
MIN_WORDS_TO_JUDGE = 20         # too few words to judge a page (stamps, blanks)

# Each court's regional language(s), as Tesseract model names. An English OCR
# pass that comes back weak is retried with '<lang>+eng' and the more
# confident reading kept: Karnataka judgments quote Kannada, Madras Tamil, and
# so on. Packages: tesseract-ocr-{hin,kan,tam,tel,mal,ben,guj,mar,ori,pan,urd,asm,nep}.
# A model that isn't installed is skipped.
COURT_LANGS = {
    '9_13': 'hin', '23_23': 'hin', '8_9': 'hin', '10_8': 'hin', '22_18': 'hin',
    '20_7': 'hin', '2_5': 'hin', '5_15': 'hin', '7_26': 'hin',
    '29_3': 'kan', '33_10': 'tam', '36_29': 'tel', '28_2': 'tel', '32_4': 'mal',
    '19_16': 'ben', '16_20': 'ben', '14_25': 'ben', '18_6': 'asm', '24_17': 'guj',
    '27_1': 'mar', '21_11': 'ori', '3_22': 'pan+hin', '1_12': 'urd+hin', '11_24': 'nep',
}
RETRY_CONF = 75                 # English pass below this gets the regional retry
REGIONAL_MIN_SHARE = 0.15       # regional reading must be >= 15% non-Latin letters...
REGIONAL_MIN_GAIN = 3           # ...and beat English by this much confidence


def non_latin_share(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    return sum(not ('a' <= c.lower() <= 'z') for c in letters) / len(letters) if letters else 0.0


def stopword_ratio(text: str) -> tuple[float, int]:
    toks = LATIN_WORD.findall(text.lower())
    if not toks:
        return 0.0, 0
    return sum(t in STOPWORDS for t in toks) / len(toks), len(toks)


def image_cover(page) -> float:
    """Largest share of the page covered by one image (0-1). A court emblem
    is a few percent; a scanned page is ~1."""
    area = abs(page.rect) or 1.0
    best = 0.0
    for info in page.get_image_info():
        best = max(best, abs(pymupdf.Rect(info['bbox']) & page.rect) / area)
    return min(best, 1.0)


def classify_page(text: str, cover: float) -> str:
    """ok | garbled | hindi_ok | hindi_broken | image | image_text | empty.

    image_text: a scanned page that carries a hidden OCR layer from upstream.
    Its quality varies (`lN THE HIGH COURT`, `Bespondent`), so it is re-OCR'd
    and the better-reading text kept.
    """
    t = text.strip()
    dev = len(DEVANAGARI.findall(t))
    if dev >= 30:
        return 'hindi_broken' if len(LEGACY_LATIN.findall(t)) > 0.02 * dev else 'hindi_ok'
    sw, ntok = stopword_ratio(t)
    if ntok >= 15:
        if sw < GARBLED_SW:
            return 'garbled'
        return 'image_text' if cover >= 0.5 else 'ok'
    dense = re.sub(r'\s', '', t)
    letters = sum(c.isalpha() for c in dense)
    if len(dense) >= 40 and letters < 0.5 * len(dense):
        return 'garbled'            # symbol soup, maybe behind a short real header
    if cover >= 0.3 and len(dense) < 150:
        return 'image'
    if len(dense) < 20:
        return 'empty'
    return 'image_text' if cover >= 0.5 else 'ok'   # short real text: signature/endorsement page


# ---------------------------------------------------------------------------
# Tesseract
# ---------------------------------------------------------------------------

_LANGS: set[str] | None = None


def tesseract_langs() -> set[str]:
    global _LANGS
    if _LANGS is None:
        try:
            out = subprocess.run(['tesseract', '--list-langs'], capture_output=True, text=True, timeout=30)
            _LANGS = {l.strip() for l in out.stdout.splitlines()[1:] if l.strip()}
        except FileNotFoundError:
            _LANGS = set()
    return _LANGS


def render_page(page, dpi: int = OCR_DPI, gray: bool = True) -> 'pymupdf.Pixmap':
    longest = max(page.rect.width, page.rect.height) / 72 * dpi
    if longest > MAX_RENDER_PX:
        dpi = int(dpi * MAX_RENDER_PX / longest)
    return page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY if gray else pymupdf.csRGB)


@dataclass
class OcrPage:
    text: str
    conf: float          # length-weighted word confidence, 0-100
    words: int
    lang: str
    seconds: float


def tesseract_png(png: bytes, lang: str) -> OcrPage:
    """OCR one rendered page. Text is rebuilt from TSV so the confidence and
    the text come from the same run."""
    t0 = time.time()
    env = dict(os.environ, OMP_THREAD_LIMIT='1')   # one core per page; parallelism is ours
    r = subprocess.run(['tesseract', 'stdin', 'stdout', '-l', lang, '--psm', '3', 'tsv'],
                       input=png, capture_output=True, timeout=300, env=env)
    if r.returncode != 0:
        raise RuntimeError(f'tesseract failed: {r.stderr.decode(errors="replace")[:200]}')
    lines: dict[tuple, list[str]] = {}
    conf_num = conf_den = 0.0
    words = 0
    for row in r.stdout.decode('utf-8', errors='replace').splitlines()[1:]:
        p = row.split('\t')
        if len(p) < 12 or p[0] != '5':
            continue
        word = p[11].strip()
        conf = float(p[10])
        if not word or conf < 0:
            continue
        lines.setdefault((int(p[2]), int(p[3]), int(p[4])), []).append(word)
        conf_num += conf * len(word)
        conf_den += len(word)
        words += 1
    out, prev_par = [], None
    for (block, par, _line), ws in lines.items():   # dicts keep TSV (reading) order
        if prev_par is not None and (block, par) != prev_par:
            out.append('')
        out.append(' '.join(ws))
        prev_par = (block, par)
    return OcrPage('\n'.join(out), conf_num / conf_den if conf_den else 0.0, words, lang, time.time() - t0)


def regional_lang(court_key: str) -> str | None:
    """The court's regional model spec, limited to installed models."""
    have = tesseract_langs()
    parts = [l for l in COURT_LANGS.get(court_key, '').split('+') if l in have]
    return '+'.join(parts) or None


def ocr_page(page, court_key: str, hint: str) -> OcrPage:
    """Free OCR for one page. `hint` is the page's classification."""
    png = render_page(page).tobytes('png')
    if hint == 'hindi_broken' and 'hin' in tesseract_langs():
        return tesseract_png(png, 'hin+eng')
    first = tesseract_png(png, 'eng')
    regional = regional_lang(court_key)
    if regional and first.conf < RETRY_CONF:
        second = tesseract_png(png, f'{regional}+eng')
        first.seconds += second.seconds
        # Confidence alone is not enough: on a noisy English scan the mixed
        # model scores a point higher while sprinkling stray glyphs into the
        # English ('೫೮001 BLE'). Keep it only where the page really is in the
        # regional script.
        if (non_latin_share(second.text) >= REGIONAL_MIN_SHARE
                and second.conf >= first.conf + REGIONAL_MIN_GAIN):
            second.seconds = first.seconds
            return second
    return first


def ocr_is_poor(o: OcrPage) -> bool:
    """Confidence is the signal: wrong script, handwriting and bad scans all
    come back low. The stopword test only breaks ties in the uncertain band —
    a confidently read page of petitioners' names and addresses has no
    stopwords at all (19 such pages of one Karnataka judgment were sent to the
    paid pass for nothing before this)."""
    if o.words < MIN_WORDS_TO_JUDGE:
        return False            # a stamp or near-blank page: nothing to judge
    if o.conf < POOR_CONF:
        return True
    if o.lang == 'eng' and o.conf < SURE_CONF:
        sw, ntok = stopword_ratio(o.text)
        return ntok >= 30 and sw < POOR_SW
    return False


# ---------------------------------------------------------------------------
# Whole document
# ---------------------------------------------------------------------------

@dataclass
class DocText:
    text: str
    page_count: int
    text_source: str            # pdf_text | tesseract | claude | mixed
    text_class: str             # digital | garbled | scan | hindi | mixed | empty
    ocr_pages: int = 0
    ocr_confidence: float | None = None
    poor_pages: list[int] = field(default_factory=list)
    ocr_seconds: float = 0.0
    page_classes: dict = field(default_factory=dict)
    paid_pages: int = 0


def _clean(s: str) -> str:
    # NUL breaks Postgres TEXT; the other C0 controls are broken-font debris.
    s = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', s)
    # Bold drawn by overprinting extracts as the same line two or three times
    # running ("IN THE HIGH COURT OF JUDICATURE AT BOMBAY" x3). Keep one.
    out: list[str] = []
    for line in s.split('\n'):
        key = ' '.join(line.split())
        if out and len(key) >= 8 and key == ' '.join(out[-1].split()):
            continue
        out.append(line)
    s = '\n'.join(out)
    s = re.sub(r'[ \t]+\n', '\n', s)
    return re.sub(r'\n{3,}', '\n\n', s).strip()


def _doc_class(classes: list[str]) -> str:
    need = [c for c in classes if c not in ('ok', 'hindi_ok', 'empty')]
    if not need:
        if all(c == 'empty' for c in classes):
            return 'empty'
        return 'hindi' if 'hindi_ok' in classes else 'digital'
    kinds = {'garbled': 'garbled', 'image': 'scan', 'image_text': 'scan', 'hindi_broken': 'hindi'}
    found = {kinds[c] for c in need}
    if len(found) == 1 and len(need) == len([c for c in classes if c != 'empty']):
        return found.pop()
    return 'mixed'


def extract(pdf: bytes, court_key: str, ocr: bool = True,
            paid_texts: dict[int, str] | None = None) -> DocText:
    """Text for a whole PDF.

    paid_texts: the second pass — {page index: text already transcribed by
    the paid model}. Those pages take that text; every other page is redone
    exactly as the free pass did it, which is deterministic, so the rest of
    the document matches what was stored.
    """
    doc = pymupdf.open(stream=pdf, filetype='pdf')
    try:
        texts, classes, sources, poor = [], [], [], []
        ocr_conf_num = ocr_conf_den = 0.0
        ocr_secs = 0.0
        for i, page in enumerate(doc):
            layer = page.get_text()
            cls = classify_page(layer, image_cover(page))
            classes.append(cls)
            # image_text starts from its hidden layer; OCR must beat it.
            keep = cls in ('ok', 'hindi_ok', 'empty', 'image_text')
            texts.append(layer if keep else '')
            sources.append('layer')
            if cls in ('ok', 'hindi_ok', 'empty') or not ocr:
                continue
            if paid_texts and i in paid_texts:
                texts[i] = paid_texts[i]
                sources[i] = 'paid'
                continue
            if not tesseract_langs():
                raise RuntimeError('tesseract is not installed (apt-get install tesseract-ocr tesseract-ocr-hin)')
            o = ocr_page(page, court_key, cls)
            ocr_secs += o.seconds
            if cls in ('garbled', 'image_text'):
                # Keep the text layer unless OCR reads clearly more like English:
                # the garbled test can misfire on a page of names and addresses,
                # and a scan's hidden layer is sometimes better than Tesseract.
                sw_layer, n_layer = stopword_ratio(layer)
                sw_ocr, n_ocr_tok = stopword_ratio(o.text)
                if n_layer >= 15:
                    margin = 0.05 if cls == 'garbled' else 0.03
                    better = sw_ocr >= GARBLED_SW and sw_ocr >= sw_layer + margin
                else:
                    # A ratio over two words means nothing ('WP.No.123' is 50% stopwords).
                    better = n_ocr_tok > n_layer
                if not better:
                    texts[i] = layer
                    if cls == 'garbled' and n_layer >= 15 and sw_layer >= 0.04:
                        classes[i] = 'ok'          # the layer was readable after all
                    continue
            texts[i] = o.text
            sources[i] = 'tesseract'
            ocr_conf_num += o.conf * max(len(o.text), 1)
            ocr_conf_den += max(len(o.text), 1)
            if ocr_is_poor(o):
                poor.append(i)

        page_count = doc.page_count
    finally:
        doc.close()

    text = _clean('\n'.join(texts))
    n_ocr = sources.count('tesseract')
    n_paid = sources.count('paid')
    used = {s for s, c in zip(sources, classes) if c != 'empty'} or {'layer'}
    source = {frozenset({'layer'}): 'pdf_text', frozenset({'tesseract'}): 'tesseract',
              frozenset({'paid'}): 'claude'}.get(frozenset(used), 'mixed')
    counts: dict[str, int] = {}
    for c in classes:
        counts[c] = counts.get(c, 0) + 1
    return DocText(
        text=text, page_count=page_count, text_source=source, text_class=_doc_class(classes),
        ocr_pages=n_ocr + n_paid,
        ocr_confidence=round(ocr_conf_num / ocr_conf_den, 1) if ocr_conf_den else None,
        poor_pages=poor, ocr_seconds=ocr_secs, page_classes=counts, paid_pages=n_paid,
    )


# ---------------------------------------------------------------------------
# Paid OCR (second pass only)
# ---------------------------------------------------------------------------

PAID_OCR_MODEL = os.getenv('HC_PAID_OCR_MODEL', 'claude-haiku-4-5-20251001')
PAID_PAGES_PER_CALL = 4
PAID_PROMPT = (
    'These are {n} page images from an Indian High Court judgment, in order. '
    'Transcribe every word on each page exactly as written, in the original language '
    '(English, Hindi or a regional language): headings, cause title, body, numbered '
    'paragraphs, stamps, handwritten notes. Do not translate, summarise, correct, or '
    'describe images. Begin each page with a line containing only ===PAGE k=== '
    '(k = 1..{n}). Output nothing else.'
)
_PAGE_MARK = re.compile(r'^===PAGE (\d+)===\s*$', re.M)


def ocr_candidates(pdf: bytes) -> list[int]:
    """Pages the free pass would OCR (same classification as extract())."""
    doc = pymupdf.open(stream=pdf, filetype='pdf')
    try:
        return [i for i, p in enumerate(doc)
                if classify_page(p.get_text(), image_cover(p)) not in ('ok', 'hindi_ok', 'empty')]
    finally:
        doc.close()


def page_jpegs(pdf: bytes, pages: list[int]) -> list[bytes]:
    """Page images for the paid model: 150 dpi grayscale JPEG (~1,500 tokens
    a page). Images, not the PDF itself: a PDF block also hands the model the
    garbage text layer, which is exactly what we are routing around."""
    doc = pymupdf.open(stream=pdf, filetype='pdf')
    try:
        return [render_page(doc[i], dpi=150, gray=True).tobytes('jpeg', jpg_quality=80) for i in pages]
    finally:
        doc.close()


def paid_ocr_requests(key: str, images: list[bytes]) -> list[dict]:
    """Message Batches requests transcribing `images`, PAID_PAGES_PER_CALL per
    request. custom_id is '<key>-<group>' (the API allows only [A-Za-z0-9_-]);
    split_pages() undoes the grouping."""
    reqs = []
    for g, s in enumerate(range(0, len(images), PAID_PAGES_PER_CALL)):
        group = images[s:s + PAID_PAGES_PER_CALL]
        content = [{'type': 'image', 'source': {
            'type': 'base64', 'media_type': 'image/jpeg',
            'data': base64.standard_b64encode(img).decode('ascii')}} for img in group]
        content.append({'type': 'text', 'text': PAID_PROMPT.format(n=len(group))})
        reqs.append({'custom_id': f'{key}-{g}', 'params': {
            'model': PAID_OCR_MODEL, 'max_tokens': 8000,
            'messages': [{'role': 'user', 'content': content}]}})
    return reqs


def split_pages(raw: str, n: int) -> list[str]:
    parts = _PAGE_MARK.split(raw)
    pages = {int(parts[i]): parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}
    if len(pages) != n:
        # Markers lost: keep the text rather than drop it; it all lands on the
        # first page of the group, which only affects page attribution.
        return [raw.strip()] + [''] * (n - 1)
    return [pages.get(k, '') for k in range(1, n + 1)]
