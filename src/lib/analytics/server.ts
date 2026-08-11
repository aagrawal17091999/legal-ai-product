/**
 * Mixpanel ingestion — server-side.
 *
 * Everything that matters (signup, payment, messages, job outcomes, errors) is
 * emitted from here rather than the browser: server events can't be blocked by
 * an extension, lost to a closed tab, or forged by a client. The browser only
 * sends clicks, via /api/analytics/event, and only from an allowlist.
 *
 * No SDK. Mixpanel's /track endpoint is a plain HTTP POST and the `mixpanel`
 * npm package would drag in its own queueing and process-exit handling that
 * fights pm2 cluster mode. A `fetch` is the whole integration.
 *
 * Fire-and-forget by construction: `track()` returns void and every failure
 * path is swallowed. Analytics must never break, slow, or fail a user request.
 */
import { logError } from "../error-logger";
import type { EventName } from "./events";

/**
 * Regional ingestion host. Mixpanel keeps EU and India projects on separate
 * endpoints, and sending to the wrong one silently drops every event (the API
 * still returns 200). Must match where the project was created:
 *   US      https://api.mixpanel.com      (default)
 *   EU      https://api-eu.mixpanel.com
 *   India   https://api-in.mixpanel.com
 */
const API_HOST = (process.env.MIXPANEL_API_HOST || "https://api.mixpanel.com").replace(/\/$/, "");
const TOKEN = process.env.MIXPANEL_TOKEN?.trim();

/** Analytics is optional: with no token configured every call is a no-op. */
export function isAnalyticsEnabled(): boolean {
  return Boolean(TOKEN);
}

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

/**
 * Record an event. Never throws, never blocks, never awaited by callers.
 */
export function track(event: EventName, opts: TrackOptions): void {
  if (!TOKEN) return;
  void send(event, opts).catch(() => {
    // send() already handles its own reporting; this catch exists so an
    // unexpected throw can't surface as an unhandled rejection and take down
    // the worker.
  });
}

async function send(event: EventName, opts: TrackOptions): Promise<void> {
  const payload = [
    {
      event,
      properties: {
        token: TOKEN,
        // Mixpanel requires distinct_id; an anonymous event still has value for
        // counting, so send a stable sentinel rather than dropping it.
        distinct_id: opts.userId != null ? String(opts.userId) : "anonymous",
        time: Date.now(),
        ...(opts.insertId ? { $insert_id: opts.insertId } : {}),
        ...sanitize(opts.properties),
      },
    },
  ];

  try {
    const res = await fetch(`${API_HOST}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify(payload),
      // Don't let a slow analytics endpoint hold a worker slot.
      signal: AbortSignal.timeout(5_000),
    });
    // Mixpanel answers "1"/"0" with HTTP 200 either way, so a non-OK status is
    // a transport problem and a "0" body is a rejected payload (bad token,
    // wrong region). Both are silent data loss, so surface them once as a
    // warning rather than letting the funnel quietly stay empty.
    if (!res.ok) {
      report(`Mixpanel /track HTTP ${res.status}`, { event });
      return;
    }
    const body = (await res.text()).trim();
    if (body === "0") {
      report("Mixpanel rejected the payload (check MIXPANEL_TOKEN and MIXPANEL_API_HOST region)", {
        event,
      });
    }
  } catch (err) {
    report(err instanceof Error ? err.message : String(err), { event });
  }
}

/**
 * Drop null/undefined and refuse anything that isn't a primitive. This is the
 * mechanical half of the privacy rule: an object or array is how a document
 * excerpt or a query string would accidentally reach Mixpanel.
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

// Analytics failures are operational noise, not user-facing incidents. Report
// at most one per minute so a Mixpanel outage can't flood error_logs — which is
// exactly the table the staff error view needs to stay readable.
let lastReportAt = 0;
const REPORT_INTERVAL_MS = 60_000;

function report(message: string, metadata: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastReportAt < REPORT_INTERVAL_MS) return;
  lastReportAt = now;
  logError({
    category: "fetching",
    message: `Analytics: ${message}`,
    severity: "warning",
    metadata,
  });
}

/**
 * Set profile properties on a user (Mixpanel "People"). Used at signup and when
 * a plan changes, so cohorts can be built on plan without joining every event.
 */
export function identify(
  userId: number,
  properties: Record<string, unknown>
): void {
  if (!TOKEN) return;
  void (async () => {
    try {
      await fetch(`${API_HOST}/engage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/plain" },
        body: JSON.stringify([
          {
            $token: TOKEN,
            $distinct_id: String(userId),
            $set: sanitize(properties),
          },
        ]),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Profile enrichment is strictly best-effort; events already carry the
      // properties needed to analyse a funnel without it.
    }
  })();
}
