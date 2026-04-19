/**
 * Shared RAG audit types.
 *
 * The old pipeline (router → embed → retrieve → rerank → context → generate)
 * was replaced by the agentic loop in `./agent.ts`. This file now only hosts
 * the step/embedding record shapes used by the audit layer (`./trace.ts`)
 * and the agent's audit adapter — everything else was deleted.
 */

export type PipelineStepName =
  | "understand"
  | "embed_queries"
  | "retrieve"
  | "rerank"
  | "context_build"
  | "generate"
  | "agent_start"
  | "tool_call";

export type PipelineStepStatus = "success" | "error" | "fallback" | "skipped";

export interface PipelineStepRecord {
  step_order: number;
  step: PipelineStepName;
  status: PipelineStepStatus;
  duration_ms: number;
  started_at: string;
  error: string | null;
  data: Record<string, unknown>;
}

export interface QueryEmbeddingRecord {
  query_index: number;
  query_type: "rewritten" | "hyde";
  query_text: string;
  embedding: number[];
}
