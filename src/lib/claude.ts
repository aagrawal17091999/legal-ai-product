import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { logError } from "./error-logger";
import type { ChatMessage } from "@/types";

const CHAT_MODEL = "claude-sonnet-4-5";

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.local.example)"
    );
  }
  return new Anthropic({ apiKey });
}

const SYSTEM_PROMPT = `You are NyayaSearch, an AI legal research assistant specializing in Indian law. You help lawyers, judges, and clerks find and understand relevant case law.

GROUNDING RULES (strict):
- You may only rely on the cases in the SEARCH RESULTS block below. Do not invent case names, citations, holdings, or legal propositions.
- Cite every legal claim inline with a footnote marker like [^1], [^2], corresponding to "Case [1]", "Case [2]" in the SEARCH RESULTS. Place the marker at the end of the sentence it supports.
- If the retrieved cases do not address the question, say so directly. Suggest how the lawyer might refine their query or which filters to add. Never fill gaps with remembered law.
- When multiple cases are relevant, synthesize them — do not just summarize each in isolation. Note agreements, distinctions, and any conflicting holdings.
- When useful, note the jurisdictional weight: a Supreme Court judgment binds all courts in India; a High Court judgment binds subordinate courts within its state. Call this out if the user seems to be arguing in a specific forum.
- Be concise and precise. Lawyers are your users.

RESPONSE FORMAT:
1. A direct answer to the question (2-5 paragraphs, with [^n] citations).
2. If the question has distinct sub-issues, use short markdown headings.
3. End with a "## Cases Referenced" section listing each cited case on its own line as: [n] Title (Citation) — one-line relevance note.

If SEARCH RESULTS is empty or irrelevant, skip the citation format and explain honestly what's missing.`;

/**
 * Streaming chat response. Returns the underlying Anthropic MessageStream so
 * the caller can forward text deltas to an SSE response AND await the final
 * usage/model metadata for tracing.
 *
 * The caller is responsible for:
 *   - stream.on('text', (delta) => ...)    // per-token
 *   - const final = await stream.finalMessage()  // full content + usage
 *   - handling errors via stream.on('error', ...)
 */
export interface ClaudeStreamStart {
  stream: MessageStream;
  contextSent: string;
  model: string;
}

export function streamChatResponse(
  conversationHistory: ChatMessage[],
  contextString: string,
  userMessage: string
): ClaudeStreamStart {
  const client = getClient();

  const recentHistory = conversationHistory.slice(-10);
  const messages: Anthropic.MessageParam[] = recentHistory.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  const augmentedMessage = `SEARCH RESULTS (these are the only cases you may reference; each one has a [n] index for citations):
${contextString || "(no cases retrieved)"}

USER'S CURRENT QUESTION:
${userMessage}`;

  messages.push({ role: "user", content: augmentedMessage });

  const stream = client.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
  });

  // Attach a single error handler that logs but does NOT throw — the caller
  // is expected to handle errors through await finalMessage() rejection.
  stream.on("error", (err) => {
    logError({
      category: "fetching",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      metadata: { model: CHAT_MODEL, messageCount: messages.length },
    });
  });

  return { stream, contextSent: augmentedMessage, model: CHAT_MODEL };
}

/**
 * Generate a short, descriptive title for a chat session based on the user's
 * first message. Uses Haiku since this is a lightweight task.
 */
export async function generateChatTitle(userMessage: string): Promise<string> {
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content: `Generate a short title (max 60 characters) for a legal research chat that starts with this question. Return ONLY the title, no quotes or punctuation at the end.\n\nQuestion: ${userMessage}`,
        },
      ],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    if (textBlock) {
      return textBlock.text.trim().slice(0, 60);
    }
  } catch {
    // Fall back to truncated message if title generation fails.
  }
  return userMessage.slice(0, 60) + (userMessage.length > 60 ? "..." : "");
}
