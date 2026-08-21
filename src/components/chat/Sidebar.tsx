"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
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
  const { user, signOut, getToken } = useAuth();
  // Staff flag comes from our users table, not the Firebase token, so it needs
  // a fetch. Failure just leaves the link hidden.
  const [isStaff, setIsStaff] = useState(false);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch("/api/user", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setIsStaff(data.is_staff === true);
      } catch {
        /* link stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, getToken]);
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
          className="fixed inset-0 z-40 bg-navy-950/60 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed lg:fixed inset-y-0 left-0 z-50 w-72 bg-ivory-100 border-r border-ivory-200 flex flex-col transition-transform ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="px-5 py-5 border-b border-ivory-200">
          <div className="flex items-center justify-between mb-5">
            <Link href="/" className="flex items-center gap-2">
              <Image
                src="/logo.png"
                alt="Legal Brain"
                width={242}
                height={256}
                className="h-7 w-auto"
              />
              <span className="flex items-baseline gap-1">
                <span className="font-serif text-xl text-charcoal-900 leading-none">
                  Legal
                </span>
                <span className="text-[15px] text-charcoal-900 tracking-tight">
                  Brain
                </span>
              </span>
            </Link>
            <button
              onClick={onClose}
              className="lg:hidden text-charcoal-400 hover:text-charcoal-900 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <button
            onClick={onNewChat}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-navy-950 text-ivory-50 px-4 py-2.5 text-[14px] font-medium hover:bg-navy-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Research
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          {sessions.length > 0 && (
            <div className="px-2 pb-2">
              <span className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">
                Recent
              </span>
            </div>
          )}
          {sessions.length === 0 ? (
            <p className="text-[13px] text-charcoal-400 text-center py-8 px-4 leading-relaxed">
              No research sessions yet. Ask your first question to get started.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((session) => (
                <li key={session.id} className="group relative">
                  <button
                    onClick={() => onSelectSession(session.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-[14px] truncate transition-colors pr-8 ${
                      activeSessionId === session.id
                        ? "bg-gold-100 text-charcoal-900"
                        : "text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900"
                    }`}
                  >
                    {session.title || "New Research"}
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    disabled={deletingId === session.id}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-charcoal-400 hover:text-burgundy-700 hover:bg-burgundy-100 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                    title="Delete session"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Bottom menu */}
        <div className="border-t border-ivory-200">
          <div className="p-3 space-y-0.5">
            <Link
              href="/workspace"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
            >
              <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              Document Workspaces
            </Link>
            <Link
              href="/translate"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
            >
              <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
              Translate Document
            </Link>
            <Link
              href="/ocr"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
            >
              <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 8V6a2 2 0 012-2h2M4 16v2a2 2 0 002 2h2m8-16h2a2 2 0 012 2v2m-4 12h2a2 2 0 002-2v-2M8 12h8M8 9h5M8 15h5" />
              </svg>
              OCR Document
            </Link>
            <Link
              href="/judgments"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
            >
              <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Judgment Library
            </Link>
            <Link
              href="/account"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
            >
              <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Upgrade Plan
            </Link>
            <Link
              href="/account"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
            >
              <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
            {/* Staff only. The API re-checks is_staff on every request and 404s
                otherwise, so hiding the link is presentation, not access control. */}
            {isStaff && (
              <Link
                href="/admin/users"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
              >
                <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                Users
              </Link>
            )}
            {isStaff && (
              <Link
                href="/admin/errors"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] text-charcoal-600 hover:bg-ivory-200 hover:text-charcoal-900 transition-colors"
              >
                <svg className="w-4 h-4 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M5.07 19H19a2 2 0 001.75-2.97l-6.93-12a2 2 0 00-3.5 0l-6.93 12A2 2 0 005.07 19z" />
                </svg>
                Error log
              </Link>
            )}
          </div>

          {/* User info */}
          <div className="px-4 py-4 border-t border-ivory-200">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-navy-950 text-ivory-50 flex items-center justify-center font-serif text-base">
                {(user?.displayName?.[0] || user?.email?.[0] || "?").toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-medium text-charcoal-900 truncate">
                  {user?.displayName || user?.email}
                </p>
              </div>
              <button
                onClick={signOut}
                className="text-charcoal-400 hover:text-charcoal-900 transition-colors"
                title="Sign out"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
