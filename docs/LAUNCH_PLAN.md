# Launch Plan

Everything standing between the current `main` and taking real money from real
advocates.

> **Status (11 Aug 2026): all code work is done and on `main` — 8 commits,
> tsc/eslint/84 tests/build all green. Nothing has been deployed.**
>
> What remains is work only you can do. In order:
>
> | # | Task | Why it's yours |
> |---|---|---|
> | 1 | Create the **₹2,000/mo** and **₹20,000/yr** Razorpay plans with GST enabled, and set `RAZORPAY_PLAN_MONTHLY` / `RAZORPAY_PLAN_YEARLY` | Razorpay console |
> | 2 | Set `RAZORPAY_WEBHOOK_SECRET` on the box — **still missing; without it no payment ever grants credits** | secret |
> | 3 | Enable the **Firestore API** for `legal-brain-cfd44` | Google Cloud console |
> | 4 | Add `SARVAM_API_KEY`, `SARVAM_OCR_ENABLED=on` to `.env.production.local` | secret |
> | 5 | Review + sign off Terms and Privacy, resolve the `⟨CONFIRM⟩` markers, delete both `REVIEW_PENDING` banners | your review |
> | 6 | Deploy, install the new systemd timers, then **upload a real multi-page PDF end to end** | prod access |
> | 7 | Set `BILLING_ENFORCE=on` (only after 6 passes) and give yourself `unlimited_credits` | prod access |
> | 8 | After deploy 1 is stable, apply `migrations/028_drop_batch_api.sql` | sequencing |
>
> Deferred by choice: analytics (no PostHog/Mixpanel yet — you'll launch blind
> on conversion) and a staff UI for `/api/admin/errors` (API exists, no page).

## Decisions locked in

| Question | Decision |
|---|---|
| Batching | Remove the **Anthropic Message Batch API** only. The `job_batches` work queue stays — it is the OCR/translate execution engine, not "batching". |
| Pricing | **₹2,000/month credit pool** (1,000 credits). Drop the word "unlimited" everywhere. |
| Yearly plan | **₹20,000/year** ("save ₹4,000"). |
| Free tier | Described as **100 credits**, not "5 free chats". |
| GST | **Added on top** of listed prices, including one-time top-ups. |
| Social proof | **Leave as-is.** Not in scope. |
| Support email | **ansh@getlegalbrain.com** everywhere. |
| Legal review | Ansh is doing it himself — no external lead time. |

---

## Phase 0 — Stop the bleeding (do first, ~10 min)

The doc-chat agent rewrite is finished, typechecks, lints, passes tests, and has
an eval behind it (22/22 quality held, credits 315 → 164) — and it exists only as
untracked files in the working tree. A stray `git checkout` loses it.

- [x] Commit the docAgent work: `src/lib/docchat/docAgent.ts`, `docAgentPrompt.ts`,
      `docAgentTools.ts`, the `answer.ts`/`retrieve.ts`/`agent.ts`/`agentTools.ts`
      edits, `workspace/[id]/page.tsx`, `src/lib/rag/__tests__/chunkRegistry.test.ts`,
      `eval/docchat_set.json`, `scripts/eval_docchat.mts`, `scripts/eval_research_cost.mts`,
      `scripts/measure_chunk_overlap.mts`, `docs/deploying-changes.md`.
- [x] Decide on `eval/results/` — likely gitignore it rather than commit run output.

---

## Phase 1 — Remove the Anthropic Batch API

Currently gated off (`BATCH_API_ENABLED === "on"`), so **nothing changes
behaviourally in prod**. This is a dead-path deletion.

### 1a. Code

- [x] **Delete** [`src/lib/jobs/batch-api.ts`](../src/lib/jobs/batch-api.ts) (244 lines).
- [x] [`src/app/api/ocr/route.ts`](../src/app/api/ocr/route.ts) — drop the
      `shouldUseBatchApi` import; `enqueueBatches(...)` loses its `delivery` argument.
