# Go-live runbook

One-time steps to take the current `main` fully live. For routine deploys after
this, use [deploying-changes.md](deploying-changes.md).

Box: `root@204.168.160.193`, checkout `/opt/legal-ai-product`.

---

## 0. ✅ DONE — env file deduplicated (11 Aug 2026)

Production `.env.production.local` held **two complete config sets** — test, then
live — with twelve keys defined twice. dotenv keeps the LAST occurrence, so the
first set was dead but looked authoritative.

Every duplicated credential was tested against its real service to decide which
was correct, then the file was rewritten keeping exactly the values already live.
Verified before/after: only the four Mixpanel keys were added; nothing else
changed, nothing was lost. Backup at `.env.production.local.bak-predupe-*`.

**One thing remains and it is the blocker for payments** — see 0a. The dedup also
kept the wrong R2 bucket, which broke every citation PDF link — see 0b.

<details>
<summary>What the two sets contained (historical)</summary>

| Key | Occurrences | Live value is from |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | 1, 33 | 33 |
| `DATABASE_URL` | 4, 32 | 32 |
| `RAZORPAY_KEY_ID` | 14, 42 | 42 |
| `RAZORPAY_KEY_SECRET` | 15, 44 | **44 — an unfilled `<placeholder>`** |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | 16, 43 | 43 |
| `RAZORPAY_PLAN_MONTHLY` | 17, 46 | 46 |
| `RAZORPAY_PLAN_YEARLY` | 18, 47 | 47 |
| `RAZORPAY_WEBHOOK_SECRET` | 19, 45 | 45 |
| `R2_ACCESS_KEY_ID` | 28, 38 | 38 |
| `R2_SECRET_ACCESS_KEY` | 29, 39 | 39 |
| `R2_BUCKET_NAME` | 31, 40 | 40 |

Credential tests: both `DATABASE_URL`s connected; both R2 pairs worked but
pointed at different buckets (`legal-judgments` vs the live `legal-brain-prod`);
and the only Razorpay credentials that authenticated were **test-mode**.

</details>

---

## 0a. ✅ DONE — the live Razorpay key secret

Added and verified against the live API (`/v1/plans` returns 200). It had never
been filled in — the file's only working Razorpay credentials were test-mode.

To re-verify at any time, or after rotating the key:

```bash
ssh root@204.168.160.193
cd /opt/legal-ai-product
nano .env.production.local        # replace <your live secret> on the RAZORPAY_KEY_SECRET line
```

Verify it authenticates without printing it:

```bash
node -e 'require("@next/env").loadEnvConfig(process.cwd(), false);
fetch("https://api.razorpay.com/v1/plans?count=1",{headers:{Authorization:"Basic "+
Buffer.from(process.env.RAZORPAY_KEY_ID+":"+process.env.RAZORPAY_KEY_SECRET).toString("base64")}})
.then(r=>console.log(r.status===200?"RAZORPAY OK":"FAILED HTTP "+r.status))'
```

If you'd rather smoke-test the whole flow without real money first, the backup
file still has the complete working **test** set (`rzp_test_…` key, its secret,
and matching `plan_SZ4r…` ids). Swap all four together — a live key id with test
plan ids fails.

### Already added for you

Mixpanel is configured and the token was verified to ingest (`status: 1` from
`api.mixpanel.com`). Both the server and browser vars are set to the same project
and region:

```
MIXPANEL_TOKEN / NEXT_PUBLIC_MIXPANEL_TOKEN       3f1d657b…
MIXPANEL_API_HOST                                  api.mixpanel.com
NEXT_PUBLIC_MIXPANEL_API_HOST                      https://api.mixpanel.com
```

Razorpay plan ids are set to the live plans: `plan_T9oqxUUcsDyhtK` (₹2,000/mo)
and `plan_T9orXVYWYES8Du` (₹20,000/yr).

`BILLING_ENFORCE` is present but **commented out on purpose** — turning it on
before checkout works would block users with no way to pay. Uncomment it at
step 5, after 0a is done.

