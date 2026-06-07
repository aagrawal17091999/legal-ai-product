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

    const parent = paragraphNumber.replace(/[A-Za-z]$/, "");

    let matchedAs: "exact" | "parent" | "chunk" = "exact";
    let { rows } = await lookup(paragraphNumber);

    if (rows.length === 0 && parent && parent !== paragraphNumber) {
      const fallback = await lookup(parent);
      if (fallback.rows.length > 0) {
        rows = fallback.rows;
        matchedAs = "parent";
      }
    }

    if (rows.length > 0) {
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
    }

    // Fallback: the paragraph isn't individually stored in case_paragraphs, but
    // the validator only lets the model pinpoint paragraphs visible in a
    // retrieval chunk. Return the chunk whose paragraph_numbers contains the
    // requested (or parent) number — the exact passage the model was shown — so
    // the user sees grounded text instead of a "not stored" dead end.
    const chunkLookup = async (p: string) =>
      pool.query(
        `SELECT chunk_text, chunk_index
           FROM case_chunks
          WHERE source_table = $1 AND source_id = $2 AND $3 = ANY(paragraph_numbers)
          ORDER BY chunk_index
          LIMIT 1`,
        [sourceTable, sourceId, p]
      );

    let chunkRows = (await chunkLookup(paragraphNumber)).rows;
    if (chunkRows.length === 0 && parent && parent !== paragraphNumber) {
      chunkRows = (await chunkLookup(parent)).rows;
    }

    if (chunkRows.length > 0) {
      const c = chunkRows[0];
      const detail: ParagraphDetail = {
        source_table: sourceTable as ParagraphDetail["source_table"],
        source_id: sourceId,
        paragraph_number: paragraphNumber,
        paragraph_text: c.chunk_text,
        paragraph_order: c.chunk_index,
        kind: "synthetic",
        matched_as: "chunk",
      };
      return NextResponse.json(detail);
    }

    return NextResponse.json({ error: "Paragraph not found" }, { status: 404 });
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
