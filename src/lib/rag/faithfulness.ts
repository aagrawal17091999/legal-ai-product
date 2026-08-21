import { getAnthropicClient } from "../claude";
import { logError } from "../error-logger";
import { mapLimit } from "../concurrency";
import type { AssembledCase } from "./contextBuilder";
import type { SupportSpan } from "@/types";

/**
 * Post-generation faithfulness (groundedness) check.
 *
 * The structural citation validator (`citationValidator.ts`) confirms a `[^n]`
 * marker points to a retrieved case and that the paragraph is visible. It does
 * NOT confirm the case actually *supports the sentence* — so the model can
 * attach a real, in-context case to a proposition that case doesn't hold. For a
 * legal product that is the highest-impact accuracy risk.
 *
 * This module re-reads the answer, pairs each cited sentence with the exact
 * excerpt the model was shown for the cited case, and asks a fast judge model
 * whether the excerpt supports the claim. Unsupported claims are surfaced to the
 * user in a footer and recorded for telemetry. The answer text itself is never
 * rewritten — we annotate, we don't silently edit legal analysis.
 */

const JUDGE_MODEL =
  process.env.FAITHFULNESS_MODEL?.trim() || "claude-haiku-4-5-20251001";

// `[^12]`, `[^12, ¶42]`, `[^12,¶42]`, `[^12, ¶42a]` — mirrors citationValidator.
const MARKER_RE = /\[\^(\d+)(?:\s*,\s*¶([0-9]+(?:\.[0-9]+)?[A-Za-z]?))?\]/g;

const MIN_CLAIM_CHARS = 25; // ignore fragments too short to be a real assertion
const MAX_CLAIMS = 40; // cap judge prompt size / latency on very long answers
const MAX_EXCERPT_CHARS = 6000; // per cited case, fed to the judge

// Judge sharding. Claims are graded in independent batches so latency tracks the
// largest shard instead of the sum, and each shard carries only the excerpts its
// own claims cite. Concurrency is capped so a long answer can't burst dozens of
// simultaneous Haiku calls into a rate limit.
const JUDGE_SHARD_CLAIMS = numEnv("FAITHFULNESS_SHARD_CLAIMS", 10);
const JUDGE_SHARD_CONCURRENCY = numEnv("FAITHFULNESS_SHARD_CONCURRENCY", 4);

function numEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export type FaithfulnessVerdict = "supported" | "unsupported" | "uncertain";

export interface FaithfulnessFinding {
  claim: string;
  case_index: number;
  verdict: FaithfulnessVerdict;
  reason: string;
  /**
   * Half-open range of this claim in the graded text, or undefined when the
   * claim is not safely replaceable in place (currently: Markdown table rows).
   * The grounding patch splices by this range — see `Claim.start`.
   */
  span?: { start: number; end: number };
  /**
   * For "supported" verdicts: the verbatim span from the cited case's excerpt
   * that backs the claim, validated as a substring of that excerpt. Undefined
   * when the judge returned no quote or the quote could not be verified verbatim
   * (we never surface an unverified quote as provenance).
   */
  quote?: string;
}

interface Claim {
  /** The claim as the judge sees it: de-marked-down, citation markers removed. */
  text: string;
  indices: number[];
  /**
   * Half-open character range of the claim in the ORIGINAL answer string, i.e.
   * `answer.slice(start, end)` is the untouched source text `text` was derived
   * from. The grounding patch splices replacements by this range.
   *
   * `text` cannot be used to find the claim in the answer: it has had Markdown
   * decoration and every `[^n]` marker stripped, and a claim only exists
   * *because* it carries a marker — so a literal search for it in the draft can
   * never match. Carrying the range is what makes a surgical repair possible.
   */
  start: number;
  end: number;
}

export interface GradeResult {
  findings: FaithfulnessFinding[];
  unsupported: FaithfulnessFinding[];
  checked: number;
  ran: boolean;
}

