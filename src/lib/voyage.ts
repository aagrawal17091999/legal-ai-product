import { logError } from "./error-logger";

const VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";

// Legal-domain specialized embedding model. 1024 dims, must match the
// vector(1024) column in case_chunks (see migrations/009_embeddings_v2.sql).
export const VOYAGE_EMBED_MODEL = "voyage-law-2";
export const EMBEDDING_DIMENSION = 1024;

// Cross-encoder reranker. rerank-2 is the current generation and handles
// long legal passages well.
export const VOYAGE_RERANK_MODEL = "rerank-2";

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Add it to .env.local (see .env.local.example)"
    );
  }
  return key;
}

interface VoyageEmbedResponse {
  data: Array<{ embedding: number[] }>;
  usage: { total_tokens: number };
}

/**
 * Embed a single query string for search.
 * Uses input_type "query" for retrieval queries.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const response = await fetch(VOYAGE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: VOYAGE_EMBED_MODEL,
      input: [text],
      input_type: "query",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logError({
      category: "fetching",
      message: `Voyage AI embedQuery failed: ${response.status} ${errorText}`,
      severity: "critical",
      metadata: { function: "embedQuery", status: response.status },
    });
    throw new Error(`Voyage AI API error: ${response.status} ${errorText}`);
  }

  const data: VoyageEmbedResponse = await response.json();
  return data.data[0].embedding;
}

export interface EmbedQueriesResult {
  embeddings: number[][];
  totalTokens: number;
}

/**
 * Embed multiple query strings in one call. Used when query-understanding
 * produces several rewritten/HyDE queries and we want one round-trip.
 * Returns both the embeddings and Voyage's reported token usage so the
 * caller can record it in the audit log.
 */
export async function embedQueries(texts: string[]): Promise<EmbedQueriesResult> {
  if (texts.length === 0) return { embeddings: [], totalTokens: 0 };
  if (texts.length > 128) {
    throw new Error("embedQueries supports max 128 texts per call");
  }

  const response = await fetch(VOYAGE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: VOYAGE_EMBED_MODEL,
      input: texts,
      input_type: "query",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logError({
      category: "fetching",
      message: `Voyage AI embedQueries failed: ${response.status} ${errorText}`,
      severity: "critical",
      metadata: { function: "embedQueries", batchSize: texts.length, status: response.status },
    });
    throw new Error(`Voyage AI API error: ${response.status} ${errorText}`);
  }

  const data: VoyageEmbedResponse = await response.json();
  return {
    embeddings: data.data.map((d) => d.embedding),
    totalTokens: data.usage?.total_tokens ?? 0,
  };
}

/**
 * Embed multiple texts for batch processing (used in pipeline).
 * Uses input_type "document" for case text chunks.
 * Max 128 texts per batch.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 128) {
    throw new Error("embedBatch supports max 128 texts per call");
  }

  const response = await fetch(VOYAGE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: VOYAGE_EMBED_MODEL,
      input: texts,
      input_type: "document",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logError({
      category: "fetching",
      message: `Voyage AI embedBatch failed: ${response.status} ${errorText}`,
      severity: "critical",
      metadata: { function: "embedBatch", batchSize: texts.length, status: response.status },
    });
    throw new Error(`Voyage AI API error: ${response.status} ${errorText}`);
  }

  const data: VoyageEmbedResponse = await response.json();
  return data.data.map((d) => d.embedding);
}

interface VoyageRerankResponse {
  data: Array<{
    index: number;
    relevance_score: number;
  }>;
  usage: { total_tokens: number };
}

export interface RerankResult {
  index: number; // position in the original documents array
  score: number; // rerank relevance score, higher = more relevant
}

export interface RerankResponse {
  results: RerankResult[];
  totalTokens: number;
}

/**
 * Rerank documents against a query using Voyage's cross-encoder.
 * Returns the documents reordered by relevance, truncated to topK, along
 * with Voyage's reported token usage for audit logging.
 * Max 1000 documents per call per Voyage docs.
 */
export async function rerank(
  query: string,
  documents: string[],
  topK: number
): Promise<RerankResponse> {
  if (documents.length === 0) return { results: [], totalTokens: 0 };

  const response = await fetch(VOYAGE_RERANK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: VOYAGE_RERANK_MODEL,
      query,
      documents,
      top_k: Math.min(topK, documents.length),
      truncation: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logError({
      category: "fetching",
      message: `Voyage AI rerank failed: ${response.status} ${errorText}`,
      severity: "critical",
      metadata: { function: "rerank", docCount: documents.length, status: response.status },
    });
    throw new Error(`Voyage AI API error: ${response.status} ${errorText}`);
  }

  const data: VoyageRerankResponse = await response.json();
  return {
    results: data.data.map((d) => ({ index: d.index, score: d.relevance_score })),
    totalTokens: data.usage?.total_tokens ?? 0,
  };
}
