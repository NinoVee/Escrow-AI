import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { EICAR, expectAppError, makeCompany, makePortalUser, makeTx, makeUser, pdf, resetDb } from "./helpers";
import { getDownloadUrl, shareDocument, uploadDocument } from "@/server/services/documents";
import { signLocalToken, verifyLocalToken } from "@/server/storage/storage";
import { sniffMime } from "@/server/storage/filetype";
import { createThread } from "@/server/services/messages";
import { audit, verifyAuditChain } from "@/server/audit";
import { updateTransactionField } from "@/server/services/transactions";
import { redact } from "@/server/logger";
import { decryptField, encryptField } from "@/server/crypto";
import type { Ctx } from "@/server/context";

describe("document security", () => {
  let officer: Ctx, accounting: Ctx, buyer: Ctx;
  let txId: string, buyerParticipant: string;

  beforeAll(async () => {
    await resetDb();
    const c = await makeCompany("Docs Co");
    officer = await makeUser(c.company.id, "ESCROW_OFFICER");
    accounting = await makeUser(c.company.id, "ACCOUNTING");
    txId = (await makeTx(officer)).id;
    buyerParticipant = (await db.participant.findFirstOrThrow({ where: { transactionId: txId, role: "BUYER" } })).id;
    buyer = await makePortalUser(c.company.id, buyerParticipant);
  });

  it("validates file type by content, not by name", async () => {
    expect(sniffMime(pdf(["x"]))).toBe("application/pdf");
    await expectAppError(uploadDocument(officer, { transactionId: txId, filename: "evil.pdf", data: Buffer.from("<html><script>alert(1)</script></html>") }), "VALIDATION");
    await expectAppError(uploadDocument(officer, { transactionId: txId, filename: "empty.pdf", data: Buffer.alloc(0) }), "VALIDATION");
  });

  it("rejects files over the size limit", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(26 * 1024 * 1024)]);
    await expectAppError(uploadDocument(officer, { transactionId: txId, filename: "big.pdf", data: big }), "VALIDATION");
  });

  it("quarantines infected files and blocks download and sharing", async () => {
    const infected = Buffer.concat([pdf(["looks normal"]), Buffer.from(EICAR)]);
    const res = await uploadDocument(officer, { transactionId: txId, filename: "invoice.pdf", data: infected });
    expect(res.scan.status).toBe("INFECTED");
    expect(res.version.scanStatus).toBe("INFECTED");
    expect(res.version.storageKey.startsWith("quarantine/")).toBe(true);
    await expectAppError(getDownloadUrl(officer, res.version.id), "FORBIDDEN");
    await expectAppError(shareDocument(officer, res.document.id, buyerParticipant), "PRECONDITION_FAILED");
    expect(await db.auditEvent.count({ where: { action: "document.download_denied", entityId: res.version.id } })).toBe(1);
  });

  it("issues short-lived, user-bound, tamper-evident download links", async () => {
    const res = await uploadDocument(officer, { transactionId: txId, filename: "ok.pdf", data: pdf(["fine"]) });
    const { url, ttl } = await getDownloadUrl(officer, res.version.id);
    expect(ttl).toBeLessThanOrEqual(900);
    const token = url.split("/").pop()!;
    const payload = verifyLocalToken(token)!;
    expect(payload.u).toBe(officer.userId);
    expect(payload.k).toBe((await db.documentVersion.findUniqueOrThrow({ where: { id: res.version.id } })).storageKey);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, u: buyer.userId })).toString("base64url");
    expect(verifyLocalToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyLocalToken(`${body}.${"0".repeat(64)}`)).toBeNull();
    const expired = signLocalToken({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 });
    expect(verifyLocalToken(expired)).toBeNull();
    expect(await db.auditEvent.count({ where: { action: "document.download_link_issued", entityId: res.version.id } })).toBe(1);
  });

  it("never shares identity or bank-verification documents through the portal", async () => {
    const res = await uploadDocument(officer, { transactionId: txId, filename: "id.pdf", data: pdf(["ID"]), category: "IDENTITY_VERIFICATION" });
    await expectAppError(shareDocument(officer, res.document.id, buyerParticipant), "FORBIDDEN");
  });

  it("roles without document permissions cannot upload", async () => {
    const manager = await makeUser(officer.companyId, "MANAGER");
    await expectAppError(uploadDocument(manager, { transactionId: txId, filename: "a.pdf", data: pdf(["a"]) }), "FORBIDDEN");
    await uploadDocument(accounting, { transactionId: txId, filename: "a.pdf", data: pdf(["a"]) });
  });

  it("blocks bank details and SSNs in portal messages", async () => {
    await expectAppError(createThread(officer, txId, { subject: "Wire", participantIds: [buyerParticipant], body: "Please wire to routing 121000358 account 000123456789" }), "VALIDATION");
    await expectAppError(createThread(officer, txId, { subject: "ID", participantIds: [buyerParticipant], body: "Your SSN on file is 123-45-6789" }), "VALIDATION");
  });
});

