/**
 * Client-side error reporter. Sends errors to /api/errors/report.
 * Fire-and-forget — never throws.
 */
export function reportError(
  message: string,
  metadata?: Record<string, unknown>,
  error?: unknown
): void {
  const stack = error instanceof Error ? error.stack : undefined;

  fetch("/api/errors/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, stack, metadata }),
  }).catch(() => {
    // Silently fail — can't do much if error reporting itself fails
  });
}
