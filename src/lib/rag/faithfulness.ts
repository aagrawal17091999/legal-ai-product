import Anthropic from "@anthropic-ai/sdk";
import { logError } from "../error-logger";
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

export type FaithfulnessVerdict = "supported" | "unsupported" | "uncertain";

export interface FaithfulnessFinding {
  claim: string;
  case_index: number;
  verdict: FaithfulnessVerdict;
  reason: string;
  /**
   * For "supported" verdicts: the verbatim span from the cited case's excerpt
   * that backs the claim, validated as a substring of that excerpt. Undefined
   * when the judge returned no quote or the quote could not be verified verbatim
   * (we never surface an unverified quote as provenance).
   */
  quote?: string;
}

export interface FaithfulnessResult {
  /** Possibly-augmented answer (warning footer appended when unsupported claims exist). */
  text: string;
  findings: FaithfulnessFinding[];
  /** Number of (claim, case) pairs actually sent to the judge. */
  checked: number;
  /** True if the judge ran; false when skipped (no claims) or it errored. */
  ran: boolean;
}

interface Claim {
  text: string;
  indices: number[];
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
  const pairs: Array<{ id: number; claim: string; index: number }> = [];
  for (const cl of claims) {
    for (const idx of cl.indices) {
      if (!byIndex.has(idx)) continue;
      pairs.push({ id: pairs.length + 1, claim: cl.text, index: idx });
      if (pairs.length >= MAX_CLAIMS) break;
    }
    if (pairs.length >= MAX_CLAIMS) break;
  }

  const citedIndices = Array.from(new Set(pairs.map((p) => p.index)));

  try {
    const findings = await runJudge(pairs, citedIndices, byIndex);
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

/**
 * Verify that each cited sentence in `answer` is supported, appending a warning
 * footer for unsupported claims. Thin wrapper over gradeDraft — kept as a
 * post-hoc backstop in the route. Returns the (possibly-augmented) text.
 */
export async function verifyFaithfulness(
  answer: string,
  cases: AssembledCase[]
): Promise<FaithfulnessResult> {
  const byIndex = new Map<number, AssembledCase>();
  for (const c of cases) byIndex.set(c.index, c);

  const grade = await gradeDraft(answer, cases);
  if (!grade.ran || grade.unsupported.length === 0) {
    return { text: answer, findings: grade.findings, checked: grade.checked, ran: grade.ran };
  }
  return {
    text: answer + buildFooter(grade.unsupported, byIndex),
    findings: grade.findings,
    checked: grade.checked,
    ran: grade.ran,
  };
}

/**
 * Split the answer into sentences and keep those that carry citation markers.
 * Each such sentence becomes a claim tagged with the case indices it cites.
 * Over-splitting on legal abbreviations ("v.", "S.") is harmless: markers sit at
 * sentence end, so the marker stays attached to the substantive tail.
 */
function extractClaims(text: string): Claim[] {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(["'“])/);
  const claims: Claim[] = [];

  for (const sentence of sentences) {
    const indices = new Set<number>();
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(sentence)) !== null) {
      indices.add(parseInt(m[1], 10));
    }
    if (indices.size === 0) continue;

    const cleaned = sentence.replace(MARKER_RE, "").replace(/\s+/g, " ").trim();
    if (cleaned.length < MIN_CLAIM_CHARS) continue;

    claims.push({ text: cleaned, indices: Array.from(indices) });
  }
  return claims;
}

async function runJudge(
  pairs: Array<{ id: number; claim: string; index: number }>,
  citedIndices: number[],
  byIndex: Map<number, AssembledCase>
): Promise<FaithfulnessFinding[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const client = new Anthropic({ apiKey });

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

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1500,
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
    });
  }
  return findings;
}

const MIN_QUOTE_CHARS = 12; // reject trivially-short "quotes" that match by accident
const MAX_QUOTE_CHARS = 600; // cap a single displayed span

/**
 * Confirm `quote` appears verbatim in `excerpt`, tolerating only the whitespace
 * differences introduced by PDF line-wrapping (the excerpt collapses soft wraps
 * differently than the judge may echo them). Returns the cleaned quote when it
 * is genuinely present, else undefined. This is the guard that keeps the support
 * panel grounded: anything not literally in the retrieved text is discarded.
 */
function verifyVerbatim(quote: string, excerpt: string): string | undefined {
  const cleaned = quote.replace(/\s+/g, " ").trim();
  if (cleaned.length < MIN_QUOTE_CHARS) return undefined;
  const haystack = excerpt.replace(/\s+/g, " ");
  if (!haystack.includes(cleaned)) return undefined;
  return cleaned.length > MAX_QUOTE_CHARS
    ? cleaned.slice(0, MAX_QUOTE_CHARS).trimEnd() + "…"
    : cleaned;
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

For every "supported" claim, also return "quote": the single most relevant passage from the CITED case's excerpt that backs the claim, copied CHARACTER-FOR-CHARACTER from the excerpt (verbatim — do not paraphrase, summarise, fix typos, or join non-adjacent sentences). Keep it to one or two sentences. For "unsupported" and "uncertain" claims, set "quote" to "".

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
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const arr = parsed?.verdicts;
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
