/**
 * Razorpay checkout launcher with failure reporting.
 *
 * Every call site used to do `new Razorpay(options).open()` and register only a
 * success `handler`. Razorpay emits `payment.failed` for a declined card, a
 * failed 3-D Secure step, an expired VPA and so on — with no listener, our UI
 * showed nothing at all: the user closed Razorpay's own dialog and landed back
 * on an unchanged page, and the failure never reached `error_logs`. This wraps
 * the launch so both happen: the caller gets a user-facing message to render,
 * and the failure is persisted server-side via /api/errors/report.
 */

import { loadRazorpay } from "./loadRazorpay";
import { reportError } from "./report-error";
import { trackClick } from "./analytics/client";
import { EVENTS } from "./analytics/events";

/** Shape Razorpay hands back on `payment.failed`. All fields are optional. */
interface RazorpayFailure {
  error?: {
    code?: string;
    description?: string;
    reason?: string;
    step?: string;
    source?: string;
    metadata?: { order_id?: string; payment_id?: string };
  };
}

interface RazorpayInstance {
  open: () => void;
  /** Present on Razorpay's standard checkout; treated as optional defensively. */
  on?: (event: string, handler: (payload: RazorpayFailure) => void) => void;
}

export interface OpenCheckoutParams<T extends object> {
  options: T;
  /**
   * Called with a message ready to show the user when the payment fails inside
   * the Razorpay dialog.
   */
  onFailure: (message: string) => void;
  /** Extra context stored alongside the reported error and analytics (plan, tier, …). */
  context?: Record<string, string | number | boolean>;
}

export async function openRazorpayCheckout<T extends object>({
  options,
  onFailure,
  context,
}: OpenCheckoutParams<T>): Promise<void> {
  await loadRazorpay();

  const Ctor = (window as unknown as {
    Razorpay: new (opts: T) => RazorpayInstance;
  }).Razorpay;
  // Razorpay calls ondismiss only when the user closes the dialog themselves —
  // a successful payment closes it without firing — so this is "walked away
  // at the payment step", the drop-off between checkout_started and paying.
  let failedAttempts = 0;
  const withDismiss = {
    ...options,
    modal: {
      ...((options as { modal?: Record<string, unknown> }).modal ?? {}),
      ondismiss: () => {
        trackClick(EVENTS.CHECKOUT_DISMISSED, { ...context, failed_attempts: failedAttempts });
        const prior = (options as { modal?: { ondismiss?: () => void } }).modal?.ondismiss;
        prior?.();
      },
    },
  } as T;
  const rzp = new Ctor(withDismiss);

  // Guarded: this is the checkout path. If a Razorpay build ever ships without
  // `.on`, an unguarded call would throw here and stop the dialog from opening
  // at all — trading a silent failure for a total one. Losing the listener just
  // returns us to the old behaviour.
  rzp.on?.("payment.failed", (payload) => {
    const description = payload?.error?.description;
    const reason = payload?.error?.reason;
    failedAttempts++;
    trackClick(EVENTS.CHECKOUT_PAYMENT_FAILED, {
      ...context,
      razorpay_code: payload?.error?.code ?? "",
      razorpay_reason: reason ?? "",
      razorpay_step: payload?.error?.step ?? "",
      razorpay_source: payload?.error?.source ?? "",
      razorpay_order_id: payload?.error?.metadata?.order_id ?? "",
      razorpay_payment_id: payload?.error?.metadata?.payment_id ?? "",
      description: description ?? "",
      attempt: failedAttempts,
    });
    // Razorpay's `description` is written for end users ("Your card was
    // declined by the issuing bank"), so prefer it verbatim over a generic line.
    onFailure(
      description
        ? `Payment failed: ${description}`
        : "Payment failed. You have not been charged. Please try another payment method."
    );
    reportError("Razorpay payment failed", {
      ...context,
      razorpay_code: payload?.error?.code,
      razorpay_reason: reason,
      razorpay_step: payload?.error?.step,
      razorpay_source: payload?.error?.source,
      razorpay_order_id: payload?.error?.metadata?.order_id,
      razorpay_payment_id: payload?.error?.metadata?.payment_id,
      description,
    });
  });

  rzp.open();
}