describe("audit trail", () => {
  let officer: Ctx;
  let txId: string;
  beforeAll(async () => {
    await resetDb();
    const c = await makeCompany("Audit Co");
    officer = await makeUser(c.company.id, "ESCROW_OFFICER");
    txId = (await makeTx(officer)).id;
  });

  it("rejects UPDATE and DELETE on audit events at the database level", async () => {
    const e = await db.auditEvent.findFirstOrThrow({ where: { companyId: officer.companyId } });
    await expect(db.auditEvent.update({ where: { id: e.id }, data: { summary: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
  });

  it("rejects edits to stage history", async () => {
    const { transitionStage } = await import("@/server/workflow/engine");
    await transitionStage(officer, txId, { toStage: "OPEN", reason: "open file" });
    const t = await db.stageTransition.findFirstOrThrow({ where: { transactionId: txId } });
    await expect(db.stageTransition.update({ where: { id: t.id }, data: { reason: "rewritten" } })).rejects.toThrow(/append-only/);
  });

  it("detects forged events through the hash chain", async () => {
    expect((await verifyAuditChain(officer.companyId)).ok).toBe(true);
    await db.auditEvent.create({ data: { companyId: officer.companyId, actorType: "USER", action: "forged", entityType: "X", summary: "inserted directly", hash: "deadbeef", prevHash: null } });
    const res = await verifyAuditChain(officer.companyId);
    expect(res.ok).toBe(false);
  });

  it("records actor, tenant, file, action and version", async () => {
    await updateTransactionField(officer, txId, "purchasePriceCents", "510,000.00", { reason: "Counter accepted" });
    const e = await db.auditEvent.findFirstOrThrow({ where: { action: "transaction.field_changed", transactionId: txId } });
    expect(e).toMatchObject({ companyId: officer.companyId, actorUserId: officer.userId, entityType: "Transaction", entityId: txId });
    expect(e.entityVersion).toBeGreaterThan(1);
  });

  it("audit details and logs are redacted", async () => {
    const ev = await audit(officer, { action: "test.redaction", entityType: "Test", summary: "redaction check", details: { accountNumber: "000123456789", note: "acct 9876543210123" } });
    const details = ev.details as Record<string, string>;
    expect(details.accountNumber).toBe("[redacted]");
    expect(details.note).not.toContain("9876543210123");
    expect(JSON.stringify(redact({ password: "hunter2", routingNumber: "121000358", ok: "fine" }))).toBe('{"password":"[redacted]","routingNumber":"[redacted]","ok":"fine"}');
  });
});

describe("field provenance", () => {
  let officer: Ctx;
  let txId: string;
  beforeAll(async () => {
    await resetDb();
    const c = await makeCompany("Prov Co");
    officer = await makeUser(c.company.id, "ESCROW_OFFICER");
    txId = (await makeTx(officer)).id;
  });

  it("keeps full history and exactly one current value", async () => {
    await updateTransactionField(officer, txId, "purchasePriceCents", "505,000.00", { reason: "Amendment 1" });
    await updateTransactionField(officer, txId, "purchasePriceCents", "499,999.99", { reason: "Amendment 2" });
    const rows = await db.fieldProvenance.findMany({ where: { transactionId: txId, fieldPath: "purchasePriceCents" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.value)).toEqual(["50000000", "50500000", "49999999"]);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: txId } })).purchasePriceCents).toBe(49_999_999n);
  });

  it("provenance values cannot be rewritten", async () => {
    const row = await db.fieldProvenance.findFirstOrThrow({ where: { transactionId: txId, isCurrent: false } });
    await expect(db.fieldProvenance.update({ where: { id: row.id }, data: { value: "1" } })).rejects.toThrow(/immutable/);
    await expect(db.fieldProvenance.update({ where: { id: row.id }, data: { isCurrent: true } })).rejects.toThrow();
  });

  it("rejects malformed and floating-point money input", async () => {
    await expectAppError(updateTransactionField(officer, txId, "purchasePriceCents", "12.345", { reason: "bad" }), "VALIDATION");
    await expectAppError(updateTransactionField(officer, txId, "purchasePriceCents", 1000.1 as unknown as string, { reason: "float" }), "VALIDATION");
    await expectAppError(updateTransactionField(officer, txId, "proposedClosingDate", "2026-02-30", { reason: "bad date" }), "VALIDATION");
  });
});

describe("field encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptField("000123456789");
    const b = encryptField("000123456789");
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe("000123456789");
    const parts = a.split(":");
    parts[4] = Buffer.from("tampered").toString("base64");
    expect(() => decryptField(parts.join(":"))).toThrow();
  });
});
