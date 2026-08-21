import pool from "./db";
import { getRequestContext } from "./request-context";
import { log } from "./logger";

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
  // Emit to stdout FIRST, unconditionally. The DB insert below is the thing
  // most likely to be unavailable in exactly the incident you need this record
  // for — a Postgres outage previously meant the error vanished into an
  // unstructured console.error. The stdout line is scraped to Loki independently
  // of the database, so the trail survives.
  const ctx = getRequestContext();
  log("error", params.message, {
    category: params.category,
    severity: params.severity ?? "error",
    endpoint: params.endpoint ?? ctx?.endpoint,
    method: params.method ?? ctx?.method,
    userId: params.userId ?? ctx?.userId ?? undefined,
    stack: params.error instanceof Error ? params.error.stack : undefined,
    ...(params.metadata ?? {}),
  });

  _insertError(params).catch((insertErr) => {
    console.error("[error-logger] Failed to persist error log:", insertErr);
    console.error("[error-logger] Original error:", params.message);
  });
}

async function _insertError(params: LogErrorParams): Promise<void> {
  const stackTrace =
    params.error instanceof Error ? params.error.stack ?? null : null;

  // Ambient request context fills in what the call site didn't pass. Explicit
  // arguments always win — a caller that names a userId means that user, even
  // if it isn't the one who made the request (e.g. an admin acting on someone
  // else's account). Undefined outside a request: cron ticks, scripts and the
  // pipeline log with no context, which is correct, not a gap.
  const ctx = getRequestContext();
  const userId = params.userId ?? ctx?.userId ?? null;
  const metadata = { ...(params.metadata ?? {}) };
  // Lets a row be traced back to the pm2 log lines for the same request.
  if (ctx?.requestId && metadata.requestId === undefined) {
    metadata.requestId = ctx.requestId;
  }

  await pool.query(
    `INSERT INTO error_logs
       (category, severity, message, stack_trace, metadata, user_id, endpoint, method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.category,
      params.severity ?? "error",
      params.message,
      stackTrace,
      JSON.stringify(metadata),
      userId,
      params.endpoint ?? ctx?.endpoint ?? null,
      params.method ?? ctx?.method ?? null,
    ]
  );
}
