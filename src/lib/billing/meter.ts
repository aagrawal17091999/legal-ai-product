/**
 * Request-scoped usage meter.
 *
 * The Claude/Voyage calls for one user action are scattered across many modules
 * (agent loop, decompose, reflect, faithfulness, vision batches, retrieval...),
 * with several independently-constructed Anthropic clients. Rather than thread a
 * billing handle through every signature, we keep an AsyncLocalStorage context:
 * a route/job wraps its handler in withMeter(); any code running underneath
 * calls addClaudeUsage()/addVoyageUsage(); on exit we sum the cost once, write a
 * usage_events row, and debit the wallet.
 *
 * Shadow mode (BILLING_ENFORCE !== "on"): we still record usage_events (so we
 * can validate the cost model against real traffic) but DO NOT debit or block.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import {
  claudeCostInr,
  voyageCostInr,
  sarvamCostInr,
  sarvamTranslateCostInr,
  inrToCredits,
  SARVAM_MODEL_KEY,
  SARVAM_TRANSLATE_MODEL_KEY,
  type ClaudeUsage,
} from "./cost";
import { debit, isUnlimited, type DebitResult } from "./credits";

export type Feature = "chat" | "workspace_chat" | "translate" | "ocr" | "ingest";

interface Line {
  provider: "claude" | "voyage" | "sarvam" | "sarvam_translate";
  model: string;
  usage: ClaudeUsage; // claude
  tokens: number; // voyage
  pages: number; // sarvam doc-ai — priced per page
  chars: number; // sarvam translate — priced per character
}

interface MeterCtx {
  userId: number;
  feature: Feature;
  refId?: string;
  /** True for Batch-API-delivered work. Charges still use full (sync) rates —
   *  the 2x rule: cost_inr/credits are 2x the actual half-price batch cost, so
   *  we keep the discount as margin. The flag lets analytics recover real COGS
   *  (= cost_inr / 2). See migration 024. */
  batchApi?: boolean;
  /** When false, the usage is still recorded (for COGS analytics) but the wallet
   *  is NOT debited — used when the metered action failed or was aborted so the
   *  user isn't charged for work they never received. Defaults to true. */
  billable: boolean;
  lines: Line[];
}

const als = new AsyncLocalStorage<MeterCtx>();

export function isEnforced(): boolean {
  return process.env.BILLING_ENFORCE === "on";
}

/** Record one Claude call's usage against the active meter (no-op if none). */
export function addClaudeUsage(model: string, usage: ClaudeUsage | undefined | null): void {
  const ctx = als.getStore();
  if (!ctx || !usage) return;
  ctx.lines.push({ provider: "claude", model, usage, tokens: 0, pages: 0, chars: 0 });
}

/** Record one Voyage embed/rerank call's token usage against the active meter. */
export function addVoyageUsage(model: string, totalTokens: number | undefined | null): void {
  const ctx = als.getStore();
  if (!ctx || !totalTokens) return;
  ctx.lines.push({ provider: "voyage", model, usage: {}, tokens: totalTokens, pages: 0, chars: 0 });
}

/** Record a Sarvam Doc AI read against the active meter. Priced per page, so a
 *  job's total COGS is this plus any translation chars plus the Claude tokens
 *  spent structuring — all landing on one usage_events row via the shared refId. */
export function addSarvamUsage(pages: number | undefined | null): void {
  const ctx = als.getStore();
  if (!ctx || !pages) return;
  ctx.lines.push({
    provider: "sarvam",
    model: SARVAM_MODEL_KEY,
    usage: {},
    tokens: 0,
    pages,
    chars: 0,
  });
}

/** Record a Sarvam /translate call against the active meter, in source characters. */
export function addSarvamTranslateUsage(chars: number | undefined | null): void {
  const ctx = als.getStore();
  if (!ctx || !chars) return;
  ctx.lines.push({
    provider: "sarvam_translate",
    model: SARVAM_TRANSLATE_MODEL_KEY,
    usage: {},
    tokens: 0,
    pages: 0,
    chars,
  });
}

/**
 * Cost in INR accumulated so far by the active meter (0 when there is none).
 *
 * Lets an agent loop read its own spend between steps and wind down before it
 * blows a budget, instead of discovering the cost after the turn is billed.
 * This is the enforcement point for a per-question credit ceiling: tuning step
 * counts and context sizes shapes the average, but only a live budget check
 * bounds the tail.
 */
export function currentCostInr(): number {
  const ctx = als.getStore();
  if (!ctx) return 0;
  return summarize(ctx.lines).costInr;
}

