/**
 * The event taxonomy — one place, so a rename can't silently split a funnel.
 *
 * Naming: `noun_verb_past_tense`, lowercase snake. Mixpanel sorts alphabetically
 * in its UI, so the noun goes first to keep a feature's events adjacent.
 *
 * WHAT GOES TO MIXPANEL (decided Oct 2026, replacing the old counts-only rule):
 * user identity (name, email, phone), what they typed (questions, search
 * filters, filenames), a 255-character preview of what they got back, and every
 * id that joins an event to our own tables or to Razorpay — message, session,
 * workspace, document, job, order, payment and subscription ids. Full answer and
 * document text stays in Postgres; the ids are how you get from an event to it.
 *
 * This is privileged client material, and Mixpanel now holds part of it. Keep
 * the privacy policy in step with what is sent here.
 */
export const EVENTS = {
  // ── Acquisition / activation ──────────────────────────────────────────────
  SIGNED_UP: "user_signed_up",
  SIGNED_IN: "user_signed_in",
  SIGNED_OUT: "user_signed_out",
  ONBOARDING_COMPLETED: "user_onboarding_completed",
  PROFILE_UPDATED: "user_profile_updated",

  // ── Case-law research ─────────────────────────────────────────────────────
  RESEARCH_ASKED: "research_question_asked",
  RESEARCH_ANSWERED: "research_answer_returned",
  RESEARCH_FAILED: "research_answer_failed",
  RESEARCH_STOPPED: "research_answer_stopped",
  RESEARCH_SESSION_CREATED: "research_session_created",
  RESEARCH_SESSION_DELETED: "research_session_deleted",

  // ── Judgment search ───────────────────────────────────────────────────────
  JUDGMENT_SEARCHED: "judgment_search_performed",
  JUDGMENT_DOWNLOADED: "judgment_downloaded",

  // ── Document workspaces ───────────────────────────────────────────────────
  WORKSPACE_CREATED: "workspace_created",
  WORKSPACE_RENAMED: "workspace_renamed",
  WORKSPACE_DELETED: "workspace_deleted",
  DOCUMENT_UPLOADED: "workspace_document_uploaded",
  DOCUMENT_READY: "workspace_document_ready",
  DOCUMENT_FAILED: "workspace_document_failed",
  DOCUMENT_DELETED: "workspace_document_deleted",
  DOCCHAT_CONVERSATION_CREATED: "docchat_conversation_created",
  DOCCHAT_ASKED: "docchat_question_asked",
  DOCCHAT_ANSWERED: "docchat_answer_returned",
  DOCCHAT_FAILED: "docchat_answer_failed",
  DOCCHAT_STOPPED: "docchat_answer_stopped",

  // ── Uploads (all features) ────────────────────────────────────────────────
  UPLOAD_REJECTED: "upload_rejected",

  // ── OCR / translation ─────────────────────────────────────────────────────
  OCR_STARTED: "ocr_job_started",
  OCR_COMPLETED: "ocr_job_completed",
  OCR_FAILED: "ocr_job_failed",
  TRANSLATE_STARTED: "translation_job_started",
  TRANSLATE_COMPLETED: "translation_job_completed",
  TRANSLATE_FAILED: "translation_job_failed",
  OCR_DELETED: "ocr_job_deleted",
  TRANSLATE_DELETED: "translation_job_deleted",

  // ── Billing ───────────────────────────────────────────────────────────────
  OUT_OF_CREDITS: "credits_exhausted",
  CHECKOUT_STARTED: "checkout_started",
  SUBSCRIPTION_ACTIVATED: "subscription_activated",
  SUBSCRIPTION_RENEWED: "subscription_renewed",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  SUBSCRIPTION_ENDED: "subscription_ended",
  SUBSCRIPTION_PLAN_CHANGED: "subscription_plan_changed",
  PAYMENT_FAILED: "payment_failed",
  TOPUP_PURCHASED: "topup_purchased",
  CREDITS_REFILLED: "credits_refilled",
  ADMIN_ACTION: "admin_action_performed",

  // ── Client-side (clicks only) ─────────────────────────────────────────────
  UPGRADE_PROMPT_SHOWN: "upgrade_prompt_shown",
  TOPUP_PROMPT_SHOWN: "topup_prompt_shown",
  PLAN_CLICKED: "plan_clicked",
  TOPUP_TIER_CLICKED: "topup_tier_clicked",
  CREDIT_METER_CLICKED: "credit_meter_clicked",
  LOW_BALANCE_BANNER_SHOWN: "low_balance_banner_shown",
  CHECKOUT_DISMISSED: "checkout_dismissed",
  CHECKOUT_PAYMENT_FAILED: "checkout_payment_failed",
  CITATION_OPENED: "citation_opened",
  OCR_RESULT_DOWNLOADED: "ocr_result_downloaded",
  TRANSLATION_RESULT_DOWNLOADED: "translation_result_downloaded",
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
  EVENTS.LOW_BALANCE_BANNER_SHOWN,
  // What happened inside Razorpay's own dialog is only visible to the browser.
  // Forgeable, but harmless: neither moves money or credits. The authoritative
  // failure is PAYMENT_FAILED from the webhook.
  EVENTS.CHECKOUT_DISMISSED,
  EVENTS.CHECKOUT_PAYMENT_FAILED,
  EVENTS.CITATION_OPENED,
  EVENTS.OCR_RESULT_DOWNLOADED,
  EVENTS.TRANSLATION_RESULT_DOWNLOADED,
]);
