import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { getSignedObjectUrl, deleteFromR2 } from "@/lib/r2";
import { expireStaleTranslations } from "@/lib/translate/expire";
import { logError } from "@/lib/error-logger";

// GET /api/translate/[id] — job status; includes a download URL when ready
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id } = await ctx.params;
    // Fail any job whose background task died and left it stuck `processing`,
    // so this poll returns a terminal state instead of spinning forever.
    await expireStaleTranslations(user.id);
    const { rows } = await pool.query(
      `SELECT id, source_filename, target_language, detected_language, status,
              segment_count, flagged_count, ocr_used, output_r2_key, result_json,
              output_locked, error, created_at
         FROM translation_jobs WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const job = rows[0];
    // Output is withheld when the job's credit cost pushed the wallet negative.
    // The work is done and stored — the client just can't see it until top-up.
    const locked = job.output_locked === true;
    let downloadUrl: string | null = null;
    if (job.status === "ready" && job.output_r2_key && !locked) {
      downloadUrl = await getSignedObjectUrl(job.output_r2_key);
    }
    // The structured translation for the in-app viewer (null for jobs created
    // before the result was persisted — the viewer falls back to download).
    // Suppressed while locked so the preview can't bypass the paywall.
    const result = locked ? null : job.result_json ?? null;
    // Don't leak the storage key (or the bulky raw column) to the client.
    delete job.output_r2_key;
    delete job.result_json;
    return NextResponse.json({ job, downloadUrl, result, locked });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/translate/[id]",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/translate/[id] — remove a translation job and its stored files
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id } = await ctx.params;

    // Delete the row first (scoped to the owner) and return its R2 keys so we
    // only clean up storage for a job that actually belonged to this user.
    const { rows } = await pool.query(
      `DELETE FROM translation_jobs
        WHERE id = $1 AND user_id = $2
        RETURNING source_r2_key, output_r2_key`,
      [id, user.id]
    );
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await deleteFromR2([rows[0].source_r2_key, rows[0].output_r2_key]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/translate/[id]",
      method: "DELETE",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
