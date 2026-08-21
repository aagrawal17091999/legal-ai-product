/**
 * Structured JSON logging to stdout/stderr.
 *
 * Why this exists: pm2 captures whatever the app prints, but free-text
 * `console.error("something broke", err)` lines can't be filtered by account or
 * correlated across a request. Grafana Alloy ships these files to Loki, and
 * Loki can only index what arrives as parseable fields — so anything we want to
 * search by has to be a JSON key, not prose.
 *
 * One JSON object per line. Field names are deliberately flat and stable:
 * `deploy/alloy/config.alloy` maps them onto Loki labels and structured
 * metadata by name, so renaming a field here silently breaks queries there.
 *
 * ## What must never go in here
 *
 * No user content — no judgment text, no chat messages, no uploaded documents,
 * no email bodies. Logs leave the box for a third party, and this is a legal
 * product. Ids, counts, durations, enums and booleans only; the same rule
 * `analytics/events.ts` already applies to Mixpanel. `redact()` below strips the
 * obvious credential-shaped keys, but it is a backstop, not a licence.
 */
import { getRequestContext } from "./request-context";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Keys whose values are never printed, whatever the call site passed. */
const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)/i;

/** Longest single field value we'll print, so one bad line can't flood the disk. */
const MAX_VALUE_CHARS = 2_000;

function redact(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]` : value;
  }
  if (value === null || typeof value !== "object") return value;
  // Cycles are real here — Error objects, pg result rows and Next request
  // objects all self-reference. Without this the recursion blows the stack and
  // the whole line is lost to the catch below, which is the one case where you
  // most want to see what was being logged.
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, undefined, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redact(v, k, seen);
  }
  return out;
}

/**
 * Emit one structured line. Never throws: a logger that can take down a request
 * is worse than no logger. Circular references, BigInts and getters that throw
 * are all possible in `fields`, so the serialize step is itself guarded.
 */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  try {
    const ctx = getRequestContext();
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      // Present only inside a request; cron ticks and scripts log without them.
      requestId: ctx?.requestId,
      userId: ctx?.userId ?? undefined,
      endpoint: ctx?.endpoint,
      method: ctx?.method,
      ...(redact(fields) as Record<string, unknown>),
    };
    const json = JSON.stringify(line, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    // Match pm2's own split: warn/error land in <app>-error.log, the rest in
    // <app>-out.log. Alloy scrapes both and labels them by stream.
    if (level === "error" || level === "warn") process.stderr.write(`${json}\n`);
    else process.stdout.write(`${json}\n`);
  } catch {
    // Last resort — a line we can still grep for, with no structure to break.
    try {
      process.stderr.write(`{"level":"error","msg":"logger serialize failed","original":${JSON.stringify(String(msg))}}\n`);
    } catch {
      /* give up rather than throw into the caller */
    }
  }
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
