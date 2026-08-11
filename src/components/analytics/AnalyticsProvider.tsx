"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { initAnalytics, identifyUser, resetAnalytics } from "@/lib/analytics/client";

/**
 * Boots the Mixpanel browser SDK and keeps its identity in step with the server's.
 *
 * The critical detail is the id. The server uses `String(users.id)` as
 * distinct_id everywhere; this must use the same value, or client and server
 * events describe two different people and every funnel that crosses the
 * boundary (click → checkout → subscription_activated) silently breaks in a way
 * that looks like poor conversion rather than a bug.
 *
 * Our `users.id` isn't in the Firebase token, so it takes one fetch. That's also
 * why identification is deliberately late: anonymous page views are captured
 * from first load and stitched to the user once we know who they are.
 *
 * No-ops entirely when NEXT_PUBLIC_MIXPANEL_TOKEN is unset.
 */
export default function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { user, getToken } = useAuth();
  // Identify once per signed-in user; re-running would reset session state.
  const identifiedFor = useRef<string | null>(null);

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    if (!user) {
      // Signed out: clear the stored distinct_id so the next person on this
      // browser isn't merged into the previous one's profile.
      if (identifiedFor.current) {
        resetAnalytics();
        identifiedFor.current = null;
      }
      return;
    }
    if (identifiedFor.current === user.uid) return;

    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch("/api/user", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (typeof data.id !== "number") return;
        identifiedFor.current = user.uid;
        identifyUser(data.id, data.plan);
      } catch {
        // Anonymous tracking continues; only the stitch is lost.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, getToken]);

  return <>{children}</>;
}
