import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { logError } from "@/lib/error-logger";

const DEFAULT_BASE_URL = "https://app.chatwoot.com";

/**
 * GET /api/support/identity — everything the Chatwoot support widget needs to
 * open as the signed-in user: the inbox's website token, plus the user's
 * identifier and its HMAC so Chatwoot can verify nobody is posing as someone
 * else. Served from here rather than NEXT_PUBLIC_* so the widget can be turned
 * on, off, or re-pointed with a restart instead of a rebuild.
 *
 * Returns { enabled: false } when the widget isn't configured, and the client
 * simply doesn't load it.
 */
export async function GET(request: NextRequest) {
  const websiteToken = process.env.CHATWOOT_WEBSITE_TOKEN;
  const hmacToken = process.env.CHATWOOT_HMAC_TOKEN;
  if (!websiteToken || !hmacToken) {
    return NextResponse.json({ enabled: false });
  }

  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const user = await getRequestUser(decoded);
    // Our users.id, the same id Mixpanel uses, so a support chat can be matched
    // to the user's events.
    const identifier = String(user.id);
    return NextResponse.json({
      enabled: true,
      baseUrl: process.env.CHATWOOT_BASE_URL || DEFAULT_BASE_URL,
      websiteToken,
      identifier,
      identifierHash: createHmac("sha256", hmacToken).update(identifier).digest("hex"),
      email: user.email,
      name: user.display_name || user.email,
      plan: user.plan,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/support/identity",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
