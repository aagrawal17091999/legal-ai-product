import { NextRequest, NextResponse, after } from "next/server";
import { verifyAuth, getRequestUser, checkQueryLimit, incrementQueryCount } from "@/lib/auth";
import pool from "@/lib/db";
import { uploadToR2 } from "@/lib/r2";
import { processOcr } from "@/lib/ocr/process";
import { expireStaleOcrJobs } from "@/lib/ocr/expire";
import { subsetPdfByRanges } from "@/lib/ocr/pages";
import { logError } from "@/lib/error-logger";

// Vision OCR pass + PDF/DOCX render run in after().
export const maxDuration = 300;

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

// POST /api/ocr — upload a document; returns a job to poll
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });

  const { allowed, remaining } = await checkQueryLimit(user.id);
  if (!allowed) return NextResponse.json({ error: "limit_reached", remaining }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const pageRange = String(form.get("pageRange") || "").trim();
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
    return NextResponse.json({ error: "File exceeds the 25 MB limit." }, { status: 400 });
  }

  const mime = file.type || "application/pdf";
  const isPdf = mime.toLowerCase() === "application/pdf" || /\.pdf$/i.test(file.name);

  // Page-range selection only applies to PDFs. Subset here (at upload) so the
  // stored source — and everything the OCR pipeline sees — is just the selected
  // pages. A malformed/out-of-bounds range is rejected up front with a 400.
  let buffer: Buffer = Buffer.from(await file.arrayBuffer());
  if (pageRange && isPdf) {
    try {
      const { buffer: subset } = await subsetPdfByRanges(buffer, pageRange);
      buffer = subset;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid page range." },
        { status: 400 }
      );
    }
  }

  try {
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

    await incrementQueryCount(user.id);
    after(() => processOcr(job.id));

    return NextResponse.json({ job });
  } catch (err) {
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
