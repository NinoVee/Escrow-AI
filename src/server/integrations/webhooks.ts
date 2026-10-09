import { z } from "zod";
import { db } from "../db";
import { hmacHex, safeEqualHex } from "../crypto";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { log } from "../logger";
import { enqueueJob } from "../jobs/queue";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Inbound webhooks.
 * Signature header:  x-escrowflow-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * - Requests older/newer than 5 minutes are rejected (replay protection).
 * - Events are stored first, unique on (provider, event id): duplicates are
 *   acknowledged without reprocessing.
 * - Processing runs as a durable job and ignores out-of-order events using the
 *   event timestamp and a monotonic status rank.
 * Live vendor webhooks use their own signature schemes; their adapters must
 * verify those natively before calling `storeAndQueue`.
 */

export const WEBHOOK_PROVIDERS = {
  "esign-demo": { secretEnv: "ESIGN_WEBHOOK_SECRET" },
  "recording-demo": { secretEnv: "RECORDING_WEBHOOK_SECRET" },
  "title-demo": { secretEnv: "TITLE_WEBHOOK_SECRET" },
} as const;
export type WebhookProvider = keyof typeof WEBHOOK_PROVIDERS;

const TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

export class WebhookError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function secretFor(provider: string): string {
  const cfg = WEBHOOK_PROVIDERS[provider as WebhookProvider];
  if (!cfg) throw new WebhookError(404, "Unknown webhook provider");
  const secret = (process.env as Record<string, string | undefined>)[cfg.secretEnv];
  if (!secret || secret.length < 16) throw new WebhookError(503, `Webhook not configured (${cfg.secretEnv})`);
  return secret;
}

export function verifySignature(secret: string, header: string | null, rawBody: string, now = Math.floor(Date.now() / 1000)) {
  if (!header) throw new WebhookError(401, "Missing signature");
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) throw new WebhookError(401, "Malformed signature");
  if (Math.abs(now - t) > TOLERANCE_SECONDS) throw new WebhookError(401, "Signature timestamp outside tolerance");
  if (!/^[0-9a-f]{64}$/.test(parts.v1) || !safeEqualHex(parts.v1, hmacHex(secret, `${t}.${rawBody}`))) throw new WebhookError(401, "Invalid signature");
}

const EventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["envelope.status", "recording.status", "title.status"]),
  occurredAt: z.string().datetime(),
  data: z.object({
    externalId: z.string().min(1).max(200),
    status: z.string().min(1).max(40),
    instrumentNumber: z.string().max(100).optional(),
  }),
});
export type WebhookEventBody = z.infer<typeof EventSchema>;

/** Verifies, stores and queues an inbound webhook. Returns quickly for the provider. */
export async function receiveWebhook(provider: string, signatureHeader: string | null, rawBody: string) {
  const secret = secretFor(provider);
  verifySignature(secret, signatureHeader, rawBody);
  let body: WebhookEventBody;
  try {
    body = EventSchema.parse(JSON.parse(rawBody));
  } catch {
    throw new WebhookError(400, "Invalid payload");
  }
  return storeAndQueue(provider, body);
}

export async function storeAndQueue(provider: string, body: WebhookEventBody) {
  try {
    const ev = await db.webhookEvent.create({
      data: { provider, externalEventId: body.id, eventType: body.type, subjectRef: body.data.externalId, occurredAt: new Date(body.occurredAt), payload: body as unknown as Prisma.InputJsonValue },
    });
    await enqueueJob("webhook.process", { webhookEventId: ev.id }, { idempotencyKey: `webhook:${provider}:${body.id}`, maxAttempts: 8 });
    return { duplicate: false, eventId: ev.id };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { duplicate: true, eventId: null };
    throw e;
  }
}

const RANKS: Record<string, Record<string, number>> = {
  "envelope.status": { CREATED: 0, SENT: 1, DELIVERED: 2, COMPLETED: 3, DECLINED: 3, VOIDED: 3 },
  "recording.status": { SUBMITTED: 0, ACCEPTED: 1, RECORDED: 2, REJECTED: 2 },
  "title.status": { SUBMITTED: 0, IN_PROGRESS: 1, REPORT_RECEIVED: 2, CANCELLED: 2 },
};

