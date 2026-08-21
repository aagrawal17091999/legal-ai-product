/**
 * Per-request ambient context for logging.
 *
 * The problem this solves: `logError` takes an optional `userId`, and of the
 * ~99 call sites across the app only 19 actually pass one. That left the
 * overwhelming majority of `error_logs` rows with `user_id = NULL`, which in
 * turn made "show me everything that went wrong for this account" unanswerable
 * — the per-user filter on /admin/errors would have had almost nothing to show.
 *
 * Rather than edit 80 call sites (and rely on everyone remembering forever), we
 * resolve the user ONCE, where it is already known — in `verifyAuth` /
 * `getRequestUser` — and stash it in an AsyncLocalStorage store that
 * `logError` reads as a fallback. Call sites that DO pass a userId still win;
 * this only fills the blanks.
 *
 * ## Why `enterWith` and not `run`
 *
 * `run(store, cb)` needs to wrap the whole request, and there is no shared
 * route-handler wrapper in this app (nor a Next.js hook for one — the
 * `instrumentation.ts` conventions in Next 16 give us `register` and
 * `onRequestError`, neither of which brackets a request). `enterWith` sets the
 * store for the current async context and everything spawned from it, which is
 * exactly the escape hatch for "I cannot wrap the entry point".
 *
 * The constraint that makes this safe: `beginRequestContext` must only ever be
 * called from inside a request's own async chain (i.e. from a route handler,
 * via verifyAuth). Called from module scope or any context that outlives a
 * single request, the store would leak across requests and misattribute rows.
 * That is why this file exports no way to set a store directly.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  /** Correlates an error_logs row with the pm2/stdout lines from the same request. */
  requestId: string;
  endpoint?: string;
  method?: string;
  /** Our internal users.id — filled in once auth resolves it, not at begin. */
  userId?: number | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Start (or join) the context for the current request. Idempotent: several
 * routes call verifyAuth more than once per request, and re-entering would
 * throw away a userId already resolved on this request.
 */
export function beginRequestContext(init: {
  endpoint?: string;
  method?: string;
}): RequestContext {
  const existing = storage.getStore();
  if (existing) return existing;

  const ctx: RequestContext = {
    requestId: randomUUID(),
    endpoint: init.endpoint,
    method: init.method,
  };
  storage.enterWith(ctx);
  return ctx;
}

/** Attach the resolved internal user id to the in-flight request, if there is one. */
export function setContextUser(userId: number | null | undefined): void {
  const ctx = storage.getStore();
  if (ctx && typeof userId === "number") ctx.userId = userId;
}

/** Read the ambient context. Returns undefined outside a request (cron, scripts, pipeline). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
