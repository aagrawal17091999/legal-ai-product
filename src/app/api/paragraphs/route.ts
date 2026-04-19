import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import type { ParagraphDetail } from "@/types";

// GET /api/paragraphs?source_table=...&source_id=...&paragraph_number=...
//
// Returns the stored paragraph for a citation pinpoint like `[^n, ¶p]`, used
// by the chat CitationPanel. If `¶11b` isn't found directly, falls back to
// the parent `¶11` — same rule the citation validator uses at
// src/lib/rag/citationValidator.ts:73-75, so anything the model was allowed
// to emit is fetchable here.
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const sourceTable = params.get("source_table");
  const sourceIdRaw = params.get("source_id");
  const paragraphNumber = params.get("paragraph_number");

  if (
    !sourceTable ||
    !sourceIdRaw ||
    !paragraphNumber ||
    !["supreme_court_cases", "high_court_cases"].includes(sourceTable)
  ) {
    return NextResponse.json(
      { error: "source_table, source_id, and paragraph_number are required" },
      { status: 400 }
    );
  }

  const sourceId = parseInt(sourceIdRaw, 10);
  if (!Number.isFinite(sourceId)) {
    return NextResponse.json({ error: "source_id must be an integer" }, { status: 400 });
  }

  try {
    const lookup = async (p: string) =>
      pool.query(
        `SELECT paragraph_number, paragraph_text, paragraph_order, kind
           FROM case_paragraphs
          WHERE source_table = $1 AND source_id = $2 AND paragraph_number = $3
          LIMIT 1`,
        [sourceTable, sourceId, p]
      );

    let matchedAs: "exact" | "parent" = "exact";
    let { rows } = await lookup(paragraphNumber);

    if (rows.length === 0) {
      const parent = paragraphNumber.replace(/[A-Za-z]$/, "");
      if (parent && parent !== paragraphNumber) {
        const fallback = await lookup(parent);
        if (fallback.rows.length > 0) {
          rows = fallback.rows;
          matchedAs = "parent";
        }
      }
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: "Paragraph not found" }, { status: 404 });
    }

    const row = rows[0];
    const detail: ParagraphDetail = {
      source_table: sourceTable as ParagraphDetail["source_table"],
      source_id: sourceId,
      paragraph_number: row.paragraph_number,
      paragraph_text: row.paragraph_text,
      paragraph_order: row.paragraph_order,
      kind: row.kind,
      matched_as: matchedAs,
    };
    return NextResponse.json(detail);
  } catch (err) {
    logError({
      category: "search",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/paragraphs",
      method: "GET",
      metadata: { sourceTable, sourceId, paragraphNumber },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
