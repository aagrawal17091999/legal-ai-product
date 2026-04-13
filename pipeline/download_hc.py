#!/usr/bin/env python3
"""Download High Court metadata and judgment PDFs from public S3."""

import argparse
import json
import os
import subprocess
from config import HC_DATA_DIR

S3_BUCKET = 's3://indian-high-court-judgments'


def list_s3_prefixes(s3_path: str) -> list[str]:
    """List immediate subdirectory prefixes under an S3 path."""
    result = subprocess.run(
        ['aws', 's3', 'ls', s3_path, '--no-sign-request'],
        capture_output=True, text=True
    )
    prefixes = []
    for line in result.stdout.strip().splitlines():
        line = line.strip()
        if line.startswith('PRE '):
            prefixes.append(line[4:].rstrip('/'))
    return prefixes


def discover_courts(year: int) -> list[str]:
    """Discover all court codes available for a given year."""
    path = f'{S3_BUCKET}/metadata/parquet/year={year}/'
    prefixes = list_s3_prefixes(path)
    codes = []
    for p in prefixes:
        if p.startswith('court='):
            codes.append(p.split('=', 1)[1])
    return sorted(codes)


def discover_bench(year: int, court_code: str, prefix: str = 'metadata/parquet') -> str | None:
    """Discover the bench subfolder for a court/year combo."""
    path = f'{S3_BUCKET}/{prefix}/year={year}/court={court_code}/'
    prefixes = list_s3_prefixes(path)
    for p in prefixes:
        if p.startswith('bench='):
            return p.split('=', 1)[1]
    return None


def download_court_year(year: int, court_code: str):
    court_dir = os.path.join(HC_DATA_DIR, f'court={court_code}', f'year={year}')
    os.makedirs(court_dir, exist_ok=True)

    # Discover bench name from metadata path
    bench = discover_bench(year, court_code, 'metadata/parquet')
    if bench is None:
        print(f'  No bench folder found for court={court_code}, year={year}, skipping.')
        return

    print(f'  Bench: {bench}')

    # Save bench name for downstream use
    bench_file = os.path.join(court_dir, 'bench.json')
    with open(bench_file, 'w') as f:
        json.dump({'bench': bench, 'court_code': court_code, 'year': year}, f)

    # Download metadata
    metadata_s3 = f'{S3_BUCKET}/metadata/parquet/year={year}/court={court_code}/bench={bench}/metadata.parquet'
    metadata_local = os.path.join(court_dir, 'metadata.parquet')
    if not os.path.exists(metadata_local):
        print(f'  Downloading metadata...')
        try:
            subprocess.run([
                'aws', 's3', 'cp', '--no-sign-request',
                metadata_s3, metadata_local
            ], check=True)
        except subprocess.CalledProcessError:
            print(f'  Failed to download metadata for court={court_code}, year={year}')
            return

    # Download data tar
    tar_s3 = f'{S3_BUCKET}/data/tar/year={year}/court={court_code}/bench={bench}/data.tar'
    tar_local = os.path.join(court_dir, 'data.tar')
    if not os.path.exists(tar_local):
        print(f'  Downloading data tar...')
        try:
            subprocess.run([
                'aws', 's3', 'cp', '--no-sign-request',
                tar_s3, tar_local
            ], check=True)
        except subprocess.CalledProcessError:
            print(f'  No data tar for court={court_code}, year={year}')

    print(f'  court={court_code} (bench={bench}), year={year} complete.')


def main():
    parser = argparse.ArgumentParser(description='Download High Court data')
    parser.add_argument('--year', type=int, required=True, help='Year to download')
    parser.add_argument('--court', type=str, help='Court code (e.g., 32_4 for Delhi)')
    parser.add_argument('--all-courts', action='store_true', help='Download all courts (auto-discovered from S3)')
    parser.add_argument('--list-courts', action='store_true', help='List available court codes for the given year')
    args = parser.parse_args()

    if args.list_courts:
        print(f'Discovering courts for year={args.year}...')
        codes = discover_courts(args.year)
        print(f'Found {len(codes)} courts:')
        for code in codes:
            bench = discover_bench(args.year, code)
            print(f'  court={code}  bench={bench}')
        return

    if args.all_courts:
        print(f'Discovering courts for year={args.year}...')
        codes = discover_courts(args.year)
        print(f'Found {len(codes)} courts.\n')
        for code in codes:
            try:
                print(f'Downloading court={code}, year={args.year}...')
                download_court_year(args.year, code)
            except Exception as e:
                print(f'  Warning: Failed court={code}: {e}')
    elif args.court:
        print(f'Downloading court={args.court}, year={args.year}...')
        download_court_year(args.year, args.court)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
