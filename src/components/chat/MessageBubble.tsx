"use client";

import ReactMarkdown from "react-markdown";
import type { ChatMessage, CitedCase } from "@/types";

interface MessageBubbleProps {
  message: ChatMessage;
  onCaseClick?: (caseRef: CitedCase) => void;
}

/**
 * Replace [^n] citation markers produced by Claude with markdown links of
 * the form [[n]](#case-n). The link component below intercepts those hrefs
 * and routes them through onCaseClick so users get the same behavior as
 * clicking a case chip (open the PDF).
 */
function inlineCitations(content: string): string {
  return content.replace(/\[\^(\d+)\]/g, "[[$1]](#case-$1)");
}

export default function MessageBubble({
  message,
  onCaseClick,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const prepared = isUser ? message.content : inlineCitations(message.content);

  const handleCitationHref = (href: string) => {
    const match = href.match(/^#case-(\d+)$/);
    if (!match) return false;
    const idx = parseInt(match[1], 10);
    const ref = message.cited_cases?.[idx - 1];
    if (ref) {
      onCaseClick?.(ref);
      return true;
    }
    return false;
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
          <div className="prose prose-sm max-w-none prose-p:text-charcoal-900 prose-p:leading-relaxed prose-headings:font-serif prose-headings:text-charcoal-900 prose-strong:text-charcoal-900 prose-li:text-charcoal-900 prose-a:text-gold-600 hover:prose-a:text-gold-700">
            <ReactMarkdown
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
              <div className="flex flex-wrap gap-2">
                {message.cited_cases.map((c, i) => (
                  <button
                    key={i}
                    id={`case-${i + 1}`}
                    onClick={() => onCaseClick?.(c)}
                    className="text-[12px] bg-gold-100 text-gold-700 hover:bg-gold-100/80 hover:text-gold-600 px-2.5 py-1 rounded transition-colors truncate max-w-xs font-medium"
                  >
                    [{i + 1}] {c.title}
                  </button>
                ))}
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