- [x] [`src/app/api/translate/route.ts`](../src/app/api/translate/route.ts) — same.
- [x] [`src/app/api/cron/process-batches/route.ts`](../src/app/api/cron/process-batches/route.ts) —
      remove the `submitPlannedBatchJobs` / `pollInFlightBatchApi` / `revertExpiredBatchUnits`
      imports and the block around lines 293–304.
- [x] [`src/lib/jobs/batches.ts`](../src/lib/jobs/batches.ts) — remove the whole
      "Batch-API delivery" section (lines ~670–795): `findPlannedJobs`,
      `claimJobForSubmission`, `markBatchSubmitted`, `revertUnitsToSync`,
      `findInFlightProviderBatches`, `getProviderBatchUnits`, `completeSubmittedBatch`,
      `revertExpiredBatchUnits`. Also drop `Delivery`, `BATCH_INFLIGHT_SQL`,
      `BATCH_API_MAX_AGE_MS`, the `delivery`/`provider_batch_id` fields on `BatchRow`,
      the `planned`/`submitting`/`submitted` members of the status union, and those
      three statuses from `OUTSTANDING_SQL`.
- [x] `batches.ts` — simplify the **six** `CASE WHEN delivery = 'batch' THEN 'planned' ELSE 'pending' END`
      expressions (lines ~473, 530, 552, 583, 606, 655) to plain `'pending'`.
      These are in the Sarvam fallback/requeue paths, so verify each one still
      returns units to the Claude sync path correctly.
- [x] [`src/lib/billing/meter.ts`](../src/lib/billing/meter.ts) — remove the
      `batchApi?: boolean` option and stop writing `usage_events.batch_api`.
- [x] [`src/lib/sarvam/client.ts`](../src/lib/sarvam/client.ts) — the comment at line 75
      references `BATCH_API_ENABLED` as a precedent; reword.

### 1b. Schema (two deploys — respects the additive-migrations rule)

`docs/deploying-changes.md` requires migrations be backward-compatible so a code
rollback never meets a schema it can't handle. Dropping columns in the same deploy
that stops using them violates that.

- [x] **Deploy 1:** ship the code above. The columns still exist; nothing writes them.
- [ ] **Deploy 2** (after Deploy 1 is confirmed stable): `migrations/028_drop_batch_api.sql`
      — drop `job_batches.delivery`, `job_batches.provider_batch_id`,
      `usage_events.batch_api`, and indexes `idx_job_batches_provider`,
      `idx_job_batches_planned`.
- [ ] Pre-flight check before Deploy 2:
      `SELECT count(*) FROM job_batches WHERE status IN ('planned','submitting','submitted');`
      must be `0`. If not, those jobs are wedged and need reverting to `pending` first.

### 1c. Config

- [x] Remove `BATCH_API_ENABLED` / `BATCH_API_MIN_PAGES` from any env file on the box.

---

## Phase 2 — Billing correctness

### 2a. 🔴 The yearly plan is a 12× underdelivery bug

`subscription.charged` fires **once per billing cycle**. For a yearly plan that is
**once a year** — and [`webhook/route.ts:126`](../src/app/api/payments/webhook/route.ts)
grants `PLAN_CREDITS.monthly` (1,000) with `periodEnd` one year out.

| Plan | Pays | Receives |
|---|---|---|
| Monthly @ ₹2,000 | ₹24,000/yr | 12,000 credits |
| Yearly @ ₹20,000 | ₹20,000/yr | **1,000 credits** |

A yearly subscriber gets one month of allowance for a year of money. This ships
refund demands on day one. Note `PLAN_CREDITS.yearly` exists but is never read —
the webhook always uses `.monthly`.

