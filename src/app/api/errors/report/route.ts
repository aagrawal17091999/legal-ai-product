import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/lib/error-logger";

/**
 * POST /api/errors/report — client-side error reporting.
 *
 * Deliberately unauthenticated: the errors most worth catching are the ones that
 * break sign-in or crash the app before a session exists. But an open endpoint
 * that writes a row per call is a free way to fill `error_logs`, so it is rate
 * limited per IP in memory.
 *
 * In-memory is the right scope here. Under pm2 cluster mode each worker keeps
 * its own counter, so the effective ceiling is LIMIT × instances — still three
 * orders of magnitude below what an abuser wants, with no Redis to operate. The
 * nginx `general` zone (30r/s) is the outer bound; this is the per-reporter one.
 */

const WINDOW_MS = 60_000;
const LIMIT = 20; // reports per IP per minute
/** Stop the map itself becoming the memory leak it is meant to prevent. */
const MAX_TRACKED_IPS = 10_000;

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || entry.resetAt <= now) {
    // Opportunistic sweep of expired entries, amortised over normal traffic.
    if (hits.size >= MAX_TRACKED_IPS) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      // Still full: every entry is live, so this is a distributed flood. Drop
      // the report rather than growing without bound.
      if (hits.size >= MAX_TRACKED_IPS) return true;
    }
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > LIMIT;
}

/** Client IP as seen behind nginx, which sets X-Forwarded-For. */
function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: NextRequest) {
  // Report the 429 honestly, but never log it — logging a rate-limit breach
  // would write the very rows the limit exists to prevent.
  if (rateLimited(clientIp(request))) {
    return NextResponse.json({ error: "Too many reports" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { message, stack, metadata } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    logError({
      category: "frontend",
      message: message.slice(0, 2000),
      severity: "error",
      metadata: {
        stack: typeof stack === "string" ? stack.slice(0, 5000) : undefined,
        userAgent: request.headers.get("user-agent"),
        // Caller-supplied and unvalidated, so keep it last: it can add context
        // but must not overwrite the fields above.
        ...(metadata && typeof metadata === "object" ? metadata : {}),
      },
    });

    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
