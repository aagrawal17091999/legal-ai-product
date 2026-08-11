"use client";

import { useEffect } from "react";
import Button from "@/components/ui/Button";
import { reportError } from "@/lib/report-error";

// Catches render/fetch throws inside any protected page so a single bad
// request doesn't blank the whole app. `reset()` re-renders the segment.
export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError("Protected route boundary caught", { component: "ProtectedError" }, error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center bg-ivory-50 px-6 py-16">
      <div className="max-w-md text-center">
        <span className="overline">Something went wrong</span>
        <h1 className="mt-5 font-serif text-3xl text-charcoal-900 tracking-tight">
          We hit an unexpected error.
        </h1>
        <p className="mt-4 text-[15px] text-charcoal-600 leading-relaxed">
          This page failed to load. You can try again — if it keeps happening,
          please let us know at{" "}
          <a href="mailto:ansh@getlegalbrain.com" className="text-gold-600 hover:text-gold-700">
            ansh@getlegalbrain.com
          </a>.
        </p>
        <div className="mt-8">
          <Button variant="primary" onClick={() => reset()}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
