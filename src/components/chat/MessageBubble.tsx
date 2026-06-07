"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, CitationRef } from "@/types";

interface MessageBubbleProps {
  message: ChatMessage;
  onCitationClick?: (ref: CitationRef) => void;
}

// [^3, ¶11b] → [[3, ¶11b]](#case-3-para-11b)
// [^3]       → [[3]](#case-3)
// The marker regex mirrors the one in src/lib/rag/citationValidator.ts:39.
function inlineCitations(content: string): string {
  return content.replace(
    /\[\^(\d+)(?:\s*,\s*¶([0-9]+(?:\.[0-9]+)?[A-Za-z]?))?\]/g,
    (_m, n, p) =>
      p ? `[[${n}, ¶${p}]](#case-${n}-para-${p})` : `[[${n}]](#case-${n})`
  );
}

const CITATION_HREF_RE = /^#case-(\d+)(?:-para-([0-9]+(?:\.[0-9]+)?[A-Za-z]?))?$/;

function MessageBubble({
  message,
  onCitationClick,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const prepared = isUser ? message.content : inlineCitations(message.content);

  const handleCitationHref = (href: string): boolean => {
    const match = href.match(CITATION_HREF_RE);
    if (!match) return false;
    const idx = parseInt(match[1], 10);
    const paragraph = match[2] ?? null;
    const ref = message.cited_cases?.[idx - 1];
    if (!ref) return false;
    onCitationClick?.({ case: ref, paragraph });
    return true;
  };

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-5`}>
      <div
        className={`max-w-[85%] rounded-xl px-5 py-4 ${
          isUser
            ? "bg-navy-950 text-ivory-50"
            : "bg-ivory-100 border border-ivory-200 text-charcoal-900"
        }`}
      >
        {isUser ? (
          <p className="text-[15px] whitespace-pre-wrap leading-relaxed">
            {message.content}
          </p>
        ) : (
          <div className="prose prose-sm max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 prose-p:text-charcoal-900 prose-p:leading-relaxed prose-p:my-3 prose-headings:font-serif prose-headings:font-semibold prose-headings:text-charcoal-900 prose-h1:text-2xl prose-h1:mt-7 prose-h1:mb-3 prose-h2:text-xl prose-h2:mt-7 prose-h2:mb-3 prose-h3:text-lg prose-h3:mt-5 prose-h3:mb-2 prose-strong:text-charcoal-900 prose-ul:my-3 prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:text-charcoal-900 prose-li:my-1 prose-li:marker:text-charcoal-400 prose-hr:my-6 prose-hr:border-ivory-200 prose-table:text-[13px] prose-th:text-charcoal-900 prose-th:font-semibold prose-th:border-ivory-200 prose-td:text-charcoal-900 prose-td:border-ivory-200 prose-blockquote:text-charcoal-600 prose-blockquote:border-gold-400 prose-a:text-gold-600 hover:prose-a:text-gold-700">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children, ...rest }) => {
                  if (href && href.startsWith("#case-")) {
                    return (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          handleCitationHref(href);
                        }}
                        className="inline-flex align-super text-[0.7rem] font-semibold text-gold-700 hover:text-gold-600 bg-gold-100 hover:bg-gold-100/80 rounded px-1.5 py-0.5 mx-0.5 no-underline"
                      >
                        {children}
                      </button>
                    );
                  }
                  return (
                    <a href={href} {...rest}>
                      {children}
                    </a>
                  );
                },
              }}
            >
              {prepared}
            </ReactMarkdown>
            {message.status === "error" && message.error && (
              <p className="text-xs text-burgundy-700 mt-2">
                Error: {message.error}
              </p>
            )}
          </div>
        )}

        {/* Cited cases */}
        {!isUser &&
          message.cited_cases &&
          message.cited_cases.length > 0 && (
            <div className="mt-4 pt-4 border-t border-ivory-200">
              <p className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider mb-3">
                Referenced Cases
              </p>
              <div className="flex flex-col gap-2">
                {message.cited_cases.map((c, i) => {
                  const paras = c.paragraphs ?? [];
                  const shownParas = paras.slice(0, 6);
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-1.5">
                      <button
                        id={`case-${i + 1}`}
                        onClick={() => onCitationClick?.({ case: c, paragraph: null })}
                        className="text-[12px] bg-gold-100 text-gold-700 hover:bg-gold-100/80 hover:text-gold-600 px-2.5 py-1 rounded transition-colors truncate max-w-xs font-medium"
                      >
                        [{i + 1}] {c.title}
                      </button>
                      {shownParas.map((p) => (
                        <button
                          key={p}
                          onClick={() => onCitationClick?.({ case: c, paragraph: p })}
                          className="text-[11px] text-charcoal-500 hover:text-gold-700 bg-ivory-50 hover:bg-gold-100/60 border border-ivory-200 rounded px-1.5 py-0.5 font-mono transition-colors"
                          title={`Open paragraph ¶${p}`}
                        >
                          ¶{p}
                        </button>
                      ))}
                      {paras.length > shownParas.length && (
                        <span className="text-[11px] text-charcoal-400">
                          +{paras.length - shownParas.length}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        {/* PDF Downloads */}
        {!isUser &&
          message.cited_cases &&
          message.cited_cases.filter((c) => c.pdf_url).length > 0 && (
            <div className="mt-4 pt-4 border-t border-ivory-200">
              <p className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider mb-3">
                PDF Downloads
              </p>
              <div className="space-y-1.5">
                {message.cited_cases
                  .filter((c) => c.pdf_url)
                  .map((c, i) => (
                    <a
                      key={i}
                      href={c.pdf_url!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-[13px] text-charcoal-900 hover:text-gold-700 bg-ivory-50 hover:bg-gold-100/60 border border-ivory-200 rounded-lg px-3 py-2 transition-colors"
                    >
                      <svg
                        className="w-4 h-4 flex-shrink-0 text-gold-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      <span className="truncate">{c.title}</span>
                    </a>
                  ))}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

// Memoized so a streaming token — which only swaps the single assistant
// message's object reference — re-renders that one bubble, not the whole
// thread (each bubble re-parses markdown, which is expensive on long chats).
export default memo(MessageBubble);
