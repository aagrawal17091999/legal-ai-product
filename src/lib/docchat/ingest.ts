/**
 * Async ingestion for workspace documents (Feature 1).
 *
 * Runs after upload, off the request that created the document row: read the
 * file from R2 → extract text (with OCR fallback) → chunk → embed in Voyage
 * batches → store in document_chunks tagged with workspace_id + document_id.
 * The document's `status` column drives the UI (processing → ready/failed).
 *
 * This can take minutes for a multi-page scan (vision OCR + embedding), which is
 * why it never runs inline in the upload request.
 */

import pool from "../db";
import { getR2Object } from "../r2";
import { embedBatch } from "../voyage";
import { extractDocument } from "../extract";
import { flattenPages, chunkText } from "../extract/chunk";
import { logError } from "../error-logger";

const EMBED_BATCH = 128; // Voyage per-call cap

export async function ingestDocument(documentId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, filename, mime, r2_key, status
       FROM workspace_documents WHERE id = $1`,
    [documentId]
  );
  if (rows.length === 0) return;
  const doc = rows[0];
  if (doc.status === "ready") return;

  await pool.query(
    `UPDATE workspace_documents SET status = 'processing', error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [documentId]
  );

  try {
    const buffer = await getR2Object(doc.r2_key);
    const extracted = await extractDocument(buffer, doc.mime, doc.filename);

    if (!extracted.text.trim()) {
      throw new Error("No extractable text (document may be empty or unreadable).");
    }

    // Flatten once and keep the flattened text: chunk offsets index into it, and
    // the source panel re-reads it to expand cited chunks back to whole sentences.
    const flat = flattenPages(extracted.pages);
    const chunks = chunkText(flat);
    if (chunks.length === 0) {
      throw new Error("Document produced no chunks.");
    }

    // Embed in batches, preserving order.
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH).map((c) => c.text);
      const vecs = await embedBatch(batch);
      embeddings.push(...vecs);
    }

    // Replace any prior chunks for this document (idempotent re-ingest), then
    // insert fresh in a transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM document_chunks WHERE document_id = $1`, [documentId]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await client.query(
          `INSERT INTO document_chunks
             (workspace_id, document_id, chunk_index, page_no, chunk_text,
              start_offset, end_offset, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
          [
            doc.workspace_id, documentId, c.chunkIndex, c.pageNo, c.text,
            c.startOffset, c.endOffset, `[${embeddings[i].join(",")}]`,
          ]
        );
      }
      await client.query(
        `UPDATE workspace_documents
            SET status = 'ready', page_count = $2, ocr_used = $3, char_count = $4,
                chunk_count = $5, full_text = $6, error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [documentId, extracted.pageCount, extracted.ocrUsed, extracted.charCount, chunks.length, flat.text]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE workspace_documents SET status = 'failed', error = $2, updated_at = NOW()
        WHERE id = $1`,
      [documentId, message]
    );
    logError({
      category: "extraction",
      message: `Document ingestion failed: ${message}`,
      error: err,
      severity: "error",
      metadata: { feature: "docchat_ingest", documentId },
    });
  }
}
