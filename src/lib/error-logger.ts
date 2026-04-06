import pool from "./db";

export type ErrorCategory =
  | "extraction"
  | "fetching"
  | "search"
  | "auth"
  | "payment"
  | "chat"
  | "database"
  | "pipeline"
  | "frontend";

export type ErrorSeverity = "warning" | "error" | "critical";

export interface LogErrorParams {
  category: ErrorCategory;
  message: string;
  severity?: ErrorSeverity;
  error?: unknown;
  metadata?: Record<string, unknown>;
  userId?: number | null;
  endpoint?: string;
  method?: string;
}

/**
 * Fire-and-forget error logger. Never throws, never blocks the caller.
 * Falls back to console.error if the DB insert fails.
 */
export function logError(params: LogErrorParams): void {
  _insertError(params).catch((insertErr) => {
    console.error("[error-logger] Failed to persist error log:", insertErr);
    console.error("[error-logger] Original error:", params.message);
  });
}

async function _insertError(params: LogErrorParams): Promise<void> {
  const stackTrace =
    params.error instanceof Error ? params.error.stack ?? null : null;

  await pool.query(
    `INSERT INTO error_logs
       (category, severity, message, stack_trace, metadata, user_id, endpoint, method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.category,
      params.severity ?? "error",
      params.message,
      stackTrace,
      JSON.stringify(params.metadata ?? {}),
      params.userId ?? null,
      params.endpoint ?? null,
      params.method ?? null,
    ]
  );
}
