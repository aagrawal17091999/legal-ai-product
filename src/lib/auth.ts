import { NextRequest } from "next/server";
import { adminAuth as getAdminAuth } from "./firebase-admin";
import pool from "./db";
import { logError } from "./error-logger";
import type { User } from "@/types";

const FREE_QUERY_LIMIT = 5;

export async function verifyAuth(
  request: NextRequest
): Promise<{ uid: string; email: string } | null> {
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
  return rows[0];
}

export async function checkQueryLimit(
  userId: number
): Promise<{ allowed: boolean; remaining: number }> {
  // Reset counter if it's a new day
  await pool.query(
    `UPDATE users
     SET queries_used_today = 0, queries_reset_date = CURRENT_DATE
     WHERE id = $1 AND queries_reset_date < CURRENT_DATE`,
    [userId]
  );

  const { rows } = await pool.query<User>(
    `SELECT plan, queries_used_today FROM users WHERE id = $1`,
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

  const remaining = FREE_QUERY_LIMIT - user.queries_used_today;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

export async function incrementQueryCount(userId: number): Promise<void> {
  await pool.query(
    `UPDATE users SET queries_used_today = queries_used_today + 1 WHERE id = $1`,
    [userId]
  );
}