/**
 * Grade each cited sentence in `answer` against the excerpt of the case it cites,
 * returning findings WITHOUT mutating the text. Used by the in-loop grounding
 * gate (#5) to decide whether to send the draft back for revision before
 * streaming it. Best-effort: any failure returns `ran: false` with no findings.
 */
export async function gradeDraft(
  answer: string,
  cases: AssembledCase[]
): Promise<GradeResult> {
  const byIndex = new Map<number, AssembledCase>();
  for (const c of cases) byIndex.set(c.index, c);

  const claims = extractClaims(answer).filter((cl) =>
    cl.indices.some((i) => byIndex.has(i))
  );
  if (claims.length === 0) {
    return { findings: [], unsupported: [], checked: 0, ran: false };
  }

  // One (claim, case) pair per cited index, capped.
  const pairs: Array<{
    id: number;
    claim: string;
    index: number;
    span?: { start: number; end: number };
  }> = [];
  for (const cl of claims) {
    const span = cl.start >= 0 ? { start: cl.start, end: cl.end } : undefined;
    for (const idx of cl.indices) {
      if (!byIndex.has(idx)) continue;
      pairs.push({ id: pairs.length + 1, claim: cl.text, index: idx, span });
      if (pairs.length >= MAX_CLAIMS) break;
    }
    if (pairs.length >= MAX_CLAIMS) break;
  }

  try {
    // Shard the judge. One batched call carried up to MAX_CLAIMS claims plus
    // every cited case's excerpt (MAX_EXCERPT_CHARS each), so both its input and
    // its serial output grew with the answer — on a long research answer that is
    // a single multi-second call sitting between the draft and the user.
    // Sharding makes wall time track the LARGEST shard rather than the sum, and
    // each shard only carries the excerpts its own claims cite, which shrinks
    // the input too. Verdicts are per (claim, case) pair and never reference
    // other claims, so splitting cannot change any individual verdict.
    const shards: Array<typeof pairs> = [];
    for (let i = 0; i < pairs.length; i += JUDGE_SHARD_CLAIMS) {
      shards.push(pairs.slice(i, i + JUDGE_SHARD_CLAIMS));
    }
    const shardFindings = await mapLimit(shards, JUDGE_SHARD_CONCURRENCY, (shard) =>
      runJudge(shard, Array.from(new Set(shard.map((p) => p.index))), byIndex)
    );
    const findings = shardFindings.flat();
    return {
      findings,
      unsupported: findings.filter((f) => f.verdict === "unsupported"),
      checked: pairs.length,
      ran: true,
    };
  } catch (err) {
    logError({
      category: "chat",
      message: `faithfulness grading failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { model: JUDGE_MODEL, pairs: pairs.length },
    });
    return { findings: [], unsupported: [], checked: 0, ran: false };
  }
}

/**
 * Build the user-facing groundedness-warning footer for unsupported claims.
 * Exported so the agent loop can append it to the final answer (after the
 * in-loop revision budget is spent) without a second judge call.
 */
export function buildGroundingFooter(
  unsupported: FaithfulnessFinding[],
  cases: AssembledCase[]
): string {
  if (unsupported.length === 0) return "";
  const byIndex = new Map<number, AssembledCase>();
  for (const c of cases) byIndex.set(c.index, c);
  return buildFooter(unsupported, byIndex);
}

/**
 * Render a human-readable list of unsupported claims, for feeding back to the
 * model during a grounding-gate revision. Exported for the agent loop.
 */
export function describeUnsupported(findings: FaithfulnessFinding[]): string {
  return findings
    .map((f) => `- (cites Case ${f.case_index}) "${f.claim}" — ${f.reason}`)
    .join("\n");
}

// Sentence boundary inside a single line of prose. The lookbehind treats the
// boundary as sentence punctuation followed by any closing quotes/brackets and
// any trailing citation markers — so a marker placed AFTER the period
// ("…held X. [^3] Next…") or a closing quote ("…offences." Next…) stays with the
// sentence it ends, and the split lands before the NEXT sentence. The lookahead
// excludes `[` so a marker's own bracket never reads as a new sentence start.
/**
 * Abbreviations whose trailing period does NOT end a sentence. This list is
 * mostly Indian case-citation vocabulary, and it is not cosmetic: without the
 * `v.` guard, EVERY case name splits mid-citation. "State of Punjab v. Joginder
 * Singh held that…" became the claim "Joginder Singh held that…", which the
 * judge then (correctly) could not verify, because it is a fragment rather than
 * an assertion. On one production answer this manufactured five of the nine
 * "unsupported" findings, each of which cost a full-answer rewrite and shipped
 * a groundedness warning to the user about a sentence that was never wrong.
 */
const NON_TERMINAL_ABBREVS = [
  "v", "vs", "Ors", "Anr", "No", "Nos", "Art", "Arts", "Sec", "Secs", "ss",
  "Ltd", "Pvt", "Co", "Corp", "Hon", "JJ", "J", "CJ", "Mr", "Mrs", "Ms", "Dr",
  "Smt", "Shri", "Sri", "cl", "para", "paras", "pp", "ed", "edn", "Ex", "Sch",
  "Regn", "Cri", "LJ", "SCC", "AIR", "SCR", "Cal", "Bom", "Mad", "All", "Del",
];

const SENTENCE_BOUNDARY_RE = new RegExp(
  // Not immediately after a known abbreviation ("… v.") …
  `(?<!\\b(?:${NON_TERMINAL_ABBREVS.join("|")})\\.)` +
    // … nor after a bare initial ("A. B. Smith", "Subba Rao, J.").
    `(?<![A-Z]\\.)` +
    // Original rule: after a terminator, optionally trailed by closing
    // punctuation or a citation marker, split on whitespace before a capital.
    `(?<=[.!?](?:["'”’)\\]]|\\s*\\[\\^[^\\]]*\\])*)\\s+(?=[A-Z("'“])`
);

/** A Markdown table separator row (`|---|:--:|`), which carries no assertion. */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Split a line into its leading block marker and the remainder. Returned
 * separately (rather than simply dropped) so callers can keep the remainder's
 * offset within the original answer — `lead.length` is exactly how far the
 * content start moved. `rest: null` means the line carries no claim at all
 * (horizontal rule).
 */
function splitLeadMarker(line: string): { lead: string; rest: string | null } {
  const m =
    /^\s*>+\s?/.exec(line) ?? // blockquote
    /^\s*#{1,6}\s+/.exec(line) ?? // heading
    /^\s*\d+\.\s+/.exec(line) ?? // ordered list
    /^\s*[-*+]\s+/.exec(line); // bullet
  const lead = m ? m[0] : "";
  const rest = line.slice(lead.length);
  if (/^\s*([-*_])\1{2,}\s*$/.test(rest)) return { lead, rest: null }; // horizontal rule
  return { lead, rest };
}

/** Inline de-decoration only — never touches leading block markers. */
function stripInline(s: string): string {
  s = s.replace(/\[([^^\]][^\]]*)\]\([^)]*\)/g, "$1"); // [text](url) → text
  s = s.replace(/`([^`]+)`/g, "$1"); // inline code
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => a ?? b); // bold
  s = s.replace(/\*([^*]+)\*/g, "$1"); // italic *
  s = s.replace(/[*`]/g, ""); // stray emphasis chars
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Pull the citable sentences out of a Markdown answer. The answer is processed
 * line by line — headings, list items, blockquotes and rules each sit on their
 * own line, so a line is already a natural claim boundary — and each line is
 * de-marked-down then sentence-split. Each sentence carrying a citation marker
 * becomes a claim tagged with the case indices it cites. Treating the whole
 * answer as flat prose (the old approach) let Markdown punctuation after a
 * period defeat the splitter, fusing an entire formatted block into one "claim".
 */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  let lineStart = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    // Advance past this line regardless of which branch consumes it.
    const thisLineStart = lineStart;
    lineStart += rawLine.length + 1; // +1 for the newline the split removed

    // A Markdown table row is not prose: its proposition and its citation live
    // in DIFFERENT cells, so sentence-splitting it yields fragments like
    // `Joginder Singh ; Ram Lal Wadhwa |` — which the judge duly reports as
    // unsupported. Join the cells so the row is graded as one assertion that
    // carries its own citation, and mark it unsplicable: replacing a table row
    // with prose would wreck the table.
    if (/^\s*\|.*\|\s*$/.test(rawLine)) {
      if (TABLE_SEPARATOR_RE.test(rawLine)) continue;
      const cells = rawLine
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => stripInline(c))
        .filter(Boolean);
      const joined = cells.join(" — ");
      const indices = markerIndices(joined);
      if (indices.length === 0) continue;
      const cleaned = tidy(joined);
      if (cleaned.length < MIN_CLAIM_CHARS) continue;
      claims.push({ text: cleaned, indices, start: -1, end: -1 });
      continue;
    }

    const { lead, rest } = splitLeadMarker(rawLine);
    if (rest === null || !rest.trim()) continue;

    // Split the RAW remainder, so every sentence keeps its offset. (Splitting
    // the de-decorated line instead would make the offsets meaningless — which
    // is why the patch could never locate a claim.)
    let cursor = thisLineStart + lead.length;
    for (const rawSentence of rest.split(SENTENCE_BOUNDARY_RE)) {
      const start = cursor;
      cursor += rawSentence.length;
      // `split` consumed the whitespace between sentences; re-find the next
      // sentence's true start rather than assuming a single space.
      const nextNonSpace = text.slice(cursor).search(/\S/);
      if (nextNonSpace > 0) cursor += nextNonSpace;

      const indices = markerIndices(rawSentence);
      if (indices.length === 0) continue;

      const cleaned = tidy(stripInline(rawSentence));
      if (cleaned.length < MIN_CLAIM_CHARS) continue;

      // Trim the recorded span to the sentence's own non-space extent so a
      // splice cannot swallow the whitespace that separates it from the next.
      const lead2 = rawSentence.length - rawSentence.trimStart().length;
      const trail = rawSentence.length - rawSentence.trimEnd().length;
      claims.push({
        text: cleaned,
        indices,
        start: start + lead2,
        end: start + rawSentence.length - trail,
      });
    }
  }
  return claims;
}

