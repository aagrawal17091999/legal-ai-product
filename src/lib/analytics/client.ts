"use client";

import type { OverridedMixpanel } from "mixpanel-browser";
import type { EventName } from "./events";

/**
 * Client-side analytics — the browser half of a deliberately server-first setup.
 *
 * What this adds that the server cannot see: referrer, UTM parameters, device,
 * browser, and session stitching. Without it you can count conversions but not
 * tell which channel produced them, which is the question that matters at launch.
 *
 * What it does NOT do: emit anything of consequence. Signups, payments,
 * messages, and job outcomes are all server-side. The browser sends interaction
 * events only.
 *
 * OFF BY DEFAULT. It initialises only when NEXT_PUBLIC_MIXPANEL_TOKEN is set.
 * Understand the trade before setting it: a browser token is public by nature,
 * so anyone can post arbitrary events to the project. That's true of every
 * client-side analytics install, but it does mean the server-side allowlist
 * stops being a hard guarantee. Keeping revenue events server-only is what
 * preserves their integrity either way.
 *
 * The SDK is loaded with a DYNAMIC import so it stays out of the bundle
 * entirely when no token is configured — a type-only import above, and ~60 KB
 * of JavaScript that never ships for a server-only install. Clicks fired before
 * it finishes loading fall through to the relay endpoint rather than being
 * queued, so nothing is lost and nothing has to be flushed.
 */

const TOKEN = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN?.trim();

/** Must match the server's region, or client and server events split across projects. */
function apiHost(): string {
  const raw = (process.env.NEXT_PUBLIC_MIXPANEL_API_HOST || "https://api.mixpanel.com").trim();
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

let mp: OverridedMixpanel | null = null;
let loading = false;

/** Idempotent; safe to call on every render path. */
export function initAnalytics(): void {
  if (mp || loading || !TOKEN || typeof window === "undefined") return;
  loading = true;
  void (async () => {
    try {
      const mod = await import("mixpanel-browser");
      const client = mod.default;
      client.init(TOKEN, {
        api_host: apiHost(),
        // Explicit events only. Autocapture would hoover up DOM text from pages
        // rendering judgment excerpts and uploaded-document content — exactly
        // the material that must never leave the box.
        autocapture: false,
        // Path only: query strings on authenticated routes can carry ids.
        track_pageview: "url-with-path",
        persistence: "localStorage",
      });
      mp = client;
    } catch {
      // Blocked, offline, or chunk failed to load: trackClick falls back to the
      // relay endpoint, so click data still arrives.
    } finally {
      loading = false;
    }
  })();
}

/**
 * Bind the browser's anonymous history to the signed-in user.
 *
 * The id MUST be the same `String(users.id)` the server uses as distinct_id, or
 * client and server events describe two different people and every funnel that
 * crosses the boundary silently breaks.
 */
export function identifyUser(userId: number, plan?: string): void {
  if (!mp) return;
  try {
    mp.identify(String(userId));
    if (plan) mp.people.set({ plan });
  } catch {
    /* best effort */
  }
}

export function resetAnalytics(): void {
  if (!mp) return;
  try {
    mp.reset();
  } catch {
    /* best effort */
  }
}

/**
 * Record an interaction.
 *
 * Uses the SDK when it's loaded (so the event carries UTM and device context),
 * and otherwise relays through our own endpoint — which keeps click tracking
 * working for a server-only install, for users whose ad blocker eats the
 * Mixpanel script, and for the first clicks before the chunk arrives.
 */
export function trackClick(
  event: EventName,
  properties?: Record<string, string | number | boolean>
): void {
  if (typeof window === "undefined") return;

  if (mp) {
    try {
      mp.track(event, properties);
      return;
    } catch {
      // fall through to the relay
    }
  }

  const body = JSON.stringify({ event, properties });
  try {
    // sendBeacon survives the page being navigated away from or closed, which is
    // exactly when a click on a checkout button fires.
    if (navigator.sendBeacon) {
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
