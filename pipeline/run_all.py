#!/usr/bin/env python3
"""End-to-end: download -> process/load -> extract -> embed.

Each sub-step is idempotent:
  - download_sc/hc.py      skip files already on disk
  - process_and_load.py    skips rows by cnr/path
  - extract_fields --all   processes only extraction_status='pending'
  - reembed_all.py         skips cases recorded in reembed_progress

Usage:
  python pipeline/run_all.py                         # SC + HC, 1950..current
  python pipeline/run_all.py --source sc
  python pipeline/run_all.py --source hc --courts 32_4 32_5
  python pipeline/run_all.py --start-year 2020 --end-year 2024
  python pipeline/run_all.py --skip-download         # DB-only (extract+embed)
"""

import argparse
import datetime
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import SC_DATA_DIR, HC_DATA_DIR

HC_COURT_CODES = [f"32_{i}" for i in range(1, 25)]
PIPELINE_DIR = Path(__file__).resolve().parent


def run(cmd: list[str]) -> int:
    print(f"\n$ {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f"  (exit {r.returncode}) — continuing to next step", flush=True)
    return r.returncode


def sc_download_and_load(years: list[int]) -> None:
    for y in years:
        run([sys.executable, str(PIPELINE_DIR / "download_sc.py"), "--year", str(y)])
        meta = os.path.join(SC_DATA_DIR, f"year={y}", "metadata.parquet")
        if not os.path.exists(meta):
            print(f"  SC {y}: metadata missing after download, skipping load")
            continue
        run([sys.executable, str(PIPELINE_DIR / "process_and_load.py"),
             "--source", "sc", "--year", str(y)])


def hc_download_and_load(years: list[int], courts: list[str]) -> None:
    for court in courts:
        for y in years:
            run([sys.executable, str(PIPELINE_DIR / "download_hc.py"),
                 "--year", str(y), "--court", court])
            meta = os.path.join(HC_DATA_DIR, f"court={court}",
                                f"year={y}", "metadata.parquet")
            if not os.path.exists(meta):
                continue
            run([sys.executable, str(PIPELINE_DIR / "process_and_load.py"),
                 "--source", "hc", "--year", str(y), "--court", court])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["sc", "hc", "all"], default="all")
    ap.add_argument("--start-year", type=int, default=1950)
    ap.add_argument("--end-year", type=int,
                    default=datetime.datetime.now().year)
    ap.add_argument("--courts", nargs="*", default=HC_COURT_CODES,
                    help="HC court codes (default: all 24)")
    ap.add_argument("--skip-download", action="store_true")
    ap.add_argument("--skip-extract", action="store_true")
    ap.add_argument("--skip-embed", action="store_true")
    args = ap.parse_args()

    years = list(range(args.start_year, args.end_year + 1))
    do_sc = args.source in ("sc", "all")
    do_hc = args.source in ("hc", "all")

    # 1. Download PDFs + metadata, 2. load rows + judgment_text into DB
    if not args.skip_download:
        if do_sc:
            sc_download_and_load(years)
        if do_hc:
            hc_download_and_load(years, args.courts)

    # 3. Extract structured metadata for every pending row
    if not args.skip_extract:
        if do_sc:
            run([sys.executable, str(PIPELINE_DIR / "extract_fields.py"),
                 "--source", "sc", "--all"])
        if do_hc:
            run([sys.executable, str(PIPELINE_DIR / "extract_fields.py"),
                 "--source", "hc", "--all"])

    # 4. Embed (metadata-header chunks) for every case not in reembed_progress
    if not args.skip_embed:
        run([sys.executable, str(PIPELINE_DIR / "reembed_all.py"),
             "--source", args.source])


if __name__ == "__main__":
    main()
