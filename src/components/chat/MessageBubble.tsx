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
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? "bg-slate-100 text-slate-900"
            : "bg-white border border-slate-200 text-slate-800"
        }`}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm prose-slate max-w-none">
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
                        className="inline-flex align-super text-[0.65rem] font-semibold text-primary-700 hover:text-primary-900 bg-primary-50 hover:bg-primary-100 rounded px-1 py-0.5 mx-0.5 no-underline"
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
              <p className="text-xs text-red-600 mt-2">Error: {message.error}</p>
            )}
          </div>
        )}

        {/* Cited cases */}
        {!isUser &&
          message.cited_cases &&
          message.cited_cases.length > 0 && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-500 mb-2">
                Referenced Cases:
              </p>
              <div className="flex flex-wrap gap-2">
                {message.cited_cases.map((c, i) => (
                  <button
                    key={i}
                    id={`case-${i + 1}`}
                    onClick={() => onCaseClick?.(c)}
                    className="text-xs bg-primary-50 text-primary-700 px-2 py-1 rounded hover:bg-primary-100 transition-colors truncate max-w-xs"
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
            <div className="mt-3 pt-3 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-500 mb-2">
                PDF Downloads:
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
                      className="flex items-center gap-2 text-xs text-primary-700 hover:text-primary-800 bg-primary-50 hover:bg-primary-100 rounded px-2.5 py-1.5 transition-colors"
                    >
                      <svg
                        className="w-4 h-4 flex-shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
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
