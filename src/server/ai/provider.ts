import { env } from "../env";

/** "LIVE" when Anthropic credentials are configured and selected; otherwise the labeled demo adapter. */
export function aiMode(): "LIVE" | "DEMO" {
  const e = env();
  if (e.AI_PROVIDER === "demo") return "DEMO";
  if (e.AI_PROVIDER === "anthropic") return e.ANTHROPIC_API_KEY ? "LIVE" : "DEMO";
  return e.ANTHROPIC_API_KEY ? "LIVE" : "DEMO";
}
