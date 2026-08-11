/**
 * Canonical public origin, used for metadataBase, robots, and the sitemap.
 *
 * NEXT_PUBLIC_APP_URL is baked in at build time, so changing it requires a
 * rebuild, not just a reload (see docs/deploying-changes.md). The fallback is
 * production rather than localhost: a missing env var should yield correct
 * canonical URLs, not quietly publish links to http://localhost:3000.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_APP_URL || "https://getlegalbrain.com"
).replace(/\/$/, "");
