import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { getSignedObjectUrl, deleteFromR2 } from "@/lib/r2";
import { expireStaleOcrJobs } from "@/lib/ocr/expire";
import { logError } from "@/lib/error-logger";

// GET /api/ocr/[id] — job status; includes download URLs (PDF + DOCX) when ready
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id } = await ctx.params;
    // Fail any job whose background task died and left it stuck `processing`,
    // so this poll returns a terminal state instead of spinning forever.
    await expireStaleOcrJobs(user.id);
    const { rows } = await pool.query(
      `SELECT id, source_filename, detected_language, status,
              segment_count, flagged_count, ocr_used, output_pdf_r2_key,
              output_docx_r2_key, result_json, error, created_at
         FROM ocr_jobs WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const job = rows[0];
    let pdfUrl: string | null = null;
    let docxUrl: string | null = null;
    if (job.status === "ready") {
      if (job.output_pdf_r2_key) pdfUrl = await getSignedObjectUrl(job.output_pdf_r2_key);
      if (job.output_docx_r2_key) docxUrl = await getSignedObjectUrl(job.output_docx_r2_key);
    }
    // The structured OCR result for the in-app viewer (null for older jobs).
    const result = job.result_json ?? null;
    // Don't leak storage keys (or the bulky raw column) to the client.
    delete job.output_pdf_r2_key;
    delete job.output_docx_r2_key;
    delete job.result_json;
    return NextResponse.json({ job, pdfUrl, docxUrl, result });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/ocr/[id]",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/ocr/[id] — remove an OCR job and its stored files
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id } = await ctx.params;

    // Delete the row first (scoped to the owner) and return its R2 keys so we
    // only clean up storage for a job that actually belonged to this user.
    const { rows } = await pool.query(
      `DELETE FROM ocr_jobs
        WHERE id = $1 AND user_id = $2
        RETURNING source_r2_key, output_pdf_r2_key, output_docx_r2_key`,
      [id, user.id]
    );
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await deleteFromR2([rows[0].source_r2_key, rows[0].output_pdf_r2_key, rows[0].output_docx_r2_key]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/ocr/[id]",
      method: "DELETE",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
