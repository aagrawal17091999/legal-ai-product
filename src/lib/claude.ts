import Anthropic from "@anthropic-ai/sdk";
import { addClaudeUsage } from "./billing/meter";

/**
 * Anthropic client utilities. The chat streaming used to live here
 * (`streamChatResponse` + per-task prompt overlays) but was replaced by the
 * agentic loop in `./rag/agent.ts`. The only surviving helper is the short
 * `generateChatTitle` call, used once per session to turn the first user
 * message into a sidebar-friendly title.
 */

function getClient(): Anthropic {
  return getAnthropicClient();
}

function rawClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.local.example)"
    );
  }
  return new Anthropic({ apiKey });
}

/**
 * Shared Anthropic client factory. Every Claude call in the app should go
 * through this so usage is metered for billing (see lib/billing). The returned
 * client is a thin Proxy that auto-reports `.messages.create()` usage to the
 * active request meter; the few `.messages.stream()` call sites report usage
 * explicitly from their `finalMessage()` (they already hold it), so the proxy
 * deliberately leaves `.stream` untouched to avoid double counting.
 */
export function getAnthropicClient(): Anthropic {
  const client = rawClient();
  const messages = client.messages;

  const meteredMessages = new Proxy(messages, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return (...args: Parameters<typeof messages.create>) => {
          const model = (args[0] as { model?: string })?.model ?? "";
          const ret = (messages.create as (...a: unknown[]) => unknown)(...args);
          // Non-streaming create() returns a Promise<Message>; meter its usage.
          // (No call site passes stream:true to create(); streaming uses .stream().)
          return Promise.resolve(ret).then((res) => {
            const usage = (res as Anthropic.Message | undefined)?.usage;
            if (usage) addClaudeUsage(model, usage);
            return res;
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "messages") return meteredMessages;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
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