- [x] Add a **monthly refill for active yearly subscribers**: a cron that grants
      `PLAN_CREDITS.monthly` on each monthly anniversary, keyed idempotently per
      `(subscription_id, month_index)` so retries can't double-grant or reset
      mid-cycle usage. Reuse the existing `grant({ type: "monthly_reset", idempotencyKey })`
      contract — it already handles exactly this.
- [x] Either wire `PLAN_CREDITS.yearly` up or delete it; a constant nothing reads is a trap.
- [ ] Backfill any yearly subscribers who already exist (likely zero pre-launch).

### 2b. Pricing constants

- [ ] Razorpay: create/point `RAZORPAY_PLAN_MONTHLY` at a **₹2,000** plan.
- [ ] Razorpay: create/point `RAZORPAY_PLAN_YEARLY` at a **₹20,000** plan.
- [ ] Confirm GST is configured **on both Razorpay plans** (18% on top of the listed price).

### 2c. GST on top-ups — add 18% server-side

[`credits/order/route.ts:28`](../src/app/api/payments/credits/order/route.ts) charges
`tier.priceInr` flat. `TopupTier.priceInr` is documented as *"ex-GST; Razorpay adds
GST per the plan config"* — but that only holds for **subscription plans**. A
one-time Order has no plan config, so today top-ups undercharge tax.

- [x] Add a `GST_RATE = 0.18` to [`billing/cost.ts`](../src/lib/billing/cost.ts).
- [x] [`createCreditOrder`](../src/lib/razorpay.ts) charges `Math.round(amountInr * 100)`
      paise — change the caller to pass the GST-inclusive total. Credits are read from
      the order's server-set `notes.credits` and are **independent of the amount**, so
      the granted credits are unaffected. Verify this holds after the change.
- [x] ⚠️ [`credits/verify/route.ts:49`](../src/app/api/payments/credits/verify/route.ts)
      records `amountInr = order.amount / 100` into `credit_transactions.amount_inr`.
      Once GST is included that column becomes the **gross** figure, which would silently
      inflate every margin calculation built on it. Record the **base (ex-GST)** amount
      there, or add a separate tax column.
- [x] `TopUpModal` must show the breakdown: base + 18% GST + total. Charging more than
      the displayed price is its own complaint category.

### 2d. Retire the dead free-tier quota

`checkQueryLimit` and `incrementQueryCount` in [`src/lib/auth.ts`](../src/lib/auth.ts)
have **zero callers** — the 5-query limit is not enforced. Credits are the real gate.

- [x] Delete both functions.
- [x] Remove the `queries_used_total / 5` widget at
      [`account/page.tsx:386`](../src/app/(protected)/account/page.tsx) — it displays a
      counter that never increments. Replace with the real credit balance (Phase 3).
- [x] Leave the `users.queries_used_total` column (additive-only rule); drop later.

---

## Phase 3 — Make credits usable (the biggest gap)

Today: no balance display, no low-balance warning, **no way to buy credits**, and
four endpoints returning `402` that no client handles.
[`TopUpModal.tsx`](../src/components/chat/TopUpModal.tsx) is fully built and mounted
nowhere; [`useCredits.ts`](../src/hooks/useCredits.ts) is imported only by it.

### 3a. Shared credits context

- [x] Add a `CreditsProvider` in [`(protected)/layout.tsx`](../src/app/(protected)/layout.tsx)
      exposing `{ credits, refresh, openTopUp }`, alongside the existing `ChatContext`.
      That layout wraps chat, workspace, translate, ocr, judgments, and account —
      one mount point covers every billable surface.

### 3b. Balance meter

- [x] Render a `<CreditMeter />` on the right of the existing protected-layout header
      (the bar with the hamburger + logo). Shows remaining credits; turns amber below
      a low-balance threshold; clicking opens the top-up modal.

### 3c. Mount the top-up modal

- [x] Mount `TopUpModal` once in the protected layout, driven by context state.
- [x] Wire `onSuccess` → `refresh()` and re-check locked outputs (`unlockOutputs`
      already runs server-side on top-up).

