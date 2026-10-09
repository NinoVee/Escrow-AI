import { db } from "../db";
import { env } from "../env";
import { requirePermission, requireUser, type Ctx } from "../context";
import { invalid } from "../errors";
import { audit } from "../audit";
import type { IntegrationMode } from "@/generated/prisma/enums";

/**
 * Integration catalog. "Live" adapters exist only where the provider's
 * protocol is public and standard (Anthropic SDK, SMTP, S3, clamd). Vendor
 * APIs that require a commercial agreement and official documentation
 * (title, property data, e-signature, e-recording, banking) ship as clearly
 * labeled Demo adapters plus an interface for a future live implementation.
 * We never invent vendor endpoints.
 */

export type IntegrationKind =
  | "AI"
  | "OCR"
  | "STORAGE"
  | "MALWARE_SCAN"
  | "EMAIL"
  | "ESIGN"
  | "TITLE"
  | "PROPERTY_DATA"
  | "RECORDED_DOCUMENTS"
  | "RECORDING"
  | "BANKING"
  | "ACCOUNTING";

export interface ProviderInfo {
  id: string;
  name: string;
  liveImplemented: boolean;
  requiredEnv: string[];
  docs?: string;
  notes?: string;
}

export interface KindInfo {
  kind: IntegrationKind;
  label: string;
  description: string;
  providers: ProviderInfo[];
  /** What DEMO means for this integration. */
  demoNote: string;
}

export const CATALOG: KindInfo[] = [
  {
    kind: "AI",
    label: "Document assistant (AI)",
    description: "Classification, extraction, summaries, cited answers and drafts. Server-side only.",
    providers: [{ id: "anthropic", name: "Anthropic API", liveImplemented: true, requiredEnv: ["ANTHROPIC_API_KEY"], docs: "https://docs.claude.com/en/api/overview", notes: "Model set by ANTHROPIC_MODEL; refusal fallbacks enabled." }],
    demoNote: "Rule-based pattern matching. Not AI. Every value cites the matched line.",
  },
  {
    kind: "OCR",
    label: "OCR for scanned documents",
    description: "Transcribes scanned PDFs and images (PNG, JPEG, WebP) before extraction.",
    providers: [{ id: "anthropic", name: "Anthropic document/vision input", liveImplemented: true, requiredEnv: ["ANTHROPIC_API_KEY"], notes: "Set OCR_PROVIDER=anthropic. TIFF must be converted first." }],
    demoNote: "Not available in demo mode; scanned files are flagged for manual review.",
  },
  {
    kind: "STORAGE",
    label: "Private document storage",
    description: "Private object storage with short-lived signed download links.",
    providers: [
      { id: "s3", name: "S3-compatible (AWS S3, MinIO)", liveImplemented: true, requiredEnv: ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] },
      { id: "local", name: "Local disk (development)", liveImplemented: false, requiredEnv: [] },
    ],
    demoNote: "Local disk storage for development; not for production.",
  },
  {
    kind: "MALWARE_SCAN",
    label: "Malware scanning",
    description: "Uploads are quarantined until scanned clean.",
    providers: [{ id: "clamav", name: "ClamAV (clamd INSTREAM)", liveImplemented: true, requiredEnv: ["CLAMAV_HOST"], docs: "https://docs.clamav.net/manual/Usage/Scanning.html" }],
    demoNote: "Detects only the EICAR test string. Not real protection.",
  },
  {
    kind: "EMAIL",
    label: "Email",
    description: "Approved outbound messages. External sending is off by default.",
    providers: [{ id: "smtp", name: "SMTP relay (e.g. your email provider)", liveImplemented: true, requiredEnv: ["SMTP_HOST", "SMTP_FROM"], notes: "Also requires EXTERNAL_SEND_ENABLED=true and the company setting." }],
    demoNote: "Messages are captured in the demo outbox and never delivered.",
  },
  {
    kind: "ESIGN",
    label: "E-signature",
    description: "Send documents for signature and receive status webhooks.",
    providers: [
      { id: "docusign", name: "DocuSign eSignature", liveImplemented: false, requiredEnv: ["DOCUSIGN_INTEGRATION_KEY", "DOCUSIGN_ACCOUNT_ID"], docs: "https://developers.docusign.com/docs/esign-rest-api/", notes: "Adapter interface only; requires a DocuSign agreement and an integration review." },
      { id: "dropbox-sign", name: "Dropbox Sign", liveImplemented: false, requiredEnv: ["DROPBOX_SIGN_API_KEY"], docs: "https://developers.hellosign.com/" },
    ],
    demoNote: "Simulated envelopes. A simulated signature is NOT a legally completed e-signature.",
  },
  {
    kind: "TITLE",
    label: "Title orders",
    description: "Submit title orders, track status, and receive reports.",
    providers: [
      { id: "qualia", name: "Qualia", liveImplemented: false, requiredEnv: ["QUALIA_API_KEY"], notes: "Requires a Qualia partnership and API access; not assumed by a subscription." },
      { id: "first-american", name: "First American (title services)", liveImplemented: false, requiredEnv: [], notes: "Integration via the company's existing title provider channel." },
    ],
    demoNote: "Simulated order status and a simulated report clearly marked as not a title report.",
  },
  {
    kind: "PROPERTY_DATA",
    label: "Property and ownership data",
    description: "Property characteristics and owner of record. Never proof of title.",
    providers: [
      { id: "attom", name: "ATTOM Property API", liveImplemented: false, requiredEnv: ["ATTOM_API_KEY"], docs: "https://api.developer.attomdata.com/docs" },
      { id: "datatree", name: "First American DataTree", liveImplemented: false, requiredEnv: ["DATATREE_CLIENT_ID", "DATATREE_CLIENT_SECRET"] },
    ],
    demoNote: "Simulated data with fictional owners. Not a title search.",
  },
  {
    kind: "RECORDED_DOCUMENTS",
    label: "Recorded-document research",
    description: "Index of recorded documents for a parcel. Not a title examination.",
    providers: [{ id: "datatree", name: "First American DataTree", liveImplemented: false, requiredEnv: ["DATATREE_CLIENT_ID", "DATATREE_CLIENT_SECRET"] }],
    demoNote: "Simulated recorded-document index.",
  },
  {
    kind: "RECORDING",
    label: "E-recording",
    description: "Submit documents for recording and receive status.",
    providers: [{ id: "simplifile", name: "Simplifile / CSC eRecording", liveImplemented: false, requiredEnv: [], notes: "Requires a submitter agreement with the provider and county." }],
    demoNote: "Simulated submission. A simulated recording response is NOT proof of recording.",
  },
  {
    kind: "BANKING",
    label: "Banking and payments",
    description: "Statement import for reconciliation. Payment execution is disabled in this MVP.",
    providers: [{ id: "csv-import", name: "CSV statement import", liveImplemented: true, requiredEnv: [], notes: "Manual upload of bank-exported CSV. No payment initiation." }],
    demoNote: "Payment execution disabled. Releases are recorded after execution in your bank's system.",
  },
  {
    kind: "ACCOUNTING",
    label: "Escrow / accounting system export",
    description: "Export journal entries for import into the company's trust accounting system.",
    providers: [{ id: "csv-export", name: "CSV journal export", liveImplemented: true, requiredEnv: [], notes: "File export; no direct connection." }],
    demoNote: "File export only.",
  },
];

