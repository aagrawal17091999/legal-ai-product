/**
 * Workspace-scoped hybrid retrieval (Feature 1).
 *
 * Mirrors the case-law retrieval shape (vector + FTS, RRF-fused, then a Voyage
 * cross-encoder rerank) but over `document_chunks` and HARD-SCOPED to a single
 * workspace: every query carries `WHERE workspace_id = $1`, so a query in one
 * workspace can never surface another workspace's chunks. The scope is enforced
 * in SQL, not in application code.
 */

import pool from "../db";
import { embedQuery, rerank } from "../voyage";
import { logError } from "../error-logger";

const RRF_K = 60;
const CANDIDATES_PER_LANE = 40;
// Defaults (flagged in the build): retrieve 40 per lane, rerank down to 8.
export const DEFAULT_TOP_K = 8;
// Voyage rerank-2 relevance score floor. Chunks below this are too weak to be
// worth sending as context; if everything is below it we keep the single best
// so the model still has a basis to (usually) say "not in your documents".
const RELEVANCE_FLOOR = 0.3;

export interface DocChunkHit {
  chunk_id: number;
  document_id: string;
  document_name: string;
  page_no: number | null;
  chunk_index: number;
  chunk_text: string;
  rrf_score: number;
  rerank_score: number;
}

interface RawHit {
  chunk_id: number;
  document_id: string;
  document_name: string;
  page_no: number | null;
  chunk_index: number;
  chunk_text: string;
}

export interface RetrieveResult {
  chunks: DocChunkHit[];
  /** Best rerank score seen, for logging / weak-retrieval signals. */
  topScore: number;
  embedTokens: number;
}

export async function retrieveWorkspaceChunks(
  workspaceId: string,
  query: string,
  topK = DEFAULT_TOP_K
): Promise<RetrieveResult> {
  try {
    const embedding = await embedQuery(query);

    const [vec, fts] = await Promise.all([
      vectorLane(workspaceId, embedding, CANDIDATES_PER_LANE),
      ftsLane(workspaceId, query, CANDIDATES_PER_LANE),
    ]);

    // RRF fuse on chunk_id.
    const scoreMap = new Map<number, { score: number; hit: RawHit }>();
    const addLane = (hits: RawHit[]) => {
      hits.forEach((hit, i) => {
        const rrf = 1 / (RRF_K + i + 1);
        const cur = scoreMap.get(hit.chunk_id);
        if (cur) cur.score += rrf;
        else scoreMap.set(hit.chunk_id, { score: rrf, hit });
      });
    };
    addLane(vec);
    addLane(fts);

    const fused = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
    if (fused.length === 0) return { chunks: [], topScore: 0, embedTokens: 0 };

    // Rerank the fused candidates (cap to keep the rerank call cheap).
    const candidates = fused.slice(0, 30);
    const { results } = await rerank(
      query,
      candidates.map((c) => c.hit.chunk_text),
      Math.min(topK, candidates.length)
    );

    const reranked: DocChunkHit[] = results.map((r) => {
      const c = candidates[r.index];
      return {
        chunk_id: c.hit.chunk_id,
        document_id: c.hit.document_id,
        document_name: c.hit.document_name,
        page_no: c.hit.page_no,
        chunk_index: c.hit.chunk_index,
        chunk_text: c.hit.chunk_text,
        rrf_score: c.score,
        rerank_score: r.score,
      };
    });

    const topScore = reranked.length > 0 ? reranked[0].rerank_score : 0;
    const passed = reranked.filter((c) => c.rerank_score >= RELEVANCE_FLOOR);
    const chunks = passed.length > 0 ? passed : reranked.slice(0, 1);

    return { chunks, topScore, embedTokens: 0 };
  } catch (err) {
    logError({
      category: "search",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      metadata: { feature: "docchat_retrieve", workspaceId },
    });
    throw err;
  }
}

async function vectorLane(
  workspaceId: string,
  embedding: number[],
  limit: number
): Promise<RawHit[]> {
  const vec = `[${embedding.join(",")}]`;
  const { rows } = await pool.query(
    `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index, dc.page_no, dc.chunk_text,
            d.filename AS document_name
       FROM document_chunks dc
       JOIN workspace_documents d ON d.id = dc.document_id
      WHERE dc.workspace_id = $1
        AND dc.embedding IS NOT NULL
        -- Don't surface chunks from a doc still mid-ingestion / failed.
        AND d.status = 'ready'
      ORDER BY dc.embedding <=> $2::vector
      LIMIT ${limit}`,
    [workspaceId, vec]
  );
  return rows.map(toRawHit);
}

async function ftsLane(
  workspaceId: string,
  query: string,
  limit: number
): Promise<RawHit[]> {
  const { rows } = await pool.query(
    `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index, dc.page_no, dc.chunk_text,
            d.filename AS document_name,
            ts_rank(to_tsvector('english', dc.chunk_text),
                    plainto_tsquery('english', $2)) AS rank
       FROM document_chunks dc
       JOIN workspace_documents d ON d.id = dc.document_id
      WHERE dc.workspace_id = $1
        AND to_tsvector('english', dc.chunk_text) @@ plainto_tsquery('english', $2)
        -- Don't surface chunks from a doc still mid-ingestion / failed.
        AND d.status = 'ready'
      ORDER BY rank DESC
      LIMIT ${limit}`,
    [workspaceId, query]
  );
  return rows.map(toRawHit);
}

function toRawHit(r: Record<string, unknown>): RawHit {
  return {
    chunk_id: r.chunk_id as number,
    document_id: r.document_id as string,
    document_name: (r.document_name as string) || "Document",
    page_no: (r.page_no as number | null) ?? null,
    chunk_index: r.chunk_index as number,
    chunk_text: (r.chunk_text as string) || "",
  };
}
