import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import type { ErrorLog } from "@/types";

/**
 * Resolve the caller and require staff. Returns the same 404 used by the trace
 * route for non-staff so we don't even confirm the admin surface exists. Any
 * authenticated-but-non-staff user (i.e. every normal customer) is rejected.
 */
async function requireStaff(request: NextRequest) {
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

// GET /api/admin/errors — Query error logs with filters
export async function GET(request: NextRequest) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  const { searchParams } = request.nextUrl;
  const category = searchParams.get("category");
  const severity = searchParams.get("severity");
  const resolved = searchParams.get("resolved");
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