### 3d. Handle 402 everywhere

[`useChat.ts:322`](../src/hooks/useChat.ts) handles `403 / "limit_reached"` → `UpgradeModal`.
It does **not** handle `402`, which is what the credit system actually returns.

- [x] `useChat` — on `402`, open the top-up modal (not the upgrade modal).
- [x] Same for the workspace conversation, translate, and OCR upload paths.
- [x] Distinguish the two prompts: a free user hitting `402` should see *upgrade to Pro*;
      a Pro user who has drained the pool should see *buy a top-up*.
- [x] Surface `output_locked` on translate/OCR results — jobs already lock their output
      when the wallet goes negative, and the UI has no affordance explaining why.

### 3e. Account page

- [x] Show plan, credit balance, period end, and top-up history.

---

## Phase 4 — Copy, legal, and contact

### 4a. Pricing copy must match the pool model

- [x] [`PricingTeaser.tsx`](../src/components/landing/PricingTeaser.tsx) — ₹2,000/mo;
      remove "unlimited"; describe the 1,000-credit monthly pool; update the yearly
      price and the "Save ₹X" line.
- [x] [`FAQ.tsx:36`](../src/components/landing/FAQ.tsx) — free tier is **100 credits**
      (one-time, no reset), not "5 free chats"; Pro is a credit pool, not unlimited.
- [x] [`Comparison.tsx`](../src/components/landing/Comparison.tsx),
      [`Hero.tsx`](../src/components/landing/Hero.tsx),
      [`FinalCTA.tsx`](../src/components/landing/FinalCTA.tsx) — sweep for
      "unlimited" / stale prices.
- [x] Add a plain-language "what is a credit?" explainer. Selling an abstract unit
      without one drives support load and refund requests.

### 4b. 🔴 Terms & Privacy

Both currently render a visible banner reading *"placeholder text… will be replaced
with reviewed Terms of Service before launch."* You cannot charge against these.

- [x] Substantive Terms of Service drafted → [`terms/page.tsx`](../src/app/(public)/terms/page.tsx).
- [x] Substantive Privacy Policy drafted → [`privacy/page.tsx`](../src/app/(public)/privacy/page.tsx),
      naming all seven sub-processors and the real retention windows.
- [ ] **Your review**: resolve the `⟨CONFIRM⟩` markers in both file headers
      (entity name + address, jurisdiction city, hosting region, DPDP grievance
      officer, refund wording, liability cap).
      Must cover DPDP obligations: what is stored, where (Hetzner + Cloudflare R2 +
      Firebase + Anthropic/Voyage/Sarvam as processors), retention, and deletion.
      You process uploaded client documents — privileged material — so the
      sub-processor list and retention policy are the parts that actually matter.
- [ ] Delete both `REVIEW_PENDING` banners — **only after** the review above.
      Deliberately left in: removing the banner is the assertion that the review
      happened, which is yours to make.
- [x] Refund/cancellation terms (Razorpay requires them published) — now a
      section in Terms. Confirm the wording matches what you will honour.

### 4c. Contact email

- [x] Replace `hello@nyayasearch.com` → **`ansh@getlegalbrain.com`** in all 8 places:
      [`error.tsx`](../src/app/(protected)/error.tsx),
      [`account/page.tsx`](../src/app/(protected)/account/page.tsx) (×4 billing-error strings),
      [`terms`](../src/app/(public)/terms/page.tsx), [`privacy`](../src/app/(public)/privacy/page.tsx),
      [`team`](../src/app/(public)/team/page.tsx), [`judgments`](../src/app/(protected)/judgments/page.tsx),
      [`Footer.tsx`](../src/components/landing/Footer.tsx),
      [`PricingTeaser.tsx`](../src/components/landing/PricingTeaser.tsx).
- [ ] Verify that mailbox actually receives mail before launch — it's the recovery
      channel for "I was charged and it failed".

