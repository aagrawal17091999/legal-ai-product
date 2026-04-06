import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/lib/error-logger";

// POST /api/errors/report — Report a frontend error (no auth required)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, stack, metadata } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    logError({
      category: "frontend",
      message: message.slice(0, 2000),
      severity: "error",
      metadata: {
        stack: typeof stack === "string" ? stack.slice(0, 5000) : undefined,
        userAgent: request.headers.get("user-agent"),
        ...metadata,
      },
    });

    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
