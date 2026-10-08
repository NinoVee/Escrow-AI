import { z } from "zod";

/**
 * Schemas every AI (or demo) output must satisfy. Values are strings so that
 * application code, not the model, converts them into money, dates and enums.
 * `null` means "not stated in the document". Unknown keys are stripped.
 */

const cite = {
  page: z.number().int().nullable().describe("1-based page number where the supporting text appears, or null"),
  excerpt: z.string().nullable().describe("Short verbatim quote (max ~200 characters) copied exactly from the document"),
  confidence: z.number().describe("0 to 1"),
};

export const ExtractedValueSchema = z.object({
  value: z.string().nullable().describe("Value exactly as stated, or null if the document does not state it"),
  ...cite,
});
export type ExtractedValue = z.infer<typeof ExtractedValueSchema>;

export const DOC_TYPES = [
  "PURCHASE_AGREEMENT",
  "AMENDMENT",
  "COUNTER_OFFER",
  "ESCROW_INSTRUCTIONS",
  "TITLE_REPORT",
  "PAYOFF_STATEMENT",
  "HOA_DEMAND",
  "LENDER_INSTRUCTIONS",
  "ENTITY_DOCUMENTS",
  "LEASE",
  "RENT_ROLL",
  "ESTOPPEL",
  "DISCLOSURE",
  "OTHER",
] as const;

export const ContractExtractionSchema = z.object({
  documentType: z.enum(DOC_TYPES),
  documentTypeConfidence: z.number(),
  summary: z.string().describe("Neutral 2-5 sentence summary of what the document says. No legal conclusions."),
  fields: z.object({
    purchasePrice: ExtractedValueSchema,
    initialDeposit: ExtractedValueSchema,
    additionalDeposit: ExtractedValueSchema,
    loanAmount: ExtractedValueSchema,
    financingType: ExtractedValueSchema.describe("One of CASH, CONVENTIONAL, FHA, VA, SELLER_CARRY, COMMERCIAL_LOAN, OTHER, or null"),
    acceptanceDate: ExtractedValueSchema.describe("YYYY-MM-DD if a specific date is stated"),
    closingDate: ExtractedValueSchema.describe("YYYY-MM-DD if a specific date is stated"),
    hasHoa: ExtractedValueSchema.describe('"true"/"false" only if the document says so'),
    hasTenants: ExtractedValueSchema,
    is1031Exchange: ExtractedValueSchema,
  }),
  parties: z.array(
    z.object({
      role: z.enum(["BUYER", "SELLER", "LENDER", "BUYER_AGENT", "LISTING_AGENT", "ATTORNEY", "EXCHANGE_ACCOMMODATOR", "OTHER"]),
      name: z.string(),
      partyType: z.enum(["INDIVIDUAL", "LLC", "CORPORATION", "TRUST", "PARTNERSHIP", "ESTATE", "OTHER_ENTITY"]),
      ...cite,
    }),
  ),
  properties: z.array(
    z.object({
      address: z.string().nullable(),
      apn: z.string().nullable(),
      legalDescription: z.string().nullable(),
      ...cite,
    }),
  ),
  timePeriods: z.array(
    z.object({
      title: z.string(),
      type: z.enum(["CONTINGENCY", "CONTRACT", "CLOSING", "LENDER", "OTHER"]),
      date: z.string().nullable().describe("YYYY-MM-DD only if the document states a calendar date"),
      daysAfterAcceptance: z.number().int().nullable().describe("If stated as N days after acceptance/effective date"),
      ...cite,
    }),
  ),
  suggestedTasks: z.array(z.object({ title: z.string(), reason: z.string(), ...cite })),
});
export type ContractExtraction = z.infer<typeof ContractExtractionSchema>;

export const TitleExceptionsSchema = z.object({
  items: z.array(
    z.object({
      itemNumber: z.string().nullable(),
      category: z.enum(["TAXES", "DEED_OF_TRUST", "LIEN", "JUDGMENT", "EASEMENT", "CCRS", "HOA", "REQUIREMENT", "OTHER"]),
      text: z.string().describe("The exception text copied verbatim"),
      plainLanguageSummary: z.string().describe("One neutral sentence describing the item. Never state that title is clear or insurable."),
      page: z.number().int().nullable(),
    }),
  ),
});
export type TitleExceptions = z.infer<typeof TitleExceptionsSchema>;

export const AnswerSchema = z.object({
  answer: z.string(),
  insufficientEvidence: z.boolean(),
  citations: z.array(z.object({ passageId: z.string(), excerpt: z.string() })),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const DraftSchema = z.object({ subject: z.string(), body: z.string() });
export type Draft = z.infer<typeof DraftSchema>;

export const OcrSchema = z.object({ pages: z.array(z.object({ pageNumber: z.number().int(), text: z.string() })) });
export type OcrResult = z.infer<typeof OcrSchema>;

export const SummarySchema = z.object({ summary: z.string(), keyPoints: z.array(z.object({ point: z.string(), page: z.number().int().nullable() })) });
export type Summary = z.infer<typeof SummarySchema>;
