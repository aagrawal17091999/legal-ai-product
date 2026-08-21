import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/admin";
import pool from "@/lib/db";
import type { ErrorLog } from "@/types";

// GET /api/admin/errors — Query error logs with filters
export async function GET(request: NextRequest) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { searchParams } = request.nextUrl;
  const category = searchParams.get("category");
  const severity = searchParams.get("severity");
  const resolved = searchParams.get("resolved");
  const userId = searchParams.get("userId");
  const email = (searchParams.get("email") ?? "").trim();
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const offset = parseInt(searchParams.get("offset") || "0");

  const clauses: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (category) {
    clauses.push(`category = $${paramIndex++}`);
    params.push(category);
  }
  if (severity) {
    clauses.push(`severity = $${paramIndex++}`);
    params.push(severity);
  }
  // Per-user view (the admin user profile). A non-numeric value would otherwise
  // reach Postgres and blow up the whole query, so drop it rather than 400 —
  // this is a filter, and an unparseable filter is best treated as absent.
  if (userId && Number.isInteger(Number(userId))) {
    clauses.push(`user_id = $${paramIndex++}`);
    params.push(Number(userId));
  }
  // Support requests arrive as an email address, not an internal id. Resolved
  // in the subquery rather than a second round-trip; `idx_users_email_lower`
  // (migration 029) makes the LOWER() comparison an index hit. An address that
  // matches no user yields no rows, which is the honest answer — better than
  // silently dropping the filter and showing everyone else's errors.
  if (email) {
    clauses.push(
      `user_id = (SELECT id FROM users WHERE LOWER(email) = LOWER($${paramIndex++}))`
    );
    params.push(email);
  }
  if (resolved !== null && resolved !== undefined && resolved !== "") {
    clauses.push(`resolved = $${paramIndex++}`);
    params.push(resolved === "true");
  }
  if (from) {
    clauses.push(`created_at >= $${paramIndex++}`);
    params.push(from);
  }
  if (to) {
    clauses.push(`created_at <= $${paramIndex++}`);
    params.push(to);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<ErrorLog>(
      `SELECT * FROM error_logs ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM error_logs ${whereClause}`,
      params
    ),
  ]);

  return NextResponse.json({
    errors: rows,
    total: parseInt(countRows[0].count),
    limit,
    offset,
  });
}

// PATCH /api/admin/errors — Mark errors as resolved
export async function PATCH(request: NextRequest) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const body = await request.json();
  const ids: number[] = body.ids;

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids array required" }, { status: 400 });
  }

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
  await pool.query(
    `UPDATE error_logs SET resolved = true, resolved_at = NOW()
     WHERE id IN (${placeholders})`,
    ids
  );

  return NextResponse.json({ status: "ok", resolved: ids.length });
}
