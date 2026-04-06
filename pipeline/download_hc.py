#!/usr/bin/env python3
"""Download High Court metadata and judgment PDFs from public S3."""

import argparse
import os
import subprocess
from config import HC_DATA_DIR

S3_BUCKET = 's3://indian-high-court-judgments'

# Common court codes
COURT_CODES = [
    '32_4',   # Delhi
    '32_5',   # Bombay
    '32_6',   # Calcutta
    '32_7',   # Madras
    '32_1',   # Allahabad
    '32_2',   # Andhra Pradesh
    '32_3',   # Chhattisgarh
    '32_8',   # Gujarat
    '32_9',   # Himachal Pradesh
    '32_10',  # Jammu & Kashmir
    '32_11',  # Jharkhand
    '32_12',  # Karnataka
    '32_13',  # Kerala
    '32_14',  # Madhya Pradesh
    '32_15',  # Manipur
    '32_16',  # Meghalaya
    '32_17',  # Orissa
    '32_18',  # Patna
    '32_19',  # Punjab & Haryana
    '32_20',  # Rajasthan
    '32_21',  # Sikkim
    '32_22',  # Telangana
    '32_23',  # Tripura
    '32_24',  # Uttarakhand
]


def download_court_year(year: int, court_code: str):
    court_dir = os.path.join(HC_DATA_DIR, f'court={court_code}', f'year={year}')
    os.makedirs(court_dir, exist_ok=True)

    # Download metadata
    metadata_s3 = f'{S3_BUCKET}/metadata/parquet/year={year}/court={court_code}/metadata.parquet'
    metadata_local = os.path.join(court_dir, 'metadata.parquet')
    if not os.path.exists(metadata_local):
        print(f'Downloading HC metadata: court={court_code}, year={year}...')
        try:
            subprocess.run([
                'aws', 's3', 'cp', '--no-sign-request',
                metadata_s3, metadata_local
            ], check=True)
        except subprocess.CalledProcessError:
            print(f'  No metadata found for court={court_code}, year={year}')
            return

    # Download PDFs tar
    tar_s3 = f'{S3_BUCKET}/data/tar/year={year}/court={court_code}/pdfs.tar'
    tar_local = os.path.join(court_dir, 'pdfs.tar')
    if not os.path.exists(tar_local):
        print(f'Downloading HC judgments tar: court={court_code}, year={year}...')
        try:
            subprocess.run([
                'aws', 's3', 'cp', '--no-sign-request',
                tar_s3, tar_local
            ], check=True)
        except subprocess.CalledProcessError:
            print(f'  No judgments tar for court={court_code}, year={year}')

    print(f'  court={court_code}, year={year} complete.')


def main():
    parser = argparse.ArgumentParser(description='Download High Court data')
    parser.add_argument('--year', type=int, required=True, help='Year to download')
    parser.add_argument('--court', type=str, help='Court code (e.g., 32_4 for Delhi)')
    parser.add_argument('--all-courts', action='store_true', help='Download all courts')
    args = parser.parse_args()

    if args.all_courts:
        for code in COURT_CODES:
            try:
                download_court_year(args.year, code)
            except Exception as e:
                print(f'Warning: Failed court={code}: {e}')
    elif args.court:
        download_court_year(args.year, args.court)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
