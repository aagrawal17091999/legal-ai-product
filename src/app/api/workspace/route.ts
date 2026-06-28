import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

// POST /api/workspace — create a new document workspace
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getOrCreateUser({ uid: decoded.uid, email: decoded.email });
    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;

    const { rows } = await pool.query(
      `INSERT INTO workspaces (user_id, title)
       VALUES ($1, $2)
       RETURNING id, title, created_at, updated_at`,
      [user.id, title]
    );
    return NextResponse.json(rows[0]);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace",
      method: "POST",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/workspace — list the user's workspaces with document counts
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { rows } = await pool.query(
      `SELECT w.id, w.title, w.created_at, w.updated_at,
              COUNT(d.id)::int AS document_count,
              COUNT(d.id) FILTER (WHERE d.status = 'ready')::int AS ready_count
         FROM workspaces w
         LEFT JOIN workspace_documents d ON d.workspace_id = w.id
        WHERE w.user_id = $1
        GROUP BY w.id
        ORDER BY w.updated_at DESC`,
      [user.id]
    );
    return NextResponse.json(rows);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