/**
 * Render a sentence as the judge should read it: citation markers removed, and
 * the space they leave in front of the punctuation they preceded closed up, so
 * a claim reads `… delay.` rather than `… delay .`.
 */
function tidy(s: string): string {
  return s
    .replace(MARKER_RE, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/** Distinct case indices cited by `s`, in first-seen order. */
function markerIndices(s: string): number[] {
  const indices = new Set<number>();
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(s)) !== null) indices.add(parseInt(m[1], 10));
  return Array.from(indices);
}

async function runJudge(
  pairs: Array<{
    id: number;
    claim: string;
    index: number;
    span?: { start: number; end: number };
  }>,
  citedIndices: number[],
  byIndex: Map<number, AssembledCase>
): Promise<FaithfulnessFinding[]> {
  const client = getAnthropicClient();

  const excerptBlocks = citedIndices.map((idx) => {
    const c = byIndex.get(idx)!;
    const title = c.meta.title || "(untitled)";
    const body = (c.excerpt || "").slice(0, MAX_EXCERPT_CHARS);
    return `--- Case [${idx}] — ${title} ---\n${body || "(no excerpt available)"}`;
  });

  const claimLines = pairs.map(
    (p) => `${p.id}. [cites Case ${p.index}] "${p.claim}"`
  );

  const userContent = `CASE EXCERPTS (the only evidence available):\n\n${excerptBlocks.join(
    "\n\n"
  )}\n\nCLAIMS TO CHECK:\n${claimLines.join("\n")}`;

  // The response carries one object per claim, and each "supported" claim now
  // includes a verbatim quote (a sentence or two). With many citations that
  // easily exceeds a flat 1500-token cap — and a truncated response fails to
  // parse, silently collapsing EVERY claim to "uncertain". Budget per claim and
  // cap at the model's ceiling so the JSON comes back whole.
  const maxTokens = Math.min(8192, 600 + pairs.length * 220);

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: maxTokens,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
  const verdicts = parseVerdicts(raw);

  const byId = new Map(verdicts.map((v) => [v.claim, v]));
  const findings: FaithfulnessFinding[] = [];
  for (const p of pairs) {
    const v = byId.get(p.id);
    const verdict = v?.verdict ?? "uncertain";
    // Only attach a quote for supported claims, and only after confirming it is
    // a verbatim span of the cited case's full excerpt. A model-emitted quote we
    // cannot verify is dropped — provenance must be grounded, not plausible.
    const quote =
      verdict === "supported" && v?.quote
        ? verifyVerbatim(v.quote, byIndex.get(p.index)?.excerpt ?? "")
        : undefined;
    findings.push({
      claim: p.claim,
      case_index: p.index,
      // Missing verdict ⇒ "uncertain" (never silently treat as supported).
      verdict,
      reason: v?.reason ?? "no verdict returned",
      ...(quote ? { quote } : {}),
      ...(p.span ? { span: p.span } : {}),
    });
  }
  return findings;
}

