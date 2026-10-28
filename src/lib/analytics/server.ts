/**
 * Mixpanel ingestion — server-side, via the official `mixpanel` Node SDK.
 *
 * Everything that matters (signup, payments, messages, job outcomes) is emitted
 * from here rather than the browser: server events can't be blocked by an
 * extension, lost to a closed tab, or forged by a client.
 *
 * Fire-and-forget by construction: `track()` returns void and every failure path
 * is swallowed. Analytics must never break, slow, or fail a user request.
 */
import Mixpanel from "mixpanel";
import pool from "../db";
import { logError } from "../error-logger";
import type { EventName } from "./events";
import type { SearchFilters } from "@/types";

/**
 * Regional ingestion host — a BARE HOSTNAME, not a URL (the SDK builds the URL
 * from `protocol` + `host` + `path`). Mixpanel keeps EU and India projects on
 * separate endpoints; use the one matching where the project was created, and
 * keep it identical to the browser SDK's host so both halves of a funnel land
 * in the same project:
 *   US      api.mixpanel.com      (default)
 *   EU      api-eu.mixpanel.com
 *   India   api-in.mixpanel.com
 * The env var is accepted in either form so a full URL doesn't quietly break it.
 */
function resolveHost(): string {
  const raw = (process.env.MIXPANEL_API_HOST || "api.mixpanel.com").trim();
  return raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

const TOKEN = process.env.MIXPANEL_TOKEN?.trim();

/**
 * One client per process. Under pm2 cluster mode each worker builds its own,
 * which is fine — the SDK holds no cross-request state for `track()`; it issues
 * one request per call rather than buffering, so a worker being recycled can't
 * strand queued events (the reason to avoid `track_batch` here).
 */
const client = TOKEN
  ? Mixpanel.init(TOKEN, {
      host: resolveHost(),
      // Never geolocate from the server's IP — every user would appear to be in
      // the Hetzner datacentre. Location, where it matters, comes from the
      // browser SDK. This is the SDK default; set explicitly so it survives an
      // upgrade that changes the default.
      geolocate: false,
      keepAlive: true,
    })
  : null;

export interface TrackOptions {
  /** Our internal users.id. Stable across devices and sessions. */
  userId: number | null;
  /** Primitives, Dates, or flat lists of primitives — see sanitize(). */
  properties?: Record<string, unknown>;
  /**
   * Deduplication key. Mixpanel drops repeat $insert_ids for ~5 days, which is
   * what makes it safe to emit from a retried webhook or a re-run cron tick.
   */
  insertId?: string;
  /**
   * The browser's Mixpanel $device_id. When set, the event carries both
   * $device_id and $user_id, which merges that device's anonymous history into
   * the user (Simplified ID Merge). Only the signup/sign-in events need it.
   */
  deviceId?: string | null;
}

/**
 * Mixpanel truncates every string property at 255 (bytes, per its type docs —
 * so fewer characters for Devanagari). Cut it ourselves so the truncation point
 * is predictable, and use this for any free text: questions, answers, names.
 */
export const PROPERTY_MAX_CHARS = 255;

export function preview(text: string | null | undefined, max = PROPERTY_MAX_CHARS): string | null {
  if (!text) return null;
  const t = text.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Search filters as flat `filter_*` properties — one per field, so "which
 * filters do people actually use" is a plain breakdown. Shared by research
 * chat and judgment search so the two report filters identically.
 */
export function filterProperties(filters: SearchFilters | null | undefined): Record<string, unknown> {
  const f = filters ?? {};
  const used = Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return {
    filters_used: used.map(([k]) => k),
    filter_count: used.length,
    filter_court: f.court,
    filter_year_from: f.yearFrom,
    filter_year_to: f.yearTo,
    filter_citation: f.citation,
    filter_petitioner: f.extractedPetitioner,
    filter_respondent: f.extractedRespondent,
    filter_case_category: f.caseCategory,
    filter_case_number: f.caseNumber,
    filter_judge: f.judgeName,
    filter_act_cited: f.actCited,
    filter_keyword: f.keyword,
  };
}

/**
 * The user's current account state, read once per event. It does two jobs:
 * stamps plan/credits onto the event itself (so any report can be broken down
 * by them without a profile join), and refreshes the whole Mixpanel profile —
 * which is what keeps "credits remaining" and "plan" current without every
 * call site having to remember to update the profile after it changes them.
 */
interface AccountSnapshot {
  event: Record<string, unknown>;
  profile: Record<string, unknown>;
}

async function readAccount(userId: number): Promise<AccountSnapshot | null> {
  const { rows } = await pool.query(
    `SELECT u.email, u.display_name, u.photo_url, u.phone, u.plan,
            u.subscription_status, u.subscription_end_date, u.comped_plan,
            u.unlimited_credits, u.is_staff, u.referral_source, u.referral_detail,
            u.onboarded_at, u.razorpay_customer_id, u.razorpay_subscription_id,
            u.firebase_uid, u.created_at,
            b.plan_credits, b.topup_credits, b.period_end
       FROM users u
       LEFT JOIN credit_balances b ON b.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  const r = rows[0];
  if (!r) return null;
  const planCredits = Number(r.plan_credits ?? 0);
  const topupCredits = Number(r.topup_credits ?? 0);
  const remaining = planCredits + topupCredits;
  return {
    event: {
      user_email: r.email,
      user_name: r.display_name,
      plan: r.plan,
      subscription_status: r.subscription_status,
      credits_remaining: remaining,
      unlimited_credits: r.unlimited_credits === true,
    },
    profile: {
      $email: r.email,
      $name: r.display_name,
      $phone: r.phone,
      $avatar: r.photo_url,
      $created: r.created_at,
      user_id: userId,
      firebase_uid: r.firebase_uid,
      plan: r.plan,
      subscription_status: r.subscription_status,
      subscription_end_date: r.subscription_end_date,
      comped_plan: r.comped_plan === true,
      unlimited_credits: r.unlimited_credits === true,
      is_staff: r.is_staff === true,
      referral_source: r.referral_source,
      referral_detail: r.referral_detail,
      onboarded_at: r.onboarded_at,
      razorpay_customer_id: r.razorpay_customer_id,
      razorpay_subscription_id: r.razorpay_subscription_id,
      credits_remaining: remaining,
      plan_credits: planCredits,
      topup_credits: topupCredits,
      credit_period_end: r.period_end,
      last_event_at: new Date(),
    },
  };
}

/** Record an event. Never throws, never blocks, never awaited by callers. */
export function track(event: EventName, opts: TrackOptions): void {
  if (!client) return;
  void (async () => {
    let account: AccountSnapshot | null = null;
    if (opts.userId != null) {
      try {
        account = await readAccount(opts.userId);
      } catch {
        // The event still goes out, just without the account stamp.
      }
    }
    try {
      client.track(
        event,
        {
          // Mixpanel requires distinct_id; an anonymous event still has counting
          // value, so send a stable sentinel rather than dropping it.
          distinct_id: opts.userId != null ? String(opts.userId) : "anonymous",
          ...(opts.insertId ? { $insert_id: opts.insertId } : {}),
          ...(opts.deviceId && opts.userId != null
            ? { $device_id: opts.deviceId, $user_id: String(opts.userId) }
            : {}),
          ...sanitize(account?.event),
          // Call-site properties win: an event that knows the balance *after*
          // its own debit, say, is more precise than the snapshot.
          ...sanitize(opts.properties),
        },
        (err) => {
          if (err) report(err.message, { event });
        }
      );
      if (account && opts.userId != null) identify(opts.userId, account.profile);
    } catch (err) {
      // The SDK can throw synchronously on a malformed payload; that must not
      // propagate into the request that happened to trigger it.
      report(err instanceof Error ? err.message : String(err), { event });
    }
  })();
}

/** Set profile properties (Mixpanel "People"). */
export function identify(userId: number, properties: Record<string, unknown>): void {
  if (!client) return;
  try {
    client.people.set(String(userId), sanitize(properties), (err) => {
      if (err) report(err.message, { kind: "people.set" });
    });
  } catch {
    // Profile enrichment is strictly best-effort — events already carry what a
    // funnel needs.
  }
}

/** Set profile properties only if they've never been set (first-touch facts). */
export function setOnce(userId: number, properties: Record<string, unknown>): void {
  if (!client) return;
  try {
    client.people.set_once(String(userId), sanitize(properties), (err) => {
      if (err) report(err.message, { kind: "people.set_once" });
    });
  } catch {
    /* best effort */
  }
}

/** Add to numeric profile counters (lifetime questions, revenue, …). */
export function increment(userId: number, counters: Record<string, number>): void {
  if (!client) return;
  try {
    client.people.increment(String(userId), counters, (err) => {
      if (err) report(err.message, { kind: "people.increment" });
    });
  } catch {
    /* best effort */
  }
}

/**
 * Normalise properties into what Mixpanel stores well: drop null/undefined,
 * turn Dates (and pg timestamps) into ISO strings, cut strings at the
 * property limit, and keep lists only when flat — a list of cited case names
 * is useful, a nested object is not queryable and gets dropped.
 *
 * `$`-prefixed keys pass through because that's how Mixpanel's own reserved
 * properties ($email, $created, $insert_id) are spelled.
 */
const MAX_LIST_ITEMS = 50;

function sanitizeValue(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  const t = typeof v;
  if (t === "string") return preview(v as string) ?? undefined;
  if (t === "number") return Number.isFinite(v) ? v : undefined;
  if (t === "boolean") return v;
  return undefined;
}

function sanitize(props?: Record<string, unknown>): Record<string, unknown> {
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const items = v
        .slice(0, MAX_LIST_ITEMS)
        .map(sanitizeValue)
        .filter((x) => x !== undefined);
      out[k] = items;
      continue;
    }
    const clean = sanitizeValue(v);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

// Analytics failures are operational noise, not user-facing incidents. Report at
// most one per minute so a Mixpanel outage can't flood error_logs — which is
// exactly the table the staff error view needs to stay readable.
let lastReportAt = 0;
const REPORT_INTERVAL_MS = 60_000;

function report(message: string, metadata: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastReportAt < REPORT_INTERVAL_MS) return;
  lastReportAt = now;
  logError({
    category: "fetching",
    message: `Analytics: ${message} (check MIXPANEL_TOKEN and that MIXPANEL_API_HOST matches the project's region)`,
    severity: "warning",
    metadata,
  });
}