/** Job handler: applies one stored event if it is new and in order. */
export async function processWebhookEvent(webhookEventId: string) {
  const ev = await db.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!ev) throw new Error("Webhook event not found");
  if (ev.status !== "RECEIVED" && ev.status !== "FAILED") return { status: ev.status };
  const body = ev.payload as unknown as WebhookEventBody;
  const rank = RANKS[body.type];
  if (rank[body.data.status] === undefined) return finish(ev.id, "IGNORED", null, `Unknown status ${body.data.status}`);

  const subject =
    body.type === "envelope.status"
      ? await db.signatureEnvelope.findUnique({ where: { externalId: body.data.externalId } })
      : body.type === "recording.status"
        ? await db.recordingSubmission.findUnique({ where: { externalId: body.data.externalId } })
        : await db.titleOrder.findFirst({ where: { externalRef: body.data.externalId } });
  if (!subject) return finish(ev.id, "IGNORED", null, "No matching record");
  const lastAt = "lastEventAt" in subject ? subject.lastEventAt : (subject as { lastStatusAt: Date | null }).lastStatusAt;
  const currentRank = rank[subject.status] ?? -1;
  if ((lastAt && ev.occurredAt <= lastAt) || rank[body.data.status] < currentRank) {
    return finish(ev.id, "STALE", subject.companyId, `Out of order: current ${subject.status}, event ${body.data.status}`);
  }

  const ctx = systemCtx(subject.companyId, `webhook:${ev.provider}`, "WEBHOOK");
  await db.$transaction(async (client) => {
    if (body.type === "envelope.status") {
      await client.signatureEnvelope.update({ where: { id: subject.id }, data: { status: body.data.status, lastEventAt: ev.occurredAt } });
      if (body.data.status === "COMPLETED") {
        await client.task.create({
          data: { companyId: subject.companyId, transactionId: subject.transactionId, title: "Review documents returned from e-signature (provider reports completed)", description: "Confirm every signature and initial before marking the signing milestone complete. Simulated envelopes are not legally completed e-signatures.", category: "SIGNING", source: "AUTOMATION", required: false },
        });
      }
    } else if (body.type === "recording.status") {
      await client.recordingSubmission.update({ where: { id: subject.id }, data: { status: body.data.status, lastEventAt: ev.occurredAt, instrumentNumber: body.data.instrumentNumber ?? undefined, recordedAt: body.data.status === "RECORDED" ? ev.occurredAt : undefined } });
      if (body.data.status === "RECORDED") {
        await client.task.create({
          data: { companyId: subject.companyId, transactionId: subject.transactionId, title: `Confirm recording${body.data.instrumentNumber ? ` (instrument ${body.data.instrumentNumber})` : ""} against the recorded document`, description: "A provider status message is not proof of recording. Obtain the recorded document or county confirmation before completing the recording milestone.", category: "RECORDING", source: "AUTOMATION" },
        });
      }
    } else {
      await client.titleOrder.update({ where: { id: subject.id }, data: { status: body.data.status as "IN_PROGRESS", lastStatusAt: ev.occurredAt } });
    }
    await client.webhookEvent.update({ where: { id: ev.id }, data: { status: "PROCESSED", companyId: subject.companyId, processedAt: new Date() } });
    await audit(ctx, { action: "webhook.processed", entityType: ev.eventType, entityId: subject.id, transactionId: subject.transactionId, summary: `${ev.provider}: ${body.type} → ${body.data.status}` }, client);
  });
  return { status: "PROCESSED" };
}

async function finish(id: string, status: string, companyId: string | null, note: string) {
  await db.webhookEvent.update({ where: { id }, data: { status, companyId: companyId ?? undefined, error: note, processedAt: new Date() } });
  log.info("webhook not applied", { id, status });
  return { status };
}
