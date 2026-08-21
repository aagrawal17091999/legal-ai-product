import { NextRequest, NextResponse } from "next/server";
import { requireStaff, loadTargetUser } from "@/lib/admin";
import pool from "@/lib/db";
import { getBalance } from "@/lib/billing/credits";
import { logError } from "@/lib/error-logger";

/** How much history the profile page shows before you go to the full log. */
const RECENT = 25;

/**
 * GET /api/admin/users/[id] — everything the staff profile view renders:
 * identity + plan, wallet balance, the credit ledger, recent metered usage, an
 * error summary, and the audit trail of what staff have already done here.
 *
 * One route rather than five so the page doesn't fan out on load; none of these
 * are large (all are LIMIT-ed) and they are always read together.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { id } = await ctx.params;
  const userId = Number(id);
  const target = await loadTargetUser(userId);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const [balance, transactions, usage, errorSummary, actions] = await Promise.all([
      getBalance(userId),
      pool.query(
        `SELECT id, type, credits, amount_inr, razorpay_payment_id, created_at
           FROM credit_transactions WHERE user_id = $1
          ORDER BY created_at DESC LIMIT ${RECENT}`,
        [userId]
      ),
      pool.query(
        `SELECT id, feature, ref_id, cost_inr, credits_charged, enforced, created_at
           FROM usage_events WHERE user_id = $1
          ORDER BY created_at DESC LIMIT ${RECENT}`,
        [userId]
      ),
      // Counts for the profile header; the log itself is paged separately from
      // /api/admin/errors?userId=… so this stays a single cheap aggregate.
      pool.query<{ total: string; unresolved: string; critical: string; last_at: string | null }>(
        `SELECT COUNT(*)                                          AS total,
                COUNT(*) FILTER (WHERE NOT resolved)              AS unresolved,
                COUNT(*) FILTER (WHERE severity = 'critical')     AS critical,
                MAX(created_at)                                   AS last_at
           FROM error_logs WHERE user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT id, actor_email, action, reason, details, created_at
           FROM admin_actions WHERE target_user_id = $1
          ORDER BY created_at DESC LIMIT ${RECENT}`,
        [userId]
      ),
    ]);

    const summary = errorSummary.rows[0];

    return NextResponse.json({
      user: {
        id: target.id,
        email: target.email,
        display_name: target.display_name,
        photo_url: target.photo_url,
        plan: target.plan,
        subscription_status: target.subscription_status,
        subscription_end_date: target.subscription_end_date,
        razorpay_customer_id: target.razorpay_customer_id,
        razorpay_subscription_id: target.razorpay_subscription_id,
        comped_plan: target.comped_plan,
        unlimited_credits: target.unlimited_credits,
        is_staff: target.is_staff,
        created_at: target.created_at,
      },
      balance,
      transactions: transactions.rows.map((r) => ({
        ...r,
        credits: Number(r.credits),
        amount_inr: r.amount_inr === null ? null : Number(r.amount_inr),
      })),
      usage: usage.rows.map((r) => ({
        ...r,
        cost_inr: Number(r.cost_inr),
        credits_charged: Number(r.credits_charged),
      })),
      errors: {
        total: parseInt(summary.total),
        unresolved: parseInt(summary.unresolved),
        critical: parseInt(summary.critical),
        lastAt: summary.last_at,
      },
      actions: actions.rows,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      userId: gate.user.id,
      endpoint: "/api/admin/users/[id]",
      method: "GET",
      metadata: { targetUserId: userId },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
