/**
 * The event taxonomy — one place, so a rename can't silently split a funnel.
 *
 * Naming: `noun_verb_past_tense`, lowercase snake. Mixpanel sorts alphabetically
 * in its UI, so the noun goes first to keep a feature's events adjacent.
 *
 * PRIVACY RULE, non-negotiable: this product handles privileged client material.
 * Never send query text, document text, document filenames, or any extracted
 * content. Counts, durations, ids, enums, and booleans only. If you find
 * yourself adding a `string` property, check it can't carry user content.
 */
export const EVENTS = {
  // ── Acquisition / activation ──────────────────────────────────────────────
  SIGNED_UP: "user_signed_up",
  SIGNED_IN: "user_signed_in",

  // ── Case-law research ─────────────────────────────────────────────────────
  RESEARCH_ASKED: "research_question_asked",
  RESEARCH_ANSWERED: "research_answer_returned",
  RESEARCH_FAILED: "research_answer_failed",

  // ── Document workspaces ───────────────────────────────────────────────────
  WORKSPACE_CREATED: "workspace_created",
  DOCUMENT_UPLOADED: "workspace_document_uploaded",
  DOCUMENT_READY: "workspace_document_ready",
  DOCUMENT_FAILED: "workspace_document_failed",
  DOCCHAT_ASKED: "docchat_question_asked",
  DOCCHAT_ANSWERED: "docchat_answer_returned",

  // ── OCR / translation ─────────────────────────────────────────────────────
  OCR_STARTED: "ocr_job_started",
  OCR_COMPLETED: "ocr_job_completed",
  OCR_FAILED: "ocr_job_failed",
  TRANSLATE_STARTED: "translation_job_started",
  TRANSLATE_COMPLETED: "translation_job_completed",
  TRANSLATE_FAILED: "translation_job_failed",

  // ── Billing ───────────────────────────────────────────────────────────────
  OUT_OF_CREDITS: "credits_exhausted",
  CHECKOUT_STARTED: "checkout_started",
  SUBSCRIPTION_ACTIVATED: "subscription_activated",
  SUBSCRIPTION_RENEWED: "subscription_renewed",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  TOPUP_PURCHASED: "topup_purchased",

  // ── Client-side (clicks only) ─────────────────────────────────────────────
  UPGRADE_PROMPT_SHOWN: "upgrade_prompt_shown",
  TOPUP_PROMPT_SHOWN: "topup_prompt_shown",
  PLAN_CLICKED: "plan_clicked",
  TOPUP_TIER_CLICKED: "topup_tier_clicked",
  CREDIT_METER_CLICKED: "credit_meter_clicked",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * Events the browser is allowed to send. Everything of consequence — signup,
 * payment, messages, job outcomes — is emitted server-side, where it can't be
 * blocked by an extension, dropped by a closed tab, or forged by a client. This
 * allowlist is what stops the public ingest endpoint from being used to inject
 * fake revenue events into the funnel.
 */
export const CLIENT_ALLOWED: ReadonlySet<string> = new Set<string>([
  EVENTS.UPGRADE_PROMPT_SHOWN,
  EVENTS.TOPUP_PROMPT_SHOWN,
  EVENTS.PLAN_CLICKED,
  EVENTS.TOPUP_TIER_CLICKED,
  EVENTS.CREDIT_METER_CLICKED,
]);
