#!/usr/bin/env python3
"""Fail-fast check for required env vars and external reachability.

Run before long pipeline jobs so the VM exits loudly on a missing secret
or broken network, instead of dying 20 minutes in.

Exit 0 = OK. Exit 1 = missing/unreachable.
"""

import os
import sys

import boto3
import psycopg2
from botocore.exceptions import ClientError, EndpointConnectionError
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))

REQUIRED = [
    "DATABASE_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "R2_BUCKET_NAME",
    "VOYAGE_API_KEY",
    "ANTHROPIC_API_KEY",
]


def check_env() -> list[str]:
    return [k for k in REQUIRED if not os.getenv(k)]


def check_db() -> str | None:
    try:
        conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        conn.close()
        return None
    except Exception as e:
        return f"{type(e).__name__}: {e}"


def check_r2() -> str | None:
    try:
        client = boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )
        client.head_bucket(Bucket=os.environ["R2_BUCKET_NAME"])
        return None
    except (ClientError, EndpointConnectionError) as e:
        return f"{type(e).__name__}: {e}"
    except Exception as e:
        return f"{type(e).__name__}: {e}"


def main() -> int:
    failed = False

    missing = check_env()
    if missing:
        print(f"[preflight] FAIL missing env vars: {', '.join(missing)}")
        failed = True
    else:
        print(f"[preflight] OK  env vars ({len(REQUIRED)}/{len(REQUIRED)})")

    if not missing:
        db_err = check_db()
        if db_err:
            print(f"[preflight] FAIL postgres unreachable: {db_err}")
            failed = True
        else:
            print("[preflight] OK  postgres reachable")

        r2_err = check_r2()
        if r2_err:
            print(f"[preflight] FAIL R2 unreachable: {r2_err}")
            failed = True
        else:
            print("[preflight] OK  R2 bucket reachable")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
