import { NextRequest, NextResponse, after } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { uploadToR2 } from "@/lib/r2";
import { ingestDocument } from "@/lib/docchat/ingest";
import { expireStaleDocuments } from "@/lib/docchat/expire";
import { detectKind } from "@/lib/extract";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import { MAX_FILE_BYTES, tooLargeMessage } from "@/lib/uploads";

// Ingestion (OCR + embedding) runs in after(); give it room for multi-page scans.
export const maxDuration = 300;

// Per-workspace ingestion quota. Caps storage + embedding cost per workspace and
// stops a single workspace from monopolising the queue.
const MAX_DOCS_PER_WORKSPACE = 50;
// NOTE: workspace_documents has no stored byte-size column (only char_count,
// which is post-extraction text length, not upload bytes), so a *total*-bytes
// cap can't be enforced from the DB. We enforce it against the bytes of THIS
// upload batch instead; the per-file MAX_FILE_BYTES already bounds each file.
const MAX_BYTES_PER_WORKSPACE = 500 * 1024 * 1024; // 500 MB
const ACCEPTED = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function acceptedFile(name: string, type: string): boolean {
  if (ACCEPTED.has((type || "").toLowerCase())) return true;
  return /\.(pdf|docx|jpe?g|png|webp)$/i.test(name || "");
}

async function ownWorkspace(userId: number, workspaceId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM workspaces WHERE id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
  return rows.length > 0;
}

// POST /api/workspace/[id]/documents — upload one or more documents (multipart)
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  const { id: workspaceId } = await ctx.params;
  if (!(await ownWorkspace(user.id, workspaceId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const files = [...form.getAll("files"), ...form.getAll("file")].filter(
    (f): f is File => f instanceof File
  );
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  // Per-workspace ingestion quota. Reject the whole batch up front if accepting
  // it would push the workspace past its document-count cap, or if the batch's
  // own size exceeds the per-workspace byte budget (see MAX_BYTES_PER_WORKSPACE
  // note — no stored byte column to sum against).
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM workspace_documents WHERE workspace_id = $1`,
    [workspaceId]
  );
  const existingDocs = countRows[0].n;
  if (existingDocs + files.length > MAX_DOCS_PER_WORKSPACE) {
    return NextResponse.json(
      {
        error: `This workspace can hold at most ${MAX_DOCS_PER_WORKSPACE} documents (it has ${existingDocs}). Delete some before uploading ${files.length} more.`,
      },
      { status: 400 }
    );
  }
  const batchBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (batchBytes > MAX_BYTES_PER_WORKSPACE) {
    return NextResponse.json(
      { error: `This upload exceeds the ${Math.round(MAX_BYTES_PER_WORKSPACE / (1024 * 1024))} MB per-workspace limit.` },
      { status: 400 }
    );
  }

  const created: Array<{ id: string; filename: string; status: string }> = [];
  const documentIds: string[] = [];

  try {
    for (const file of files) {
      if (!acceptedFile(file.name, file.type)) {
        return NextResponse.json(
          { error: `Unsupported file type: ${file.name}. Accepted: PDF, DOCX, JPG, PNG.` },
          { status: 400 }
        );
      }
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: tooLargeMessage(file.name) },
          { status: 400 }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const mime =
        file.type ||
        (detectKind("", file.name) === "pdf" ? "application/pdf" : "application/octet-stream");
      const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
      const key = `workspaces/${workspaceId}/${globalThis.crypto.randomUUID()}-${safeName}`;

      await uploadToR2(key, buffer, mime);

      const { rows } = await pool.query(
        `INSERT INTO workspace_documents (workspace_id, user_id, filename, mime, r2_key, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id, filename, status`,
        [workspaceId, user.id, file.name, mime, key]
      );
      created.push(rows[0]);
      documentIds.push(rows[0].id);
      track(EVENTS.DOCUMENT_UPLOADED, {
        userId: user.id,
        insertId: `doc_upload:${rows[0].id}`,
        // Size and type only; the filename can carry a client or matter name.
        properties: { file_bytes: file.size, mime },
      });
    }

    await pool.query(`UPDATE workspaces SET updated_at = NOW() WHERE id = $1`, [workspaceId]);

    // Process (extract → chunk → embed) off the response. Sequential to bound
    // memory/concurrency on the OCR + embedding calls.
    after(async () => {
      for (const docId of documentIds) {
        const startedAt = Date.now();
        // ingestDocument records failures on the row itself, but it can still
        // throw if that very bookkeeping fails (DB down mid-ingest). Left
        // unhandled, the document would sit on `processing` until the watchdog
        // swept it 15 minutes later, so settle it here instead — the user sees
        // the failure on their next poll rather than a stuck spinner.
        try {
          await ingestDocument(docId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError({
            category: "extraction",
            message: `Document ingestion threw outside its own handler: ${message}`,
            error: err,
            severity: "critical",
            userId: user.id,
            endpoint: "/api/workspace/[id]/documents",
            method: "POST",
            metadata: { workspaceId, documentId: docId },
          });
          await pool
            .query(
              `UPDATE workspace_documents
                  SET status = 'failed', error = $2, updated_at = NOW()
                WHERE id = $1 AND status <> 'ready'`,
              [docId, "Processing failed unexpectedly. Please try uploading this document again."]
            )
            .catch(() => {
              /* the DB is the thing that failed — the watchdog is the backstop */
            });
        }
        // ingestDocument owns its own error handling and records the outcome on
        // the row, so read the settled status back rather than assuming success.
        try {
          const { rows: after } = await pool.query<{ status: string }>(
            `SELECT status FROM workspace_documents WHERE id = $1`,
            [docId]
          );
          const settled = after[0]?.status;
          if (settled === "ready" || settled === "failed") {
            track(settled === "ready" ? EVENTS.DOCUMENT_READY : EVENTS.DOCUMENT_FAILED, {
              userId: user.id,
              insertId: `doc_ingest:${docId}`,
              properties: { duration_ms: Date.now() - startedAt },
            });
          }
        } catch {
          // Best-effort: never let analytics abort the remaining ingestions.
        }
      }
    });

    return NextResponse.json({ documents: created });
  } catch (err) {
    logError({
      category: "fetching",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      userId: user.id,
      endpoint: "/api/workspace/[id]/documents",
      method: "POST",
      metadata: { workspaceId },
    });
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}

// GET /api/workspace/[id]/documents — list documents + status (for polling)
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  const { id: workspaceId } = await ctx.params;
  if (!(await ownWorkspace(user.id, workspaceId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Settle documents whose ingestion died with the process before reporting
  // status, so a poll that would otherwise spin on "Processing" forever returns
  // a terminal `failed` with a reason attached.
  await expireStaleDocuments(workspaceId);

  const { rows } = await pool.query(
    `SELECT id, filename, mime, status, page_count, ocr_used, char_count, chunk_count, error, created_at
       FROM workspace_documents WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [workspaceId]
  );
  return NextResponse.json({ documents: rows });
}
