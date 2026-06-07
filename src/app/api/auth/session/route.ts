import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { getOrCreateUser, SESSION_COOKIE } from "@/lib/auth";
import { logError } from "@/lib/error-logger";

// Firebase session cookies can live up to 14 days. The browser cookie and the
// Firebase session share the same lifetime.
const EXPIRES_IN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * POST /api/auth/session
 *
 * Exchanges a freshly-minted Firebase ID token for an httpOnly session cookie.
 * The cookie lets `proxy.ts` make instant, server-side auth redirects (no
 * landing-page flash) and lets same-origin <a> navigations authenticate. We
 * also upsert the user row here — once, at login — so the per-request write in
 * the chat endpoints can go away.
 */
export async function POST(request: NextRequest) {
  let idToken: string | undefined;
  try {
    ({ idToken } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!idToken) {
    return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
  }

  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    await getOrCreateUser({ uid: decoded.uid, email: decoded.email || "" });

    const sessionCookie = await adminAuth().createSessionCookie(idToken, {
      expiresIn: EXPIRES_IN_MS,
    });

    const res = NextResponse.json({ status: "ok" });
    res.cookies.set(SESSION_COOKIE, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(EXPIRES_IN_MS / 1000),
    });
    return res;
  } catch (err) {
    logError({
      category: "auth",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "warning",
      endpoint: "/api/auth/session",
      method: "POST",
    });
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}

/** DELETE /api/auth/session — clears the session cookie on sign-out. */
export async function DELETE() {
  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