const MIN_QUOTE_CHARS = 12; // reject trivially-short "quotes" that match by accident
const MAX_QUOTE_CHARS = 1600; // safety ceiling for a runaway enumeration

/**
 * Confirm `quote` appears verbatim in `excerpt` (tolerating only the whitespace
 * differences introduced by PDF line-wrapping), then EXPAND it to whole-sentence
 * boundaries so the panel shows the complete sentence(s) the passage sits in —
 * never a mid-sentence fragment, even when the judge copied only a clause.
 * Returns the verified, sentence-complete span, or undefined when the quote is
 * not genuinely present. This is the guard that keeps provenance grounded:
 * anything not literally in the retrieved text is discarded.
 */
export function verifyVerbatim(quote: string, excerpt: string): string | undefined {
  const cleaned = quote.replace(/\s+/g, " ").trim();
  if (cleaned.length < MIN_QUOTE_CHARS) return undefined;
  const hay = excerpt.replace(/\s+/g, " ");
  const at = hay.indexOf(cleaned);
  if (at === -1) return undefined;

  // Expand to whole-sentence boundaries. Left: back to just after the previous
  // terminator (a span that already starts a sentence finds the PRIOR sentence's
  // terminator, so start lands correctly). Right: only extend when the span does
  // NOT already end a sentence — otherwise we'd swallow the following sentence.
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (/[.!?]/.test(hay[i])) { start = i + 1; break; }
  }
  const matchEnd = at + cleaned.length;
  let end = matchEnd;
  if (!/[.!?]["'”’)\]]*$/.test(cleaned)) {
    end = hay.length;
    for (let i = matchEnd; i < hay.length; i++) {
      if (/[.!?]/.test(hay[i])) { end = i + 1; break; }
    }
  }
  const sentence = hay.slice(start, end).trim();
  // If expansion ran away (e.g. an un-terminated list), fall back to the
  // verified clause rather than dumping a huge block.
  return sentence.length <= MAX_QUOTE_CHARS ? sentence : cleaned;
}

