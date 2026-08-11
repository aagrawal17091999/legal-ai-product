import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Everything behind auth is disallowed — not for secrecy (it 302s to /login
 * anyway) but so crawl budget goes to the marketing pages that can actually
 * rank. Staging is kept out of the index by an X-Robots-Tag in nginx.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/chat",
        "/account",
        "/judgments",
        "/trace",
        "/workspace",
        "/translate",
        "/ocr",
        "/admin",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