`NEXT_PUBLIC_*` values are baked in at BUILD time, so all of the above take
effect at the next `deploy.sh` build, not on a reload.

`MIXPANEL_API_HOST` must match where the project was created: `api.mixpanel.com`
(US), `api-eu.mixpanel.com` (EU), `api-in.mixpanel.com` (India) — **and the same
region for the server and browser vars**, so both halves of a funnel land in one
project. `verify-prod.sh` checks both. A typo'd host fails outright rather than
degrading quietly.

Leave `BILLING_ENFORCE=on` out until step 5 if you want to smoke-test unbilled.

---

## 0b. ⬜ TODO on the box — point R2 at the corpus bucket

**Symptom:** clicking a citation's "Open full judgment" returns R2's raw
`<Error><Code>NoSuchKey</Code></Error>` XML.

**Cause:** the env dedup in §0 kept `R2_BUCKET_NAME=legal-brain-prod` (set 40),
but the ingestion pipeline uploads the judgment corpus to `legal-judgments`
(`pipeline/config.py` default). Supreme Court PDFs are not stored as URLs —
`/api/judgments/download` rebuilds the key `supreme-court/{year}/{path}_EN.pdf`
and presigns it at click time. The signature is valid, so R2 accepts the request
and reports the key as missing; the app logs nothing.

**Verified before changing anything** (against the live DB + `legal-judgments`):

- 38,245 corpus objects vs 38,246 rows — only 5 rows have no PDF (ids 14243,
  16740, 16802, 36606, 37199). Key derivation is correct; the historical
  `year`-vs-path drift (227 rows) does *not* cause misses.
- All 7 R2 keys referenced by live user data (2 workspace docs, 1 translation,
  1 OCR job) **already exist in `legal-judgments`**, so the switch orphans
  nothing. `high_court_cases` is empty, so every citation takes this path.

**The bucket is only half of it — the credentials are scoped per bucket.** Done
on the box 2026-08-17: `R2_BUCKET_NAME=legal-judgments` + `pm2 reload`
(server-only var, no rebuild; backup `.env.production.local.bak-r2bucket-*`).
That alone does NOT fix it. The live key pair (dedup set 39/40) is scoped to
`legal-brain-prod` and returns **AccessDenied** on `legal-judgments`, so the app
now fails on that bucket for reads *and writes* — citation PDFs and new
OCR/translate/workspace uploads alike. The pair the dedup discarded as "dead"
(set 28/29, still in `.env.production.local.bak-predupe-1786445786223`, and the
same pair as local `.env.local` — verified by hashing the key id) has full
read/write/delete on `legal-judgments`, tested with a put + delete round-trip.

**Finish it** — swap the key pair to set 28/29, then reload:

```bash
ssh root@204.168.160.193
cd /opt/legal-ai-product
F=.env.production.local.bak-predupe-1786445786223
cp .env.production.local ".env.production.local.bak-r2creds-$(date +%Y%m%d%H%M%S)"
AK=$(grep '^R2_ACCESS_KEY_ID=' "$F" | head -1 | cut -d= -f2-)
SK=$(grep '^R2_SECRET_ACCESS_KEY=' "$F" | head -1 | cut -d= -f2-)
python3 - "$AK" "$SK" <<'PY'
import sys
p = ".env.production.local"; ak, sk = sys.argv[1], sys.argv[2]
out = []
for line in open(p):
    if line.startswith("R2_ACCESS_KEY_ID="):       line = "R2_ACCESS_KEY_ID=%s\n" % ak
    elif line.startswith("R2_SECRET_ACCESS_KEY="): line = "R2_SECRET_ACCESS_KEY=%s\n" % sk
    out.append(line)
open(p, "w").writelines(out)
PY
pm2 reload nyayasearch --update-env
```

