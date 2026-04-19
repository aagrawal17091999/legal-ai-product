import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

/**
 * Daily retention job for the RAG audit tables.
 *
 * Why: rag_pipeline_steps grows ~5 rows per assistant turn × 1–5 KB JSONB
 * each. chat_messages.rag_trace adds another few KB per turn. Left alone,
 * this compounds into 10s of GB/year at modest traffic. Debug signal on
 * turns older than 30 days is rarely useful (bug reports come in within
 * days, not months), so we reclaim the storage.
 *
 * Schedule: vercel.json runs this at 03:00 UTC daily.
 *
 * Auth: reads CRON_SECRET from env and compares to the Authorization header.
 * Vercel's cron runner auto-attaches it when the env var is set on the
 * project. In dev you can hit the endpoint manually:
 *   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/rag-retention
 *
 * What it cleans:
 *   - rag_pipeline_steps older than 30 days → hard delete
 *   - trace_access_log older than 30 days → hard delete
 *   - chat_messages.rag_trace on turns older than 30 days → set NULL
 *     (keeps the message visible in chat history; drops only the audit blob)
 */

const RETENTION_DAYS = 30;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logError({
      category: "chat",
      message: "CRON_SECRET not set — retention job refusing to run",
      severity: "critical",
      endpoint: "/api/cron/rag-retention",
    });
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stepsRes = await pool.query(
      `DELETE FROM rag_pipeline_steps
        WHERE created_at < NOW() - ($1::int || ' days')::interval`,
      [RETENTION_DAYS]
    );
    const accessRes = await pool.query(
      `DELETE FROM trace_access_log
        WHERE created_at < NOW() - ($1::int || ' days')::interval`,
      [RETENTION_DAYS]
    );
    const traceRes = await pool.query(
      `UPDATE chat_messages
          SET rag_trace = NULL
        WHERE rag_trace IS NOT NULL
          AND created_at < NOW() - ($1::int || ' days')::interval`,
      [RETENTION_DAYS]
    );

    return NextResponse.json({
      status: "ok",
      retention_days: RETENTION_DAYS,
      deleted: {
        rag_pipeline_steps: stepsRes.rowCount ?? 0,
        trace_access_log: accessRes.rowCount ?? 0,
      },
      nulled: {
        chat_messages_rag_trace: traceRes.rowCount ?? 0,
      },
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      endpoint: "/api/cron/rag-retention",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
