import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/admin";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

/**
 * GET /api/admin/users — staff user directory.
 *
 * Search is by email, display name, or exact internal id, so a support request
 * ("this person can't run a translation") can be resolved from whatever
 * identifier arrived with it. Balance is joined in because it is the first thing
 * anyone looks at, and a second round-trip per row would be silly.
 */
export async function GET(request: NextRequest) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { searchParams } = request.nextUrl;
  const q = (searchParams.get("q") ?? "").trim();
  const plan = searchParams.get("plan");
  const limit = Math.min(parseInt(searchParams.get("limit") || "25"), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0"), 0);

  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (q) {
    // ILIKE on email/name, plus an exact id match when the query is a number,
    // so pasting a user id from an error log row lands on the right person.
    const idMatch = /^\d+$/.test(q) ? Number(q) : null;
    if (idMatch !== null) {
      clauses.push(`(u.id = $${i} OR u.email ILIKE $${i + 1} OR u.display_name ILIKE $${i + 1})`);
      params.push(idMatch, `%${q}%`);
      i += 2;
    } else {
      clauses.push(`(u.email ILIKE $${i} OR u.display_name ILIKE $${i})`);
      params.push(`%${q}%`);
      i += 1;
    }
  }
  if (plan && ["free", "monthly", "yearly"].includes(plan)) {
    clauses.push(`u.plan = $${i++}`);
    params.push(plan);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT u.id, u.email, u.display_name, u.plan, u.subscription_status,
                u.subscription_end_date, u.razorpay_subscription_id,
                u.comped_plan, u.unlimited_credits, u.is_staff, u.created_at,
                COALESCE(b.plan_credits, 0)  AS plan_credits,
                COALESCE(b.topup_credits, 0) AS topup_credits
           FROM users u
           LEFT JOIN credit_balances b ON b.user_id = u.id
           ${where}
          ORDER BY u.created_at DESC
          LIMIT $${i} OFFSET $${i + 1}`,
        [...params, limit, offset]
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM users u ${where}`,
        params
      ),
    ]);

    return NextResponse.json({
      users: rows.map((r) => ({
        ...r,
        plan_credits: Number(r.plan_credits),
        topup_credits: Number(r.topup_credits),
        remaining: Number(r.plan_credits) + Number(r.topup_credits),
      })),
      total: parseInt(countRows[0].count),
      limit,
      offset,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      userId: gate.user.id,
      endpoint: "/api/admin/users",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
