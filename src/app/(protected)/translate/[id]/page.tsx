"use client";

import { useState, useEffect, useCallback, use as usePromise } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { useJobStatusPush } from "@/hooks/useJobStatusPush";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";

interface TranslatedSegment {
  source: string;
  translation: string;
  flagged: boolean;
  note: string | null;
}

interface Run {
  text: string;
  italic?: boolean;
  bold?: boolean;
  flagged?: boolean;
  note?: string | null;
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; number?: string | null; runs: Run[] }
  | { type: "kv"; rows: Array<{ key: string; value: Run[] }> }
  | { type: "table"; header: string[]; rows: Run[][][] }
  | { type: "partyLabel"; runs: Run[] }
  | { type: "signature"; runs: Run[] };

interface TranslationResult {
  detectedLanguage: string;
  targetLanguage: string;
  /** Structured blocks (new jobs). Older jobs only have `segments`. */
  blocks?: Block[];
  segments: TranslatedSegment[];
  flaggedCount: number;
}

interface TranslationJob {
  id: string;
  source_filename: string;
  target_language: string;
  detected_language: string | null;
  status: "processing" | "ready" | "failed";
  segment_count: number;
  flagged_count: number;
  ocr_used: boolean;
  error: string | null;
  created_at: string;
}

export default function TranslationViewerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const { getToken } = useAuth();

  // Single state object so the async loader commits exactly one update per run.
  const [view, setView] = useState<{
    loaded: boolean;
    notFound: boolean;
    job: TranslationJob | null;
    result: TranslationResult | null;
    downloadUrl: string | null;
  }>({ loaded: false, notFound: false, job: null, result: null, downloadUrl: null });

  const load = useCallback(async () => {
    const token = await getToken();
    const res = await fetch(`/api/translate/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      setView({ loaded: true, notFound: true, job: null, result: null, downloadUrl: null });
      return;
    }
    if (!res.ok) {
      setView((v) => ({ ...v, loaded: true }));
      return;
    }
    const data = await res.json();
    setView({
      loaded: true,
      notFound: false,
      job: data.job ?? null,
      result: data.result ?? null,
      downloadUrl: data.downloadUrl ?? null,
    });
  }, [getToken, id]);

  const { loaded, notFound, job, result, downloadUrl } = view;

  useEffect(() => {
    // On-mount fetch: the single state update commits only after awaited I/O.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Push instead of poll: re-load from Postgres when the job's Firestore status
  // doc flips out of `processing`.
  useJobStatusPush("translate", job?.status === "processing" ? [id] : [], load);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link
          href="/translate"
          className="text-[13px] text-charcoal-500 hover:text-charcoal-900 transition-colors"
        >
          ← All translations
        </Link>

        {!loaded ? (
          <div className="mt-10 flex justify-center">
            <Spinner />
          </div>
        ) : notFound || !job ? (
          <p className="mt-8 text-[14px] text-charcoal-500">Translation not found.</p>
        ) : (
          <>
            {/* ── Header ── */}
            <div className="mt-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="font-serif text-2xl text-charcoal-900 truncate">
                  {job.source_filename}
                </h1>
                <p className="text-[13px] text-charcoal-500 mt-1">
                  {(job.detected_language ?? result?.detectedLanguage) &&
                    `${job.detected_language ?? result?.detectedLanguage} → `}
                  {job.target_language}
                  {job.status === "ready" && (
                    <>
                      {" · "}
                      {job.segment_count} segments
                      {job.flagged_count > 0 && (
                        <span className="text-burgundy-700"> · {job.flagged_count} flagged</span>
                      )}
                      {job.ocr_used ? " · OCR" : ""}
                    </>
                  )}
                </p>
              </div>
              {job.status === "ready" && downloadUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(downloadUrl, "_blank")}
                >
                  Download .docx
                </Button>
              )}
            </div>

            {/* ── Processing ── */}
            {job.status === "processing" && (
              <div className="mt-8 flex items-center gap-2 text-[13px] text-gold-700">
                <Spinner size="sm" /> Translating… this page updates automatically.
              </div>
            )}

            {/* ── Failed ── */}
            {job.status === "failed" && (
              <div className="mt-6 rounded-lg border border-burgundy-300 bg-burgundy-50 px-4 py-3">
                <p className="text-[13px] text-burgundy-700 leading-relaxed">
                  {job.error || "This translation could not be completed."}
                </p>
              </div>
            )}

            {/* ── Ready ── */}
            {job.status === "ready" && (
              <>
                {/* Certification notice */}
                <div className="mt-6 rounded-lg border border-gold-400 bg-gold-100/50 px-4 py-3">
                  <p className="text-[13px] text-charcoal-700 leading-relaxed">
                    <span className="font-semibold">Draft for review.</span> This AI translation is
                    not certified. It must be reviewed and certified by a qualified human translator
                    before being filed or relied upon. Sections the system could not read
                    confidently are flagged below rather than guessed.
                  </p>
                </div>

                {result ? (
                  <>
                    {result.flaggedCount > 0 && (
                      <p className="mt-5 text-[13px] font-medium text-burgundy-700">
                        {result.flaggedCount} section(s) below are marked NEEDS HUMAN REVIEW — the
                        translator could not read or render them with confidence.
                      </p>
                    )}

                    <div className="mt-5 rounded-xl border border-ivory-200 bg-ivory-50 px-6 py-6 space-y-3">
                      {result.blocks && result.blocks.length > 0
                        ? result.blocks.map((block, i) => <BlockView key={i} block={block} />)
                        : result.segments.map((seg, i) => <Segment key={i} seg={seg} />)}
                    </div>
                  </>
                ) : (
                  // Pre-migration jobs have no stored result — fall back to download.
                  <p className="mt-6 text-[13px] text-charcoal-500">
                    An in-app preview isn&apos;t available for this older translation. Use{" "}
                    <span className="font-medium">Download .docx</span> above to open it.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Segment({ seg }: { seg: TranslatedSegment }) {
  const marker = seg.translation
    ? `⚠ NEEDS HUMAN REVIEW${seg.note ? `: ${seg.note}` : ""}`
    : `⚠ UNREADABLE — NEEDS HUMAN REVIEW${seg.note ? `: ${seg.note}` : ""}`;
  return (
    <p className="text-[15px] leading-relaxed text-charcoal-900 whitespace-pre-wrap">
      {seg.translation}
      {seg.flagged && (
        <span className="font-semibold text-burgundy-700">
          {seg.translation ? "  " : ""}
          [{marker}]
        </span>
      )}
    </p>
  );
}

/** Render a run list as inline spans, appending a review marker for flagged runs. */
function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, i) => {
        const marker = r.flagged
          ? r.text
            ? `  [⚠ NEEDS HUMAN REVIEW${r.note ? `: ${r.note}` : ""}]`
            : `[⚠ UNREADABLE — NEEDS HUMAN REVIEW${r.note ? `: ${r.note}` : ""}]`
          : null;
        return (
          <span key={i}>
            {r.text && (
              <span className={`${r.italic ? "italic" : ""} ${r.bold ? "font-semibold" : ""}`}>{r.text}</span>
            )}
            {marker && <span className="font-semibold text-burgundy-700">{marker}</span>}
          </span>
        );
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      const cls =
        block.level === 1
          ? "font-serif text-xl text-charcoal-900 text-center mt-2"
          : "font-semibold text-[15px] text-charcoal-900 mt-3";
      return (
        <p className={cls}>
          <Runs runs={block.runs} />
        </p>
      );
    }
    case "paragraph":
      return (
        <p className="text-[15px] leading-relaxed text-charcoal-900">
          {block.number && <span className="text-charcoal-500">{block.number} </span>}
          <Runs runs={block.runs} />
        </p>
      );
    case "partyLabel":
      return (
        <p className="text-[15px] font-medium text-charcoal-700 text-right">
          <Runs runs={block.runs} />
        </p>
      );
    case "signature":
      return (
        <p className="text-[15px] text-charcoal-900 text-right mt-3">
          <Runs runs={block.runs} />
        </p>
      );
    case "kv":
      return (
        <div className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-1 text-[15px] text-charcoal-900">
          {block.rows.map((row, i) => (
            <div key={i} className="contents">
              <div className="font-semibold">{row.key}</div>
              <div>
                <Runs runs={row.value} />
              </div>
            </div>
          ))}
        </div>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px] text-charcoal-900">
            {block.header.length > 0 && (
              <thead>
                <tr>
                  {block.header.map((h, i) => (
                    <th key={i} className="border border-ivory-300 bg-ivory-100 px-2 py-1 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="border border-ivory-300 px-2 py-1 align-top">
                      <Runs runs={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
