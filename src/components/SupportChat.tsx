"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";

interface SupportIdentity {
  enabled: true;
  baseUrl: string;
  websiteToken: string;
  identifier: string;
  identifierHash: string;
  email: string;
  name: string;
  plan: string;
}

interface ChatwootGlobal {
  setUser: (
    identifier: string,
    user: { email: string; name: string; identifier_hash: string }
  ) => void;
  setCustomAttributes: (attrs: Record<string, string | number>) => void;
  reset: () => void;
}

declare global {
  interface Window {
    chatwootSettings?: Record<string, unknown>;
    chatwootSDK?: { run: (opts: { websiteToken: string; baseUrl: string }) => void };
    $chatwoot?: ChatwootGlobal;
  }
}

const SCRIPT_ID = "chatwoot-sdk";

/**
 * The bottom-right support chat (Chatwoot). Conversations land in Chatwoot and
 * its Slack integration; replies posted in the Slack thread come back here.
 *
 * Renders nothing itself — the SDK injects its own bubble. Loads once per page
 * life; sign-out resets it (see useAuth.signOut) so the next person on this
 * browser doesn't see the previous user's conversation.
 */
export default function SupportChat() {
  const { getToken } = useAuth();

  useEffect(() => {
    // StrictMode double-run, or remounting after a client-side navigation.
    if (document.getElementById(SCRIPT_ID)) return;

    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch("/api/support/identity", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const identity = (await res.json()) as SupportIdentity | { enabled: false };
        if (cancelled || !identity.enabled) return;
        if (document.getElementById(SCRIPT_ID)) return;

        window.addEventListener(
          "chatwoot:ready",
          () => {
            window.$chatwoot?.setUser(identity.identifier, {
              email: identity.email,
              name: identity.name,
              identifier_hash: identity.identifierHash,
            });
            window.$chatwoot?.setCustomAttributes({ plan: identity.plan });
          },
          { once: true }
        );

        window.chatwootSettings = { position: "right", type: "standard" };
        const script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.src = `${identity.baseUrl}/packs/js/sdk.js`;
        script.async = true;
        script.onload = () => {
          window.chatwootSDK?.run({
            websiteToken: identity.websiteToken,
            baseUrl: identity.baseUrl,
          });
        };
        document.body.appendChild(script);
      } catch {
        /* support chat is non-essential — never break the dashboard over it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  return null;
}
