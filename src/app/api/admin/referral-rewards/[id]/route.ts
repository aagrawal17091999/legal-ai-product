import { NextRequest, NextResponse } from "next/server";
import { requireStaff, loadTargetUser, logAdminAction } from "@/lib/admin";
import { invalidateUserCache } from "@/lib/auth";
import pool from "@/lib/db";
import { RewardError, completeReward, scheduleReward } from "@/lib/referrals/rewards";
import { logError } from "@/lib/error-logger";

/**
 * POST /api/admin/referral-rewards/[id] — staff hands on one free month.
 *
 * Body: { action, reason?, note? }
 *   apply         book it against the next renewal NOW (pause, or refund mode),
 *                 without waiting for the 3-day window. Same code the cron runs.
 *   complete      finish a paused month: chain into the next banked month or
 *                 resume billing. Before the skipped renewal, this is an undo.
 *   mark_applied  record a month staff gave outside the app (paused/refunded in
 *                 the Razorpay dashboard). Bookkeeping only — touches nothing.
 *   revoke        withdraw a banked month (fraud). Its milestone stays used.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { id } = await ctx.params;
  const rewardId = Number(id);
  const { rows } = await pool.query<{ referrer_user_id: number; status: string }>(
    `SELECT referrer_user_id, status FROM referral_rewards WHERE id = $1`,
    [Number.isInteger(rewardId) ? rewardId : 0]
  );
  if (!rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const target = await loadTargetUser(rows[0].referrer_user_id);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const reason = typeof body.reason === "string" ? body.reason : null;
  const actor = gate.user.email;

  try {
    let result: Record<string, unknown>;
    switch (action) {
      case "apply": {
        result = await scheduleReward(rewardId, { actor, force: true });
        break;
      }
      case "complete": {
        result = await completeReward(rewardId, { actor, force: true });
        break;
      }
      case "mark_applied": {
        const res = await pool.query(
          `UPDATE referral_rewards
              SET status = 'applied', method = 'manual', actor = $2, note = $3,
                  applied_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND status = 'banked'`,
          [rewardId, actor, reason]
        );
        if ((res.rowCount ?? 0) === 0) {
          throw new RewardError(
            "Only a banked month can be marked as given by hand. A month in progress is finished with Complete."
          );
        }
        result = { status: "applied" };
        break;
      }
      case "revoke": {
        const res = await pool.query(
          `UPDATE referral_rewards
              SET status = 'revoked', actor = $2, note = $3, updated_at = NOW()
            WHERE id = $1 AND status = 'banked'`,
          [rewardId, actor, reason]
        );
        if ((res.rowCount ?? 0) === 0) {
          throw new RewardError("Only a banked month can be revoked");
        }
        result = { status: "revoked" };
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    invalidateUserCache(target.firebase_uid);
    await logAdminAction({
      actor: gate.user,
      target,
      action:
        action === "apply"
          ? "referral_reward_apply"
          : action === "complete"
            ? "referral_reward_complete"
            : action === "mark_applied"
              ? "referral_reward_mark_applied"
              : "referral_reward_revoke",
      reason,
      details: { rewardId, ...result },
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RewardError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: gate.user.id,
      endpoint: "/api/admin/referral-rewards/[id]",
      method: "POST",
      metadata: { rewardId, action, targetUserId: target.id },
    });
    return NextResponse.json(
      {
        error: `Razorpay or the database refused: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 500 }
    );
  }
}
