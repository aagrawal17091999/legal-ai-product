"use client";

import type { EventName } from "./events";

/**
 * Client-side click tracking.
 *
 * Deliberately NOT the Mixpanel browser SDK. Posting to our own endpoint means
 * the project token never enters the browser bundle, there's no third-party
 * script to slow first paint or to be blocked outright, and the server decides
 * what is allowed to be recorded (see CLIENT_ALLOWED in events.ts).
 *
 * Only interaction events belong here. Anything that must be true — a payment,
 * a signup, a message — is emitted server-side where it can't be lost or faked.
 */
export function trackClick(
  event: EventName,
  properties?: Record<string, string | number | boolean>
): void {
  if (typeof window === "undefined") return;

  const body = JSON.stringify({ event, properties });

  // sendBeacon survives the page being navigated away from or closed, which is
  // exactly when a click on a link or a checkout button fires. Fall back to
  // fetch+keepalive where it isn't available.
  try {
    if (navigator.sendBeacon) {
      // Beacon sends text/plain unless given a Blob with an explicit type; the
      // route accepts both, but keeping it JSON avoids a content-type branch.
      navigator.sendBeacon(
        "/api/analytics/event",
        new Blob([body], { type: "application/json" })
      );
      return;
    }
    void fetch("/api/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics must never break an interaction.
  }
}
