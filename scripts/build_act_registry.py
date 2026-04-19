#!/usr/bin/env python3
"""
Scrape IndiaCode (indiacode.nic.in) for the full list of Central Acts and
write pipeline/data/indian_acts.json.

Run once (or occasionally to refresh):
  python scripts/build_act_registry.py

The scraper paginates through the Acts of Parliament listing and captures
canonical "<Short Title>, <Year>" entries. Network-dependent; if scraping
fails, the seed registry (~80 acts) still works out of the box.

Notes:
  - IndiaCode's HTML structure changes occasionally. Update selectors if the
    scraper stops working. The target table has short title + year columns.
  - Some entries contain repealed acts; they're kept since judgments may
    cite them for historical reasons.
"""

import argparse
import json
import logging
import re
import sys
import time
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Missing deps. Install: pip install requests beautifulsoup4")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

BASE = "https://www.indiacode.nic.in"
LIST_URL = BASE + "/handle/123456789/1362/simple-search"
USER_AGENT = "Mozilla/5.0 (legal-ai-product registry builder)"


def fetch_page(session: requests.Session, start: int) -> str:
    params = {
        "query": "",
        "sort_by": "dc.date.issued_dt",
        "order": "DESC",
        "rpp": 100,
        "start": start,
    }
    r = session.get(LIST_URL, params=params, timeout=30)
    r.raise_for_status()
    return r.text


def parse_page(html: str) -> list[dict]:
    """Extract (short_title, year) rows from IndiaCode listing table."""
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select("table.table tbody tr")
    entries = []
    for row in rows:
        cells = [c.get_text(strip=True) for c in row.find_all("td")]
        if len(cells) < 3:
            continue
        year = cells[0]
        title = cells[2] if len(cells) > 2 else cells[1]
        if not title:
            continue
        if not re.fullmatch(r"\d{4}", year):
            continue
        canonical = f"{title.rstrip('.')}, {year}"
        entries.append({"canonical": canonical, "aliases": []})
    return entries


def merge_with_seed(scraped: list[dict], seed_path: Path) -> list[dict]:
    """Keep scraped canonicals but preserve aliases from existing seed."""
    alias_map: dict[str, list[str]] = {}
    if seed_path.exists():
        seed = json.loads(seed_path.read_text())
        for e in seed.get("acts", []):
            alias_map[e["canonical"]] = e.get("aliases", [])

    merged = []
    seen = set()
    for e in scraped:
        c = e["canonical"]
        if c in seen:
            continue
        seen.add(c)
        merged.append({"canonical": c, "aliases": alias_map.get(c, [])})

    # Preserve seed entries the scraper may have missed (abbreviations etc.)
    for c, aliases in alias_map.items():
        if c not in seen:
            merged.append({"canonical": c, "aliases": aliases})
            seen.add(c)

    return merged


def main():
    parser = argparse.ArgumentParser(description="Build Indian Central Acts registry from IndiaCode")
    parser.add_argument("--max-pages", type=int, default=20, help="Max pages to scrape (100 rows per page)")
    parser.add_argument("--output", default=None, help="Output JSON (default: pipeline/data/indian_acts.json)")
    parser.add_argument("--dry-run", action="store_true", help="Print count but do not write")
    args = parser.parse_args()

    out_path = Path(args.output) if args.output else (
        Path(__file__).resolve().parent.parent / "pipeline" / "data" / "indian_acts.json"
    )

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    all_entries: list[dict] = []
    for page in range(args.max_pages):
        start = page * 100
        logger.info(f"Fetching page {page + 1}/{args.max_pages} (start={start})")
        try:
            html = fetch_page(session, start)
        except requests.RequestException as e:
            logger.error(f"Request failed on page {page + 1}: {e}")
            break

        rows = parse_page(html)
        if not rows:
            logger.info("No rows on this page — reached end of listing.")
            break
        all_entries.extend(rows)
        time.sleep(1.0)

    logger.info(f"Scraped {len(all_entries)} raw entries")

    merged = merge_with_seed(all_entries, out_path)
    logger.info(f"Merged into {len(merged)} registry entries")

    if args.dry_run:
        print(json.dumps(merged[:5], indent=2))
        return

    payload = {
        "_note": f"Indian Central Acts from IndiaCode (scraped). Entries: {len(merged)}.",
        "_version": "indiacode-scrape-1",
        "acts": merged,
    }
    out_path.write_text(json.dumps(payload, indent=2))
    logger.info(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
