"use client";

import { useEffect, useState, use } from "react";
import ChatArea from "@/components/chat/ChatArea";
import ChatInput from "@/components/chat/ChatInput";
import CitationPanel from "@/components/chat/CitationPanel";
import UpgradeModal from "@/components/chat/UpgradeModal";
import { useChatContext } from "../../layout";
import type { CitationRef } from "@/types";

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

  const [selectedCitation, setSelectedCitation] = useState<CitationRef | null>(null);

  // Depend on uid (stable) rather than the Firebase user object, whose identity
  // changes on every token refresh. Re-firing this effect mid-stream would call
  // loadSession and overwrite the in-flight assistant bubble with the DB state.
  const uid = user?.uid;
  useEffect(() => {
    if (uid && !authLoading) {
      loadSession(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, uid, authLoading]);

  return (
    <>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <ChatArea
            messages={messages}
            isLoading={isLoading}
            error={error}
            onDismissError={() => setError(null)}
            onSuggestionClick={(s) => sendMessage(s)}
            onCitationClick={setSelectedCitation}
          />
          <ChatInput onSend={sendMessage} onStop={stopMessage} isLoading={isLoading} />
        </div>
        <CitationPanel
          citation={selectedCitation}
          onClose={() => setSelectedCitation(null)}
        />
      </div>
      <UpgradeModal
        isOpen={limitReached}
        onClose={() => setLimitReached(false)}
      />
    </>
  );
}
