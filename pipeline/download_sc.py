#!/usr/bin/env python3
"""Download Supreme Court metadata and judgment PDFs from public S3."""

import argparse
import os
import subprocess
from config import SC_DATA_DIR

S3_BUCKET = 's3://indian-supreme-court-judgments'


def download_year(year: int):
    year_dir = os.path.join(SC_DATA_DIR, f'year={year}')
    os.makedirs(year_dir, exist_ok=True)

    # Download metadata parquet
    metadata_s3 = f'{S3_BUCKET}/metadata/parquet/year={year}/metadata.parquet'
    metadata_local = os.path.join(year_dir, 'metadata.parquet')
    if not os.path.exists(metadata_local):
        print(f'Downloading metadata for {year}...')
        subprocess.run([
            'aws', 's3', 'cp', '--no-sign-request',
            metadata_s3, metadata_local
        ], check=True)
    else:
        print(f'Metadata for {year} already exists, skipping.')

    # Download judgment tar
    tar_s3 = f'{S3_BUCKET}/data/tar/year={year}/english/english.tar'
    tar_local = os.path.join(year_dir, 'english.tar')
    if not os.path.exists(tar_local):
        print(f'Downloading judgments tar for {year}...')
        subprocess.run([
            'aws', 's3', 'cp', '--no-sign-request',
            tar_s3, tar_local
        ], check=True)
    else:
        print(f'Judgments tar for {year} already exists, skipping.')

    print(f'Year {year} download complete.')


def main():
    parser = argparse.ArgumentParser(description='Download Supreme Court data')
    parser.add_argument('--year', type=int, help='Specific year to download')
    parser.add_argument('--all', action='store_true', help='Download all years (1950-present)')
    args = parser.parse_args()

    if args.all:
        import datetime
        current_year = datetime.datetime.now().year
        for year in range(1950, current_year + 1):
            try:
                download_year(year)
            except subprocess.CalledProcessError:
                print(f'Warning: Failed to download year {year}, continuing...')
    elif args.year:
        download_year(args.year)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
