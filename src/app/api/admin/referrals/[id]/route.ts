import { NextRequest, NextResponse } from "next/server";
import { requireStaff, loadTargetUser, logAdminAction } from "@/lib/admin";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

/**
 * POST /api/admin/referrals/[id] { action: "disqualify", reason } — strike one
 * referral from a referrer's count (self-referral the automatic checks missed,
 * a chargeback). Credits already paid are not clawed back here; revoke them
 * from the Credits card separately if they shouldn't stand.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  if (body.action !== "disqualify") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  try {
    const { rows } = await pool.query<{ referrer_user_id: number; referee_user_id: number }>(
      `UPDATE referrals
          SET status = 'disqualified', disqualified_reason = COALESCE($2, 'staff'),
              updated_at = NOW()
        WHERE id = $1 AND status <> 'disqualified'
        RETURNING referrer_user_id, referee_user_id`,
      [Number(id) || 0, reason]
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "Not found or already disqualified" }, { status: 404 });
    }
    const target = await loadTargetUser(rows[0].referrer_user_id);
    if (target) {
      await logAdminAction({
        actor: gate.user,
        target,
        action: "referral_disqualify",
        reason,
        details: { referralId: Number(id), refereeUserId: rows[0].referee_user_id },
      });
    }
    return NextResponse.json({ status: "disqualified" });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      userId: gate.user.id,
      endpoint: "/api/admin/referrals/[id]",
      method: "POST",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
