import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

// POST /api/chat/sessions — Create a new chat session
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await getOrCreateUser({
      uid: decoded.uid,
      email: decoded.email,
    });

    const body = await request.json();
    const filters = body.filters || {};

    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (user_id, filters)
       VALUES ($1, $2)
       RETURNING id, title, filters, created_at, updated_at`,
      [user.id, JSON.stringify(filters)]
    );

    return NextResponse.json(rows[0]);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/chat/sessions",
      method: "POST",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/chat/sessions — List all sessions for the user
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await getOrCreateUser({
      uid: decoded.uid,
      email: decoded.email,
    });

    const { rows } = await pool.query(
      `SELECT id, title, filters, created_at, updated_at
       FROM chat_sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [user.id]
    );

    return NextResponse.json(rows);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/chat/sessions",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
