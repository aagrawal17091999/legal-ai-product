/**
 * High Court judgments are loaded in batches by pipeline/ingest_hc.py. They
 * stay out of search, chat retrieval and the filter dropdowns until
 * HC_SEARCH_ENABLED=on, so a partly loaded, unreviewed corpus never reaches
 * users while the UI still says "Supreme Court only". Flip it together with
 * that copy.
 */
export function hcSearchEnabled(): boolean {
  return process.env.HC_SEARCH_ENABLED === "on";
}
