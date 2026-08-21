import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { requestStop } from "@/lib/chat/turnRunner";

/**
 * POST /api/chat/sessions/[id]/turns/[mid]/stop
 *
 * Stop is now an explicit action rather than "the client closed the socket" —
 * that conflation is exactly why a refresh used to cancel the answer. Works
 * from any tab, and across processes via the row's `cancel_requested` flag.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  const { id: sessionId, mid } = await params;

  const { rows } = await pool.query<{ id: string }>(
    `SELECT m.id
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.id = $1 AND m.session_id = $2 AND s.user_id = $3
        AND m.role = 'assistant'`,
    [mid, sessionId, user.id]
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "Turn not found" }, { status: 404 });
  }

  await requestStop(mid);
  return NextResponse.json({ stopped: true });
}
