import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import pool from "@/lib/db";
import { getSignedPdfUrl } from "@/lib/r2";
import { logError } from "@/lib/error-logger";

// GET /api/judgments/download?source=supreme_court_cases&id=123
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const source = params.get("source");
  const id = params.get("id");

  if (!source || !id || !["supreme_court_cases", "high_court_cases"].includes(source)) {
    return NextResponse.json({ error: "Invalid source or id parameter" }, { status: 400 });
  }

  try {
    if (source === "supreme_court_cases") {
      const { rows } = await pool.query(
        `SELECT path, year FROM supreme_court_cases WHERE id = $1`,
        [id]
      );
      if (rows.length === 0 || !rows[0].path || !rows[0].year) {
        return NextResponse.json({ error: "PDF not found" }, { status: 404 });
      }
      const pdfKey = `supreme-court/${rows[0].year}/${rows[0].path}_EN.pdf`;
      const url = await getSignedPdfUrl(pdfKey);
      return NextResponse.json({ url });
    }

    // High Court cases
    const { rows } = await pool.query(
      `SELECT pdf_url, pdf_link FROM high_court_cases WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }
    const url = rows[0].pdf_url || rows[0].pdf_link;
    if (!url) {
      return NextResponse.json({ error: "PDF not available for this case" }, { status: 404 });
    }
    return NextResponse.json({ url });
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
