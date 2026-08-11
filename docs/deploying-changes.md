# How to Deploy Changes to Production

**Short answer: pushing to GitHub is NOT a deploy.** The Hetzner box does not auto-pull.
A deploy is always: **push to GitHub → SSH into the box → pull + build + reload.**

```
Your laptop  ──git push──►  GitHub (main)  ──(does NOT auto-deploy)──►  Hetzner box
                                                                          ▲
                                          you SSH in and run deploy.sh ───┘
```

Production runs on the Hetzner box at `204.168.160.193` (`getlegalbrain.com`):
Next.js under pm2 (cluster mode) + Postgres, behind nginx. There is no Vercel.

---

## The normal case: you changed code

1. **Commit & push** your change to `main` (from your laptop).
2. **SSH into the box:**
   ```bash
   ssh root@204.168.160.193
   ```
3. **Deploy:**
   ```bash
   cd /opt/legal-ai-product
   bash scripts/deploy.sh
   ```

`deploy.sh` does all of this in order, and stops if any step fails:
`git fetch + checkout main → npm ci → npm run build → run DB migrations → pm2 reload → tag the release`.
The `pm2 reload` is zero-downtime (cluster mode), so in-flight chat streams survive.

4. **Verify** it actually went live:
   ```bash
   bash scripts/verify-prod.sh
   curl -I https://getlegalbrain.com/api/health     # expect 200
   ```

That's it for code changes.

---

## If you changed environment variables / secrets

Secrets are **NOT in git** — they live only in `/opt/legal-ai-product/.env.production.local`
on the box. So you edit that file directly on the box; a `git pull` never touches it.

```bash
ssh root@204.168.160.193
cd /opt/legal-ai-product
nano .env.production.local          # edit with KEY=value  (NEVER "KEY - value")
```
Then how you apply it depends on the variable:

- **`NEXT_PUBLIC_*` variable** (Firebase keys, Razorpay key id, app URL): these are **baked
  into the browser bundle at build time**, so you MUST rebuild:
  ```bash
  NODE_ENV=production npm run build && pm2 reload nyayasearch --update-env
  ```
- **Server-only variable** (DB URL, API keys, webhook secret, plan IDs): a restart is enough:
  ```bash
  pm2 reload nyayasearch --update-env
  ```
When unsure, just rebuild — it's always safe.

---

## If you changed the database schema

Add a new numbered file in `migrations/` (e.g. `024_add_column.sql`). Make it
**additive / backward-compatible** (add column → backfill → switch reads → drop later)
so a rollback never hits a schema it can't handle. `deploy.sh` runs it automatically
(via `scripts/migrate.sh`, which applies each file exactly once).

---

## Rolling back a bad deploy

Every production deploy is auto-tagged `prod-<timestamp>`. To go back:
```bash
cd /opt/legal-ai-product
git tag | grep prod- | tail -5        # find the last good tag
REF=prod-20260705-120000 bash scripts/deploy.sh
```
Remember: code rolls back, but **migrations do not** — that's why they must be additive.

---

## Golden rules (learned the hard way)

1. **Secrets never go in git.** Not in code, not in `.env.production.local.example`,
   nowhere tracked. Only in `.env.production.local` on the box (`chmod 600`).
2. **Never `source` an env file into your shell** (no `set -a; source .env...` in
   `.bashrc`). Exported vars become `process.env`, which overrides every `.env` file at
   build and runtime — this silently ships the wrong config. The app reads
   `.env.production.local` on its own; it does not need shell exports.
3. **`NEXT_PUBLIC_*` changes require a rebuild**, not just a reload.
4. **Always verify after deploying** with `scripts/verify-prod.sh` — don't trust that a
   reload happened; trust the check.
5. **The GitHub repo must never contain live secrets.** If one leaks, rotate it.

---

## Quick reference

| I changed… | Do this on the box (after pushing code) |
|---|---|
| Code | `bash scripts/deploy.sh` |
| A `NEXT_PUBLIC_*` env var | edit `.env.production.local` → `npm run build && pm2 reload nyayasearch --update-env` |
| A server-only env var | edit `.env.production.local` → `pm2 reload nyayasearch --update-env` |
| DB schema | add `migrations/NNN_*.sql` → `bash scripts/deploy.sh` |
| Need to undo | `REF=<prod-tag> bash scripts/deploy.sh` |
| nginx / TLS / systemd | edit the file in `deploy/`, copy to the system path, reload that service |
