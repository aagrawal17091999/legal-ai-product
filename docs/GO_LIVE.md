# Go-live runbook

One-time steps to take the current `main` fully live. For routine deploys after
this, use [deploying-changes.md](deploying-changes.md).

Box: `root@204.168.160.193`, checkout `/opt/legal-ai-product`.

---

## 0. 🔴 Fix the env file FIRST — payments are broken right now

Production `.env.production.local` contains **two conflicting blocks**. Twelve
keys appear twice with different values, and **the last occurrence wins** (dotenv
overwrites earlier keys within a file). Verified live on the box:

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

**The live `RAZORPAY_KEY_SECRET` is the literal string `<razorpay-live-key-secret>`.**
Every signature verification and every Razorpay API call fails with that value,
so checkout cannot complete today regardless of anything else. The real secret is
almost certainly the one at line 15, which is being shadowed.

R2 is presumably working because whichever credentials landed in the second block
are valid — but you have two different R2 key pairs in one file, so confirm which
is current before deleting either.

### Fix

```bash
ssh root@204.168.160.193
cd /opt/legal-ai-product
cp .env.production.local .env.production.local.bak-$(date +%s)   # keep a copy
nano .env.production.local
```

Delete the **duplicates**, keeping exactly one occurrence of each key with the
correct value. Then verify no key is defined twice and nothing is a placeholder:

```bash
# any key listed here is still duplicated
grep -oE '^[A-Z_0-9]+' .env.production.local | sort | uniq -d

# any line whose value still looks like <placeholder>
grep -nE '^[A-Z_0-9]+=<' .env.production.local
```

Both should print nothing.

### While you're in there, add

```bash
BILLING_ENFORCE=on          # NOT set today = shadow mode, nobody is ever charged
MIXPANEL_TOKEN=<token>      # server-side only; do NOT prefix NEXT_PUBLIC_
MIXPANEL_API_HOST=https://api-in.mixpanel.com   # MUST match the project's region
```

`MIXPANEL_API_HOST` matters: an EU or India project rejects events sent to the US
host, and Mixpanel still answers HTTP 200, so the failure is silent. Use
`https://api.mixpanel.com` (US), `https://api-eu.mixpanel.com` (EU), or
`https://api-in.mixpanel.com` (India).

Leave `BILLING_ENFORCE=on` out until step 5 if you want to smoke-test unbilled.

---

## 1. Razorpay console

- Create/confirm a **₹2,000/month** plan and a **₹20,000/year** plan, GST enabled.
- Put their plan ids in `RAZORPAY_PLAN_MONTHLY` / `RAZORPAY_PLAN_YEARLY`.
- Confirm the webhook points at `https://getlegalbrain.com/api/payments/webhook`
  and is subscribed to at least: `payment.captured`, `subscription.activated`,
  `subscription.charged`, `subscription.cancelled`.
- Publish the refund/cancellation policy (now a section in `/terms`).

## 2. Google Cloud console

Enable the **Firestore API** for project `legal-brain-cfd44`. Until then every
job logs `PERMISSION_DENIED` and the OCR/translate UI falls back to polling
instead of live push updates.

## 3. Deploy the code

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

## 4. Install the new systemd timers

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

## 5. Verify

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
5. Subscribe on the monthly plan; confirm 1,000 credits land and
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

`migrations/028_drop_batch_api.sql` is already committed and applies itself on the
next deploy once you're ready. It is held back only because dropping columns in
the same release that stops writing them would break rollback safety.

---

## Rollback

```bash
git tag | grep prod- | tail -5
REF=prod-20260811-XXXXXX bash scripts/deploy.sh
```

Code rolls back; migrations don't. Everything shipped so far is additive except
028, which is why it goes last.
