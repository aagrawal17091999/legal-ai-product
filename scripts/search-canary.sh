#!/bin/bash
set -uo pipefail

# Synthetic search canary.
#
# Error-rate alerting only fires when users generate traffic. At current volume a
# retrieval outage can sit undetected for hours overnight and then greet the
# first lawyer of the morning. This exercises the retrieval path on a schedule,
# whether or not anyone is using the product.
#
# It checks the three external dependencies that actually failed on 2026-08-17,
# in the order a real search hits them:
#   1. Voyage embeddings  — the 401 that broke everything
#   2. pgvector + HNSW    — the corpus is reachable and returns neighbours
#   3. Voyage rerank      — the relevance gate the agent abstains on
#
# Deliberately does NOT run the agent loop: that would cost real credits on every
# tick and make failures ambiguous (a model refusal is not an outage). The
# trade-off is that a bug in the agent itself will not be caught here.
#
# Env (from $ENV_FILE, default .env.production.local):
#   CANARY_QUERY           the probe query; default is a stable doctrinal phrase
#   CANARY_MIN_ROWS        minimum vector neighbours expected, default 5
#   CANARY_COOLDOWN_MIN    silence after an alert, default 60

APP_DIR="${APP_DIR:-/opt/legal-ai-product}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production.local}"
STATE_FILE="${CANARY_STATE:-/var/lib/nyayasearch/canary.state}"

read_var() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//'
}

DB_URL="${DATABASE_URL:-$(read_var DATABASE_URL)}"
VOYAGE_KEY="${VOYAGE_API_KEY:-$(read_var VOYAGE_API_KEY)}"
QUERY="${CANARY_QUERY:-$(read_var CANARY_QUERY)}"
QUERY="${QUERY:-section 14 IBC moratorium bar on institution of proceedings}"
MIN_ROWS="${CANARY_MIN_ROWS:-$(read_var CANARY_MIN_ROWS)}"; MIN_ROWS="${MIN_ROWS:-5}"
COOLDOWN="${CANARY_COOLDOWN_MIN:-$(read_var CANARY_COOLDOWN_MIN)}"; COOLDOWN="${COOLDOWN:-60}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  local stage="$1" detail="$2"
  mkdir -p "$(dirname "$STATE_FILE")"
  local now last_stage last_ts
  now="$(date +%s)"
  last_stage=""; last_ts=0
  if [ -f "$STATE_FILE" ]; then
    last_stage="$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null || echo "")"
    last_ts="$(cut -d' ' -f2 "$STATE_FILE" 2>/dev/null || echo 0)"
  fi
  [ -z "$last_ts" ] && last_ts=0

  if [ "$stage" = "$last_stage" ] && [ $((now - last_ts)) -lt $((COOLDOWN * 60)) ]; then
    echo "CANARY FAIL [$stage] $detail — cooling down, not re-alerting" >&2
  else
    bash "$(dirname "$0")/send-alert.sh" \
      "Search canary FAILED at $stage" \
      "The synthetic search canary failed on $(hostname) at $(date -u '+%Y-%m-%d %H:%M:%S UTC').

STAGE:  $stage
DETAIL: $detail
QUERY:  \"$QUERY\"

Case search is likely broken for every user right now. The agent will answer
without case law and show its 'no on-point case' banner rather than erroring,
so users see a degraded answer, not an outage.

Box: ssh root@$(hostname -I | awk '{print $1}') && cd $APP_DIR" || true
    printf '%s %s\n' "$stage" "$now" > "$STATE_FILE"
  fi
  exit 1
}

# ── 1. embed ─────────────────────────────────────────────────
[ -n "$VOYAGE_KEY" ] || fail "config" "VOYAGE_API_KEY missing from $ENV_FILE"
[ -n "$DB_URL" ] || fail "config" "DATABASE_URL missing from $ENV_FILE"

HTTP="$(curl -s -o "$WORK/embed.json" -w '%{http_code}' -m 30 \
  https://api.voyageai.com/v1/embeddings \
  -H "Authorization: Bearer $VOYAGE_KEY" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"model":"voyage-law-2","input":[sys.argv[1]],"input_type":"query"}))' "$QUERY")" \
  2>/dev/null || echo "000")"

[ "$HTTP" = "200" ] || fail "voyage_embed" "HTTP $HTTP — $(head -c 200 "$WORK/embed.json" 2>/dev/null)"

python3 - "$WORK/embed.json" "$WORK/vec.txt" <<'PY' || fail "voyage_embed" "unparseable embedding response"
import json, sys
data = json.load(open(sys.argv[1]))
emb = data["data"][0]["embedding"]
assert len(emb) == 1024, f"expected 1024 dims, got {len(emb)}"
open(sys.argv[2], "w").write("[" + ",".join(map(str, emb)) + "]")
PY

# ── 2. pgvector ──────────────────────────────────────────────
{
  printf "select ch.chunk_text from case_chunks ch order by ch.embedding <=> '"
  cat "$WORK/vec.txt"
  printf "'::vector limit 10;\n"
} > "$WORK/q.sql"

psql "$DB_URL" -At -f "$WORK/q.sql" > "$WORK/rows.txt" 2>"$WORK/pg.err" \
  || fail "pgvector" "$(head -c 200 "$WORK/pg.err")"

ROWS="$(wc -l < "$WORK/rows.txt" | tr -d ' ')"
[ "$ROWS" -ge "$MIN_ROWS" ] || fail "pgvector" "only $ROWS neighbours returned (expected >= $MIN_ROWS) — index or corpus problem"

# ── 3. rerank ────────────────────────────────────────────────
python3 - "$WORK/rows.txt" "$QUERY" "$WORK/rr.json" <<'PY' || fail "rerank" "could not build rerank payload"
import json, sys
docs = [l.strip()[:2000] for l in open(sys.argv[1]) if l.strip()][:10]
json.dump({"model": "rerank-2", "query": sys.argv[2], "documents": docs, "top_k": 3},
          open(sys.argv[3], "w"))
PY

HTTP="$(curl -s -o "$WORK/rerank.json" -w '%{http_code}' -m 30 \
  https://api.voyageai.com/v1/rerank \
  -H "Authorization: Bearer $VOYAGE_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "@$WORK/rr.json" 2>/dev/null || echo "000")"

[ "$HTTP" = "200" ] || fail "voyage_rerank" "HTTP $HTTP — $(head -c 200 "$WORK/rerank.json" 2>/dev/null)"

TOP="$(python3 -c 'import json,sys; print(round(json.load(open(sys.argv[1]))["data"][0]["relevance_score"], 4))' "$WORK/rerank.json" 2>/dev/null || echo "")"
[ -n "$TOP" ] || fail "voyage_rerank" "unparseable rerank response"

# Recovery: clear the failure state so the next failure alerts immediately.
rm -f "$STATE_FILE"
echo "canary ok — embed 1024d, $ROWS neighbours, top rerank score $TOP"
