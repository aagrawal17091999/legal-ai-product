"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";

export default function Navbar() {
  const { user, loading, signOut } = useAuth();

  return (
    <nav className="border-b border-slate-200 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="text-xl font-bold text-slate-900">
            NyayaSearch
          </Link>

          <div className="hidden sm:flex items-center gap-6">
            <Link
              href="/pricing"
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              Pricing
            </Link>
            <Link
              href="/team"
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              Team
            </Link>
          </div>

          <div className="flex items-center gap-3">
            {loading ? (
              <div className="w-20 h-8" />
            ) : user ? (
              <>
                <Link href="/chat">
                  <Button variant="primary" size="sm">
                    Go to Chat
                  </Button>
                </Link>
                <button
                  onClick={signOut}
                  className="text-sm text-slate-600 hover:text-slate-900"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <Link href="/login">
                  <Button variant="ghost" size="sm">
                    Log In
                  </Button>
                </Link>
                <Link href="/signup">
                  <Button variant="primary" size="sm">
                    Sign Up
                  </Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
