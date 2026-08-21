import { NextRequest, NextResponse } from "next/server";
import { requireStaff, loadTargetUser, logAdminAction } from "@/lib/admin";
import { adminAdjustCredits, getBalance } from "@/lib/billing/credits";
import { logError } from "@/lib/error-logger";

/** Guard-rail on a single adjustment. A slipped digit here is real money. */
const MAX_ADJUSTMENT = 100_000;

/**
 * POST /api/admin/users/[id]/credits — grant (or claw back) credits.
 *
 * Body: { credits: number, reason?: string }
 *   credits > 0 grants, credits < 0 revokes. The adjustment lands in the
 *   persistent top-up bucket, so it survives the next billing-cycle reset.
 *
 * A revoke is clamped to the balance on hand (see adminAdjustCredits), and the
 * response reports what was ACTUALLY applied, which may be less than asked.
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
  const credits = Math.round(Number(body.credits));
  const reason = typeof body.reason === "string" ? body.reason : null;

  if (!Number.isFinite(credits) || credits === 0) {
    return NextResponse.json(
      { error: "credits must be a non-zero number" },
      { status: 400 }
    );
  }
  if (Math.abs(credits) > MAX_ADJUSTMENT) {
    return NextResponse.json(
      { error: `Adjustment is capped at ${MAX_ADJUSTMENT.toLocaleString()} credits` },
      { status: 400 }
    );
  }

  try {
    const before = await getBalance(target.id);
    const { applied, remaining } = await adminAdjustCredits({
      userId: target.id,
      credits,
    });

    await logAdminAction({
      actor: gate.user,
      target,
      action: applied >= 0 ? "grant_credits" : "revoke_credits",
      reason,
      details: { requested: credits, applied, before: before.remaining, after: remaining },
    });

    return NextResponse.json({
      status: "ok",
      requested: credits,
      applied,
      // Surfaced so the UI can say "only N could be revoked" rather than
      // silently doing less than the admin asked for.
      clamped: applied !== credits,
      remaining,
    });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: gate.user.id,
      endpoint: "/api/admin/users/[id]/credits",
      method: "POST",
      metadata: { targetUserId: target.id, credits },
    });
    return NextResponse.json({ error: "Failed to adjust credits" }, { status: 500 });
  }
}
