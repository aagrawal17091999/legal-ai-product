"use client";

import { useState, useRef, useEffect } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
}

export default function ChatInput({ onSend, onStop, isLoading, disabled }: ChatInputProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 240) + "px";
    }
  }, [message]);

  const handleSubmit = () => {
    if (isLoading) return;
    const trimmed = message.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setMessage("");
  };

  const handleStop = () => {
    onStop?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isLoading) {
        handleStop();
      } else {
        handleSubmit();
      }
    }
  };

  return (
    <div className="border-t border-ivory-200 bg-ivory-50 px-6 py-5">
      <div className="max-w-3xl mx-auto">
        <div className="relative flex items-end gap-3 bg-ivory-100 border border-ivory-200 rounded-xl px-5 py-4 focus-within:border-gold-500 focus-within:[box-shadow:0_0_0_3px_rgba(192,125,43,0.2)] transition-colors">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a legal research question…"
            rows={1}
            className="flex-1 resize-none bg-transparent text-[17px] text-charcoal-900 placeholder:text-charcoal-400 focus:outline-none leading-relaxed"
          />
          {isLoading ? (
            <button
              type="button"
              onClick={handleStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-burgundy-700 text-ivory-50 hover:opacity-90 transition-opacity"
            >
              <span className="block w-3 h-3 bg-ivory-50 rounded-[2px]" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={disabled || !message.trim()}
              aria-label="Send message"
              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-navy-950 text-gold-500 hover:bg-navy-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
              </svg>
            </button>
          )}
        </div>
        <p className="mt-3 text-center text-[12px] text-charcoal-400">
          Press Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
