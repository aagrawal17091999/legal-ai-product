"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";

interface AuthGuardProps {
  children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push(`/login?returnUrl=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [user, loading, router]);

  if (loading) {
    // Render the sidebar shell + skeleton while auth resolves so the page
    // doesn't flash a blank spinner before showing the real layout.
    return (
      <div className="flex h-screen bg-ivory-50">
        <aside className="fixed inset-y-0 left-0 z-50 w-72 bg-ivory-100 border-r border-ivory-200 flex flex-col">
          <div className="px-5 py-5 border-b border-ivory-200">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-baseline gap-1">
                <span className="font-serif text-xl text-charcoal-900 leading-none">Nyaya</span>
                <span className="text-[15px] text-charcoal-900 tracking-tight">Search</span>
              </div>
            </div>
            <div className="w-full h-10 rounded-lg bg-ivory-200 animate-pulse" />
          </div>
          <div className="flex-1 px-3 py-4 space-y-2">
            <div className="px-2 pb-2">
              <div className="h-3 w-12 bg-ivory-200 rounded animate-pulse" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 rounded-lg bg-ivory-200 animate-pulse" />
            ))}
          </div>
        </aside>
        <div className="flex-1 lg:ml-72" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}