/**
 * Group verified supporting spans by cited case index, for attaching to the
 * CitedCase payload the UI renders. Only "supported" findings that carry a
 * verified `quote` contribute. Deduplicates identical (claim, quote) pairs that
 * can arise when a sentence cites the same case twice.
 */
export function buildSupportByCase(
  findings: FaithfulnessFinding[]
): Map<number, SupportSpan[]> {
  const byCase = new Map<number, SupportSpan[]>();
  for (const f of findings) {
    if (f.verdict !== "supported" || !f.quote) continue;
    const spans = byCase.get(f.case_index) ?? [];
    if (spans.some((s) => s.claim === f.claim && s.quote === f.quote)) continue;
    spans.push({ claim: f.claim, quote: f.quote });
    byCase.set(f.case_index, spans);
  }
  return byCase;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict legal citation auditor. You are given case excerpts and a numbered list of claims. Each claim is tagged with the case it cites.

For each claim, decide whether the CITED case's excerpt SUPPORTS the claim:
- "supported": the excerpt clearly states or directly entails the claim.
- "unsupported": the excerpt contradicts the claim, or says nothing that establishes it.
- "uncertain": the excerpt is related but too partial to confirm or deny (e.g. the relevant passage may be elsewhere in the judgment, not in this excerpt).

Be conservative: only mark "supported" when the excerpt genuinely backs the specific assertion. A claim about a holding needs the holding in the excerpt, not just related discussion. Do not use outside knowledge — judge ONLY against the provided excerpt.

For every "supported" claim, also return "quote": the single most relevant passage from the CITED case's excerpt that backs the claim, copied CHARACTER-FOR-CHARACTER from the excerpt (verbatim — do not paraphrase, summarise, fix typos, or join non-adjacent sentences). Quote COMPLETE sentences, not a mid-sentence fragment — begin at the start of a sentence and end at its full stop. One or two sentences is ideal. For "unsupported" and "uncertain" claims, set "quote" to "".

Return ONLY a JSON object:
{"verdicts":[{"claim":<number>,"verdict":"supported|unsupported|uncertain","reason":"<short>","quote":"<verbatim span or empty string>"}]}`;

function parseVerdicts(
  raw: string
): Array<{ claim: number; verdict: FaithfulnessVerdict; reason: string; quote: string }> {
  if (!raw) return [];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    let arr: unknown;
    try {
      arr = (JSON.parse(raw.slice(start, end + 1)) as { verdicts?: unknown })?.verdicts;
    } catch {
      // The response was likely truncated mid-array (a quote ran long). Salvage
      // every complete verdict object rather than discarding the whole batch —
      // otherwise one overflow silently maps all claims to "uncertain".
      arr = salvageVerdictObjects(raw);
    }
    if (!Array.isArray(arr)) return [];
    const out: Array<{ claim: number; verdict: FaithfulnessVerdict; reason: string; quote: string }> = [];
    for (const v of arr) {
      const claim = Number(v?.claim);
      const verdict = v?.verdict;
      if (!Number.isInteger(claim)) continue;
      if (verdict !== "supported" && verdict !== "unsupported" && verdict !== "uncertain") {
        continue;
      }
      out.push({
        claim,
        verdict,
        reason: typeof v?.reason === "string" ? v.reason : "",
        quote: typeof v?.quote === "string" ? v.quote : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Recover complete verdict objects from a truncated JSON response. Scans for
 * top-level `{...}` objects inside the `verdicts` array, tracking string state
 * so braces inside quoted text don't miscount, and JSON-parses each complete
 * object individually. The trailing incomplete object (if any) is skipped.
 */
function salvageVerdictObjects(raw: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          const obj = JSON.parse(raw.slice(objStart, i + 1));
          // Only keep verdict-shaped objects (skip the outer wrapper object).
          if (obj && typeof obj === "object" && "claim" in obj && "verdict" in obj) {
            out.push(obj);
          }
        } catch {
          /* skip unparseable fragment */
        }
        objStart = -1;
      }
    }
  }
  return out;
}

function buildFooter(
  unsupported: FaithfulnessFinding[],
  byIndex: Map<number, AssembledCase>
): string {
  const lines = unsupported.slice(0, 10).map((f) => {
    const title = byIndex.get(f.case_index)?.meta.title || `Case [${f.case_index}]`;
    const snippet = f.claim.length > 140 ? f.claim.slice(0, 140) + "…" : f.claim;
    return `- "${snippet}" — not supported by the retrieved excerpt of ${title} [^${f.case_index}].`;
  });
  return `\n\n> **Groundedness warning:** the following statements could not be verified against the retrieved text of the cases they cite. Treat them with caution and check the source before relying on them:\n${lines.join(
    "\n"
  )}`;
}
