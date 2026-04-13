"use client";

import { useRef, useEffect } from "react";
import MessageBubble from "./MessageBubble";
import Spinner from "@/components/ui/Spinner";
import type { ChatMessage, CitedCase } from "@/types";

interface ChatAreaProps {
  messages: ChatMessage[];
  isLoading: boolean;
  error?: string | null;
  onDismissError?: () => void;
  onSuggestionClick?: (suggestion: string) => void;
}

const SUGGESTIONS = [
  "What is the current position of the Supreme Court on the grant of anticipatory bail in economic offences?",
  "Summarise the ratio in Vishaka v. State of Rajasthan and its subsequent application by High Courts",
  "What are the grounds on which a High Court can quash an FIR under Section 482 CrPC?",
];

export default function ChatArea({
  messages,
  isLoading,
  error,
  onDismissError,
  onSuggestionClick,
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleCaseClick = (caseRef: CitedCase) => {
    if (caseRef.pdf_url) {
      window.open(caseRef.pdf_url, "_blank");
    }
  };

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-ivory-50">
        <div className="text-center max-w-[640px]">
          <span className="overline">Start a new session</span>
          <h2 className="mt-6 font-serif text-4xl sm:text-[40px] leading-tight tracking-tight text-charcoal-900">
            What are you researching today?
          </h2>
          <p className="mt-4 text-[15px] text-charcoal-600 max-w-md mx-auto leading-relaxed">
            Ask any question about Indian case law. Every answer will cite the
            source judgment.
          </p>

          <div className="mt-10 space-y-2.5 text-left">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => onSuggestionClick?.(suggestion)}
                className="w-full text-left text-[14px] text-charcoal-900 bg-ivory-100 hover:bg-gold-100 border border-ivory-200 hover:border-gold-400 rounded-lg px-5 py-3.5 transition-colors leading-snug"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-ivory-50">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onCaseClick={handleCaseClick}
          />
        ))}
        {isLoading &&
          (() => {
            const last = messages[messages.length - 1];
            const streaming =
              last && last.role === "assistant" && last.content.length > 0;
            if (streaming) return null;
            return (
              <div className="flex items-center gap-3 text-charcoal-600 mb-4">
                <Spinner size="sm" />
                <span className="text-[14px]">Searching case law…</span>
              </div>
            );
          })()}
        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-lg bg-burgundy-100 border border-burgundy-700/30 px-4 py-3">
            <svg className="w-5 h-5 text-burgundy-700 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <p className="text-[14px] text-burgundy-700">{error}</p>
            </div>
            {onDismissError && (
              <button
                onClick={onDismissError}
                className="text-burgundy-700/60 hover:text-burgundy-700"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
