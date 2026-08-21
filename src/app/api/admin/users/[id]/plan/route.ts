import { NextRequest, NextResponse } from "next/server";
import { requireStaff, loadTargetUser, logAdminAction } from "@/lib/admin";
import { invalidateUserCache } from "@/lib/auth";
import pool from "@/lib/db";
import { grant } from "@/lib/billing/credits";
import { PLAN_CREDITS, creditPeriodEnd, compedPlanEnd } from "@/lib/billing/cost";
import {
  updateSubscriptionPlan,
  subscriptionCycleKey,
  subscriptionEndDate,
  markSubscriptionActive,
} from "@/lib/razorpay";
import { logError } from "@/lib/error-logger";

/** Longest comp a single action may issue, so a typo can't hand out a decade. */
const MAX_COMP_MONTHS = 36;

/**
 * POST /api/admin/users/[id]/plan — put a user on the monthly or yearly plan.
 *
 * Body: { plan: "monthly" | "yearly", months?: number, reason?: string }
 *
 * Two genuinely different situations, decided by whether the user already has a
 * Razorpay subscription — not by an option the admin has to get right:
 *
 *   1. LIVE SUBSCRIPTION -> switch the existing subscription's plan in place
 *      ("now", with Razorpay proration). Real money, same subscription id, no
 *      window where the user has no plan. This is the same call the self-serve
 *      /api/payments/change-plan makes.
 *
 *   2. NO SUBSCRIPTION -> a COMPED plan: the plan is granted outright for
 *      `months` months with no charge and no Razorpay object. `comped_plan` is
 *      set so /api/cron/credit-refill knows to keep the wallet topped up monthly
 *      and to downgrade the user when the comp expires — no webhook will ever
 *      arrive to do either.
 *
 * Deliberately does NOT emit the subscription_activated analytics event: a comp
 * is not a conversion, and counting it as one corrupts the funnel it feeds.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { id } = await ctx.params;
  const target = await loadTargetUser(Number(id));
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const plan = body.plan as "monthly" | "yearly";
  const reason = typeof body.reason === "string" ? body.reason : null;

  if (!["monthly", "yearly"].includes(plan)) {
    return NextResponse.json(
      { error: "plan must be 'monthly' or 'yearly'" },
      { status: 400 }
    );
  }

  const months = Math.round(
    Number.isFinite(Number(body.months)) && Number(body.months) > 0
      ? Number(body.months)
      : plan === "yearly"
        ? 12
        : 1
  );
  if (months > MAX_COMP_MONTHS) {
    return NextResponse.json(
      { error: `Comped plans are capped at ${MAX_COMP_MONTHS} months` },
      { status: 400 }
    );
  }

  try {
    // ---------------------------------------------------------------- billed
    if (target.razorpay_subscription_id) {
      if (target.plan === plan && target.subscription_status === "active") {
        return NextResponse.json(
          { error: `Already on the ${plan} plan` },
          { status: 400 }
        );
      }

      const updated = (await updateSubscriptionPlan(
        target.razorpay_subscription_id,
        plan,
        "now"
      )) as { current_end?: number | null };

      const endDate = subscriptionEndDate(plan, updated.current_end);
      await markSubscriptionActive({
        userId: target.id,
        subscriptionId: target.razorpay_subscription_id,
        plan,
        endDate,
      });
      // A plan switch is a new cycle. Key the grant exactly as the webhook will,
      // so whichever of the two lands second is a no-op instead of a double
      // allowance.
      await grant({
        userId: target.id,
        type: "monthly_reset",
        credits: PLAN_CREDITS[plan],
        periodEnd: creditPeriodEnd(plan, endDate),
        idempotencyKey: subscriptionCycleKey(
          target.razorpay_subscription_id,
          updated.current_end
        ),
      });

      invalidateUserCache(target.firebase_uid);
      await logAdminAction({
        actor: gate.user,
        target,
        action: "set_plan",
        reason,
        details: {
          mode: "razorpay",
          plan,
          from: target.plan,
          subscriptionId: target.razorpay_subscription_id,
          endDate: endDate.toISOString(),
        },
      });

      return NextResponse.json({
        status: "ok",
        mode: "razorpay",
        plan,
        endDate: endDate.toISOString(),
      });
    }

    // ---------------------------------------------------------------- comped
    // Extend from the existing expiry when the user is already comped and still
    // inside it, so "give them another month" adds a month rather than
    // truncating the one they have.
    const existingEnd = target.subscription_end_date
      ? new Date(target.subscription_end_date)
      : null;
    const from =
      target.comped_plan && existingEnd && existingEnd > new Date()
        ? existingEnd
        : new Date();
    const endDate = compedPlanEnd(from, months);

    await pool.query(
      `UPDATE users SET
         plan = $1,
         subscription_status = 'active',
         comped_plan = TRUE,
         subscription_end_date = $2,
         updated_at = NOW()
       WHERE id = $3`,
      [plan, endDate.toISOString(), target.id]
    );

    // Open a fresh credit period now. The wallet is a one-month window even on a
    // yearly comp; the refill cron issues the rest.
    await grant({
      userId: target.id,
      type: "monthly_reset",
      credits: PLAN_CREDITS[plan],
      periodEnd: creditPeriodEnd(plan, endDate),
      idempotencyKey: `comped:${target.id}:${endDate.toISOString().slice(0, 10)}`,
    });

    invalidateUserCache(target.firebase_uid);
    await logAdminAction({
      actor: gate.user,
      target,
      action: "set_plan",
      reason,
      details: {
        mode: "comped",
        plan,
        from: target.plan,
        months,
        endDate: endDate.toISOString(),
      },
    });

    return NextResponse.json({
      status: "ok",
      mode: "comped",
      plan,
      months,
      endDate: endDate.toISOString(),
    });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: gate.user.id,
      endpoint: "/api/admin/users/[id]/plan",
      method: "POST",
      metadata: { targetUserId: target.id, plan },
    });
    return NextResponse.json({ error: "Failed to change plan" }, { status: 500 });
  }
}
