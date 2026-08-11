"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { useJobStatusPush } from "@/hooks/useJobStatusPush";
import { useCreditsContext } from "@/components/credits/CreditsProvider";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";

interface OcrJob {
  id: string;
  source_filename: string;
  detected_language: string | null;
  status: "processing" | "ready" | "failed";
  segment_count: number;
  flagged_count: number;
  ocr_used: boolean;
  error: string | null;
  created_at: string;
}

const ACCEPT = ".pdf,.docx,.jpg,.jpeg,.png,.webp";
// Mirror the server limit (25 MB) and accepted extensions so we fail fast
// client-side instead of uploading a file the server will reject.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXT = ["pdf", "docx", "jpg", "jpeg", "png", "webp"];

function validateFile(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXT.includes(ext)) {
    return "Unsupported file type. Use PDF, DOCX, JPG, PNG, or WEBP.";
  }
  if (file.size > MAX_FILE_BYTES) {
    return "File exceeds the 25 MB limit.";
  }
  return null;
}

export default function OcrPage() {
  const { handlePaymentRequired, refresh: refreshCredits } = useCreditsContext();
  const { getToken } = useAuth();
  const [jobs, setJobs] = useState<OcrJob[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return { Authorization: `Bearer ${token}` };
  }, [getToken]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/ocr", { headers: await authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs ?? []);
      } else {
        setError("Couldn't load your documents. Please refresh and try again.");
      }
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
  }, [authHeaders]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Push instead of poll: subscribe to each processing job's Firestore status
  // doc and refresh the list (Postgres is source of truth) the moment one turns
  // ready/failed.
  useJobStatusPush(
    "ocr",
    jobs.filter((j) => j.status === "processing").map((j) => j.id),
    loadJobs
  );

  // Fetch a fresh signed URL and open it (URLs are short-lived, so fetch on
  // click). Open the blank tab synchronously on click — before the await — so
  // popup blockers don't kill it, then point it at the resolved URL.
  const download = async (jobId: string, kind: "pdf" | "docx") => {
    setError(null);
    const w = window.open("", "_blank");
    try {
      const res = await fetch(`/api/ocr/${jobId}`, { headers: await authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const url = kind === "pdf" ? data.pdfUrl : data.docxUrl;
        if (url) {
          if (w) w.location.href = url;
          return;
        }
      }
      if (w) w.close();
      setError("Couldn't get the download. Please try again.");
    } catch {
      if (w) w.close();
      setError("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const deleteJob = async (jobId: string, name: string) => {
    if (!window.confirm(`Delete the OCR result for "${name}"? This can't be undone.`)) return;
    setDeletingId(jobId);
    try {
      const res = await fetch(`/api/ocr/${jobId}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      if (res.ok) setJobs((prev) => prev.filter((j) => j.id !== jobId));
    } finally {
      setDeletingId(null);
    }
  };

  const submit = async () => {
    if (!file) {
      setError("Choose a file to run OCR on.");
      return;
    }
    const invalid = validateFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/ocr", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });
      // Out of credits: open the purchase path instead of showing a dead-end
      // error the user has no way to act on.
      if (handlePaymentRequired(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.error || "Failed to start OCR.");
        return;
      }
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await loadJobs();
      void refreshCredits();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="font-serif text-2xl text-charcoal-900">OCR Document</h1>
        <p className="text-[14px] text-charcoal-500 mt-1.5 max-w-xl leading-relaxed">
          Extract text from a scanned or photographed document — preserving its
          structure — and download a clean, formatted PDF (or editable Word file).
          The original language is kept; nothing is translated.
        </p>

        {/* Review notice */}
        <div className="mt-5 rounded-lg border border-gold-400 bg-gold-100/50 px-4 py-3">
          <p className="text-[13px] text-charcoal-700 leading-relaxed">
            <span className="font-semibold">Draft for review.</span> AI OCR can misread faded ink,
            handwriting, or unusual scripts. Sections the system can&apos;t read confidently are
            flagged in the output rather than guessed. Review before relying on it.
          </p>
        </div>

        {/* Upload form */}
        <div className="mt-6 rounded-xl border border-ivory-200 bg-ivory-100 p-5">
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-[13px] font-medium text-charcoal-700 mb-1.5">Document</label>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-[13px] text-charcoal-700 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-950 file:px-4 file:py-2 file:text-ivory-50 file:text-[13px] file:font-medium hover:file:bg-navy-800"
              />
              <p className="text-[11px] text-charcoal-400 mt-1.5">PDF, DOCX, JPG, PNG · up to 25 MB</p>
            </div>
            {error && <p className="text-[13px] text-burgundy-700">{error}</p>}
            <div>
              <Button onClick={submit} disabled={submitting}>
                {submitting ? <Spinner size="sm" /> : "Run OCR"}
              </Button>
            </div>
          </div>
        </div>

        {/* Jobs */}
        <div className="mt-8">
          <h2 className="text-[12px] font-medium text-charcoal-400 uppercase tracking-wider mb-3">
            Your documents
          </h2>
          {jobs.length === 0 ? (
            <p className="text-[13px] text-charcoal-400">No documents yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {jobs.map((j) => (
                <li
                  key={j.id}
                  className="group rounded-xl border border-ivory-200 bg-ivory-50 px-5 py-4 flex items-center justify-between gap-4"
                >
                  {(() => {
                    const info = (
                      <>
                        <p className="text-[14px] font-medium text-charcoal-900 truncate group-hover:underline">
                          {j.source_filename}
                        </p>
                        <p className="text-[12px] text-charcoal-500 mt-0.5">
                          {j.detected_language ?? ""}
                          {j.status === "ready" && (
                            <>
                              {j.detected_language ? " · " : ""}
                              {j.segment_count} segments
                              {j.flagged_count > 0 && (
                                <span className="text-burgundy-700"> · {j.flagged_count} flagged</span>
                              )}
                            </>
                          )}
                        </p>
                        {j.status === "failed" && j.error && (
                          <p className="text-[12px] text-burgundy-700 mt-0.5">{j.error}</p>
                        )}
                      </>
                    );
                    // Ready jobs open the in-app viewer; others aren't clickable.
                    return j.status === "ready" ? (
                      <Link href={`/ocr/${j.id}`} className="min-w-0 group block">
                        {info}
                      </Link>
                    ) : (
                      <div className="min-w-0">{info}</div>
                    );
                  })()}
                  <div className="flex-shrink-0 flex items-center gap-3">
                    {j.status === "processing" && (
                      <span className="flex items-center gap-2 text-[12px] text-gold-700">
                        <Spinner size="sm" /> Processing
                      </span>
                    )}
                    {j.status === "ready" && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => download(j.id, "pdf")}>
                          Download PDF
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => download(j.id, "docx")}>
                          .docx
                        </Button>
                      </>
                    )}
                    {j.status === "failed" && (
                      <span className="text-[12px] text-burgundy-700">Failed</span>
                    )}
                    <button
                      onClick={() => deleteJob(j.id, j.source_filename)}
                      disabled={deletingId === j.id}
                      className="text-charcoal-400 hover:text-burgundy-700 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                      title="Delete OCR result"
                    >
                      {deletingId === j.id ? (
                        <Spinner size="sm" />
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      )}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
