"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";

export default function Navbar() {
  const { user, loading, signOut } = useAuth();

  return (
    <nav className="border-b border-ivory-200 bg-ivory-50">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-baseline gap-1">
            <span className="font-serif text-2xl text-charcoal-900 leading-none">
              Nyaya
            </span>
            <span className="text-lg text-charcoal-900 tracking-tight">
              Search
            </span>
          </Link>

          <div className="hidden sm:flex items-center gap-8">
            <Link
              href="/#features"
              className="text-[14px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
            >
              Features
            </Link>
            <Link
              href="/#pricing"
              className="text-[14px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
            >
              Pricing
            </Link>
            {user && (
              <Link
                href="/judgments"
                className="text-[14px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
              >
                Judgments
              </Link>
            )}
            <Link
              href="/team"
              className="text-[14px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
            >
              About
            </Link>
          </div>

          <div className="flex items-center gap-3">
            {loading ? (
              <div className="w-20 h-8" />
            ) : user ? (
              <>
                <Link href="/chat">
                  <Button variant="primary" size="sm">
                    Go to Research →
                  </Button>
                </Link>
                <button
                  onClick={signOut}
                  className="text-[14px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="text-[14px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
                >
                  Sign In
                </Link>
                <Link href="/signup">
                  <Button variant="primary" size="sm">
                    Start Free →
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
