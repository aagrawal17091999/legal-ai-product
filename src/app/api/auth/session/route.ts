import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { getOrCreateUser, SESSION_COOKIE } from "@/lib/auth";
import { logError } from "@/lib/error-logger";
import pool from "@/lib/db";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";

function clearCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

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
    const provider = decoded.firebase?.sign_in_provider;
    // The name and photo were never passed here, so users.display_name stayed
    // NULL for everyone who didn't later edit it on /account. Google tokens
    // carry both; email signups carry the name once useAuth force-refreshes
    // the token after updateProfile.
    const user = await getOrCreateUser({
      uid: decoded.uid,
      email: decoded.email || "",
      displayName: typeof decoded.name === "string" ? decoded.name : undefined,
      photoURL: typeof decoded.picture === "string" ? decoded.picture : undefined,
      signInProvider: provider,
    });

    // This route also runs on every page load and hourly token refresh, so it
    // is not itself a sign-in. auth_time is when the user actually
    // authenticated: keying on it makes every repeat post of the same login a
    // Mixpanel duplicate, leaving one event per real sign-in.
    track(EVENTS.SIGNED_IN, {
      userId: user.id,
      insertId: `signin:${user.id}:${decoded.auth_time}`,
      properties: {
        sign_in_provider: provider ?? null,
        email: user.email,
        auth_time: new Date(decoded.auth_time * 1000),
      },
    });

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

/**
 * DELETE /api/auth/session — sign-out. Clears the cookie AND revokes the user's
 * Firebase refresh tokens so the session cookie can no longer be re-validated
 * server-side (paired with verifySessionCookie(..., true) in verifyAuth). Without
 * the revoke, a copied cookie would survive logout for the full 14-day lifetime.
 */
export async function DELETE(request: NextRequest) {
  const res = NextResponse.json({ status: "ok" });
  clearCookie(res);

  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionCookie) {
    try {
      // Don't checkRevoked here — we're about to revoke; we just need the uid.
      const decoded = await adminAuth().verifySessionCookie(sessionCookie);
      await adminAuth().revokeRefreshTokens(decoded.uid);
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM users WHERE firebase_uid = $1`,
        [decoded.uid]
      );
      if (rows[0]) track(EVENTS.SIGNED_OUT, { userId: rows[0].id });
    } catch (err) {
      // Already-expired/invalid cookie: nothing to revoke. Still clear + 200 so
      // the client always completes sign-out.
      logError({
        category: "auth",
        message: "Sign-out token revoke skipped",
        error: err,
        severity: "warning",
        endpoint: "/api/auth/session",
        method: "DELETE",
      });
    }
  }
  return res;
}
