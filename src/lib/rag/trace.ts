import pool from "../db";
import { logError } from "../error-logger";
import type { PipelineStepRecord, QueryEmbeddingRecord } from "./pipeline";

/**
 * Persist per-stage RAG audit rows for a single assistant message.
 *
 * - rag_pipeline_steps  — one row per PipelineStepRecord (5 from the pipeline
 *                         + 1 `generate` row appended by the route handler).
 * - rag_query_embeddings — one row per rewritten/HyDE query, storing the raw
 *                          query-side embedding vector as pgvector.
 *
 * Both writes are best-effort: a persistence failure is logged but never
 * surfaced to the user. The chat response has already been streamed by the
 * time this runs, so there is nothing useful to do with an error here.
 */
export async function persistPipelineAudit(
  chatMessageId: string,
  steps: PipelineStepRecord[],
  queryEmbeddings: QueryEmbeddingRecord[]
): Promise<void> {
  await Promise.all([
    persistSteps(chatMessageId, steps),
    persistQueryEmbeddings(chatMessageId, queryEmbeddings),
  ]);
}

async function persistSteps(
  chatMessageId: string,
  steps: PipelineStepRecord[]
): Promise<void> {
  if (steps.length === 0) return;

  // Bulk insert: one multi-row VALUES clause, one round-trip.
  const cols = "(message_id, step_order, step, status, duration_ms, error, data, created_at)";
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const s of steps) {
    placeholders.push(
      `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`
    );
    params.push(
      chatMessageId,
      s.step_order,
      s.step,
      s.status,
      s.duration_ms,
      s.error,
      JSON.stringify(s.data),
      s.started_at
    );
  }

  const sql = `INSERT INTO rag_pipeline_steps ${cols} VALUES ${placeholders.join(", ")}`;
  try {
    await pool.query(sql, params);
  } catch (err) {
    logError({
      category: "database",
      message: `failed to persist rag_pipeline_steps: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { chatMessageId, stepCount: steps.length },
    });
  }
}

async function persistQueryEmbeddings(
  chatMessageId: string,
  embeddings: QueryEmbeddingRecord[]
): Promise<void> {
  if (embeddings.length === 0) return;

  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const e of embeddings) {
    placeholders.push(
      `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}::vector)`
    );
    params.push(
      chatMessageId,
      e.query_index,
      e.query_type,
      e.query_text,
      `[${e.embedding.join(",")}]`
    );
  }

  const sql = `
    INSERT INTO rag_query_embeddings
      (message_id, query_index, query_type, query_text, embedding)
    VALUES ${placeholders.join(", ")}
  `;
  try {
    await pool.query(sql, params);
  } catch (err) {
    logError({
      category: "database",
      message: `failed to persist rag_query_embeddings: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { chatMessageId, embeddingCount: embeddings.length },
    });
  }
}
