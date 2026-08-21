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
import { logError } from "../error-logger";
import type { EventName } from "./events";

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
  /** Counts, durations, ids, enums, booleans. NEVER user content — see events.ts. */
  properties?: Record<string, unknown>;
  /**
   * Deduplication key. Mixpanel drops repeat $insert_ids for ~5 days, which is
   * what makes it safe to emit from a retried webhook or a re-run cron tick.
   */
  insertId?: string;
}

/** Record an event. Never throws, never blocks, never awaited by callers. */
export function track(event: EventName, opts: TrackOptions): void {
  if (!client) return;
  try {
    client.track(
      event,
      {
        // Mixpanel requires distinct_id; an anonymous event still has counting
        // value, so send a stable sentinel rather than dropping it.
        distinct_id: opts.userId != null ? String(opts.userId) : "anonymous",
        ...(opts.insertId ? { $insert_id: opts.insertId } : {}),
        ...sanitize(opts.properties),
      },
      (err) => {
        if (err) report(err.message, { event });
      }
    );
  } catch (err) {
    // The SDK can throw synchronously on a malformed payload; that must not
    // propagate into the request that happened to trigger it.
    report(err instanceof Error ? err.message : String(err), { event });
  }
}

/**
 * Set profile properties (Mixpanel "People"), so cohorts can be built on plan
 * without joining every event.
 */
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

/**
 * Drop null/undefined and refuse anything that isn't a primitive. This is the
 * mechanical half of the privacy rule: an object or array is how a document
 * excerpt or a query string would accidentally reach Mixpanel.
 *
 * `$`-prefixed keys are allowed through because that's how Mixpanel's own
 * reserved properties ($email, $created, $insert_id) are spelled.
 */
function sanitize(props?: Record<string, unknown>): Record<string, unknown> {
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") out[k] = v;
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
