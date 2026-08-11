import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** Public, indexable pages only — everything else is behind auth. */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages: { path: string; priority: number }[] = [
    { path: "", priority: 1 },
    { path: "/team", priority: 0.5 },
    { path: "/terms", priority: 0.3 },
    { path: "/privacy", priority: 0.3 },
    { path: "/login", priority: 0.4 },
    { path: "/signup", priority: 0.6 },
  ];
  return pages.map(({ path, priority }) => ({
    url: `${SITE_URL}${path}`,
    priority,
  }));
}
