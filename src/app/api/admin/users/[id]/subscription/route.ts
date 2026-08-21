import { NextRequest, NextResponse } from "next/server";
import { requireStaff, loadTargetUser, logAdminAction } from "@/lib/admin";
import { invalidateUserCache } from "@/lib/auth";
import pool from "@/lib/db";
import { cancelSubscription } from "@/lib/razorpay";
import { logError } from "@/lib/error-logger";

/**
 * DELETE /api/admin/users/[id]/subscription — cancel a user's paid plan.
 *
 * Body: { immediate?: boolean, reason?: string }
 *
 * Default is cancel-at-cycle-end, matching the self-serve flow: the user keeps
 * the access and the credits they already paid for until the period they bought
 * runs out. `immediate: true` is the refund/abuse path — it ends access now and
 * zeroes the plan allowance in the same breath.
 *
 * Both a billed subscription and a comped plan are cancellable here. Purchased
 * and lifetime credits (topup_credits) are never touched in either case: the
 * user bought those separately and they outlive the plan.
 */
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { id } = await ctx.params;
  const target = await loadTargetUser(Number(id));
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const immediate = body.immediate === true;
  const reason = typeof body.reason === "string" ? body.reason : null;
  const comped = target.comped_plan === true;

  if (!target.razorpay_subscription_id && !comped) {
    return NextResponse.json(
      { error: "User has no subscription or comped plan to cancel" },
      { status: 400 }
    );
  }

  try {
    if (target.razorpay_subscription_id) {
      // Razorpay rejects cancelling an already-cancelled subscription. That is a
      // 400 about a state we can see, so report it plainly rather than as a 500
      // — and never let it stop us recording the intent below.
      await cancelSubscription(target.razorpay_subscription_id, !immediate);
    }

    if (immediate) {
      await pool.query(
        `UPDATE users SET
           plan = 'free',
           subscription_status = 'inactive',
           comped_plan = FALSE,
           subscription_end_date = NOW(),
           updated_at = NOW()
         WHERE id = $1`,
        [target.id]
      );
      // The plan allowance dies with the plan; purchased credits survive.
      await pool.query(
        `UPDATE credit_balances
            SET plan_credits = 0, period_end = NOW(), updated_at = NOW()
          WHERE user_id = $1`,
        [target.id]
      );
    } else {
      // Access stands until subscription_end_date. For a billed subscription the
      // subscription.cancelled webhook does the downgrade at cycle end; for a
      // comped plan the refill cron's expiry sweep does. `comped_plan` is left
      // set precisely so that sweep still owns the row.
      await pool.query(
        `UPDATE users SET subscription_status = 'cancelled', updated_at = NOW()
          WHERE id = $1`,
        [target.id]
      );
    }

    invalidateUserCache(target.firebase_uid);
    await logAdminAction({
      actor: gate.user,
      target,
      action: "cancel_plan",
      reason,
      details: {
        immediate,
        mode: target.razorpay_subscription_id ? "razorpay" : "comped",
        plan: target.plan,
        subscriptionId: target.razorpay_subscription_id,
        accessUntil: immediate ? null : target.subscription_end_date,
      },
    });

    return NextResponse.json({
      status: "cancelled",
      immediate,
      accessUntil: immediate ? null : (target.subscription_end_date ?? null),
    });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: gate.user.id,
      endpoint: "/api/admin/users/[id]/subscription",
      method: "DELETE",
      metadata: { targetUserId: target.id, immediate },
    });
    return NextResponse.json(
      { error: "Failed to cancel subscription" },
      { status: 500 }
    );
  }
}
