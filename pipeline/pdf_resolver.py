"""
PDF resolver — finds the local PDF for a given case, downloading from R2 if not
present. Used by the layout-aware acts extractor, which needs bytes on disk.

R2 key layout (must match process_and_load.py):
  SC: supreme-court/{year}/{path}_EN.pdf
  HC: hc/{court_name}/{year}/{pdf_filename}
"""

import logging
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

import boto3

from config import (
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_ENDPOINT,
    R2_BUCKET_NAME,
    SC_DATA_DIR,
    HC_DATA_DIR,
)

logger = logging.getLogger(__name__)

_r2_client = None


def _r2():
    global _r2_client
    if _r2_client is None:
        _r2_client = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
        )
    return _r2_client


def _local_sc_path(year: int, path: str) -> str | None:
    """Look for the PDF in the local SC data directory."""
    if not year or not path:
        return None
    pdfs_dir = os.path.join(SC_DATA_DIR, f"year={year}", "pdfs")
    candidates = [
        os.path.join(pdfs_dir, f"{path}_EN.pdf"),
        os.path.join(pdfs_dir, f"{path}.pdf"),
        os.path.join(pdfs_dir, path),
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def _local_hc_path(year: int, court_name: str, pdf_filename: str) -> str | None:
    if not year or not court_name or not pdf_filename:
        return None
    candidate = os.path.join(
        HC_DATA_DIR, f"court={court_name}", f"year={year}", "pdfs", pdf_filename
    )
    return candidate if os.path.exists(candidate) else None


def _download_r2(key: str, dest: str) -> bool:
    try:
        _r2().download_file(R2_BUCKET_NAME, key, dest)
        return True
    except Exception as e:
        logger.warning(f"R2 download failed for key={key}: {e}")
        return False


@contextmanager
def resolve_sc_pdf(year: int, path: str):
    """
    Yield a local filesystem path to the SC PDF. If the file already exists
    locally, yields that path. Otherwise downloads from R2 to a temp file
    and cleans it up on exit.

    Yields None if the PDF cannot be located.
    """
    local = _local_sc_path(year, path)
    if local:
        yield local
        return

    key = f"supreme-court/{year}/{path}_EN.pdf"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        if _download_r2(key, tmp_path):
            yield tmp_path
        else:
            yield None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@contextmanager
def resolve_hc_pdf(year: int, court_name: str, pdf_link: str):
    """Yield a local path to the HC PDF (local or R2-downloaded). None if missing."""
    if not pdf_link:
        yield None
        return
    pdf_filename = os.path.basename(pdf_link)
    local = _local_hc_path(year, court_name, pdf_filename)
    if local:
        yield local
        return

    key = f"hc/{court_name}/{year}/{pdf_filename}"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        if _download_r2(key, tmp_path):
            yield tmp_path
        else:
            yield None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@contextmanager
def resolve_pdf(source: str, **kwargs):
    """Dispatch by source. kwargs: year, path (sc); year, court_name, pdf_link (hc)."""
    if source == "sc":
        with resolve_sc_pdf(kwargs["year"], kwargs["path"]) as p:
            yield p
    elif source == "hc":
        with resolve_hc_pdf(
            kwargs["year"], kwargs["court_name"], kwargs["pdf_link"]
        ) as p:
            yield p
    else:
        raise ValueError(f"Unknown source: {source}")
