import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client utilities. The chat streaming used to live here
 * (`streamChatResponse` + per-task prompt overlays) but was replaced by the
 * agentic loop in `./rag/agent.ts`. The only surviving helper is the short
 * `generateChatTitle` call, used once per session to turn the first user
 * message into a sidebar-friendly title.
 */

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.local.example)"
    );
  }
  return new Anthropic({ apiKey });
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
