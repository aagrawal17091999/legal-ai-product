"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import Sidebar from "@/components/chat/Sidebar";
import { useChat } from "@/hooks/useChat";
import type { SearchFilters } from "@/types";

// Share chat context across all protected pages
import { createContext, useContext } from "react";

interface ChatContextValue {
  sessions: ReturnType<typeof useChat>["sessions"];
  currentSession: ReturnType<typeof useChat>["currentSession"];
  messages: ReturnType<typeof useChat>["messages"];
  isLoading: ReturnType<typeof useChat>["isLoading"];
  limitReached: ReturnType<typeof useChat>["limitReached"];
  setLimitReached: ReturnType<typeof useChat>["setLimitReached"];
  error: ReturnType<typeof useChat>["error"];
  setError: ReturnType<typeof useChat>["setError"];
  createSession: (filters: SearchFilters) => Promise<ReturnType<typeof useChat>["currentSession"]>;
  loadSession: (id: string) => Promise<void>;
  deleteSession: ReturnType<typeof useChat>["deleteSession"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  user: ReturnType<typeof useChat>["user"];
  authLoading: ReturnType<typeof useChat>["authLoading"];
}

export const ChatContext = createContext<ChatContextValue | null>(null);
export function useChatContext() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatContext must be used within ChatContext");
  return ctx;
}

function ProtectedContent({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const chat = useChat();

  useEffect(() => {
    if (chat.user && !chat.authLoading) {
      chat.loadSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.user, chat.authLoading]);

  const handleNewChat = useCallback(() => {
    chat.setCurrentSession(null);
    chat.setMessages([]);
    router.push("/chat");
    setSidebarOpen(false);
  }, [chat, router]);

  const activeSessionId = pathname.startsWith("/chat/")
    ? pathname.replace("/chat/", "")
    : undefined;

  const handleSelectSession = useCallback(
    (id: string) => {
      router.push(`/chat/${id}`);
      setSidebarOpen(false);
    },
    [router]
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      const deleted = await chat.deleteSession(id);
      if (deleted && activeSessionId === id) {
        router.push("/chat");
      }
    },
    [chat, activeSessionId, router]
  );

  return (
    <ChatContext.Provider value={chat}>
      <div className="flex h-screen bg-white">
        <Sidebar
          sessions={chat.sessions}
          activeSessionId={activeSessionId}
          onNewChat={handleNewChat}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        <div
          className={`flex-1 flex flex-col min-w-0 transition-all ${
            sidebarOpen ? "lg:ml-72" : ""
          }`}
        >
          {/* Header with hamburger toggle */}
          <div className="flex items-center gap-3 p-3 border-b border-slate-200">
            <button
              onClick={() => setSidebarOpen((prev) => !prev)}
              className="text-slate-600 hover:text-slate-900"
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="text-sm font-medium text-slate-900">
              NyayaSearch
            </span>
          </div>

          {children}
        </div>
      </div>
    </ChatContext.Provider>
  );
}

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <ProtectedContent>{children}</ProtectedContent>
    </AuthGuard>
  );
}
