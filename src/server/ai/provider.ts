import { env } from "../env";
import type { Answer, ContractExtraction, Draft, OcrResult, Summary, TitleExceptions } from "./schemas";
import type { PageText } from "./prompts";

/**
 * Document-assistant provider. Implementations return schema-validated data
 * only; they have no access to the database and no ability to act.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string | null;
  readonly mode: "LIVE" | "DEMO";
  extractContract(pages: PageText[]): Promise<ContractExtraction>;
  extractTitleExceptions(pages: PageText[]): Promise<TitleExceptions>;
  summarize(pages: PageText[]): Promise<Summary>;
  answer(question: string, passages: PageText[]): Promise<Answer>;
  draft(kind: DraftKind, facts: Record<string, string>): Promise<Draft>;
  /** Transcribes a scanned PDF or image. Returns null if OCR is unavailable. */
  ocr(data: Buffer, mimeType: string): Promise<OcrResult | null>;
}

export type DraftKind = "DOCUMENT_REQUEST" | "STATUS_UPDATE" | "DEADLINE_REMINDER";

export class AiUnavailableError extends Error {}

/** "LIVE" when Anthropic credentials are configured and selected; otherwise the labeled demo adapter. */
export function aiMode(): "LIVE" | "DEMO" {
  const e = env();
  if (e.AI_PROVIDER === "demo") return "DEMO";
  return e.ANTHROPIC_API_KEY ? "LIVE" : "DEMO";
}

let override: AiProvider | null = null;
/** Tests inject fake providers here. */
export function setAiProviderForTests(p: AiProvider | null) {
  override = p;
}

export async function getAiProvider(): Promise<AiProvider> {
  if (override) return override;
  if (aiMode() === "LIVE") {
    const { AnthropicProvider } = await import("./anthropic");
    return new AnthropicProvider();
  }
  const { DemoProvider } = await import("./demo");
  return new DemoProvider();
}
