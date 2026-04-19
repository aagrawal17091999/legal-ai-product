"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import Spinner from "@/components/ui/Spinner";

/**
 * /trace/[messageId] — per-turn RAG debug view.
 *
 * Renders:
 *   - the user question that triggered the turn + the assistant's final answer
 *   - a timeline of rag_pipeline_steps (agent_start → tool_call(s) → generate)
 *   - a top-level rag_trace summary (model, tokens, stop reason, duration)
 *   - a raw JSON drawer for each step's `data` field
 *
 * Accessed via the "Debug" link added to every assistant bubble in chat, or
 * directly by URL for anything with an assistant message id. Auth-gated and
 * scoped to the user's own sessions — server returns 404 for others'.
 */

interface CitedCase {
  id: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  title: string;
  citation: string | null;
  pdf_url: string | null;
  pdf_path: string | null;
}

interface PipelineStep {
  step_order: number;
  step: string;
  status: "success" | "error" | "fallback" | "skipped";
  duration_ms: number;
  error: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

interface TraceResponse {
  message: {
    id: string;
    session_id: string;
    session_title: string | null;
    role: "assistant" | "user";
    content: string;
    cited_cases: CitedCase[];
    search_query: string | null;
    model: string | null;
    token_usage: { input_tokens: number; output_tokens: number } | null;
    response_time_ms: number | null;
    rag_trace: Record<string, unknown> | null;
    status: "success" | "error";
    error: string | null;
    created_at: string;
  };
  triggering_message: { id: string; content: string; created_at: string } | null;
  pipeline_steps: PipelineStep[];
}

const STATUS_STYLES: Record<PipelineStep["status"], string> = {
  success: "bg-forest-100 text-forest-700 border-forest-700/20",
  error: "bg-burgundy-100 text-burgundy-700 border-burgundy-700/30",
  fallback: "bg-gold-100 text-gold-700 border-gold-700/30",
  skipped: "bg-ivory-200 text-charcoal-600 border-charcoal-400/20",
};

const STEP_LABELS: Record<string, string> = {
  agent_start: "Agent start",
  tool_call: "Tool call",
  generate: "Generate",
  understand: "Understand",
  embed_queries: "Embed queries",
  retrieve: "Retrieve",
  rerank: "Rerank",
  context_build: "Context build",
};

export default function TracePage({
  params,
}: {
  params: Promise<{ messageId: string }>;
}) {
  const { messageId } = use(params);
  const { getToken, loading: authLoading } = useAuth();
  const [data, setData] = useState<TraceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(`/api/chat/messages/${messageId}/trace`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) {
            setError(body.error || `HTTP ${res.status}`);
            setLoading(false);
          }
          return;
        }
        const json: TraceResponse = await res.json();
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId, getToken, authLoading]);

  if (loading || authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px] text-charcoal-600">
        <Spinner size="sm" />
        <span className="ml-3">Loading trace…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <h1 className="font-serif text-2xl text-charcoal-900 mb-3">Trace not found</h1>
        <p className="text-charcoal-600">{error || "No data"}</p>
        <Link
          href="/chat"
          className="inline-block mt-6 text-[14px] text-gold-700 hover:text-gold-600"
        >
          ← Back to chat
        </Link>
      </div>
    );
  }

  const { message, triggering_message, pipeline_steps } = data;
  const trace = (message.rag_trace ?? {}) as Record<string, unknown>;

  return (
    <div className="max-w-4xl mx-auto p-6 lg:p-8 bg-ivory-50 min-h-screen">
      <Link
        href={`/chat/${message.session_id}`}
        className="inline-flex items-center text-[13px] text-charcoal-600 hover:text-charcoal-900 mb-6"
      >
        ← {message.session_title || "Session"}
      </Link>

      <h1 className="font-serif text-3xl tracking-tight text-charcoal-900 mb-1">
        RAG trace
      </h1>
      <p className="text-[13px] text-charcoal-400 mb-8 font-mono">
        {message.id}
      </p>

      {/* Question + Answer ================================================ */}
      <section className="mb-8 space-y-4">
        {triggering_message && (
          <div className="border border-ivory-200 bg-white rounded-lg p-4">
            <p className="overline mb-2">Question</p>
            <p className="text-[14px] text-charcoal-900 whitespace-pre-wrap">
              {triggering_message.content}
            </p>
          </div>
        )}
        <div className="border border-ivory-200 bg-white rounded-lg p-4">
          <p className="overline mb-2">
            Answer {message.status === "error" ? "(errored)" : ""}
          </p>
          <pre className="text-[13px] text-charcoal-900 whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto">
            {message.content}
          </pre>
          {message.error && (
            <p className="mt-3 text-[12px] text-burgundy-700">{message.error}</p>
          )}
        </div>
      </section>

      {/* Summary chips =================================================== */}
      <section className="mb-8 grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryChip label="Mode" value={String(trace.mode ?? "—")} />
        <SummaryChip label="Model" value={message.model ?? "—"} />
        <SummaryChip
          label="Steps used"
          value={String(trace.steps_used ?? pipeline_steps.length)}
        />
        <SummaryChip
          label="Stop reason"
          value={String(trace.stop_reason ?? "—")}
        />
        <SummaryChip
          label="Duration"
          value={
            message.response_time_ms != null
              ? `${message.response_time_ms} ms`
              : "—"
          }
        />
        <SummaryChip
          label="Input tokens"
          value={
            message.token_usage ? String(message.token_usage.input_tokens) : "—"
          }
        />
        <SummaryChip
          label="Output tokens"
          value={
            message.token_usage ? String(message.token_usage.output_tokens) : "—"
          }
        />
        <SummaryChip
          label="Cases cited"
          value={String(message.cited_cases.length)}
        />
      </section>

      {/* Timeline ======================================================== */}
      <section className="mb-8">
        <h2 className="font-serif text-xl text-charcoal-900 mb-3">
          Pipeline steps
        </h2>
        <div className="space-y-2">
          {pipeline_steps.map((step) => (
            <StepRow key={step.step_order} step={step} />
          ))}
          {pipeline_steps.length === 0 && (
            <p className="text-[13px] text-charcoal-400 italic">
              No pipeline steps recorded for this message.
            </p>
          )}
        </div>
      </section>

      {/* Cited cases ===================================================== */}
      {message.cited_cases.length > 0 && (
        <section className="mb-8">
          <h2 className="font-serif text-xl text-charcoal-900 mb-3">
            Cited cases
          </h2>
          <div className="space-y-2">
            {message.cited_cases.map((c, i) => (
              <div
                key={`${c.source_table}-${c.id}`}
                className="border border-ivory-200 bg-white rounded-lg p-3 flex items-baseline gap-3"
              >
                <span className="text-[11px] font-semibold text-gold-700 bg-gold-100 rounded px-2 py-0.5">
                  [{i + 1}]
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] text-charcoal-900 truncate">
                    {c.title}
                  </p>
                  <p className="text-[12px] text-charcoal-400">
                    {c.citation ?? "(no citation)"} — {c.source_table}:{c.id}
                  </p>
                </div>
                {c.pdf_url && (
                  <a
                    href={c.pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-gold-700 hover:text-gold-600"
                  >
                    PDF
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Raw JSON drawer ================================================= */}
      <section className="mb-16">
        <details className="border border-ivory-200 bg-white rounded-lg">
          <summary className="px-4 py-3 cursor-pointer text-[13px] text-charcoal-600 hover:text-charcoal-900 select-none">
            Raw rag_trace JSON
          </summary>
          <pre className="text-[11px] text-charcoal-900 bg-ivory-100 p-4 overflow-x-auto border-t border-ivory-200 font-mono">
            {JSON.stringify(trace, null, 2)}
          </pre>
        </details>
      </section>
    </div>
  );
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-ivory-200 bg-white rounded-lg px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-charcoal-400 font-medium">
        {label}
      </p>
      <p className="text-[13px] text-charcoal-900 font-mono mt-1 truncate">
        {value}
      </p>
    </div>
  );
}

function StepRow({ step }: { step: PipelineStep }) {
  const [open, setOpen] = useState(false);
  const label = STEP_LABELS[step.step] ?? step.step;
  const isToolCall = step.step === "tool_call";
  const toolName =
    isToolCall && step.data && typeof step.data.tool === "string"
      ? String(step.data.tool)
      : null;

  return (
    <div className="border border-ivory-200 bg-white rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ivory-100 transition-colors rounded-lg"
      >
        <span className="text-[11px] text-charcoal-400 font-mono w-6">
          {step.step_order}
        </span>
        <span className="flex-1 min-w-0">
          <span className="text-[14px] text-charcoal-900 font-medium">
            {label}
            {toolName && (
              <span className="ml-2 text-charcoal-600 font-normal">
                {toolName}
              </span>
            )}
          </span>
          {step.error && (
            <span className="block text-[12px] text-burgundy-700 mt-0.5 truncate">
              {step.error}
            </span>
          )}
        </span>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider border rounded px-2 py-0.5 ${STATUS_STYLES[step.status]}`}
        >
          {step.status}
        </span>
        <span className="text-[12px] text-charcoal-600 font-mono w-16 text-right">
          {step.duration_ms} ms
        </span>
        <span
          className={`text-charcoal-400 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
      </button>
      {open && (
        <div className="border-t border-ivory-200 px-4 py-3 bg-ivory-50">
          {isToolCall && step.data?.input ? (
            <div className="mb-3">
              <p className="overline mb-1">Input</p>
              <pre className="text-[11px] bg-white border border-ivory-200 rounded p-2 overflow-x-auto font-mono">
                {JSON.stringify(step.data.input, null, 2)}
              </pre>
            </div>
          ) : null}
          {isToolCall && typeof step.data?.result_preview === "string" && (
            <div className="mb-3">
              <p className="overline mb-1">Result preview</p>
              <pre className="text-[11px] bg-white border border-ivory-200 rounded p-2 overflow-x-auto font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                {String(step.data.result_preview)}
              </pre>
            </div>
          )}
          <div>
            <p className="overline mb-1">Data</p>
            <pre className="text-[11px] bg-white border border-ivory-200 rounded p-2 overflow-x-auto font-mono max-h-60 overflow-y-auto">
              {JSON.stringify(step.data ?? {}, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