/** Allow a deeper layer to set the ref id (e.g. once the message row exists). */
export function setMeterRef(refId: string): void {
  const ctx = als.getStore();
  if (ctx) ctx.refId = refId;
}

/**
 * Mark the active metered action as unbillable. The usage is still recorded for
 * COGS analytics, but the wallet is not debited. Call this from a route's
 * error/abort handler when the agent threw, returned an empty/error answer, or
 * the client disconnected — so the user is never charged for a turn they didn't
 * receive. No-op if there is no active meter. Idempotent.
 */
export function markMeterUnbillable(): void {
  const ctx = als.getStore();
  if (ctx) ctx.billable = false;
}

export interface MeterResult {
  costInr: number;
  credits: number;
  debit: DebitResult | null; // null in shadow mode
}

function summarize(lines: Line[]) {
  let costInr = 0;
  const breakdown: Record<
    string,
    {
      in: number;
      out: number;
      cacheR: number;
      cacheW: number;
      tok: number;
      pages: number;
      chars: number;
    }
  > = {};
  for (const l of lines) {
    const b = (breakdown[l.model] ??= {
      in: 0,
      out: 0,
      cacheR: 0,
      cacheW: 0,
      tok: 0,
      pages: 0,
      chars: 0,
    });
    if (l.provider === "claude") {
      costInr += claudeCostInr(l.model, l.usage);
      b.in += l.usage.input_tokens ?? 0;
      b.out += l.usage.output_tokens ?? 0;
      b.cacheR += l.usage.cache_read_input_tokens ?? 0;
      b.cacheW += l.usage.cache_creation_input_tokens ?? 0;
    } else if (l.provider === "sarvam") {
      costInr += sarvamCostInr(l.pages);
      b.pages += l.pages;
    } else if (l.provider === "sarvam_translate") {
      costInr += sarvamTranslateCostInr(l.chars);
      b.chars += l.chars;
    } else {
      costInr += voyageCostInr(l.model, l.tokens);
      b.tok += l.tokens;
    }
  }
  return { costInr, breakdown };
}

/**
 * Run `fn` under a fresh meter. After it resolves we persist a usage_events row
 * and (when enforced) debit the wallet. Returns both the function's result and
 * the metering outcome so the caller can react (e.g. lock an output if the
 * debit went negative). Metering failures never break the user request.
 */
export async function withMeter<T>(
  opts: { userId: number; feature: Feature; refId?: string; batchApi?: boolean },
  fn: () => Promise<T>
): Promise<{ result: T; meter: MeterResult }> {
  const ctx: MeterCtx = { ...opts, billable: true, lines: [] };

  let result: T;
  try {
    result = await als.run(ctx, fn);
  } catch (err) {
    // The action threw: record the usage for COGS analytics but never debit —
    // the user got nothing back. Then re-throw so the caller's flow is unchanged.
    await finalizeMeter(ctx, false);
    throw err;
  }

  const meter = await finalizeMeter(ctx, ctx.billable);
  return { result, meter };
}

/** Summarize usage, write a usage_events row, and debit the wallet when billable
 *  + enforced. Metering failures are logged but never break the user request. */
async function finalizeMeter(ctx: MeterCtx, billable: boolean): Promise<MeterResult> {
  let meter: MeterResult = { costInr: 0, credits: 0, debit: null };
  try {
    const { costInr, breakdown } = summarize(ctx.lines);
    const credits = inrToCredits(costInr);
    const enforced = isEnforced();
    // Unlimited accounts (migration 025) are never debited — but we still record
    // the usage_events row below so COGS analytics stay accurate. Only pay the
    // extra lookup when we would otherwise have charged.
    let charged = billable && enforced && credits > 0;
    if (charged && (await isUnlimited(ctx.userId))) charged = false;

    let debitResult: DebitResult | null = null;
    if (charged) {
      debitResult = await debit(ctx.userId, credits);
    }

    await pool.query(
      `INSERT INTO usage_events
         (user_id, feature, ref_id, model_breakdown, cost_inr, credits_charged, enforced, batch_api)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ctx.userId,
        ctx.feature,
        ctx.refId ?? null,
        JSON.stringify(breakdown),
        costInr,
        // Record what was actually charged: 0 when the action was unbillable.
        charged ? credits : 0,
        enforced,
        ctx.batchApi ?? false,
      ]
    );

    meter = { costInr, credits: charged ? credits : 0, debit: debitResult };
  } catch (err) {
    logError({
      category: "payment",
      message: "Usage metering finalize failed",
      error: err,
      severity: "warning",
      metadata: { userId: ctx.userId, feature: ctx.feature, refId: ctx.refId },
    });
  }
  return meter;
}
