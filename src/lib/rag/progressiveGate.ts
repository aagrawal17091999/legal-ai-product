import { Semaphore } from "../concurrency";
import { gradeDraft, type FaithfulnessFinding } from "./faithfulness";
import { patchUnsupported } from "./groundingPatch";
import type { AssembledCase } from "./contextBuilder";

/**
 * Progressive grounding gate: verify the answer a paragraph at a time, while
 * the model is still writing it.
 *
 * The original gate was strictly sequential — generate the whole answer, then
 * grade the whole answer, then (maybe) repair it — and NOTHING reached the user
 * until all of that finished. On a measured production turn that was 71.9s of
 * drafting + 13.7s of grading + a 77.0s repair, and the user watched a status
 * line for all 226s of it.
 *
 * Two things change here:
 *
 *   1. Grading overlaps generation. A paragraph is graded the moment it is
 *      complete, so by the time the model stops writing, everything except the
 *      final paragraph has already been judged.
 *   2. Verified paragraphs are released as they clear, so the user starts
 *      reading at the first paragraph instead of at the last.
 *
 * What deliberately does NOT change is the guarantee. A paragraph is released
 * only after its claims have been graded and any repair applied; released text
 * is never rewritten afterwards. Showing a paragraph and then silently mutating
 * it would read as the model changing its mind about the law, which in this
 * product is worse than making the user wait.
 *
 * Release safety. Text is held one paragraph behind the writer, and nothing is
 * released at all once the round turns out to be a tool-calling round. A model
 * that narrates before searching ("Let me look at the limitation cases…") emits
 * that narration as a paragraph too; holding one behind means the tool call
 * arrives — and cancels the release — before the narration can escape.
 */

/** Paragraphs verified concurrently. Each one fans out into sharded judge calls. */
const PARAGRAPH_CONCURRENCY = numEnv("GROUNDING_PARAGRAPH_CONCURRENCY", 3);

function numEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface ProgressiveGateResult {
  /** The full verified answer, with every applied repair spliced in. */
  text: string;
  /** Findings across every paragraph, for the footer and telemetry. */
  findings: FaithfulnessFinding[];
  /** Claims still unsupported after repair — these drive the footer. */
  unsupported: FaithfulnessFinding[];
  /** Total (claim, case) pairs graded. */
  checked: number;
  /** True if the judge ran on at least one paragraph. */
  ran: boolean;
  /** True if at least one paragraph was repaired by splice. */
  patched: boolean;
  /** Characters released to the client mid-stream (0 when release was cancelled). */
  releasedChars: number;
}

export interface ProgressiveGateOptions {
  cases: AssembledCase[];
  /**
   * Applied to each paragraph before it is graded or released. Returning null
   * drops the paragraph entirely.
   *
   * The sequential gate could normalise citations and strip a preamble on the
   * finished answer, because it held the whole thing. Releasing progressively
   * means both have to happen per paragraph, BEFORE the judge sees the text —
   * grading un-normalised text would miss every bare `[n]` citation.
   */
  transform?: (part: string, index: number) => string | null;
  /**
   * Called with each verified paragraph, in document order, as it clears.
   * Receives the paragraph plus its trailing separator so concatenating every
   * call reproduces `result.text` exactly.
   */
  onRelease: (chunk: string) => void;
  /** Called the first time a paragraph is held for grading. */
  onVerifying?: () => void;
  /**
   * Called if release is cancelled AFTER text had already been emitted, i.e.
   * the optimistic release turned out to be wrong. The consumer must discard
   * everything released for this round.
   *
   * Holding one paragraph back makes this rare — a model that narrates before
   * searching emits a single short paragraph, which is still held when the tool
   * call lands. It is reachable only when the model writes two full paragraphs
   * of prose and THEN decides to search. Rare is not never, and text that has
   * reached a lawyer's screen has to be retractable explicitly rather than left
   * to be quietly duplicated by the answer that follows.
   */
  onRollback?: () => void;
  abortSignal?: AbortSignal;
}

export class ProgressiveGate {
  private buffer = "";
  /** Paragraph text + separator, in arrival order. */
  private readonly parts: string[] = [];
  /** Verification promise per part index. */
  private readonly verified: Array<Promise<VerifiedPart>> = [];
  /** Serialises release so paragraphs reach the client in document order. */
  private releaseChain: Promise<void> = Promise.resolve();
  private releasedUpTo = 0;
  private releasedChars = 0;
  private cancelled = false;
  private announcedVerifying = false;
  private readonly sem = new Semaphore(PARAGRAPH_CONCURRENCY);
  // Declared explicitly rather than as a constructor parameter property: the
  // test runner strips types without transforming, and parameter properties
  // need a real transform.
  private readonly opts: ProgressiveGateOptions;

  constructor(opts: ProgressiveGateOptions) {
    this.opts = opts;
  }

