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
}

export default function ChatArea({ messages, isLoading, error, onDismissError }: ChatAreaProps) {
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
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h3 className="text-lg font-semibold text-slate-900 mb-2">
            Welcome to NyayaSearch
          </h3>
          <p className="text-slate-500 text-sm mb-6">
            Ask any legal research question. Your answers will be grounded in
            Indian case law with verifiable citations.
          </p>
          <div className="space-y-2">
            {[
              "What are the landmark cases on Right to Privacy?",
              "Recent Supreme Court judgments on Section 498A",
              "High Court rulings on bail in NDPS cases",
            ].map((suggestion) => (
              <p
                key={suggestion}
                className="text-sm text-primary-600 bg-primary-50 rounded-lg px-4 py-2"
              >
                {suggestion}
              </p>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onCaseClick={handleCaseClick}
          />
        ))}
        {isLoading &&
          (() => {
            // Only show the standalone spinner while the assistant bubble is
            // still empty (retrieval + rerank phase). Once tokens start
            // streaming, the bubble itself signals progress.
            const last = messages[messages.length - 1];
            const streaming =
              last && last.role === "assistant" && last.content.length > 0;
            if (streaming) return null;
            return (
              <div className="flex items-center gap-2 text-slate-500 mb-4">
                <Spinner size="sm" />
                <span className="text-sm">Searching case law...</span>
              </div>
            );
          })()}
        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <svg className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm text-red-800">{error}</p>
            </div>
            {onDismissError && (
              <button
                onClick={onDismissError}
                className="text-red-400 hover:text-red-600"
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
