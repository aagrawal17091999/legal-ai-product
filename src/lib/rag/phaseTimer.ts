import type { PipelineStepName, PipelineStepRecord } from "./pipeline";

/**
 * Per-phase timing for one agent turn.
 *
 * Before this existed the audit wrote a single `generate` row whose
 * `duration_ms` was the WHOLE request (measured from before the agent started),
 * so it double-counted every tool row and told you nothing about where the time
 * inside a 5-minute turn actually went. Model rounds, the decompose call, the
 * reflect call, the grounding judge and the revision rewrite were all invisible.
 *
 * Every model call in the loop is now wrapped in `time()`, and the records land
 * in `rag_pipeline_steps` alongside the tool rows. That makes per-phase p50/p95
 * queryable across real traffic, which is the only honest basis for deciding
 * what to optimise next.
 */

/** Phases we time inside the agent loop. Kept narrow so the audit stays legible. */
export type AgentPhase = Extract<
  PipelineStepName,
  | "decompose"
  | "model_round"
  | "reflect"
  | "grounding_judge"
  | "revision"
  | "generate"
>;

export interface PhaseRecord {
  phase: AgentPhase;
  started_at: string;
  duration_ms: number;
  status: "success" | "error";
  error: string | null;
  data: Record<string, unknown>;
}

export class PhaseTimer {
  private readonly records: PhaseRecord[] = [];

  /**
   * Time `fn`, recording one row. `data` may be a plain object or a function of
   * the result, so callers can record token counts they only learn afterwards.
   * Errors are recorded and rethrown — the caller keeps its own error handling.
   */
  async time<T>(
    phase: AgentPhase,
    fn: () => Promise<T>,
    data?: Record<string, unknown> | ((result: T) => Record<string, unknown>)
  ): Promise<T> {
    const startedAtMs = Date.now();
    const started_at = new Date(startedAtMs).toISOString();
    try {
      const result = await fn();
      this.records.push({
        phase,
        started_at,
        duration_ms: Date.now() - startedAtMs,
        status: "success",
        error: null,
        data: typeof data === "function" ? data(result) : (data ?? {}),
      });
      return result;
    } catch (err) {
      this.records.push({
        phase,
        started_at,
        duration_ms: Date.now() - startedAtMs,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        data: typeof data === "function" ? {} : (data ?? {}),
      });
      throw err;
    }
  }

  list(): PhaseRecord[] {
    return [...this.records];
  }

  /** Total wall time attributed to a phase across the turn. */
  totalFor(phase: AgentPhase): number {
    return this.records
      .filter((r) => r.phase === phase)
      .reduce((sum, r) => sum + r.duration_ms, 0);
  }

  /** Compact {phase: total_ms} rollup, for the turn-level summary row. */
  rollup(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.records) out[r.phase] = (out[r.phase] ?? 0) + r.duration_ms;
    return out;
  }
}

/** Convert timing records into audit rows, numbered from `startOrder`. */
export function phaseStepRecords(
  records: PhaseRecord[],
  startOrder: number
): PipelineStepRecord[] {
  return records.map((r, i) => ({
    step_order: startOrder + i,
    step: r.phase,
    status: r.status,
    duration_ms: r.duration_ms,
    started_at: r.started_at,
    error: r.error,
    data: r.data,
  }));
}
