import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, invalidateUserCache } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import {
  isReferralSource,
  normalizeIndianMobile,
  REFERRAL_DETAIL_MAX,
} from "@/lib/onboarding";

/**
 * POST /api/user/onboarding — saves the post-signup step: mobile number and how
 * the user heard about us. Re-submitting overwrites; onboarded_at keeps the
 * first completion time.
 */
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { phone?: unknown; referral_source?: unknown; referral_detail?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const phone =
    typeof body.phone === "string" ? normalizeIndianMobile(body.phone) : null;
  if (!phone) {
    return NextResponse.json(
      { error: "Enter a valid 10-digit Indian mobile number" },
      { status: 400 }
    );
  }

  if (!isReferralSource(body.referral_source)) {
    return NextResponse.json(
      { error: "Tell us how you heard about Legal Brain" },
      { status: 400 }
    );
  }
  const source = body.referral_source;

  const detail =
    typeof body.referral_detail === "string" ? body.referral_detail.trim() : "";
  if (source === "other" && !detail) {
    return NextResponse.json(
      { error: "Tell us where you heard about Legal Brain" },
      { status: 400 }
    );
  }
  if (detail.length > REFERRAL_DETAIL_MAX) {
    return NextResponse.json(
      { error: `Keep it under ${REFERRAL_DETAIL_MAX} characters` },
      { status: 400 }
    );
  }

  try {
    const { rows } = await pool.query<{ id: number; first: boolean }>(
      `UPDATE users
          SET phone = $1,
              referral_source = $2,
              referral_detail = $3,
              onboarded_at = COALESCE(onboarded_at, NOW()),
              updated_at = NOW()
        WHERE firebase_uid = $4
        RETURNING id, (onboarded_at = updated_at) AS first`,
      [phone, source, source === "other" ? detail : null, decoded.uid]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    invalidateUserCache(decoded.uid);

    const { id, first } = rows[0];
    if (first) {
      // The profile's $phone and referral fields are refreshed by track().
      track(EVENTS.ONBOARDING_COMPLETED, {
        userId: id,
        insertId: `onboarding:${id}`,
        properties: {
          phone,
          referral_source: source,
          referral_detail: source === "other" ? detail : null,
        },
      });
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/user/onboarding",
      method: "POST",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
