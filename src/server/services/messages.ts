import { db } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound } from "../errors";
import { audit } from "../audit";
import { loadTransaction, myParticipantIds } from "./access";
import { detectSensitiveContent } from "../sensitive";

/**
 * Secure portal messaging. Threads have an explicit member list of
 * participants; an external user sees only threads that include one of their
 * participant records. Internal-only threads never include participants.
 */

export async function listThreads(ctx: Ctx, transactionId: string) {
  await loadTransaction(ctx, transactionId);
  if (isExternal(ctx)) {
    const mine = await myParticipantIds(ctx, transactionId);
    return db.messageThread.findMany({
      where: { companyId: ctx.companyId, transactionId, internalOnly: false, members: { some: { participantId: { in: mine } } } },
      include: { messages: { orderBy: { createdAt: "asc" } }, members: { include: { participant: { select: { displayName: true, role: true } } } } },
      orderBy: { createdAt: "desc" },
    });
  }
  return db.messageThread.findMany({
    where: { companyId: ctx.companyId, transactionId },
    include: { messages: { orderBy: { createdAt: "asc" } }, members: { include: { participant: { select: { displayName: true, role: true } } } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function createThread(ctx: Ctx, transactionId: string, input: { subject: string; participantIds: string[]; internalOnly?: boolean; body: string }) {
  requirePermission(ctx, "comms.draft");
  const authorId = requireUser(ctx);
  if (!input.subject?.trim() || !input.body?.trim()) throw invalid("Subject and message are required.");
  const tx = await loadTransaction(ctx, transactionId);
  const internalOnly = Boolean(input.internalOnly);
  const ids = internalOnly ? [] : [...new Set(input.participantIds)];
  if (!internalOnly && ids.length === 0) throw invalid("Choose at least one participant, or mark the thread internal.");
  const participants = await db.participant.findMany({ where: { id: { in: ids }, transactionId: tx.id, companyId: ctx.companyId } });
  if (participants.length !== ids.length) throw invalid("All recipients must be participants in this file.");
  const sensitive = detectSensitiveContent(input.body);
  if (!internalOnly && sensitive.length) throw invalid(`Portal messages to participants cannot contain ${sensitive.join(", ")}. Use the controlled process instead.`);
  return db.$transaction(async (client) => {
    const thread = await client.messageThread.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        subject: input.subject.trim(),
        internalOnly,
        createdById: authorId,
        members: { create: ids.map((participantId) => ({ participantId })) },
        messages: { create: { companyId: ctx.companyId, authorUserId: authorId, body: input.body.trim() } },
      },
    });
    await audit(ctx, { action: "message.thread_created", entityType: "MessageThread", entityId: thread.id, transactionId: tx.id, summary: `Message thread "${thread.subject}" started${internalOnly ? " (internal)" : ` with ${participants.map((p) => p.displayName).join(", ")}`}` }, client);
    return thread;
  });
}

export async function postMessage(ctx: Ctx, threadId: string, body: string) {
  const authorId = requireUser(ctx);
  if (!body?.trim()) throw invalid("Message is empty.");
  if (body.length > 10_000) throw invalid("Message is too long.");
  const thread = await db.messageThread.findFirst({ where: { id: threadId, companyId: ctx.companyId }, include: { members: true } });
  if (!thread) throw notFound("Thread");
  await loadTransaction(ctx, thread.transactionId);
  let authorParticipantId: string | null = null;
  if (isExternal(ctx)) {
    const mine = await myParticipantIds(ctx, thread.transactionId);
    const member = thread.members.find((m) => mine.includes(m.participantId));
    if (thread.internalOnly || !member) throw notFound("Thread");
    authorParticipantId = member.participantId;
  } else {
    requirePermission(ctx, "comms.draft");
    const sensitive = detectSensitiveContent(body);
    if (!thread.internalOnly && sensitive.length) throw invalid(`Messages to participants cannot contain ${sensitive.join(", ")}.`);
  }
  return db.$transaction(async (client) => {
    const m = await client.message.create({ data: { companyId: ctx.companyId, threadId: thread.id, authorUserId: authorId, authorParticipantId, body: body.trim() } });
    await audit(ctx, { action: "message.posted", entityType: "Message", entityId: m.id, transactionId: thread.transactionId, summary: `Message posted in "${thread.subject}"` }, client);
    return m;
  });
}
