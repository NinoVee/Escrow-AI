import { z } from "zod";
import { db } from "./db";

/**
 * Company-level configuration. Defaults are conservative: external sending is
 * off, staff MFA is required, and retention values are placeholders that must
 * be confirmed against the company's legal and regulatory obligations.
 */
export const CompanySettingsSchema = z.object({
  requireStaffMfa: z.boolean().default(true),
  stepUpWindowMinutes: z.number().int().min(1).max(30).default(10),
  /** Company-level switch for automated/external email. The env kill switch must also be on. */
  externalSendingEnabled: z.boolean().default(false),
  timezone: z.string().default("America/Los_Angeles"),
  escrowNumberPrefix: z.string().default("ESC"),
  /** Placeholder retention period. Confirm with counsel before relying on it. */
  retentionYearsAfterClose: z.number().int().min(1).max(50).default(7),
  /** Require a second person to verify bank instructions (verifier != creator). */
  requireIndependentBankVerification: z.boolean().default(true),
  /** Settlement conventions */
  prorationBasis: z.enum(["ACTUAL_365", "ACTUAL_ACTUAL", "BANKER_360"]).default("ACTUAL_365"),
  prorationSellerOwnsClosingDay: z.boolean().default(false),
  roundingMode: z.enum(["HALF_UP", "HALF_EVEN"]).default("HALF_UP"),
  procedures: z
    .object({
      requireOfficerReviewOfAmendments: z.boolean().default(true),
      requireDocumentReviewBeforeSharing: z.boolean().default(false),
    })
    .default({ requireOfficerReviewOfAmendments: true, requireDocumentReviewBeforeSharing: false }),
});

export type CompanySettings = z.infer<typeof CompanySettingsSchema>;

export function parseSettings(raw: unknown): CompanySettings {
  return CompanySettingsSchema.parse(raw ?? {});
}

export async function getCompanySettings(companyId: string): Promise<CompanySettings> {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  return parseSettings(c?.settings);
}
