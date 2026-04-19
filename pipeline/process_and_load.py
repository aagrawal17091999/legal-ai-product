#!/usr/bin/env python3
"""Process downloaded data: extract text from PDFs, upload to R2, load into PostgreSQL, create embeddings."""

import argparse
import os
import tarfile
import time

import boto3
import fitz  # PyMuPDF
import pandas as pd
import psycopg2
import voyageai
from tqdm import tqdm

from config import (
    DATABASE_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT,
    R2_BUCKET_NAME, VOYAGE_API_KEY, SC_DATA_DIR, HC_DATA_DIR,
    CHUNK_SIZE, CHUNK_OVERLAP, VOYAGE_BATCH_SIZE
)
from error_logger import log_error


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def get_r2_client():
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )


def extract_text_from_pdf(pdf_path: str, allow_ocr: bool = True) -> str:
    """Extract text from a PDF.

    Tries PyMuPDF first (free, instant). If the result is too sparse to be a
    real text layer (typical of older scanned/handwritten judgments), falls
    back to a Claude Sonnet vision OCR pass via pdf_ocr.extract_text_with_vision.
    """
    try:
        doc = fitz.open(pdf_path)
        text = ''
        page_count = doc.page_count
        for page in doc:
            text += page.get_text()
        doc.close()
        text = text.strip()
    except Exception as e:
        print(f'  Warning: Failed to extract text from {pdf_path}: {e}')
        log_error("pipeline", f"PDF text extraction failed: {pdf_path}", error=e, metadata={"pdf_path": pdf_path})
        return ''

    if not allow_ocr:
        return text

    from pdf_ocr import needs_ocr, extract_text_with_vision
    if not needs_ocr(text, page_count):
        return text

    print(f'  PyMuPDF returned {len(text)} chars over {page_count} pages — running vision OCR')
    try:
        ocr_text = extract_text_with_vision(pdf_path)
        if ocr_text and len(ocr_text) > len(text):
            return ocr_text
        return text
    except Exception as e:
        print(f'  Warning: Vision OCR failed for {pdf_path}: {e}')
        log_error("pipeline", f"Vision OCR failed: {pdf_path}", error=e, metadata={"pdf_path": pdf_path})
        return text


def find_pdf_in_dir(pdfs_dir: str, path: str) -> str | None:
    """
    Find the actual PDF file matching a parquet 'path' value.

    The parquet stores paths like '2024_10_108_125' but the tar contains
    files like '2024_10_108_125_EN.pdf'. This function resolves the match.
    """
    if not path or not pdfs_dir:
        return None

    # Try exact match first (unlikely but handles edge cases)
    exact = os.path.join(pdfs_dir, path)
    if os.path.exists(exact):
        return exact

    # Try with .pdf extension
    with_ext = os.path.join(pdfs_dir, f'{path}.pdf')
    if os.path.exists(with_ext):
        return with_ext

    # Try with _EN.pdf suffix (standard SCR format)
    en_pdf = os.path.join(pdfs_dir, f'{path}_EN.pdf')
    if os.path.exists(en_pdf):
        return en_pdf

    # Glob for any file starting with the path value
    import glob
    matches = glob.glob(os.path.join(pdfs_dir, f'{path}*'))
    if matches:
        # Prefer .pdf files
        pdf_matches = [m for m in matches if m.endswith('.pdf')]
        return pdf_matches[0] if pdf_matches else matches[0]

    return None


def upload_to_r2(r2_client, local_path: str, r2_key: str) -> str:
    """Upload a file to R2 and return the URL."""
    r2_client.upload_file(local_path, R2_BUCKET_NAME, r2_key)
    return f'{R2_ENDPOINT}/{R2_BUCKET_NAME}/{r2_key}'


from chunk_utils import chunk_text_plain


def embed_and_store_chunks(conn, source_table: str, source_id: int, text: str, voyage_client):
    """Chunk text, embed via Voyage AI, store in case_chunks.

    Uses plain chunking (no metadata header) because this runs right after
    the initial INSERT — extraction hasn't happened yet. After extraction,
    run reembed_all.py to re-embed with metadata headers.
    """
    chunks = chunk_text_plain(text)
    if not chunks:
        return 0

    cur = conn.cursor()
    count = 0

    # Process in batches
    for i in range(0, len(chunks), VOYAGE_BATCH_SIZE):
        batch = chunks[i:i + VOYAGE_BATCH_SIZE]
        try:
            result = voyage_client.embed(batch, model='voyage-law-2', input_type='document')
            embeddings = result.embeddings

            for j, (chunk_text_item, embedding) in enumerate(zip(batch, embeddings)):
                cur.execute(
                    """INSERT INTO case_chunks (source_table, source_id, chunk_index, chunk_text, embedding)
                       VALUES (%s, %s, %s, %s, %s::vector)""",
                    (source_table, source_id, i + j, chunk_text_item, str(embedding))
                )
                count += 1

            conn.commit()
            time.sleep(0.5)  # Rate limiting
        except Exception as e:
            print(f'  Warning: Embedding batch failed: {e}')
            conn.rollback()

    return count


