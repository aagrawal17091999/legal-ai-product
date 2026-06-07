// Lazily inject the Razorpay Checkout script on first use, instead of loading
// it globally on every page (it was previously a <script> in the root layout,
// so the landing page and every chat paid for a third-party request that only
// the upgrade/checkout flow actually needs). Resolves once window.Razorpay is
// available; subsequent calls reuse the same in-flight/loaded promise.

const SRC = "https://checkout.razorpay.com/v1/checkout.js";

let promise: Promise<void> | null = null;

export function loadRazorpay(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ("Razorpay" in window) return Promise.resolve();
  if (promise) return promise;

  promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SRC}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Razorpay failed to load")));
      return;
    }
    const script = document.createElement("script");
    script.src = SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      promise = null; // allow a retry on next attempt
      reject(new Error("Razorpay failed to load"));
    };
    document.body.appendChild(script);
  });
  return promise;
}
