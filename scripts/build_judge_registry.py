#!/usr/bin/env python3
"""
Build/refresh the canonical judge registry from the existing DB.

Strategy: pull every distinct judge name already extracted into
`supreme_court_cases.judge_names` / `author_judge_name` and cluster them
by fuzzy similarity. Cluster representatives become canonical; the rest
become aliases.

Usage:
  python scripts/build_judge_registry.py               # SC judges
  python scripts/build_judge_registry.py --source hc   # HC judges
  python scripts/build_judge_registry.py --threshold 88   # similarity cutoff
  python scripts/build_judge_registry.py --dry-run     # print, don't write

The output augments the existing seed — existing canonicals are retained,
DB-discovered variants are added as aliases.
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

try:
    from rapidfuzz import fuzz, process
except ImportError:
    print("Install rapidfuzz: pip install rapidfuzz")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

REGISTRY_PATH = ROOT / "pipeline" / "data" / "indian_judges.json"
SOURCE_MAP = {"sc": "supreme_court_cases", "hc": "high_court_cases"}


def load_env():
    try:
        from dotenv import load_dotenv
        for name in (".env.local", ".env"):
            p = ROOT / name
            if p.exists():
                load_dotenv(p); return
    except ImportError:
        pass


def get_db():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL not set"); sys.exit(1)
    return psycopg2.connect(url)


def collect_names(conn, table: str) -> list[str]:
    """Pull every unique judge name from the table."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(f"""
        SELECT DISTINCT jsonb_array_elements_text(judge_names) AS name
        FROM {table}
        WHERE judge_names IS NOT NULL AND jsonb_array_length(judge_names) > 0
    """)
    names = [r["name"].strip() for r in cur.fetchall() if r["name"] and r["name"].strip()]
    cur.execute(f"SELECT DISTINCT author_judge_name FROM {table} WHERE author_judge_name IS NOT NULL")
    names.extend(r["author_judge_name"].strip() for r in cur.fetchall() if r["author_judge_name"])
    cur.close()
    return list(set(names))


def cluster(names: list[str], threshold: int) -> dict[str, list[str]]:
    """Group names by fuzzy similarity. Returns {representative: [members]}."""
    remaining = list(names)
    # Deterministic: sort by descending length so longer full names become reps.
    remaining.sort(key=len, reverse=True)
    clusters: dict[str, list[str]] = {}
    used: set[str] = set()

    for name in remaining:
        if name in used:
            continue
        clusters[name] = [name]
        used.add(name)
        candidates = [n for n in remaining if n not in used]
        if not candidates:
            continue
        matches = process.extract(name, candidates, scorer=fuzz.token_sort_ratio, limit=len(candidates))
        for m_name, m_score, _ in matches:
            if m_score >= threshold and m_name not in used:
                clusters[name].append(m_name)
                used.add(m_name)
    return clusters


def merge_with_existing(new_clusters: dict[str, list[str]]) -> list[dict]:
    """Preserve existing canonicals + aliases; add any new cluster entries."""
    existing = []
    if REGISTRY_PATH.exists():
        data = json.loads(REGISTRY_PATH.read_text())
        existing = data.get("judges", [])

    # Canonical name → set of aliases
    merged: dict[str, set[str]] = {}
    for e in existing:
        merged[e["canonical"]] = set(e.get("aliases", []))

    for rep, members in new_clusters.items():
        # If the rep or any member matches an existing canonical name fuzzily, fold in there.
        matched_canonical = None
        for canonical in merged.keys():
            if fuzz.token_sort_ratio(rep.lower(), canonical.lower()) >= 90:
                matched_canonical = canonical
                break
        if matched_canonical:
            for m in members:
                if m != matched_canonical:
                    merged[matched_canonical].add(m)
        else:
            merged[rep] = set(members) - {rep}

    return [
        {"canonical": c, "aliases": sorted(merged[c])}
        for c in sorted(merged.keys())
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=["sc", "hc", "both"], default="sc")
    parser.add_argument("--threshold", type=int, default=88)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    load_env()
    conn = get_db()
    try:
        all_names: list[str] = []
        for s in (["sc", "hc"] if args.source == "both" else [args.source]):
            names = collect_names(conn, SOURCE_MAP[s])
            logger.info(f"[{s}] {len(names)} distinct judge strings")
            all_names.extend(names)
        all_names = list(set(all_names))
        logger.info(f"Total unique: {len(all_names)}")

        clusters = cluster(all_names, args.threshold)
        logger.info(f"Formed {len(clusters)} clusters at threshold={args.threshold}")

        merged = merge_with_existing(clusters)
        logger.info(f"Final registry size: {len(merged)} canonical judges")

        if args.dry_run:
            print(json.dumps(merged[:10], indent=2))
            return

        REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        REGISTRY_PATH.write_text(json.dumps(
            {
                "_note": f"Judge registry auto-built from DB (threshold={args.threshold})",
                "_version": "db-cluster-1",
                "judges": merged,
            },
            indent=2,
        ))
        logger.info(f"Wrote {REGISTRY_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