function envPresent(names: string[]) {
  const e = process.env as Record<string, string | undefined>;
  return names.every((n) => Boolean(e[n]));
}

export interface IntegrationStatus {
  kind: IntegrationKind;
  label: string;
  description: string;
  mode: IntegrationMode;
  provider: string;
  reason: string;
  info: KindInfo;
}

/** Effective mode: what actually runs, regardless of what was requested. */
export async function integrationStatuses(companyId: string): Promise<IntegrationStatus[]> {
  const configs = await db.integrationConfig.findMany({ where: { companyId } });
  const e = env();
  return CATALOG.map((info) => {
    const cfg = configs.find((c) => c.kind === info.kind);
    const base = { kind: info.kind, label: info.label, description: info.description, info };
    switch (info.kind) {
      case "AI":
        return e.ANTHROPIC_API_KEY && e.AI_PROVIDER !== "demo"
          ? { ...base, mode: "LIVE" as const, provider: `anthropic (${e.ANTHROPIC_MODEL})`, reason: "ANTHROPIC_API_KEY configured." }
          : { ...base, mode: "DEMO" as const, provider: "demo-rules", reason: e.AI_PROVIDER === "demo" ? "AI_PROVIDER=demo." : "ANTHROPIC_API_KEY not set." };
      case "OCR":
        return e.ANTHROPIC_API_KEY && e.OCR_PROVIDER === "anthropic" && e.AI_PROVIDER !== "demo"
          ? { ...base, mode: "LIVE" as const, provider: "anthropic", reason: "Uses the configured Anthropic model." }
          : { ...base, mode: "NOT_CONFIGURED" as const, provider: "none", reason: "Requires ANTHROPIC_API_KEY and OCR_PROVIDER=anthropic." };
      case "STORAGE":
        return e.STORAGE_DRIVER === "s3"
          ? { ...base, mode: "LIVE" as const, provider: `s3 (${e.S3_BUCKET})`, reason: e.S3_ENDPOINT ? `Endpoint ${e.S3_ENDPOINT}` : "AWS S3" }
          : { ...base, mode: "DEMO" as const, provider: "local disk", reason: "STORAGE_DRIVER=local (development only)." };
      case "MALWARE_SCAN":
        return e.MALWARE_SCANNER === "clamav"
          ? { ...base, mode: "LIVE" as const, provider: `clamav ${e.CLAMAV_HOST}:${e.CLAMAV_PORT}`, reason: "clamd INSTREAM." }
          : e.MALWARE_SCANNER === "demo"
            ? { ...base, mode: "DEMO" as const, provider: "demo (EICAR only)", reason: "MALWARE_SCANNER=demo." }
            : { ...base, mode: "NOT_CONFIGURED" as const, provider: "none", reason: "Uploads stay quarantined." };
      case "EMAIL": {
        const smtp = envPresent(["SMTP_HOST", "SMTP_FROM"]);
        const requested = cfg?.mode ?? "DEMO";
        if (smtp && (requested === "LIVE" || requested === "SANDBOX")) {
          return { ...base, mode: requested, provider: `smtp ${e.SMTP_HOST}`, reason: e.EXTERNAL_SEND_ENABLED === "true" ? "SMTP configured; server sending switch is on." : "SMTP configured, but EXTERNAL_SEND_ENABLED is false, so nothing is sent." };
        }
        return { ...base, mode: "DEMO" as const, provider: "demo outbox", reason: smtp ? "SMTP configured; select Sandbox or Live to use it." : "SMTP_HOST/SMTP_FROM not set." };
      }
      case "BANKING":
        return { ...base, mode: "NOT_CONFIGURED" as const, provider: "csv-import", reason: "Payment execution is disabled. CSV statement import is available for reconciliation." };
      case "ACCOUNTING":
        return { ...base, mode: "LIVE" as const, provider: "csv-export", reason: "Journal CSV export (no direct connection)." };
      default: {
        // Vendor integrations: demo unless an admin turned them off. No live adapters are implemented.
        const requested = cfg?.mode ?? "DEMO";
        if (requested === "NOT_CONFIGURED") return { ...base, mode: "NOT_CONFIGURED" as const, provider: "none", reason: "Turned off by an administrator." };
        const configuredButUnimplemented = info.providers.find((p) => !p.liveImplemented && p.requiredEnv.length && envPresent(p.requiredEnv));
        return {
          ...base,
          mode: "DEMO" as const,
          provider: "demo (simulated)",
          reason: configuredButUnimplemented ? `${configuredButUnimplemented.name} credentials found, but no live adapter is implemented yet; staying in Demo.` : "No live adapter configured.",
        };
      }
    }
  });
}

