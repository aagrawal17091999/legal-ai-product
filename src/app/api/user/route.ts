import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import pool from "@/lib/db";
import { adminAuth } from "@/lib/firebase-admin";
import { logError } from "@/lib/error-logger";

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

    return NextResponse.json({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      plan: user.plan,
      queries_used_today: user.queries_used_today,
      subscription_status: user.subscription_status,
      subscription_end_date: user.subscription_end_date,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/user",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const displayName = body.display_name?.trim();

    if (!displayName || displayName.length > 100) {
      return NextResponse.json(
        { error: "Display name must be between 1 and 100 characters" },
        { status: 400 }
      );
    }

    // Update in database
    const { rows } = await pool.query(
      `UPDATE users SET display_name = $1, updated_at = NOW() WHERE firebase_uid = $2
       RETURNING id, email, display_name, plan, queries_used_today, subscription_status, subscription_end_date`,
      [displayName, decoded.uid]
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Update Firebase profile
    const auth = adminAuth();
    await auth.updateUser(decoded.uid, { displayName });

    return NextResponse.json(rows[0]);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/user",
      method: "PATCH",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
