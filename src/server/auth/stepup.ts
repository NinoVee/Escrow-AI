import { auth } from "./auth";
import { db } from "../db";
import type { Ctx } from "../context";
import { AppError } from "../errors";
import { audit } from "../audit";
import { getCompanySettings } from "../settings";

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Step-up authentication: the user re-enters a TOTP code before a sensitive
 * action (revealing bank details, approving a disbursement, verifying bank
 * instructions). A successful step-up is valid for the company's configured
 * window and only for the current session.
 *
 * Better Auth's verify endpoint does not lock out signed-in sessions, so
 * failed step-up attempts are rate limited here.
 */
export async function verifyStepUp(ctx: Ctx, code: string, requestHeaders: Headers) {
  if (!ctx.userId || !ctx.sessionId) throw new AppError("UNAUTHENTICATED", "Please sign in again.");
  const since = new Date(Date.now() - FAILURE_WINDOW_MS);
  const failures = await db.stepUpVerification.count({
    where: { userId: ctx.userId, success: false, createdAt: { gte: since } },
  });
  if (failures >= MAX_FAILURES) {
    throw new AppError("RATE_LIMITED", "Too many failed verification attempts. Try again in 15 minutes.");
  }
  if (!/^\d{6}$/.test(code.trim())) throw new AppError("VALIDATION", "Enter the 6-digit code from your authenticator app.");

  let ok = false;
  try {
    await auth.api.verifyTOTP({ body: { code: code.trim() }, headers: requestHeaders });
    ok = true;
  } catch {
    ok = false;
  }
  const settings = await getCompanySettings(ctx.companyId);
  await db.stepUpVerification.create({
    data: {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      success: ok,
      expiresAt: new Date(Date.now() + settings.stepUpWindowMinutes * 60 * 1000),
    },
  });
  await audit(ctx, {
    action: ok ? "auth.step_up.success" : "auth.step_up.failure",
    entityType: "User",
    entityId: ctx.userId,
    summary: ok ? "Completed step-up verification" : "Failed step-up verification",
  });
  if (!ok) throw new AppError("VALIDATION", "That code was not accepted.");
}

export async function hasValidStepUp(ctx: Ctx): Promise<boolean> {
  if (!ctx.userId || !ctx.sessionId) return false;
  const row = await db.stepUpVerification.findFirst({
    where: { userId: ctx.userId, sessionId: ctx.sessionId, success: true, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return Boolean(row);
}

export async function requireStepUp(ctx: Ctx) {
  if (ctx.actorType !== "USER") throw new AppError("FORBIDDEN", "Sensitive actions require a human user.");
  if (!(await hasValidStepUp(ctx))) {
    throw new AppError("STEP_UP_REQUIRED", "Confirm your identity with your authenticator code to continue.");
  }
}
