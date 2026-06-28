"use client";

import { useEffect } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirestore } from "@/lib/firebase";

/**
 * Push-based replacement for status polling. The OCR/Translate workers mirror a
 * job's status into Firestore (`{feature}_jobs/{jobId}`); this subscribes to each
 * still-processing job and calls `onTerminal` the moment one flips to `ready` or
 * `failed`. The callback should re-fetch from Postgres (the source of truth) for
 * the full updated row + download URLs.
 *
 * Reads are authenticated by the signed-in Firebase user and gated by
 * firestore.rules; snapshot errors (e.g. before the doc exists) are ignored.
 */
export function useJobStatusPush(
  feature: "ocr" | "translate",
  processingIds: string[],
  onTerminal: () => void
): void {
  // Join into a stable dependency so the effect re-subscribes only when the set
  // of processing jobs actually changes, not on every render.
  const key = processingIds.join(",");

  useEffect(() => {
    if (processingIds.length === 0) return;
    const db = getFirestore();
    const collection = feature === "ocr" ? "ocr_jobs" : "translate_jobs";

    const unsubs = processingIds.map((id) =>
      onSnapshot(
        doc(db, collection, id),
        (snap) => {
          const status = snap.data()?.status;
          if (status === "ready" || status === "failed") onTerminal();
        },
        () => {
          /* permission/transient errors are non-fatal — the watchdog + manual
             reload still recover the UI. */
        }
      )
    );
    return () => unsubs.forEach((u) => u());
    // `key` captures processingIds; onTerminal must be stable (useCallback).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature, key, onTerminal]);

  // Safety net for the rare dropped push (Firestore mirror is best-effort and is
  // the only notification): when the tab regains focus while jobs are still
  // processing, reconcile against Postgres. Event-driven, not a polling loop.
  useEffect(() => {
    if (processingIds.length === 0) return;
    const reconcile = () => {
      if (document.visibilityState === "visible") onTerminal();
    };
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onTerminal]);
}
