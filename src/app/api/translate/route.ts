import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { requireCredits, OutOfCreditsError } from "@/lib/billing/credits";
import pool from "@/lib/db";
import { uploadToR2 } from "@/lib/r2";
import { expireStaleTranslations } from "@/lib/translate/expire";
import { planBatches } from "@/lib/vision/structured";
import { enqueueBatches } from "@/lib/jobs/batches";
import { shouldUseBatchApi } from "@/lib/jobs/batch-api";
import { isSarvamEnabled, sarvamCanRead } from "@/lib/sarvam/client";
import { isSupportedLanguage, LANGUAGE_NAMES } from "@/lib/sarvam/languages";
import { mirrorJobStatus } from "@/lib/firebase-admin";
import { logError } from "@/lib/error-logger";

// Upload only splits the document into batch rows; the cron worker
// (/api/cron/process-batches) runs the vision passes and assembles the result.
export const maxDuration = 60;

const MAX_FILE_BYTES = 25 * 1024 * 1024;
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

// POST /api/translate — upload a document + target language; returns a job to poll
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });

  // Gate on credits: allow the job to start while any balance remains. Its
  // batches are metered in the worker; if they overshoot, the finished output is
  // locked (page count is capped at 150, so a single job's overshoot is bounded).
  try {
    await requireCredits(user.id);
  } catch (e) {
    if (e instanceof OutOfCreditsError) {
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
  const targetLanguage = String(form.get("targetLanguage") || "").trim();
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!targetLanguage) {
    return NextResponse.json({ error: "Target language is required" }, { status: 400 });
  }
  // The picker only offers supported languages, so this catches direct API calls
  // and stale clients rather than normal use.
  if (!isSupportedLanguage(targetLanguage)) {
    return NextResponse.json(
      {
        error: `"${targetLanguage}" is not a supported target language. Supported: ${LANGUAGE_NAMES.join(", ")}.`,
      },
      { status: 400 }
    );
  }
  if (!acceptedFile(file.name, file.type)) {
    return NextResponse.json(
      { error: "Unsupported file type. Accepted: PDF, DOCX, JPG, PNG." },
      { status: 400 }
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "File exceeds the 25 MB limit." }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "application/pdf";

    // Plan the page-range batches up front so an over-cap document is rejected
    // here (same 400 as before) rather than failing later in the worker.
    const plan = await planBatches(buffer, mime, file.name);

    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
    const key = `translations/${user.id}/src/${globalThis.crypto.randomUUID()}-${safeName}`;
    await uploadToR2(key, buffer, mime);

    const { rows } = await pool.query(
      `INSERT INTO translation_jobs
         (user_id, source_filename, source_mime, source_r2_key, target_language, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')
       RETURNING id, source_filename, target_language, status, created_at`,
      [user.id, file.name, mime, key, targetLanguage]
    );
    const job = rows[0];

    // Enqueue one batch row per planned page range; the cron worker drains them.
    // PDF/image units are read by Sarvam Doc AI first (jobs/sarvam-ocr.ts) so
    // Claude only has to translate + structure the extracted text. A DOCX has no
    // pixels, and Sarvam can't read every format we accept (WebP), so those go
    // straight to Claude. Large documents then go to the Anthropic Batch API
    // (cheaper, async); smaller ones stay on the fast synchronous path. See
    // jobs/batch-api.ts.
    await enqueueBatches(
      job.id,
      "translate",
      plan.batches,
      shouldUseBatchApi(plan) ? "batch" : "sync",
      isSarvamEnabled() && plan.kind !== "text" && sarvamCanRead(mime, file.name)
    );
    // Seed the Firestore mirror so the client can subscribe immediately.
    await mirrorJobStatus("translate", job.id, { ownerUid: decoded.uid, status: "processing" });

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
      endpoint: "/api/translate",
      method: "POST",
    });
    return NextResponse.json({ error: "Translation request failed" }, { status: 500 });
  }
}

// GET /api/translate — list the user's translation jobs
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  // Fail any job whose background task died and left it stuck `processing`.
  await expireStaleTranslations(user.id);
  const { rows } = await pool.query(
    `SELECT id, source_filename, target_language, detected_language, status,
            segment_count, flagged_count, ocr_used, error, created_at
       FROM translation_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [user.id]
  );
  return NextResponse.json({ jobs: rows });
}
