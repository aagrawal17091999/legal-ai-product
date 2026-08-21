/**
 * Shared plumbing for the staff admin surface (/admin/*, /api/admin/*).
 *
 * Two things every admin route needs: the staff gate, and an audit row for any
 * action taken against someone else's account.
 */
import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { getRequestUser, verifyAuth } from "@/lib/auth";
import type { User } from "@/types";

export type AdminActionType =
  | "grant_credits"
  | "revoke_credits"
  | "set_plan"
  | "cancel_plan";

/**
 * Resolve the caller and require staff.
 *
 * Non-staff get 404, not 403 — the same response the trace route uses — so the
 * admin surface isn't confirmed to exist to anyone who isn't already inside it.
 * Returns either `{ user }` or `{ error }`; callers must check `error` first.
 */
export async function requireStaff(
  request: NextRequest
): Promise<{ user: User; error?: never } | { user?: never; error: NextResponse }> {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const user = await getRequestUser(decoded);
  if (!user.is_staff) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { user };
}

/**
 * Record a staff action against a user account (migration 029).
 *
 * Emails are denormalized alongside the ids because the ids go NULL if either
 * account is later deleted, and "who did this" is the whole reason the row
 * exists. Never throws: an audit write that fails must not roll back or 500 the
 * action the admin actually asked for — it is logged as an error instead.
 */
export async function logAdminAction(opts: {
  actor: User;
  target: Pick<User, "id" | "email">;
  action: AdminActionType;
  reason?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_actions
         (actor_user_id, actor_email, target_user_id, target_email, action, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        opts.actor.id,
        opts.actor.email,
        opts.target.id,
        opts.target.email,
        opts.action,
        opts.reason?.trim() || null,
        JSON.stringify(opts.details ?? {}),
      ]
    );
  } catch (err) {
    const { logError } = await import("@/lib/error-logger");
    logError({
      category: "database",
      message: `Failed to write admin_actions row: ${
        err instanceof Error ? err.message : String(err)
      }`,
      error: err,
      severity: "error",
      userId: opts.actor.id,
      metadata: { action: opts.action, targetUserId: opts.target.id },
    });
  }
}

/** Load the target of an admin action by our internal user id. */
export async function loadTargetUser(id: number): Promise<User | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query<User>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
