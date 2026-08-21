/**
 * Turn a persisted internal error into something worth showing a user.
 *
 * `chat_messages.error` and `workspace_messages.error` store the raw failure so
 * it is debuggable — in practice that means provider payloads like
 * `400 {"type":"error","error":{"type":"invalid_request_error", ...}}`. That is
 * exactly what we want in the database and exactly what we must not paste into
 * a chat bubble: it tells the user nothing, and it leaks our provider and
 * request internals.
 *
 * So: keep the raw text on the row and in error_logs, and run it through here on
 * the way to the screen. Messages we authored ourselves (already written for a
 * user) pass through untouched.
 */

/** Does this read like an internal/provider error rather than authored prose? */
function looksInternal(raw: string): boolean {
  return (
    raw.includes("{") ||
    raw.includes('"type":') ||
    /^\d{3}\b/.test(raw) || // "400 …", "529 …"
    /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|fetch failed|socket hang up)\b/i.test(raw) ||
    /\bat\s+\w+\s+\(/.test(raw) || // a stack frame leaked into the message
    raw.length > 160
  );
}

const GENERIC = "Something went wrong generating this answer. Please try again.";

/**
 * @param raw the stored error text (or null)
 * @returns a sentence safe to render, or null when there is nothing to say
 */
export function userFacingError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  // Not a failure — the user pressed Stop.
  if (text === "cancelled") return null;

  // Authored for a user already ("Upload and process at least one document
  // first.", "The connection to the server was lost…") — don't mangle it.
  if (!looksInternal(text)) return text;

  const lower = text.toLowerCase();

  if (lower.includes("overloaded") || /\b529\b/.test(text)) {
    return "The AI service is busy right now. Please try again in a moment.";
  }
  if (lower.includes("rate_limit") || /\b429\b/.test(text)) {
    return "We've hit a temporary rate limit. Please try again in a moment.";
  }
  if (
    lower.includes("prompt is too long") ||
    lower.includes("context_length") ||
    lower.includes("max_tokens") ||
    lower.includes("too many tokens")
  ) {
    return "This conversation has grown too long to process. Please start a new chat and ask again.";
  }
  if (lower.includes("invalid_request_error") || /\b400\b/.test(text)) {
    return "This question couldn't be processed. Try rephrasing it, or start a new chat.";
  }
  if (lower.includes("authentication") || /\b401\b|\b403\b/.test(text)) {
    return "Your session has expired. Please sign in again.";
  }
  if (
    /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|fetch failed|socket hang up)\b/i.test(text) ||
    lower.includes("timeout") ||
    lower.includes("aborted")
  ) {
    return "The connection dropped before this answer finished. Please try again.";
  }
  return GENERIC;
}
