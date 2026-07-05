import { NextResponse } from "next/server";
import pool from "@/lib/db";

/**
 * Liveness/readiness probe for external uptime monitoring (UptimeRobot,
 * BetterStack, etc.) and for nginx/pm2 health checks.
 *
 * Unauthenticated ON PURPOSE — monitors can't carry secrets — so it returns
 * only a boolean-ish status and never leaks connection strings, versions, or
 * row counts. It does a cheap round-trip to Postgres so a healthy HTTP process
 * sitting on top of a dead database still reports unhealthy (503), which is the
 * failure mode that actually pages you on a single co-located box.
 */

export const dynamic = "force-dynamic"; // never cache a health check

export async function GET() {
  try {
    await pool.query("SELECT 1");
    return NextResponse.json(
      { status: "ok", db: "up" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { status: "degraded", db: "down" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
