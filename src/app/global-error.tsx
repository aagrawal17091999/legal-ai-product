"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/report-error";

// Root global error boundary. Replaces the root layout when it (or the app
// shell) throws, so it must render its own <html>/<body>. Kept dependency-free
// — Tailwind classes may not be available this far up, so styles are inline.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError("Global error boundary caught", { component: "GlobalError" }, error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#FBF9F4",
          color: "#1A1A1A",
          fontFamily: "Georgia, 'Times New Roman', serif",
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.875rem", lineHeight: 1.2, margin: 0 }}>
            Something went wrong.
          </h1>
          <p
            style={{
              marginTop: "1rem",
              fontSize: "1rem",
              lineHeight: 1.6,
              color: "#4A4A4A",
              fontFamily: "system-ui, sans-serif",
            }}
          >
            The application ran into an unexpected error. Please reload and try
            again.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "2rem",
              backgroundColor: "#0A1A2F",
              color: "#FBF9F4",
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.75rem 1.5rem",
              fontSize: "0.9375rem",
              fontFamily: "system-ui, sans-serif",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
