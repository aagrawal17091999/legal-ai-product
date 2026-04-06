"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import type { ChatSession } from "@/types";

interface SidebarProps {
  sessions: ChatSession[];
  activeSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  isOpen,
  onClose,
}: SidebarProps) {
  const { user, signOut } = useAuth();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setDeletingId(sessionId);
    await onDeleteSession(sessionId);
    setDeletingId(null);
  };

  return (
    <>
      {/* Overlay when sidebar is open on mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed lg:fixed inset-y-0 left-0 z-50 w-72 bg-slate-50 border-r border-slate-200 flex flex-col transition-transform ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="p-4 border-b border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-slate-900">
              NyayaSearch
            </span>
            <button
              onClick={onClose}
              className="lg:hidden text-slate-400 hover:text-slate-600"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <button
            onClick={onNewChat}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-primary-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Chat
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">
              No conversations yet
            </p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((session) => (
                <li key={session.id} className="group relative">
                  <button
                    onClick={() => onSelectSession(session.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors pr-8 ${
                      activeSessionId === session.id
                        ? "bg-primary-100 text-primary-700"
                        : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {session.title || "New Chat"}
                  </button>
                  {/* Delete button — visible on hover */}
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    disabled={deletingId === session.id}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                    title="Delete chat"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Bottom menu: Features, Settings, Upgrade, Sign Out */}
        <div className="border-t border-slate-200">
          {/* Navigation links */}
          <div className="p-2 space-y-0.5">
            <Link
              href="/judgments"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Judgment Library
            </Link>
            <Link
              href="/account"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Upgrade Plan
            </Link>
            <Link
              href="/account"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
          </div>

          {/* User info */}
          <div className="p-4 pt-2 border-t border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-600 text-sm font-medium">
                {user?.displayName?.[0] || user?.email?.[0] || "?"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">
                  {user?.displayName || user?.email}
                </p>
              </div>
              <button
                onClick={signOut}
                className="text-slate-400 hover:text-slate-600"
                title="Sign out"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