---

## Phase 5 — Launch config & ops

### 5a. 🔴 `/api/cron/process-batches` is not scheduled AT ALL — confirmed on the box

I checked production directly. **Nothing runs it.** This is worse than "untracked config":

```
root crontab            → "no crontab for root"
all user crontabs       → /var/spool/cron/crontabs/ is empty
/etc/cron.d             → certbot, e2scrub_all, sysstat only
systemd timers          → nyayasearch-{backup,disk-alert,rag-retention} only
grep -rl process-batches /etc/systemd/system /etc/cron* /var/spool/cron  → no matches
```

It's declared in `vercel.json` at `* * * * *`, but there is no Vercel runner on Hetzner.
That tick is the **entire engine** for OCR and translation.

Why this hasn't surfaced: there is essentially no traffic. `job_batches` is **empty**,
and there are exactly **1 OCR job and 1 translation job ever**, both from 28 June, both
`ready`. The Sarvam end-to-end verification must have been done by invoking the endpoint
by hand, which works fine and hides the missing timer.

**Consequence at launch:** the first real upload sits in `pending` forever. It won't even
fail cleanly — the 30-minute stale-job watchdog lives *inside* `process-batches`, so the
job never gets failed and the UI spins indefinitely with no error.

- [x] Add `deploy/systemd/nyayasearch-process-batches.service` + `.timer`
      (`OnUnitActiveSec=60`, `Persistent=false`), calling
      `scripts/cron-tick.sh /api/cron/process-batches`.
- [x] Add it to the enable list in [`bootstrap-box.sh`](../scripts/bootstrap-box.sh).
- [x] Add it to the timer check in [`verify-prod.sh`](../scripts/verify-prod.sh).
- [ ] **Test with a real multi-page upload before launch.** This path has never run
      unattended.

### 5a-bis. ✅ Not a bug — `User=deploy` is an adapted placeholder

Initially flagged as drift: the repo templates say `User=deploy`, no such user exists,
and the installed units say `User=root`. On inspection
[`bootstrap-box.sh:61`](../scripts/bootstrap-box.sh) sed-rewrites both `User=` and
`WorkingDirectory=` to the box's actual values, so the repo version is an intentional
placeholder and a fresh bootstrap is correct. No action needed — the new
process-batches unit just follows the same single-line `Key=value` convention so the
substitution keeps working.

### 5b. Env template + verification gaps

[`.env.production.local.example`](../.env.production.local.example) is missing keys
that are live in prod, and `verify-prod.sh` doesn't check them.

- [x] Add to the template: `SARVAM_API_KEY`, `SARVAM_OCR_ENABLED`, `BILLING_ENFORCE`.
- [x] Add to `verify-prod.sh`'s secret checklist: `SARVAM_API_KEY`.
- [x] Add an explicit `verify-prod.sh` check that **`BILLING_ENFORCE=on`** — its default
      is shadow mode (usage recorded, wallet never debited, nobody blocked). Launching
      without it means serving Sonnet traffic for free indefinitely, and the failure is
      completely silent.

### 5c. Enforcement cutover

- [ ] Flip `BILLING_ENFORCE=on` **only after Phase 3 ships**. Enforcing before users
      can buy credits just produces dead ends.
- [ ] Give your own account `unlimited_credits = true` before the flip.

### 5d. Observability

- [ ] Build a staff UI for [`/api/admin/errors`](../src/app/api/admin/errors/route.ts).
      The API is done — filters, pagination, staff-gated. Nothing calls it. Right now
      you'd debug launch day with `curl`.
- [ ] Add analytics (PostHog/Mixpanel). There is currently **none** — you will launch
      blind on signup → activation → conversion.
- [ ] Confirm `ALERT_WEBHOOK_URL` fires: disk alert, backup failure, batch backlog.

---

## Phase 6 — Cleanup

