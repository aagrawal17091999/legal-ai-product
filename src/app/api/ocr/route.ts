import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { requireCredits, OutOfCreditsError } from "@/lib/billing/credits";
import pool from "@/lib/db";
import { uploadToR2 } from "@/lib/r2";
import { expireStaleOcrJobs } from "@/lib/ocr/expire";
import { planBatches } from "@/lib/vision/structured";
import { enqueueBatches } from "@/lib/jobs/batches";
import { isSarvamEnabled, sarvamCanRead } from "@/lib/sarvam/client";
import { mirrorJobStatus } from "@/lib/firebase-admin";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import { MAX_FILE_BYTES, tooLargeMessage } from "@/lib/uploads";

// Upload only splits the document into batch rows; the cron worker
// (/api/cron/process-batches) runs the vision passes and assembles the result.
export const maxDuration = 60;

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

// POST /api/ocr — upload a document; returns a job to poll
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });

  // Gate on credits; batches are metered in the worker (output locked on overshoot).
  try {
    await requireCredits(user.id);
  } catch (e) {
    if (e instanceof OutOfCreditsError) {
      track(EVENTS.OUT_OF_CREDITS, {
        userId: user.id,
        properties: { feature: "ocr", plan: user.plan },
      });
      return NextResponse.json(
        { error: "insufficient_credits", remaining: e.remaining },
        { status: 402 }
      );
    }
    throw e;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!acceptedFile(file.name, file.type)) {
    return NextResponse.json(
      { error: "Unsupported file type. Accepted: PDF, DOCX, JPG, PNG." },
      { status: 400 }
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: tooLargeMessage() }, { status: 400 });
  }

  const mime = file.type || "application/pdf";
  const buffer: Buffer = Buffer.from(await file.arrayBuffer());

  try {
    // Plan the page-range batches up front so an over-cap document is rejected
    // here (same 400 as before) rather than failing later in the worker.
    const plan = await planBatches(buffer, mime, file.name);

    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
    const key = `ocr/${user.id}/src/${globalThis.crypto.randomUUID()}-${safeName}`;
    await uploadToR2(key, buffer, mime);

    const { rows } = await pool.query(
      `INSERT INTO ocr_jobs
         (user_id, source_filename, source_mime, source_r2_key, status)
       VALUES ($1, $2, $3, $4, 'processing')
       RETURNING id, source_filename, status, created_at`,
      [user.id, file.name, mime, key]
    );
    const job = rows[0];

    // Enqueue one batch row per planned page range; the cron worker drains them.
    // PDF/image units are read by Sarvam Doc AI first (jobs/sarvam-ocr.ts) so
    // Claude only has to structure the extracted text. A DOCX has no pixels to
    // read, and Sarvam can't read every format we accept (WebP), so those go
    // straight to Claude.
    await enqueueBatches(
      job.id,
      "ocr",
      plan.batches,
      isSarvamEnabled() && plan.kind !== "text" && sarvamCanRead(mime, file.name)
    );
    track(EVENTS.OCR_STARTED, {
      userId: user.id,
      insertId: `ocr_start:${job.id}`,
      properties: {
        // Shape and size only — never the filename, which routinely carries a
        // client or matter name.
        pages: plan.totalPages,
        batches: plan.batches.length,
        source_kind: plan.kind,
        via_sarvam: isSarvamEnabled() && plan.kind !== "text" && sarvamCanRead(mime, file.name),
        file_bytes: file.size,
      },
    });

    // Seed the Firestore mirror so the client can subscribe immediately. ownerUid
    // is the Firebase uid the security rule checks; the worker updates status.
    await mirrorJobStatus("ocr", job.id, { ownerUid: decoded.uid, status: "processing" });

    // Credits are debited per batch in the worker as the vision passes run.
    return NextResponse.json({ job });
  } catch (err) {
    // planBatches throws user-facing validation messages (over page cap,
    // password-protected, or no pages) — surface them as a 400, not a 500.
    if (
      err instanceof Error &&
      /supports up to|password-protected|no pages/.test(err.message)
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logError({
      category: "fetching",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      userId: user.id,
      endpoint: "/api/ocr",
      method: "POST",
    });
    return NextResponse.json({ error: "OCR request failed" }, { status: 500 });
  }
}

// GET /api/ocr — list the user's OCR jobs
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  // Fail any job whose background task died and left it stuck `processing`.
  await expireStaleOcrJobs(user.id);
  const { rows } = await pool.query(
    `SELECT id, source_filename, detected_language, status,
            segment_count, flagged_count, ocr_used, error, created_at
       FROM ocr_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [user.id]
  );
  return NextResponse.json({ jobs: rows });
}
