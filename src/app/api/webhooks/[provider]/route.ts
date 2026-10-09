import { NextResponse } from "next/server";
import { receiveWebhook, WebhookError } from "@/server/integrations/webhooks";
import { log } from "@/server/logger";

const MAX_BODY = 256 * 1024;

/** Inbound provider callbacks. Authenticated by HMAC signature, never by session. */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) throw new WebhookError(413, "Payload too large");
    const res = await receiveWebhook(provider, request.headers.get("x-escrowflow-signature"), raw);
    return NextResponse.json({ received: true, duplicate: res.duplicate });
  } catch (e) {
    if (e instanceof WebhookError) {
      log.warn("webhook rejected", { provider, status: e.status, reason: e.message });
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    log.error("webhook error", { provider, error: e });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
