import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { getSignedPdfUrl } from "@/lib/r2";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";

// GET /api/judgments/download?source=supreme_court_cases&id=123
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const source = params.get("source");
  const id = params.get("id");
  // When ?redirect=1, 307 straight to the signed URL so a plain <a> link opens
  // the PDF directly; otherwise return the URL as JSON for fetch() callers.
  const redirect = params.get("redirect") === "1";

  if (!source || !id || !["supreme_court_cases", "high_court_cases"].includes(source)) {
    return NextResponse.json({ error: "Invalid source or id parameter" }, { status: 400 });
  }

  // High-Court pdf_url/pdf_link are stored corpus values that legitimately point
  // at external court websites (not our R2), so we can't allowlist a single host.
  // The open-redirect surface that matters is a malformed/hostile scheme
  // (javascript:, data:, protocol-relative) bouncing an authed user somewhere
  // unexpected. Permit a redirect ONLY to an absolute http(s) URL with a real
  // host; everything else returns the URL as JSON instead of 307-ing to it.
  // (SC mints its own signed https R2 URL, so it always passes.)
  const isSafeRedirectUrl = (url: string): boolean => {
    try {
      const u = new URL(url);
      return (u.protocol === "https:" || u.protocol === "http:") && u.host.length > 0;
    } catch {
      return false;
    }
  };
  const respond = (url: string) => {
    if (!redirect) return NextResponse.json({ url });
    if (!isSafeRedirectUrl(url)) {
      // Fall back to JSON rather than 307-ing to an unsafe/malformed target.
      return NextResponse.json({ url });
    }
    return NextResponse.redirect(url, 307);
  };

  // Records the attempt whether or not a PDF exists — a missing PDF is exactly
  // the case worth seeing.
  const recordDownload = async (props: Record<string, unknown>) => {
    try {
      const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
      track(EVENTS.JUDGMENT_DOWNLOADED, {
        userId: user.id,
        properties: { source, case_id: id, opened_via_link: redirect, ...props },
      });
    } catch {
      /* analytics must not fail the download */
    }
  };

  try {
    if (source === "supreme_court_cases") {
      const { rows } = await pool.query(
        `SELECT path, year, title, extracted_citation FROM supreme_court_cases WHERE id = $1`,
        [id]
      );
      const found = rows.length > 0 && Boolean(rows[0].path) && Boolean(rows[0].year);
      await recordDownload({
        case_title: rows[0]?.title,
        case_citation: rows[0]?.extracted_citation,
        court: "Supreme Court of India",
        year: rows[0]?.year,
        pdf_available: found,
      });
      if (!found) {
        return NextResponse.json({ error: "PDF not found" }, { status: 404 });
      }
      const pdfKey = `supreme-court/${rows[0].year}/${rows[0].path}_EN.pdf`;
      const url = await getSignedPdfUrl(pdfKey);
      return respond(url);
    }

    // High Court cases
    const { rows } = await pool.query(
      `SELECT pdf_url, pdf_link, title, extracted_citation, court_name, year
         FROM high_court_cases WHERE id = $1`,
      [id]
    );
    const url = rows[0] ? rows[0].pdf_url || rows[0].pdf_link : null;
    await recordDownload({
      case_title: rows[0]?.title,
      case_citation: rows[0]?.extracted_citation,
      court: rows[0]?.court_name,
      year: rows[0]?.year,
      pdf_available: Boolean(url),
    });
    if (rows.length === 0) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }
    if (!url) {
      return NextResponse.json({ error: "PDF not available for this case" }, { status: 404 });
    }
    return respond(url);
  } catch (err) {
    logError({
      category: "search",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/judgments/download",
      method: "GET",
      metadata: { source, id },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