export async function integrationMode(companyId: string, kind: IntegrationKind): Promise<IntegrationMode> {
  return (await integrationStatuses(companyId)).find((s) => s.kind === kind)!.mode;
}

/** Admins can choose a requested mode; impossible choices are rejected. */
export async function setIntegrationMode(ctx: Ctx, kind: IntegrationKind, mode: IntegrationMode) {
  requirePermission(ctx, "integrations.manage");
  const userId = requireUser(ctx);
  const info = CATALOG.find((c) => c.kind === kind);
  if (!info) throw invalid("Unknown integration.");
  if ((mode === "LIVE" || mode === "SANDBOX") && !info.providers.some((p) => p.liveImplemented && envPresent(p.requiredEnv))) {
    throw invalid(`${info.label} cannot be set to ${mode.toLowerCase()}: no implemented adapter has the required credentials (${info.providers.map((p) => p.requiredEnv.join(", ") || "n/a").join(" | ")}).`);
  }
  await db.$transaction(async (client) => {
    await client.integrationConfig.upsert({
      where: { companyId_kind: { companyId: ctx.companyId, kind } },
      create: { companyId: ctx.companyId, kind, provider: info.providers[0].id, mode, updatedById: userId },
      update: { mode, updatedById: userId },
    });
    await audit(ctx, { action: "integration.mode_changed", entityType: "IntegrationConfig", entityId: kind, summary: `${info.label} set to ${mode.toLowerCase().replace("_", " ")}` }, client);
  });
}
