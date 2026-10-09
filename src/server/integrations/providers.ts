import { randomUUID } from "node:crypto";
import { buildPdf } from "@/lib/simple-pdf";

/**
 * Provider interfaces for vendor integrations, plus DEMO implementations.
 * A live implementation must use the vendor's official API documentation and
 * credentials obtained under an agreement that includes API access. Demo
 * outputs are labeled as simulated everywhere they appear.
 */

export interface TitleOrderProvider {
  readonly id: string;
  submitOrder(input: { escrowNumber: string; address: string; apns: string[] }): Promise<{ externalRef: string; status: "SUBMITTED" }>;
  getReport(externalRef: string, input: { address: string; apns: string[] }): Promise<{ filename: string; data: Buffer } | null>;
}

export interface PropertyDataProvider {
  readonly id: string;
  lookup(input: { address: string; apn?: string }): Promise<{ result: Record<string, unknown>; coverageNote: string }>;
}

export interface RecordedDocumentsProvider {
  readonly id: string;
  search(input: { apn: string; county?: string }): Promise<{ result: Record<string, unknown>; coverageNote: string }>;
}

export interface ESignProvider {
  readonly id: string;
  createEnvelope(input: { subject: string; signers: string[]; documentIds: string[] }): Promise<{ externalId: string }>;
}

export interface RecordingProvider {
  readonly id: string;
  submit(input: { county: string | null; documentIds: string[] }): Promise<{ externalId: string }>;
}

/** Payment execution is intentionally unavailable. */
export interface PaymentExecutionProvider {
  execute(): Promise<never>;
}

const SIM = "SIMULATED (DEMO) DATA - NOT FROM A REAL PROVIDER";

export const demoTitle: TitleOrderProvider = {
  id: "title-demo",
  async submitOrder() {
    return { externalRef: `DEMO-TTL-${randomUUID().slice(0, 8).toUpperCase()}`, status: "SUBMITTED" };
  },
  async getReport(externalRef, input) {
    return {
      filename: `${externalRef}-simulated-report.pdf`,
      data: buildPdf(
        [
          [
            "*** SIMULATED DEMO DOCUMENT - THIS IS NOT A TITLE REPORT OR COMMITMENT ***",
            "SIMULATED PRELIMINARY REPORT (DEMO PROVIDER)",
            `Order: ${externalRef}`,
            `Property: ${input.address}   APN: ${input.apns.join(", ") || "not provided"}`,
            "Title vested in: SIMULATED OWNER OF RECORD (demo)",
            "",
            "SCHEDULE B - EXCEPTIONS",
            "1. General and special taxes for the current fiscal year (simulated).",
            "2. Deed of Trust in favor of Demo Lender, original amount $250,000.00 (simulated).",
            "3. Easements of record (simulated).",
            "",
            "No title examination was performed. Order a real report from your title company.",
          ],
        ],
        "Simulated report",
      ),
    };
  },
};

export const demoProperty: PropertyDataProvider = {
  id: "property-demo",
  async lookup(input) {
    const seed = [...(input.apn ?? input.address)].reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      result: {
        notice: SIM,
        ownerOfRecord: "SIMULATED OWNER (demo)",
        propertyUse: seed % 2 ? "Single family residence" : "Commercial",
        yearBuilt: 1960 + (seed % 60),
        lotSqFt: 4000 + (seed % 9000),
        buildingSqFt: 1100 + (seed % 2400),
        lastSaleDate: "SIMULATED",
        assessedValue: "SIMULATED",
      },
      coverageNote: "Simulated data for demonstration. Property data is not a title search and does not establish ownership, liens or insurability.",
    };
  },
};

export const demoRecordedDocs: RecordedDocumentsProvider = {
  id: "recorded-docs-demo",
  async search(input) {
    return {
      result: {
        notice: SIM,
        apn: input.apn,
        documents: [
          { type: "Grant deed (simulated)", recorded: "SIMULATED", instrument: "DEMO-0001" },
          { type: "Deed of trust (simulated)", recorded: "SIMULATED", instrument: "DEMO-0002" },
        ],
      },
      coverageNote: "Simulated index. Recorded-document research is not a professional title examination.",
    };
  },
};

export const demoESign: ESignProvider = {
  id: "esign-demo",
  async createEnvelope() {
    return { externalId: `DEMO-ENV-${randomUUID().slice(0, 8).toUpperCase()}` };
  },
};

export const demoRecording: RecordingProvider = {
  id: "recording-demo",
  async submit() {
    return { externalId: `DEMO-REC-${randomUUID().slice(0, 8).toUpperCase()}` };
  },
};

export const disabledPayments: PaymentExecutionProvider = {
  async execute(): Promise<never> {
    throw new Error("Payment execution is disabled in EscrowFlow. Execute payments in your approved banking system.");
  },
};
