"use client";

import { useEffect, useRef, useState } from "react";
import Spinner from "@/components/ui/Spinner";
import { useAuth } from "@/hooks/useAuth";

export interface DocCitation {
  ref: number;
  chunk_id: number;
  document_id: string;
  document_name: string;
  page_no: number | null;
  snippet: string;
  support_quote?: string | null;
  verified?: boolean;
}

interface ChunkContext {
  chunk_index: number;
  page_no: number | null;
  chunk_text: string;
  is_cited: boolean;
}

interface ChunkDetail {
  chunk_id: number;
  document_id: string;
  document_name: string;
  page_no: number | null;
  chunk_text: string;
  /** Sentence-aligned passage (offset-based docs); null for legacy docs. */
  passage: string | null;
  context: ChunkContext[];
}

interface Props {
  workspaceId: string;
  citation: DocCitation | null;
  onClose: () => void;
  onOpenDocument: (documentId: string) => void;
}

const chunkCache = new Map<number, ChunkDetail>();

// Highlight the verbatim support quote within the full chunk text (whitespace-
// insensitive match). Returns segments so the backing passage stands out.
function highlightQuote(text: string, quote: string | null | undefined) {
  if (!quote) return [{ text, hit: false }];
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const idx = norm(text).indexOf(norm(quote));
  if (idx === -1) return [{ text, hit: false }];
  // Map normalized index back to the original string approximately by walking.
  // Simple approach: find the quote's first ~12 chars verbatim, fall back to no
  // highlight if the raw substring isn't directly present.
  const probe = quote.trim().slice(0, 24);
  const rawIdx = text.indexOf(probe);
  if (rawIdx === -1) return [{ text, hit: false }];
  const end = rawIdx + quote.trim().length;
  return [
    { text: text.slice(0, rawIdx), hit: false },
    { text: text.slice(rawIdx, end), hit: true },
    { text: text.slice(end), hit: false },
  ];
}

export default function WorkspaceCitationPanel({
  workspaceId,
  citation,
  onClose,
  onOpenDocument,
}: Props) {
  const { getToken } = useAuth();
  const [detail, setDetail] = useState<ChunkDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<number | null>(null);

  const chunkId = citation?.chunk_id ?? null;

  useEffect(() => {
    if (chunkId == null) return;
    const cached = chunkCache.get(chunkId);
    if (cached) {
      setDetail(cached);
      setError(null);
      return;
    }
    if (inFlight.current === chunkId) return;
    inFlight.current = chunkId;
    setLoading(true);
    setError(null);
    setDetail(null);

    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(`/api/workspace/${workspaceId}/chunks/${chunkId}`, {
          headers: { Authorization: `Bearer ${token ?? ""}` },
        });
        if (!res.ok) {
          setError("Couldn't load the source passage.");
          return;
        }
        const data = (await res.json()) as ChunkDetail;
        chunkCache.set(chunkId, data);
        setDetail(data);
      } catch {
        setError("Couldn't load the source passage.");
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    })();
  }, [chunkId, workspaceId, getToken]);

  if (!citation) return null;

  return (
    <aside className="hidden md:flex w-[420px] flex-shrink-0 flex-col border-l border-ivory-200 bg-ivory-50">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-ivory-200 bg-white">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">
            Source [{citation.ref}]
            {citation.verified === true && (
              <span className="ml-2 text-green-700 normal-case tracking-normal">✓ verified</span>
            )}
            {citation.verified === false && (
              <span className="ml-2 text-burgundy-700 normal-case tracking-normal">⚠ unverified</span>
            )}
          </p>
          <h2 className="mt-1 font-serif text-[17px] leading-snug text-charcoal-900 truncate">
            {citation.document_name}
          </h2>
          {citation.page_no != null && (
            <p className="mt-0.5 text-[12px] text-charcoal-600">Page {citation.page_no}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 text-charcoal-400 hover:text-charcoal-900 transition-colors"
          title="Close"
          aria-label="Close source panel"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {citation.support_quote && (
          <div className="mb-5">
            <p className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider mb-2">
              Backing passage
            </p>
            <blockquote className="border-l-2 border-gold-400 pl-3 text-[14px] leading-relaxed text-charcoal-900">
              {citation.support_quote}
            </blockquote>
          </div>
        )}

        <p className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider mb-2">
          From the document
        </p>
        {loading ? (
          <div className="flex items-center gap-2 text-charcoal-600 text-[13px]">
            <Spinner size="sm" />
            <span>Loading passage…</span>
          </div>
        ) : error ? (
          // Fall back to the stored snippet so the panel is never a dead end.
          <p className="text-[14px] leading-relaxed text-charcoal-700">{citation.snippet}…</p>
        ) : detail?.passage ? (
          // Sentence-aligned passage: one clean block, support quote highlighted.
          <div className="text-[14px] leading-relaxed text-charcoal-900">
            <p className="bg-gold-100/50 rounded px-2 py-1.5 -mx-2">
              {highlightQuote(detail.passage, citation.support_quote).map((seg, j) =>
                seg.hit ? (
                  <mark key={j} className="bg-gold-200 text-charcoal-900 rounded px-0.5">
                    {seg.text}
                  </mark>
                ) : (
                  <span key={j}>{seg.text}</span>
                )
              )}
            </p>
          </div>
        ) : detail ? (
          <div className="space-y-3 text-[14px] leading-relaxed">
            {detail.context.map((c, i) => (
              <p
                key={i}
                className={
                  c.is_cited
                    ? "text-charcoal-900 bg-gold-100/50 rounded px-2 py-1.5 -mx-2"
                    : "text-charcoal-500"
                }
              >
                {c.is_cited
                  ? highlightQuote(c.chunk_text, citation.support_quote).map((seg, j) =>
                      seg.hit ? (
                        <mark key={j} className="bg-gold-200 text-charcoal-900 rounded px-0.5">
                          {seg.text}
                        </mark>
                      ) : (
                        <span key={j}>{seg.text}</span>
                      )
                    )
                  : c.chunk_text}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-[14px] leading-relaxed text-charcoal-700">{citation.snippet}…</p>
        )}
      </div>

      <div className="border-t border-ivory-200 px-5 py-3 bg-white">
        <button
          type="button"
          onClick={() => onOpenDocument(citation.document_id)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gold-700 hover:text-gold-600 font-medium"
        >
          Open document
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