Verify (should print the object's metadata, not AccessDenied):

```bash
set -a; . ./.env.production.local; set +a
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto aws s3api head-object --bucket "$R2_BUCKET_NAME" \
  --key supreme-court/2024/2024_3_1009_1013_EN.pdf --endpoint-url "$R2_ENDPOINT"
```

**Rollback** to the pre-change state at any time — nothing was deleted, and the
7 user-data objects exist in both buckets:

```bash
cp .env.production.local.bak-r2bucket-<ts> .env.production.local
pm2 reload nyayasearch --update-env
```

Longer-term: issue one Cloudflare R2 token scoped to `legal-judgments` and
retire `legal-brain-prod` (check it for objects not mirrored in the corpus
bucket first — the old backups under `app-backups/` and `reference-dumps/` were
written there and will need the old key pair to read).

---

## 1. Razorpay console

- ✅ Live key secret added and verified against the API.
- ✅ `plan_T9oqxUUcsDyhtK` — ₹2,000, period `monthly`, interval 1. **Correct.**
- 🔴 `plan_T9orXVYWYES8Du` — ₹20,000, period **`monthly`**, interval 1.
  **WRONG: this bills ₹20,000 EVERY MONTH (₹2,40,000/yr).** Razorpay makes
  `period`/`interval` immutable after creation, so it needs a *new* plan with
  billing cycle **Yearly**, amount ₹20,000, GST enabled. Then update
  `RAZORPAY_PLAN_YEARLY`. Until then the yearly option must not be sold.
- Confirm **GST is enabled on both** plans.
- Confirm the webhook points at `https://getlegalbrain.com/api/payments/webhook`
  and is subscribed to at least: `payment.captured`, `subscription.activated`,
  `subscription.charged`, `subscription.cancelled`.
- Publish the refund/cancellation policy (now a section in `/terms`).

## 2. ✅ DONE — Firestore

Creating the database enabled the API (verified with a real admin write → read →
delete from the box).

The database was created in **production mode**, whose default rules deny every
client read — so the live job-status push channel would never have fired, and a
user watching the OCR spinner would have seen nothing until they switched tabs
and back (`useJobStatusPush` reconciles on focus).

The committed [`firestore.rules`](../firestore.rules) are now published via the
Firebase Rules REST API using the app's own service account — no CLI needed:

    ruleset projects/legal-brain-cfd44/rulesets/857695ba-…  (live)

A user may read only their own `ocr_jobs` / `translate_jobs` docs; no client may
write. To republish after editing the file, re-run the same two-step API call
(create ruleset → update the `cloud.firestore` release).

## 3. ✅ DONE — Deployed

Released `prod-20260811-120912`. `npm ci` → build → migrations (0 applied, 28
skipped — 028 is parked) → zero-downtime `pm2 reload` of both cluster workers.

```bash
ssh root@204.168.160.193
cd /opt/legal-ai-product
bash scripts/deploy.sh
```

That runs: fetch → checkout `origin/main` → `npm ci` → build → migrations →
`pm2 reload` → tag. Migrations gate the reload, so a failed migration leaves the
old process serving.

`NEXT_PUBLIC_*` values are baked in at build time, so the build above is what
picks up any `NEXT_PUBLIC_APP_URL` / Razorpay key-id changes from step 0.

Optional tidy — the checkout has stray files from a fumbled shell command
(`a`, `adcavs`, `${DATE_THRESHOLD}::date`, `.venv/`). They're harmless but noisy:

```bash
rm -rf a adcavs '${DATE_THRESHOLD}::date' .venv
```

## 4. ✅ DONE — timers installed

**This is the step that makes OCR and translation work at all.** There is
currently no scheduler for the batch worker on the box, so uploads would sit in
`pending` forever.

```bash
cd /opt/legal-ai-product
for u in process-batches credit-refill; do
  sed -e "s#^User=.*#User=root#" \
      -e "s#^WorkingDirectory=.*#WorkingDirectory=/opt/legal-ai-product#" \
      "deploy/systemd/nyayasearch-$u.service" > "/etc/systemd/system/nyayasearch-$u.service"
  cp "deploy/systemd/nyayasearch-$u.timer" "/etc/systemd/system/nyayasearch-$u.timer"
done
systemctl daemon-reload
systemctl enable --now nyayasearch-process-batches.timer nyayasearch-credit-refill.timer
systemctl list-timers | grep nyayasearch
```

(`User=root` matches the three timers already installed. The units ship with a
`deploy` placeholder that `bootstrap-box.sh` rewrites; here you're installing by
hand, so substitute it yourself — there is no `deploy` user on this box.)

Confirm the worker is actually running:

```bash
journalctl -u nyayasearch-process-batches.service -n 20 --no-pager
```

## 5. ✅ DONE — verified (40 pass, 1 warn, 1 fail)

The single failure is `BILLING_ENFORCE`, deliberately off until the smoke test
passes. The warning is `high_court_cases` being empty, which predates this work.

Re-run any time with:

```bash
bash scripts/verify-prod.sh
```

It now hard-fails on: a missing `process-batches` timer, `BILLING_ENFORCE` not
being `on`, a missing `SARVAM_API_KEY`, batches stuck over 30 minutes, and an
unrecognised `MIXPANEL_API_HOST`.

## 6. Smoke test — do this before announcing anything

1. **Upload a real multi-page PDF** to `/ocr` and let it finish. This path has
   never run unattended; it is the single most likely thing to be broken.
2. Do the same on `/translate`.
3. Ask a research question; confirm the credit meter in the header drops.
4. **Buy the smallest top-up with a real card.** Confirm: the charge is
   GST-inclusive, credits land, and `credit_transactions.amount_inr` records the
   **ex-GST** base.
5. Subscribe on the monthly plan; confirm 2,000 credits land and
   `subscription_activated` shows up in Mixpanel.
6. Drain a test account to zero and confirm the 402 opens the top-up modal
   rather than a dead-end error.

## 7. Make yourself staff and unlimited

No account currently has `is_staff`, so `/admin/errors` will 404 for you. Sign in
once so your user row exists, then:

```bash
DB=$(grep -E '^DATABASE_URL=' /opt/legal-ai-product/.env.production.local | tail -1 | cut -d= -f2-)
psql "$DB" -c "UPDATE users SET is_staff = TRUE, unlimited_credits = TRUE WHERE email = 'ansh@getlegalbrain.com';"
psql "$DB" -c "SELECT id, email, is_staff, unlimited_credits FROM users WHERE is_staff;"
```

`unlimited_credits` keeps your own testing from draining a wallet once
`BILLING_ENFORCE=on`.

## 8. Legal sign-off

Read `/terms` and `/privacy`, resolve the `⟨CONFIRM⟩` items in each file's header
comment, then delete the `REVIEW_PENDING` banner in both and redeploy. The banner
is deliberately still there — removing it asserts the review happened.

## 9. Deploy 2 — drop the Batch API columns

Only after step 3 has been stable for a day or so:

```bash
psql "$DB" -c "SELECT count(*) FROM job_batches WHERE status IN ('planned','submitting','submitted');"
# must be 0, then:
cd /opt/legal-ai-product && bash scripts/deploy.sh
```

`migrations/pending/028_drop_batch_api.sql` is written but parked —
`scripts/migrate.sh` globs `migrations/*.sql`, which doesn't match that
subdirectory, so it cannot apply by accident. To run it:

```bash
git mv migrations/pending/028_drop_batch_api.sql migrations/028_drop_batch_api.sql
git commit -am "Apply migration 028" && git push
# then on the box: bash scripts/deploy.sh
```

It is parked only because dropping columns in the same release that stops writing
them would make a rollback land on a schema the old code can't read.

---

## Rollback

```bash
git tag | grep prod- | tail -5
REF=prod-20260811-XXXXXX bash scripts/deploy.sh
```

Code rolls back; migrations don't. Everything shipped so far is additive except
028, which is why it goes last.
