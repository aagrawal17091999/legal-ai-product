import { NextRequest } from "next/server";
import { adminAuth as getAdminAuth } from "./firebase-admin";
import pool from "./db";
import { logError } from "./error-logger";
import type { User } from "@/types";

const FREE_QUERY_LIMIT = 3;

/** Name of the httpOnly session cookie minted by /api/auth/session. */
export const SESSION_COOKIE = "__session";

export async function verifyAuth(
  request: NextRequest
): Promise<{ uid: string; email: string } | null> {
  // Prefer the session cookie (sent automatically on same-origin requests,
  // including plain <a> navigations like PDF downloads). Fall back to the
  // Authorization bearer header for the client fetch() flow.
  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionCookie) {
    try {
      const decoded = await getAdminAuth().verifySessionCookie(sessionCookie);
      return { uid: decoded.uid, email: decoded.email || "" };
    } catch {
      // Expired/invalid cookie — fall through to the bearer header.
    }
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
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
    return cached.user;
  }

  const { rows } = await pool.query<User>(
    `SELECT * FROM users WHERE firebase_uid = $1`,
    [firebaseUser.uid]
  );
  const user = rows[0] ?? (await getOrCreateUser(firebaseUser));
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
     RETURNING *`,
    [
      firebaseUser.uid,
      firebaseUser.email,
      firebaseUser.displayName || null,
      firebaseUser.photoURL || null,
    ]
  );
  const user = rows[0];
  userCache.set(user.firebase_uid, {
    user,
    expires: Date.now() + USER_CACHE_TTL_MS,
  });
  return user;
}

export async function checkQueryLimit(
  userId: number
): Promise<{ allowed: boolean; remaining: number }> {
  // Free tier is a lifetime quota: queries_used_total never resets.
  const { rows } = await pool.query<User>(
    `SELECT plan, queries_used_total FROM users WHERE id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    return { allowed: false, remaining: 0 };
  }

  const user = rows[0];

  // Pro users have unlimited queries
  if (user.plan === "monthly" || user.plan === "yearly") {
    return { allowed: true, remaining: Infinity };
  }

  const remaining = FREE_QUERY_LIMIT - user.queries_used_total;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

export async function incrementQueryCount(userId: number): Promise<void> {
  await pool.query(
    `UPDATE users SET queries_used_total = queries_used_total + 1 WHERE id = $1`,
    [userId]
  );
}
