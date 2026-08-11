import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { track } from "@/lib/analytics/server";
import { CLIENT_ALLOWED, type EventName } from "@/lib/analytics/events";

/**
 * POST /api/analytics/event — the browser's only route into analytics.
 *
 * Exists so the Mixpanel token stays server-side and so the set of events a
 * client can produce is a closed allowlist. Without that, anyone could POST
 * `subscription_activated` and poison the revenue funnel; with it, the worst a
 * forged request can do is inflate a click count.
 *
 * The user is resolved from the session rather than trusted from the body, so a
 * client cannot attribute its clicks to somebody else's account.
 */

export const dynamic = "force-dynamic";

/** Cap what a single event may carry — clicks need very little. */
const MAX_PROPS = 10;
const MAX_STRING_LEN = 200;

export async function POST(request: NextRequest) {
  // Always answer 204. The browser can do nothing useful with an analytics
  // error, and sendBeacon ignores the response entirely.
  const ok = () => new NextResponse(null, { status: 204 });

  try {
    const body = await request.json();
    const event = String(body?.event ?? "");
    if (!CLIENT_ALLOWED.has(event)) return ok();

    const decoded = await verifyAuth(request);
    const userId = decoded
      ? (await getRequestUser({ uid: decoded.uid, email: decoded.email })).id
      : null;

    track(event as EventName, {
      userId,
      properties: { ...clean(body?.properties), source: "client" },
    });
    return ok();
  } catch {
    return ok();
  }
}

/**
 * Primitives only, bounded in count and length. The allowlist already stops
 * forged *events*; this stops a forged event from smuggling a large or
 * structured *payload* into the analytics store.
 */
function clean(props: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (n >= MAX_PROPS) break;
    if (typeof v === "string") out[k] = v.slice(0, MAX_STRING_LEN);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else continue;
    n++;
  }
  return out;
}
