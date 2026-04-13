"use client";

import { useEffect, use } from "react";
import ChatArea from "@/components/chat/ChatArea";
import ChatInput from "@/components/chat/ChatInput";
import UpgradeModal from "@/components/chat/UpgradeModal";
import { useChatContext } from "../../layout";

export default function ChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const {
    messages,
    isLoading,
    limitReached,
    setLimitReached,
    error,
    setError,
    loadSession,
    sendMessage,
    stopMessage,
    user,
    authLoading,
  } = useChatContext();

  useEffect(() => {
    if (user && !authLoading) {
      loadSession(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, user, authLoading]);

  return (
    <>
      <ChatArea
        messages={messages}
        isLoading={isLoading}
        error={error}
        onDismissError={() => setError(null)}
        onSuggestionClick={(s) => sendMessage(s)}
      />
      <ChatInput onSend={sendMessage} onStop={stopMessage} isLoading={isLoading} />
      <UpgradeModal
        isOpen={limitReached}
        onClose={() => setLimitReached(false)}
      />
    </>
  );
}
