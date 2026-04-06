#!/usr/bin/env python3
"""Inspect parquet files from S3 to understand the actual column schema."""

import argparse
import os
import subprocess
import sys

import pandas as pd

SC_BUCKET = 's3://indian-supreme-court-judgments'
HC_BUCKET = 's3://indian-high-court-judgments'

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')


def download_parquet(source: str, year: int, court_code: str | None = None) -> str:
    """Download a single parquet file and return local path."""
    if source == 'sc':
        s3_path = f'{SC_BUCKET}/metadata/parquet/year={year}/metadata.parquet'
        local_dir = os.path.join(DATA_DIR, 'supreme-court', f'year={year}')
    else:
        if not court_code:
            print('Error: --court required for HC')
            sys.exit(1)
        s3_path = f'{HC_BUCKET}/metadata/parquet/court={court_code}/year={year}/metadata.parquet'
        local_dir = os.path.join(DATA_DIR, 'high-courts', f'court={court_code}', f'year={year}')

    os.makedirs(local_dir, exist_ok=True)
    local_path = os.path.join(local_dir, 'metadata.parquet')

    if not os.path.exists(local_path):
        print(f'Downloading {s3_path}...')
        subprocess.run([
            'aws', 's3', 'cp', '--no-sign-request',
            s3_path, local_path
        ], check=True)
    else:
        print(f'Using cached {local_path}')

    return local_path


def inspect(path: str, sample_rows: int = 3):
    """Print schema, stats, and sample data from a parquet file."""
    df = pd.read_parquet(path)

    print('\n' + '=' * 70)
    print('PARQUET INSPECTION')
    print('=' * 70)

    print(f'\nFile: {path}')
    print(f'Rows: {len(df)}')
    print(f'Columns: {len(df.columns)}')

    print('\n--- COLUMN SCHEMA ---')
    print(f'{"Column":<30} {"Dtype":<15} {"Non-Null":<10} {"Sample Value"}')
    print('-' * 90)
    for col in df.columns:
        non_null = df[col].notna().sum()
        sample = ''
        # Get first non-null value
        non_null_vals = df[col].dropna()
        if len(non_null_vals) > 0:
            val = non_null_vals.iloc[0]
            sample = str(val)[:80]
        print(f'{col:<30} {str(df[col].dtype):<15} {non_null:<10} {sample}')

    print(f'\n--- SAMPLE ROWS (first {sample_rows}) ---')
    for i, (_, row) in enumerate(df.head(sample_rows).iterrows()):
        print(f'\n  Row {i}:')
        for col in df.columns:
            val = row[col]
            if pd.notna(val):
                val_str = str(val)
                if len(val_str) > 120:
                    val_str = val_str[:120] + '...'
                print(f'    {col}: {val_str}')

    # Show which columns our DB expects vs what parquet has
    print('\n--- COLUMN MAPPING CHECK (Supreme Court) ---')
    sc_expected = [
        'title', 'petitioner', 'respondent', 'description', 'judge',
        'author_judge', 'citation', 'case_id', 'cnr', 'decision_date',
        'disposal_nature', 'available_languages', 'path', 'nc_display'
    ]
    parquet_cols = set(df.columns)
    print(f'\n  {"Expected Column":<25} {"In Parquet?":<15} {"Closest Match?"}')
    print('  ' + '-' * 70)
    for col in sc_expected:
        found = col in parquet_cols
        closest = ''
        if not found:
            # Try fuzzy match
            for pc in parquet_cols:
                if col.replace('_', '') in pc.replace('_', '').lower():
                    closest = pc
                    break
        print(f'  {col:<25} {"YES" if found else "NO":<15} {closest}')

    extra = parquet_cols - set(sc_expected) - {'raw_html', 'scraped_at'}
    if extra:
        print(f'\n  Extra columns in parquet (not mapped): {sorted(extra)}')

    print('\n' + '=' * 70)


def main():
    parser = argparse.ArgumentParser(description='Inspect parquet schema from S3')
    parser.add_argument('--source', required=True, choices=['sc', 'hc'])
    parser.add_argument('--year', type=int, default=2024, help='Year to inspect (default: 2024)')
    parser.add_argument('--court', type=str, help='Court code for HC')
    parser.add_argument('--rows', type=int, default=3, help='Number of sample rows')
    parser.add_argument('--local', type=str, help='Inspect a local parquet file directly')
    args = parser.parse_args()

    if args.local:
        path = args.local
    else:
        path = download_parquet(args.source, args.year, args.court)

    inspect(path, args.rows)


if __name__ == '__main__':
    main()
