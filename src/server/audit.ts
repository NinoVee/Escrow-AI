import { db, type Tx } from "./db";
import type { Ctx } from "./context";
import { canonicalJson, sha256Hex } from "./crypto";
import { redact } from "./logger";
import type { Prisma } from "@/generated/prisma/client";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  entityVersion?: number | null;
  transactionId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * Append an audit event. Events are hash-chained per company: each event's
 * hash covers its content and the previous event's hash, so edits or gaps are
 * detectable by `verifyAuditChain`. A transaction-scoped advisory lock keeps the
 * chain linear under concurrency.
 *
 * Pass `tx` to write the audit row in the same database transaction as the
 * change it describes, so the change and its record commit or roll back together.
 */
export async function audit(ctx: Ctx, input: AuditInput, tx?: Tx) {
  const run = async (client: Tx) => {
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + ctx.companyId}))`;
    const prev = await client.auditEvent.findFirst({
      where: { companyId: ctx.companyId },
      orderBy: { seq: "desc" },
      select: { hash: true },
    });
    const createdAt = new Date();
    const details = input.details ? (redactDetails(input.details) as Prisma.InputJsonValue) : undefined;
    const body = {
      companyId: ctx.companyId,
      actorType: ctx.actorType,
      actorUserId: ctx.userId,
      transactionId: input.transactionId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityVersion: input.entityVersion ?? null,
      summary: input.summary,
      details: details ?? null,
      createdAt: createdAt.toISOString(),
    };
    const prevHash = prev?.hash ?? null;
    const hash = sha256Hex((prevHash ?? "genesis") + canonicalJson(body));
    return client.auditEvent.create({
      data: {
        companyId: ctx.companyId,
        actorType: ctx.actorType,
        actorUserId: ctx.userId,
        actorLabel: ctx.userName ?? null,
        transactionId: input.transactionId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityVersion: input.entityVersion ?? null,
        summary: input.summary,
        details,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
        prevHash,
        hash,
        createdAt,
      },
    });
  };
  if (tx) return run(tx);
  return db.$transaction((t) => run(t));
}

/** Details are redacted the same way as logs; audit rows never hold secrets. */
function redactDetails(details: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(redact(details)));
}

/** Recompute the chain for a company. Returns the first broken event, if any. */
export async function verifyAuditChain(companyId: string) {
  const events = await db.auditEvent.findMany({ where: { companyId }, orderBy: { seq: "asc" } });
  let prevHash: string | null = null;
  for (const e of events) {
    const body = {
      companyId: e.companyId,
      actorType: e.actorType,
      actorUserId: e.actorUserId,
      transactionId: e.transactionId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      entityVersion: e.entityVersion,
      summary: e.summary,
      details: e.details ?? null,
      createdAt: e.createdAt.toISOString(),
    };
    const expected = sha256Hex((prevHash ?? "genesis") + canonicalJson(body));
    if (e.prevHash !== prevHash || e.hash !== expected) {
      return { ok: false as const, brokenAt: e.id, count: events.length };
    }
    prevHash = e.hash;
  }
  return { ok: true as const, count: events.length };
}
