import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

// Routes that require authentication. A logged-out visitor is bounced to /login.
const PROTECTED_PREFIXES = ["/chat", "/account", "/judgments", "/trace"];
// Pages a logged-in user should never see — they're sent straight to /chat.
const AUTH_ONLY_PAGES = ["/", "/login", "/signup"];

/**
 * Optimistic, server-side auth redirects. Per the Next.js auth guide, proxy
 * only *reads* the session cookie's presence — it does no crypto or DB work —
 * so it runs cheaply on every navigation, including prefetches. The real
 * verification happens in the route handlers (verifyAuth). This is what
 * eliminates the "landing page flashes before redirecting" delay: an
 * authenticated request to `/` is 302'd to `/chat` before any HTML renders.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  if (isProtected && !hasSession) {
    const url = new URL("/login", request.url);
    url.searchParams.set("returnUrl", pathname);
    return NextResponse.redirect(url);
  }

  if (hasSession && AUTH_ONLY_PAGES.includes(pathname)) {
    return NextResponse.redirect(new URL("/chat", request.url));
  }

  return NextResponse.next();
}

// Skip API routes, Next internals, and anything with a file extension.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