def process_supreme_court(year: int):
    year_dir = os.path.join(SC_DATA_DIR, f'year={year}')
    metadata_path = os.path.join(year_dir, 'metadata.parquet')
    tar_path = os.path.join(year_dir, 'english.tar')

    if not os.path.exists(metadata_path):
        print(f'No metadata found for SC year {year}')
        return

    print(f'Processing Supreme Court year {year}...')

    # Read metadata
    df = pd.read_parquet(metadata_path)
    if 'raw_html' in df.columns:
        df = df.drop(columns=['raw_html'])
    if 'scraped_at' in df.columns:
        df = df.drop(columns=['scraped_at'])
    # Pandas uses pd.NA for missing values in nullable dtypes; psycopg2 can't
    # adapt NAType. Coerce all NA/NaN to None so they become SQL NULL.
    df = df.astype(object).where(pd.notna(df), None)

    # Extract tar if exists
    pdfs_dir = os.path.join(year_dir, 'pdfs')
    if os.path.exists(tar_path) and not os.path.exists(pdfs_dir):
        print('  Extracting tar...')
        os.makedirs(pdfs_dir, exist_ok=True)
        with tarfile.open(tar_path, 'r') as tar:
            tar.extractall(pdfs_dir)

    conn = get_db_connection()
    r2_client = get_r2_client()
    voyage_client = voyageai.Client(api_key=VOYAGE_API_KEY)
    cur = conn.cursor()

    inserted = 0
    skipped = 0
    failed = 0
    chunks_created = 0

    for _, row in tqdm(df.iterrows(), total=len(df), desc=f'SC {year}'):
        try:
            # Check for duplicates (only match on non-empty values)
            cnr = row.get('cnr', '') or ''
            path = row.get('path', '') or ''
            if cnr or path:
                conditions = []
                params_dedup = []
                if cnr:
                    conditions.append('cnr = %s')
                    params_dedup.append(cnr)
                if path:
                    conditions.append('path = %s')
                    params_dedup.append(path)
                cur.execute(
                    f'SELECT id FROM supreme_court_cases WHERE {" OR ".join(conditions)}',
                    params_dedup
                )
                if cur.fetchone():
                    skipped += 1
                    continue

            # Extract text from PDF if available
            judgment_text = ''

            pdf_file = find_pdf_in_dir(pdfs_dir, path)
            if pdf_file:
                judgment_text = extract_text_from_pdf(pdf_file)
                # Upload to R2 so contextBuilder can presign on read. SC no
                # longer stores the URL in the DB — the key is rebuilt from
                # (year, path) at query time. Must match the layout consumed
                # by src/lib/rag/contextBuilder.ts and
                # src/app/api/judgments/download/route.ts.
                r2_key = f'supreme-court/{year}/{path}_EN.pdf'
                try:
                    upload_to_r2(r2_client, pdf_file, r2_key)
                except Exception as e:
                    print(f'  R2 upload failed: {e}')

            # Insert into database
            cur.execute(
                """INSERT INTO supreme_court_cases
                   (title, petitioner, respondent, description, judge, author_judge,
                    citation, case_id, cnr, decision_date, disposal_nature, court,
                    available_languages, path, nc_display, year, judgment_text)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   RETURNING id""",
                (
                    row.get('title'), row.get('petitioner'), row.get('respondent'),
                    row.get('description'), row.get('judge'), row.get('author_judge'),
                    row.get('citation'), row.get('case_id'), cnr,
                    row.get('decision_date'), row.get('disposal_nature'),
                    'Supreme Court of India', row.get('available_languages'),
                    path, row.get('nc_display'), year,
                    judgment_text if judgment_text else None,
                )
            )
            result = cur.fetchone()
            conn.commit()

            # Embedding is intentionally skipped here — reembed_all.py is the
            # sole embedder so chunks include the metadata header built from
            # extract_fields output. Avoids duplicate plain+header chunks.
            # if result and judgment_text:
            #     case_id = result[0]
            #     n = embed_and_store_chunks(
            #         conn, 'supreme_court_cases', case_id, judgment_text, voyage_client
            #     )
            #     chunks_created += n

            inserted += 1

        except Exception as e:
            conn.rollback()
            failed += 1
            print(f'  Error processing row: {e}')

    cur.close()
    conn.close()

    print(f'\nSC {year} Summary: {inserted} inserted, {skipped} skipped, {failed} failed, {chunks_created} chunks')


