#!/bin/bash
# End-to-end production verification. Run ON THE BOX:
#   cd /opt/legal-ai-product && bash scripts/verify-prod.sh
#
# It never prints secret VALUES — only whether each is present/valid. Read-only:
# it changes nothing. Exit code is non-zero if any hard check FAILs.

ENV_FILE="${ENV_FILE:-.env.production.local}"
PUBLIC_URL="${PUBLIC_URL:-https://getlegalbrain.com}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:3000}"

pass=0; warn=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
wn()   { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
no()   { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# value of a key from the env file (empty if missing)
ev() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e "s/^'//" -e 's/"$//' -e "s/'$//"; }
# is a key set to a real (non-placeholder, non-empty) value?
set_ok() { local v; v="$(ev "$1")"; [ -n "$v" ] && [[ "$v" != \<* ]]; }
export DATABASE_URL; DATABASE_URL="$(ev DATABASE_URL)"
PSQL() { psql "$DATABASE_URL" -tAc "$1" 2>/dev/null; }

hdr "Secrets present in $ENV_FILE (values never shown)"
for k in DATABASE_URL ANTHROPIC_API_KEY VOYAGE_API_KEY \
         NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_PROJECT_ID FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY \
         R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME \
         CRON_SECRET BACKUP_ENC_PASSPHRASE; do
  set_ok "$k" && ok "$k set" || no "$k MISSING"
done
# admin key must be parseable JSON
python3 -c "import json,sys; json.loads(sys.argv[1])" "$(ev FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY)" 2>/dev/null \
  && ok "FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY parses as JSON" || no "FIREBASE admin key is not valid JSON"

hdr "Firebase project actually shipped"
FBP="$(ev NEXT_PUBLIC_FIREBASE_PROJECT_ID)"
echo "  env says project: ${FBP:-<unset>}"
if [ -d .next ]; then
  built="$(grep -rhoE 'legal-brain-cfd44|legal-ai-product-2ff2a' .next/static 2>/dev/null | sort -u | tr '\n' ' ')"
  echo "  built into bundle: ${built:-<none found>}"
  case "$built" in
    *"$FBP"*) ok "built bundle matches env project ($FBP)";;
    "") wn "couldn't find a project id in .next (rebuild may be needed to check)";;
    *) no "built bundle ($built) != env ($FBP) — you changed Firebase but did NOT rebuild";;
  esac
fi

hdr "Payments / Razorpay"
if set_ok RAZORPAY_KEY_ID; then
  case "$(ev RAZORPAY_KEY_ID)" in
    rzp_live_*) ok "RAZORPAY_KEY_ID is a LIVE key";;
    rzp_test_*) wn "RAZORPAY_KEY_ID is a TEST key (payments won't take real money)";;
    *) wn "RAZORPAY_KEY_ID set but unrecognized format";;
  esac
else no "RAZORPAY_KEY_ID missing — payments disabled"; fi
set_ok NEXT_PUBLIC_RAZORPAY_KEY_ID && ok "NEXT_PUBLIC_RAZORPAY_KEY_ID set (checkout button will work after build)" || no "NEXT_PUBLIC_RAZORPAY_KEY_ID missing — Buy Credits button can't open checkout"
set_ok RAZORPAY_KEY_SECRET   && ok "RAZORPAY_KEY_SECRET set"   || no "RAZORPAY_KEY_SECRET missing"
set_ok RAZORPAY_WEBHOOK_SECRET && ok "RAZORPAY_WEBHOOK_SECRET set" || no "RAZORPAY_WEBHOOK_SECRET missing — webhooks return 'skipped', credits never granted"
set_ok RAZORPAY_PLAN_MONTHLY && ok "subscription plans configured" || wn "no subscription plan IDs (fine if launching credit-topups only)"

hdr "App process (pm2)"
if command -v pm2 >/dev/null; then
  python3 - <<'PY'
import json,subprocess,sys
G="\033[32m✓\033[0m"; R="\033[31m✗\033[0m"; Y="\033[33m!\033[0m"
try: procs=json.loads(subprocess.check_output(["pm2","jlist"]))
except Exception: print("  "+R+" pm2 jlist failed"); sys.exit()
p=next((x for x in procs if x.get("name")=="nyayasearch"),None)
if not p: print("  "+R+" nyayasearch not under pm2"); sys.exit()
env=p.get("pm2_env",{})
st=env.get("status"); mode=env.get("exec_mode"); inst=env.get("instances"); restarts=env.get("restart_time",0)
mark=G if st=="online" else R
print("  %s status=%s  mode=%s  instances=%s  restarts=%s" % (mark,st,mode,inst,restarts))
if mode!="cluster_mode": print("  "+Y+" not cluster mode - pm2 reload won't be zero-downtime")
PY
else no "pm2 not installed"; fi

hdr "Scheduled jobs (systemd timers)"
for t in rag-retention backup disk-alert; do
  systemctl is-active --quiet "nyayasearch-$t.timer" 2>/dev/null && ok "nyayasearch-$t.timer active" || wn "nyayasearch-$t.timer not active"
done

hdr "Database"
if [ -n "$DATABASE_URL" ] && command -v psql >/dev/null; then
  [ "$(PSQL 'SELECT 1')" = "1" ] && ok "Postgres reachable" || no "cannot connect to Postgres"
  sb="$(PSQL 'SHOW shared_buffers')"; echo "  shared_buffers = $sb"
  case "$sb" in 128MB) wn "shared_buffers still at stock 128MB — tuning.conf not applied";; *) ok "shared_buffers tuned ($sb)";; esac
  cc="$(PSQL 'SELECT count(*) FROM case_chunks')"; [ "${cc:-0}" -gt 0 ] && ok "case_chunks has $cc rows" || no "case_chunks empty"
  hc="$(PSQL 'SELECT count(*) FROM high_court_cases')"; [ "${hc:-0}" -gt 0 ] && ok "high_court_cases has $hc rows" || wn "high_court_cases empty (HC data not loaded)"
fi

hdr "HTTP surface"
h="$(curl -sS -m 15 "$LOCAL_URL/api/health" 2>/dev/null)"; echo "$h" | grep -q '"db":"up"' && ok "local /api/health db:up" || no "local health not ok: $h"
pc="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$PUBLIC_URL" 2>/dev/null)"; [ "$pc" = 200 ] && ok "public homepage 200 over HTTPS" || no "public homepage $pc"
wsec="$(curl -sS -m 15 -X POST "$PUBLIC_URL/api/payments/webhook" -d '{}' 2>/dev/null)"
echo "$wsec" | grep -q skipped && wn "webhook returns 'skipped' → RAZORPAY_WEBHOOK_SECRET not in running env (rebuild+reload after setting it)" || ok "webhook enforces signature"
curl -sSI -m 12 "$PUBLIC_URL" 2>/dev/null | grep -qi 'strict-transport-security' && ok "HSTS header present" || wn "HSTS header missing (add to nginx)"

hdr "Disk"
used="$(df -P / | awk 'NR==2{gsub("%","",$5);print $5}')"; avail="$(df -Ph / | awk 'NR==2{print $4}')"
[ "$used" -lt 80 ] && ok "disk ${used}% used (${avail} free)" || wn "disk ${used}% used — watch it"

printf '\n\033[1mSUMMARY:\033[0m \033[32m%d pass\033[0m  \033[33m%d warn\033[0m  \033[31m%d fail\033[0m\n' "$pass" "$warn" "$fail"
[ "$fail" -eq 0 ]