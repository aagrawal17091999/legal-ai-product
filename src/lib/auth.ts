import { NextRequest } from "next/server";
import { adminAuth as getAdminAuth } from "./firebase-admin";
import pool from "./db";
import { grantSignupCredits } from "./billing/credits";
import { logError } from "./error-logger";
import { beginRequestContext, setContextUser } from "./request-context";
import { track, identify } from "./analytics/server";
import { EVENTS } from "./analytics/events";
import type { User } from "@/types";

/** Name of the httpOnly session cookie minted by /api/auth/session. */
export const SESSION_COOKIE = "__session";

export async function verifyAuth(
  request: NextRequest
): Promise<{ uid: string; email: string } | null> {
  // Open the ambient logging context for this request. Done here because this
  // is the one function on essentially every authenticated path that still has
  // the NextRequest in hand; everything downstream (including fire-and-forget
  // logError calls in .catch handlers) inherits it. See request-context.ts.
  beginRequestContext({
    endpoint: request.nextUrl.pathname,
    method: request.method,
  });

  // Prefer the session cookie (sent automatically on same-origin requests,
  // including plain <a> navigations like PDF downloads). Fall back to the
  // Authorization bearer header for the client fetch() flow.
  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionCookie) {
    try {
      // checkRevoked: true makes Firebase reject cookies whose refresh tokens
      // were revoked (sign-out, password reset) or whose user was disabled —
      // without it a captured cookie stays valid for the full 14-day lifetime.
      const decoded = await getAdminAuth().verifySessionCookie(sessionCookie, true);
      return { uid: decoded.uid, email: decoded.email || "" };
    } catch {
      // Expired/invalid/revoked cookie — fall through to the bearer header.
    }
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    return { uid: decoded.uid, email: decoded.email || "" };
  } catch (err) {
    logError({
      category: "auth",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "warning",
      endpoint: request.nextUrl.pathname,
      method: request.method,
    });
    return null;
  }
}

// Short-lived in-memory cache of the firebase_uid -> users row. Under Fluid
// Compute a function instance is reused across requests, so this lets the hot
// chat endpoints resolve the user with zero DB round-trips most of the time —
// and, crucially, without the write that getOrCreateUser performs on every call.
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, { user: User; expires: number }>();

/**
 * Drop a user's cached row so their very next request re-reads from Postgres.
 *
 * Call this after changing a user's row from OUTSIDE their own session — the
 * admin console changing a plan, granting credits, cancelling a subscription.
 * Without it the target keeps seeing their old plan for up to USER_CACHE_TTL_MS,
 * which for an upgrade means the thing they were just told was fixed still isn't.
 *
 * Caveat worth knowing: the cache is per function instance, so this clears the
 * instance that served the admin's request. Other warm instances still expire on
 * their own TTL — a minute, not a session.
 */
export function invalidateUserCache(firebaseUid: string): void {
  userCache.delete(firebaseUid);
}

/**
 * Resolve the application user for an authenticated request without writing on
 * every call. Reads from the in-memory cache, then a plain SELECT, and only
 * upserts when the user genuinely doesn't exist yet (first request after
 * signup before the session route ran). Use this on read/chat endpoints where
 * only a stable `user.id` is needed. Payment/account endpoints that depend on
 * fresh columns should keep using getOrCreateUser.
 */
export async function getRequestUser(firebaseUser: {
  uid: string;
  email: string;
}): Promise<User> {
  const cached = userCache.get(firebaseUser.uid);
  if (cached && cached.expires > Date.now()) {
    setContextUser(cached.user.id);
    return cached.user;
  }

  const { rows } = await pool.query<User>(
    `SELECT * FROM users WHERE firebase_uid = $1`,
    [firebaseUser.uid]
  );
  const user = rows[0] ?? (await getOrCreateUser(firebaseUser));
  setContextUser(user.id);
  userCache.set(firebaseUser.uid, {
    user,
    expires: Date.now() + USER_CACHE_TTL_MS,
  });
  return user;
}

export async function getOrCreateUser(firebaseUser: {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
}): Promise<User> {
  const { rows } = await pool.query<User>(
    `INSERT INTO users (firebase_uid, email, display_name, photo_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (firebase_uid) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
       updated_at = NOW()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      firebaseUser.uid,
      firebaseUser.email,
      firebaseUser.displayName || null,
      firebaseUser.photoURL || null,
    ]
  );
  const user = rows[0];
  // `xmax = 0` is true only when this statement INSERTed the row, so an upsert
  // that merely refreshed an existing user doesn't get counted as a signup.
  // Every other signal here (the credit grant, a "first request" heuristic) is
  // either idempotent or racy across concurrent logins.
  const isNewUser = (rows[0] as User & { inserted?: boolean }).inserted === true;
  if (isNewUser) {
    track(EVENTS.SIGNED_UP, {
      userId: user.id,
      // Dedup key, so a retried request during signup can't double-count.
      insertId: `signup:${user.id}`,
      properties: { plan: user.plan },
    });
    identify(user.id, {
      $email: user.email,
      $created: new Date().toISOString(),
      plan: user.plan,
    });
  }
  // One-time free credit allowance for genuinely new users. Idempotent (no-op if
  // the user already has any ledger history), so it's safe to call on every
  // upsert; never let a billing hiccup break authentication.
  try {
    await grantSignupCredits(user.id);
  } catch (err) {
    logError({
      category: "payment",
      message: "grantSignupCredits failed",
      error: err,
      severity: "warning",
      metadata: { userId: user.id },
    });
  }
  setContextUser(user.id);
  userCache.set(user.firebase_uid, {
    user,
    expires: Date.now() + USER_CACHE_TTL_MS,
  });
  return user;
}
