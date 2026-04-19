import fs from "fs";
import path from "path";
import { logError } from "../error-logger";

/**
 * Act & judge registries for query-time expansion.
 *
 * Motivation: the DB stores canonical forms ("Code of Criminal Procedure,
 * 1973") but users and the router use shorthand ("CrPC"). Post-rerank soft
 * boosts partially fix this, but semantic retrieval only sees the shorthand
 * fingerprint. By detecting a registry mention in a query and generating an
 * additional query that substitutes the canonical form, we get a second set
 * of chunks whose embeddings key off the long form.
 *
 * Files live under pipeline/data/ and are rebuilt by the Python pipeline. We
 * load them once at module init; failure is non-fatal — queries still work
 * without expansion.
 */

interface RegistryEntry {
  canonical: string;
  aliases: string[];
}

interface ActsFile {
  acts: RegistryEntry[];
}

interface JudgesFile {
  judges: RegistryEntry[];
}

/** Surface forms that appear in the registry as standalone words (e.g. "IPC",
 *  "CrPC") get matched with word boundaries so we don't false-positive on
 *  substrings. Threshold tuned so "NI Act" still uses word-boundary matching
 *  but "Code of Criminal Procedure, 1973" uses plain substring. */
const SHORT_FORM_THRESHOLD = 8;
const MAX_QUERIES_AFTER_EXPANSION = 5;

let acts: RegistryEntry[] = [];
let judges: RegistryEntry[] = [];
let loaded = false;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    const root = process.cwd();
    const actsPath = path.join(root, "pipeline/data/indian_acts.json");
    const judgesPath = path.join(root, "pipeline/data/indian_judges.json");

    if (fs.existsSync(actsPath)) {
      const parsed = JSON.parse(fs.readFileSync(actsPath, "utf-8")) as ActsFile;
      acts = Array.isArray(parsed.acts) ? parsed.acts : [];
    }
    if (fs.existsSync(judgesPath)) {
      const parsed = JSON.parse(fs.readFileSync(judgesPath, "utf-8")) as JudgesFile;
      // Judge registry is auto-built and includes noisy entries. Filter out
      // anything with garbled canonicals (embedded uppercase joins, very
      // short tokens) to avoid spurious expansions.
      judges = (Array.isArray(parsed.judges) ? parsed.judges : []).filter(
        (j) => isCleanJudgeCanonical(j.canonical)
      );
    }
  } catch (err) {
    logError({
      category: "search",
      message: `Registry load failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { step: "registry.loadOnce" },
    });
  }
}

/** The auto-built judge registry has garbage entries like "B.R" or
 *  "Aniruddha Bose andB. Pardiwala". Skip anything that doesn't look like
 *  a plausible justice name. */
function isCleanJudgeCanonical(s: string): boolean {
  const t = s.trim();
  if (t.length < 6) return false;
  if (/\band(?=[A-Z])/.test(t)) return false; // "andB. Pardiwala"
  if (/^\d/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 2) return false;
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Mention {
  entry: RegistryEntry;
  matchedForm: string;
  matchedIndex: number;
  matchedLength: number;
}

/** Find every registry entry whose canonical or any alias appears in the
 *  query text. Returns the matched surface form so we can substitute. */
function findMentions(query: string, entries: RegistryEntry[]): Mention[] {
  const q = query;
  const qLower = q.toLowerCase();
  const out: Mention[] = [];
  const seen = new Set<RegistryEntry>();

  for (const entry of entries) {
    if (seen.has(entry)) continue;
    const forms = [entry.canonical, ...entry.aliases]
      .filter((f) => f && f.length > 0)
      .sort((a, b) => b.length - a.length); // prefer longer matches

    for (const form of forms) {
      const formLower = form.toLowerCase();
      let matchIdx = -1;
      if (form.length <= SHORT_FORM_THRESHOLD) {
        // Word-boundary match for short forms so "IPC" doesn't hit "recipe".
        const re = new RegExp(`\\b${escapeRegExp(formLower)}\\b`);
        const m = re.exec(qLower);
        if (m) matchIdx = m.index;
      } else {
        matchIdx = qLower.indexOf(formLower);
      }
      if (matchIdx >= 0) {
        out.push({
          entry,
          matchedForm: q.slice(matchIdx, matchIdx + form.length),
          matchedIndex: matchIdx,
          matchedLength: form.length,
        });
        seen.add(entry);
        break;
      }
    }
  }
  return out;
}

/**
 * Generate expansion queries by substituting the matched alias in each
 * detected mention with the canonical form (or vice versa). One expansion
 * per mention keeps the query count bounded. Original queries are preserved
 * first.
 */
export function expandQueriesWithRegistry(queries: string[]): {
  expanded: string[];
  trace: Array<{
    query: string;
    mentions: Array<{ canonical: string; matchedForm: string; substitutedWith: string }>;
  }>;
} {
  loadOnce();
  if (acts.length === 0 && judges.length === 0) {
    return { expanded: [...queries], trace: [] };
  }

  const out: string[] = [...queries];
  const seen = new Set(queries.map((q) => q.toLowerCase()));
  const trace: Array<{
    query: string;
    mentions: Array<{ canonical: string; matchedForm: string; substitutedWith: string }>;
  }> = [];

  for (const q of queries) {
    if (out.length >= MAX_QUERIES_AFTER_EXPANSION) break;

    const actMentions = findMentions(q, acts);
    const judgeMentions = findMentions(q, judges);
    const mentions = [...actMentions, ...judgeMentions];
    if (mentions.length === 0) continue;

    const queryTrace: Array<{ canonical: string; matchedForm: string; substitutedWith: string }> = [];

    for (const m of mentions) {
      if (out.length >= MAX_QUERIES_AFTER_EXPANSION) break;
      // Pick the longest *different* form in the entry as the substitute.
      // If the user matched the canonical, substitute in the longest alias;
      // if the user matched an alias, substitute in the canonical.
      const forms = [m.entry.canonical, ...m.entry.aliases]
        .filter((f) => f && f.toLowerCase() !== m.matchedForm.toLowerCase());
      if (forms.length === 0) continue;
      // Prefer canonical (usually the most descriptive form) as substitute.
      const substitute = forms.includes(m.entry.canonical)
        ? m.entry.canonical
        : forms.sort((a, b) => b.length - a.length)[0];

      const before = q.slice(0, m.matchedIndex);
      const after = q.slice(m.matchedIndex + m.matchedLength);
      const expanded = `${before}${substitute}${after}`;

      queryTrace.push({
        canonical: m.entry.canonical,
        matchedForm: m.matchedForm,
        substitutedWith: substitute,
      });

      const lower = expanded.toLowerCase();
      if (!seen.has(lower)) {
        out.push(expanded);
        seen.add(lower);
      }
    }

    if (queryTrace.length > 0) trace.push({ query: q, mentions: queryTrace });
  }

  return {
    expanded: out.slice(0, MAX_QUERIES_AFTER_EXPANSION),
    trace,
  };
}