def process_high_court(year: int, court_code: str):
    court_dir = os.path.join(HC_DATA_DIR, f'court={court_code}', f'year={year}')
    metadata_path = os.path.join(court_dir, 'metadata.parquet')
    tar_path = os.path.join(court_dir, 'data.tar')
    # Fallback for older downloads that used pdfs.tar
    if not os.path.exists(tar_path):
        tar_path = os.path.join(court_dir, 'pdfs.tar')

    if not os.path.exists(metadata_path):
        print(f'No metadata found for HC court={court_code}, year={year}')
        return

    print(f'Processing High Court court={court_code}, year={year}...')

    df = pd.read_parquet(metadata_path)
    if 'raw_html' in df.columns:
        df = df.drop(columns=['raw_html'])
    if 'scraped_at' in df.columns:
        df = df.drop(columns=['scraped_at'])
    df = df.astype(object).where(pd.notna(df), None)

    # Extract tar
    pdfs_dir = os.path.join(court_dir, 'pdfs')
    if os.path.exists(tar_path) and not os.path.exists(pdfs_dir):
        print('  Extracting tar...')
        os.makedirs(pdfs_dir, exist_ok=True)
        with tarfile.open(tar_path, 'r') as tar:
            tar.extractall(pdfs_dir)

    conn = get_db_connection()
    r2_client = get_r2_client()
    voyage_client = voyageai.Client(api_key=VOYAGE_API_KEY)
    cur = conn.cursor()

    inserted = 0
    skipped = 0
    failed = 0
    chunks_created = 0

    for _, row in tqdm(df.iterrows(), total=len(df), desc=f'HC {court_code} {year}'):
        try:
            cnr = row.get('cnr', '') or ''
            if cnr:
                cur.execute('SELECT id FROM high_court_cases WHERE cnr = %s', (cnr,))
                if cur.fetchone():
                    skipped += 1
                    continue

            judgment_text = ''
            pdf_url = None
            pdf_link = row.get('pdf_link', '')

            # Try to find PDF in extracted files
            if pdfs_dir and pdf_link:
                pdf_filename = os.path.basename(pdf_link)
                pdf_file = os.path.join(pdfs_dir, pdf_filename)
                if os.path.exists(pdf_file):
                    judgment_text = extract_text_from_pdf(pdf_file)
                    court_name = row.get('court_name', court_code)
                    r2_key = f'hc/{court_name}/{year}/{pdf_filename}'
                    try:
                        pdf_url = upload_to_r2(r2_client, pdf_file, r2_key)
                    except Exception as e:
                        print(f'  R2 upload failed: {e}')

            cur.execute(
                """INSERT INTO high_court_cases
                   (court_code, title, description, judge, pdf_link, cnr,
                    date_of_registration, decision_date, disposal_nature,
                    court_name, year, bench, judgment_text, pdf_url)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   RETURNING id""",
                (
                    row.get('court_code', court_code), row.get('title'),
                    row.get('description'), row.get('judge'), pdf_link, cnr,
                    row.get('date_of_registration'), row.get('decision_date'),
                    row.get('disposal_nature'), row.get('court_name'),
                    year, row.get('bench'),
                    judgment_text if judgment_text else None,
                    pdf_url
                )
            )
            result = cur.fetchone()
            conn.commit()

            if result and judgment_text:
                case_id = result[0]
                n = embed_and_store_chunks(
                    conn, 'high_court_cases', case_id, judgment_text, voyage_client
                )
                chunks_created += n

            inserted += 1

        except Exception as e:
            conn.rollback()
            failed += 1
            print(f'  Error: {e}')

    cur.close()
    conn.close()

    print(f'\nHC {court_code} {year} Summary: {inserted} inserted, {skipped} skipped, {failed} failed, {chunks_created} chunks')


def main():
    parser = argparse.ArgumentParser(description='Process and load case law data')
    parser.add_argument('--source', required=True, choices=['sc', 'hc'])
    parser.add_argument('--year', type=int, required=True)
    parser.add_argument('--court', type=str, help='Court code for HC (e.g., 32_4)')
    args = parser.parse_args()

    if args.source == 'sc':
        process_supreme_court(args.year)
    elif args.source == 'hc':
        if not args.court:
            print('Error: --court is required for high court processing')
            return
        process_high_court(args.year, args.court)


if __name__ == '__main__':
    main()
