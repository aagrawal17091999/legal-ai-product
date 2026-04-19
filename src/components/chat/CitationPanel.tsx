"use client";

import { useEffect, useRef, useState } from "react";
import Spinner from "@/components/ui/Spinner";
import { useAuth } from "@/hooks/useAuth";
import type { CitationRef, ParagraphDetail } from "@/types";

interface CitationPanelProps {
  citation: CitationRef | null;
  onClose: () => void;
}

type Outcome =
  | { status: "ok"; detail: ParagraphDetail }
  | { status: "not_found" }
  | { status: "error"; message: string };

type DisplayState = Outcome | { status: "idle" } | { status: "loading" };

const paragraphCache = new Map<string, ParagraphDetail>();

function cacheKey(sourceTable: string, sourceId: number, paragraph: string): string {
  return `${sourceTable}:${sourceId}:${paragraph}`;
}

// Indian-judgment PDFs extract with soft \n line-wraps and no \n\n paragraph
// boundaries. We collapse the soft wraps, then re-introduce breaks before
// structural cues (clause markers, numbered paragraph starts, quoted sections).
// Every split rule requires the preceding char to be sentence-terminal so we
// don't break citations like "Section 3(3)(b)(i)" or dates like "15. March".
const SPLIT_SENTINEL = "\u0001";
const CLAUSE_NUM_RE = /([.!?;:][)"']?)\s+(?=\(\d+\))/g;
const CLAUSE_ALPHA_RE = /([.!?;:][)"']?)\s+(?=\([a-z]\)\s)/g;
const CLAUSE_ROMAN_RE = /([.!?;:][)"']?)\s+(?=\([ivx]{1,4}\)\s)/g;
const QUOTED_SECTION_RE = /([.!?][)"']?)\s+(?="\d+\.\s+[A-Z])/g;
const NUMBERED_PARA_RE = /([.!?][)"']?)\s+(?=\d+\.\s+[A-Z])/g;

function splitIntoParagraphs(raw: string): string[] {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return [];
  const marked = collapsed
    .replace(CLAUSE_NUM_RE, `$1${SPLIT_SENTINEL}`)
    .replace(CLAUSE_ALPHA_RE, `$1${SPLIT_SENTINEL}`)
    .replace(CLAUSE_ROMAN_RE, `$1${SPLIT_SENTINEL}`)
    .replace(QUOTED_SECTION_RE, `$1${SPLIT_SENTINEL}`)
    .replace(NUMBERED_PARA_RE, `$1${SPLIT_SENTINEL}`);
  return marked
    .split(SPLIT_SENTINEL)
    .map((p) => p.trim())
    .filter(Boolean);
}

export default function CitationPanel({ citation, onClose }: CitationPanelProps) {
  const { getToken } = useAuth();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const inFlight = useRef(new Set<string>());

  const sourceTable = citation?.case.source_table;
  const sourceId = citation?.case.id;
  const paragraph = citation?.paragraph;
  const key =
    sourceTable && sourceId !== undefined && paragraph
      ? cacheKey(sourceTable, sourceId, paragraph)
      : null;

  useEffect(() => {
    if (!key || !sourceTable || sourceId === undefined || !paragraph) return;
    if (paragraphCache.has(key)) return;
    if (outcomes[key]) return;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);

    const run = async () => {
      try {
        const token = await getToken();
        const res = await fetch(
          `/api/paragraphs?source_table=${encodeURIComponent(sourceTable)}&source_id=${sourceId}&paragraph_number=${encodeURIComponent(paragraph)}`,
          { headers: { Authorization: `Bearer ${token ?? ""}` } }
        );
        let outcome: Outcome;
        if (res.status === 404) {
          outcome = { status: "not_found" };
        } else if (!res.ok) {
          outcome = { status: "error", message: `Request failed (${res.status})` };
        } else {
          const detail = (await res.json()) as ParagraphDetail;
          paragraphCache.set(key, detail);
          outcome = { status: "ok", detail };
        }
        setOutcomes((prev) => ({ ...prev, [key]: outcome }));
      } catch (err) {
        setOutcomes((prev) => ({
          ...prev,
          [key]: {
            status: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          },
        }));
      } finally {
        inFlight.current.delete(key);
      }
    };

    run();
  }, [key, sourceTable, sourceId, paragraph, outcomes, getToken]);

  if (!citation) return null;

  const computeDisplay = (): DisplayState => {
    if (!key) return { status: "idle" };
    const cached = paragraphCache.get(key);
    if (cached) return { status: "ok", detail: cached };
    const settled: Outcome | undefined = outcomes[key];
    return settled ?? { status: "loading" };
  };
  const display: DisplayState = computeDisplay();

  return (
    <aside className="hidden md:flex w-[420px] flex-shrink-0 flex-col border-l border-ivory-200 bg-ivory-50">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-ivory-200 bg-white">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">
            {paragraph ? `Paragraph ¶${paragraph}` : "Cited case"}
          </p>
          <h2 className="mt-1 font-serif text-[17px] leading-snug text-charcoal-900 truncate">
            {citation.case.title}
          </h2>
          {citation.case.citation && (
            <p className="mt-0.5 text-[12px] text-charcoal-600 truncate">
              {citation.case.citation}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 text-charcoal-400 hover:text-charcoal-900 transition-colors"
          title="Close"
          aria-label="Close citation panel"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {display.status === "idle" ? (
          <CaseOverview />
        ) : display.status === "loading" ? (
          <div className="flex items-center gap-2 text-charcoal-600 text-[13px]">
            <Spinner size="sm" />
            <span>Loading paragraph…</span>
          </div>
        ) : display.status === "ok" ? (
          <ParagraphBody detail={display.detail} />
        ) : display.status === "not_found" ? (
          <p className="text-[13px] text-charcoal-600 leading-relaxed">
            Paragraph ¶{paragraph} isn&apos;t individually stored for this
            judgment. Open the full judgment below to locate it.
          </p>
        ) : (
          <p className="text-[13px] text-burgundy-700">
            Could not load paragraph: {display.message}
          </p>
        )}
      </div>

      {citation.case.pdf_url && (
        <div className="border-t border-ivory-200 px-5 py-3 bg-white">
          <a
            href={citation.case.pdf_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] text-gold-700 hover:text-gold-600 font-medium"
          >
            Open full judgment
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      )}
    </aside>
  );
}

function CaseOverview() {
  return (
    <p className="text-[13px] text-charcoal-600 leading-relaxed">
      Click a paragraph marker like <span className="font-mono text-charcoal-900">¶11b</span> in the
      answer to see the exact text pinpointed in this judgment.
    </p>
  );
}

function ParagraphBody({ detail }: { detail: ParagraphDetail }) {
  const paragraphs = splitIntoParagraphs(detail.paragraph_text);
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-charcoal-900">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