Verified orphans (built from the full import graph, not grep):

- [x] Delete [`src/lib/rag/registry.ts`](../src/lib/rag/registry.ts) — never imported,
      and it reads `pipeline/data/` at module init.
- [x] Delete [`src/components/ui/Card.tsx`](../src/components/ui/Card.tsx) and
      [`ui/Select.tsx`](../src/components/ui/Select.tsx) — never imported.
- [x] Delete [`nginx/nyayasearch.conf`](../nginx/nyayasearch.conf) — stale duplicate of
      `deploy/nginx/`, still says `server_name yourdomain.com`.
- [x] Delete `vercel.json` and `.vercel/` — both crons are inert on Hetzner. Keeping
      them is what made 5a easy to miss. (Also drop the now-stale `.vercelignore`.)
- [x] Delete `public/next.svg`, `vercel.svg`, `file.svg`, `globe.svg`, `window.svg`.
- [x] Delete `legal_brain_favicon.png` — a **2.2 MB** unreferenced PNG at repo root,
      the largest tracked file by 5×. `src/app/icon.png` is the real favicon.
- [x] Rewrite [`README.md`](../README.md) — still verbatim create-next-app boilerplate
      ending in "Deploy on Vercel".
- [x] Fix the ESLint warning: unused `isPro` at `account/page.tsx:282`.
- [x] Rename one of the two `019_` migrations (`019_translation_result.sql` /
      `019_workspace_conversations.sql`) — the ledger keys on filename so it works, but
      the next person will assume 019 is taken. Rename **only** if you also update the
      `schema_migrations` row; otherwise just document it.
- [ ] Move the 13 GB of CSVs out of the working directory (gitignored, but heavy).

---

## Phase 7 — Hardening (nice-to-have, not blocking)

- [x] `/api/errors/report` is unauthenticated and writes to Postgres with no per-IP cap
      beyond nginx's 30r/s. Trivial to fill `error_logs`. Add a guard.
- [ ] `/api/filters/options` is the only unauthenticated data route — it dumps the
      judge/court/act taxonomy. Probably fine; know that it's public.
- [x] No `robots.txt`, `sitemap.ts`, `metadataBase`, or OpenGraph tags. Every shared
      link renders bare. Cheap to fix, matters for an SEO-led product.
- [ ] Confirm certbot added HSTS (`verify-prod.sh` warns if missing).

---

## Suggested sequencing

| Deploy | Contents | Gate |
|---|---|---|
| **1** | Phase 0 + Phase 1a/1c + Phase 6 | tests + `tsc` + `verify-prod.sh` green |
| **2** | Phase 5a/5b (schedulers + env template) | timers active on the box |
| **3** | Phase 2 (yearly bug, pricing, GST) | Razorpay plans confirmed live-mode |
| **4** | Phase 3 (credit UX) | manual buy-a-top-up run end to end |
| **5** | Phase 4 (copy + legal) | your Terms/Privacy review done |
| **6** | Phase 1b (drop columns) + `BILLING_ENFORCE=on` | Deploy 1 stable; zero rows in batch statuses |

**Hard gate before taking money:** reviewed Terms + Privacy live, top-up flow proven
end to end with a real card, `BILLING_ENFORCE=on` verified, the yearly credit refill
fixed, and **a real multi-page document processed start-to-finish on the new timer**.

## Resolved

1. ~~Yearly price~~ → **₹20,000/yr**, "save ₹4,000".
2. ~~GST on top-ups~~ → **add 18% server-side** (see 2c, incl. the ledger caveat).
3. ~~Existing crontab on the box?~~ → **No. Nothing schedules `process-batches` at all.**
   Verified directly against production; see 5a. Also surfaced the `User=deploy` drift (5a-bis).
4. ~~Legal review owner~~ → **Ansh**, self-reviewed, so Phase 4b is not gated on an
   external party and can move earlier if convenient.