  /** Feed a text delta from the model stream. */
  push(delta: string): void {
    this.buffer += delta;
    // A blank line closes a paragraph. Markdown tables and lists contain no
    // blank lines, so they stay intact as a single part.
    for (;;) {
      const m = /\n[ \t]*\n+/.exec(this.buffer);
      if (!m) break;
      const end = m.index + m[0].length;
      this.enqueue(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
    this.pump();
  }

  /**
   * Cancel release for this round — the model called a tool, so the text so far
   * was narration, not the answer. Verification already in flight is abandoned;
   * nothing further is emitted. Safe to call more than once.
   */
  cancelRelease(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.releasedChars > 0) {
      this.releasedChars = 0;
      this.opts.onRollback?.();
    }
  }

  /** True once any text has been released to the client. */
  get hasReleased(): boolean {
    return this.releasedChars > 0;
  }

  /**
   * Close the stream: verify whatever is left, release everything still held,
   * and return the assembled answer.
   */
  async finish(): Promise<ProgressiveGateResult> {
    if (this.buffer.trim()) {
      this.enqueue(this.buffer);
      this.buffer = "";
    }
    // Everything is complete now, so the one-behind hold no longer applies.
    this.pump(true);
    await this.releaseChain;

    const results = await Promise.all(this.verified);
    const findings = results.flatMap((r) => r.findings);
    return {
      text: results.map((r) => r.text).join(""),
      findings,
      unsupported: findings.filter((f) => f.verdict === "unsupported"),
      checked: results.reduce((n, r) => n + r.checked, 0),
      ran: results.some((r) => r.ran),
      patched: results.some((r) => r.patched),
      releasedChars: this.releasedChars,
    };
  }

  private enqueue(raw: string): void {
    const i = this.parts.length;
    const part = this.opts.transform ? this.opts.transform(raw, i) : raw;
    if (part === null) return; // dropped (e.g. a preamble paragraph)
    this.parts.push(part);
    // Start verifying immediately — this is the overlap with generation.
    this.verified[this.parts.length - 1] = this.verify(part);
  }

  /**
   * Release every part that is verified and safe to emit. Holds the newest part
   * back unless `flush`, so a tool call still has a chance to cancel it.
   */
  private pump(flush = false): void {
    const limit = flush ? this.parts.length : this.parts.length - 1;
    while (this.releasedUpTo < limit) {
      const i = this.releasedUpTo++;
      this.releaseChain = this.releaseChain.then(async () => {
        if (this.cancelled) return;
        const r = await this.verified[i];
        if (this.cancelled) return;
        this.releasedChars += r.text.length;
        this.opts.onRelease(r.text);
      });
    }
    // Swallow rejections here; `finish()` awaits the same promises and surfaces
    // any real failure to the caller.
    this.releaseChain = this.releaseChain.catch(() => {});
  }

  private async verify(part: string): Promise<VerifiedPart> {
    const empty: VerifiedPart = {
      text: part,
      findings: [],
      checked: 0,
      ran: false,
      patched: false,
    };
    // Nothing cited ⇒ nothing to verify. Headings, transitions and the "Cases
    // Referenced" list take this path and cost nothing.
    if (!/\[\^\d+/.test(part)) return empty;

    if (!this.announcedVerifying) {
      this.announcedVerifying = true;
      this.opts.onVerifying?.();
    }

    return this.sem.run(async () => {
      if (this.opts.abortSignal?.aborted) return empty;
      const grade = await gradeDraft(part, this.opts.cases);
      if (!grade.ran) return empty;
      if (grade.unsupported.length === 0) {
        return {
          text: part,
          findings: grade.findings,
          checked: grade.checked,
          ran: true,
          patched: false,
        };
      }

      // Repair in place. There is no full-rewrite fallback here by design: a
      // rewrite would have to regenerate text we may have already shown. When a
      // claim cannot be patched it stays as written and is reported in the
      // footer — exactly what the sequential gate did with claims it failed to
      // repair within its revision budget.
      const patch = await patchUnsupported({
        draft: part,
        unsupported: grade.unsupported,
        cases: this.opts.cases,
        abortSignal: this.opts.abortSignal,
      });
      if (!patch) {
        return {
          text: part,
          findings: grade.findings,
          checked: grade.checked,
          ran: true,
          patched: false,
        };
      }

      // Re-grade ONLY the replacements. Untouched sentences are byte-identical
      // to the ones already graded, so their verdicts still stand.
      const regrade =
        patch.replacements.length > 0
          ? await gradeDraft(patch.replacements.join("\n\n"), this.opts.cases)
          : null;

      return {
        text: patch.text,
        findings: mergeFindings(grade.findings, patch.patchedClaims, regrade?.findings ?? []),
        checked: grade.checked + (regrade?.checked ?? 0),
        ran: true,
        patched: true,
      };
    });
  }
}

interface VerifiedPart {
  text: string;
  findings: FaithfulnessFinding[];
  checked: number;
  ran: boolean;
  patched: boolean;
}

/**
 * Replace the verdicts of claims that were successfully patched with the
 * verdicts of their replacements. A patched claim's original "unsupported"
 * finding no longer describes any text in the answer, so carrying it into the
 * footer would warn the user about a sentence that is no longer there.
 */
function mergeFindings(
  original: FaithfulnessFinding[],
  patchedClaims: string[],
  regraded: FaithfulnessFinding[]
): FaithfulnessFinding[] {
  const patched = new Set(patchedClaims);
  return [...original.filter((f) => !patched.has(f.claim)), ...regraded];
}
