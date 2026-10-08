import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { expectAppError, makeCompany, makePortalUser, makeTx, makeUser, pdf, resetDb } from "./helpers";
import { listTransactions, updateTransactionField } from "@/server/services/transactions";
import { loadTransaction } from "@/server/services/access";
import { getDownloadUrl, listDocuments, shareDocument, revokeShare, uploadDocument } from "@/server/services/documents";
import { createThread, listThreads, postMessage } from "@/server/services/messages";
import { decideApproval } from "@/server/services/approvals";
import { listTasksForTest } from "./queries";
import type { Ctx } from "@/server/context";

describe("tenant and participant isolation", () => {
  let officerA: Ctx, officerB: Ctx, buyer: Ctx, seller: Ctx, otherBuyer: Ctx;
  let txA: string, txA2: string, txB: string;
  let sharedDocId: string, buyerPrivateVersion: string, sellerPrivateVersion: string, internalVersion: string;
  let buyerParticipant: string, sellerParticipant: string;

  beforeAll(async () => {
    await resetDb();
    const a = await makeCompany("Alpha Escrow");
    const b = await makeCompany("Beta Escrow");
    officerA = await makeUser(a.company.id, "ESCROW_OFFICER");
    officerB = await makeUser(b.company.id, "ESCROW_OFFICER");
    txA = (await makeTx(officerA)).id;
    txA2 = (await makeTx(officerA)).id;
    txB = (await makeTx(officerB)).id;

    const parts = await db.participant.findMany({ where: { transactionId: txA } });
    buyerParticipant = parts.find((p) => p.role === "BUYER")!.id;
    sellerParticipant = parts.find((p) => p.role === "SELLER")!.id;
    buyer = await makePortalUser(a.company.id, buyerParticipant);
    seller = await makePortalUser(a.company.id, sellerParticipant);
    const otherParts = await db.participant.findMany({ where: { transactionId: txA2 } });
    otherBuyer = await makePortalUser(a.company.id, otherParts.find((p) => p.role === "BUYER")!.id);

    const shared = await uploadDocument(officerA, { transactionId: txA, filename: "pa.pdf", data: pdf(["Purchase agreement"]), category: "PURCHASE_AGREEMENT" });
    sharedDocId = shared.document.id;
    await shareDocument(officerA, sharedDocId, buyerParticipant);
    await shareDocument(officerA, sharedDocId, sellerParticipant);
    const bp = await uploadDocument(officerA, { transactionId: txA, filename: "preapproval.pdf", data: pdf(["Buyer pre-approval"]) });
    await shareDocument(officerA, bp.document.id, buyerParticipant);
    buyerPrivateVersion = bp.version.id;
    const sp = await uploadDocument(officerA, { transactionId: txA, filename: "payoff.pdf", data: pdf(["Seller payoff"]) });
    await shareDocument(officerA, sp.document.id, sellerParticipant);
    sellerPrivateVersion = sp.version.id;
    internalVersion = (await uploadDocument(officerA, { transactionId: txA, filename: "internal.pdf", data: pdf(["Internal note"]) })).version.id;
  });

  it("staff cannot see or change another company's transactions", async () => {
    const listB = await listTransactions(officerB);
    expect(listB.map((t) => t.id)).toEqual([txB]);
    await expectAppError(loadTransaction(officerB, txA), "NOT_FOUND");
    await expectAppError(updateTransactionField(officerB, txA, "purchasePriceCents", "1.00", { reason: "attack" }), "NOT_FOUND");
    await expectAppError(listDocuments(officerB, txA), "NOT_FOUND");
    await expectAppError(listTasksForTest(officerB, txA), "NOT_FOUND");
  });

  it("staff cannot download another company's documents", async () => {
    await expectAppError(getDownloadUrl(officerB, internalVersion), "NOT_FOUND");
  });

  it("external participants only see their own transaction", async () => {
    expect((await listTransactions(buyer)).map((t) => t.id)).toEqual([txA]);
    await expectAppError(loadTransaction(buyer, txA2), "NOT_FOUND");
    await expectAppError(loadTransaction(otherBuyer, txA), "NOT_FOUND");
    await expectAppError(loadTransaction(buyer, txB), "NOT_FOUND");
  });

  it("buyers and sellers do not see each other's private documents", async () => {
    const buyerDocs = (await listDocuments(buyer, txA)).map((d) => d.id);
    const sellerDocs = (await listDocuments(seller, txA)).map((d) => d.id);
    expect(buyerDocs).toContain(sharedDocId);
    expect(sellerDocs).toContain(sharedDocId);
    expect(buyerDocs).toHaveLength(2);
    expect(sellerDocs).toHaveLength(2);
    await expectAppError(getDownloadUrl(buyer, sellerPrivateVersion), "NOT_FOUND");
    await expectAppError(getDownloadUrl(seller, buyerPrivateVersion), "NOT_FOUND");
    await expectAppError(getDownloadUrl(buyer, internalVersion), "NOT_FOUND");
    const ok = await getDownloadUrl(buyer, buyerPrivateVersion);
    expect(ok.url).toMatch(/^\/api\/files\//);
  });

  it("external participants never receive share lists or scan details", async () => {
    const docs = await listDocuments(buyer, txA);
    for (const d of docs) {
      expect(d.shares).toEqual([]);
      for (const v of d.versions) expect(v.scanDetail).toBeNull();
    }
  });

  it("participant uploads are private to the uploader and staff", async () => {
    const up = await uploadDocument(buyer, { transactionId: txA, filename: "bank-letter.pdf", data: pdf(["Buyer upload"]) });
    expect((await listDocuments(buyer, txA)).map((d) => d.id)).toContain(up.document.id);
    expect((await listDocuments(seller, txA)).map((d) => d.id)).not.toContain(up.document.id);
    await expectAppError(getDownloadUrl(seller, up.version.id), "NOT_FOUND");
  });

  it("participants cannot upload into a transaction they are not part of", async () => {
    await expectAppError(uploadDocument(otherBuyer, { transactionId: txA, filename: "x.pdf", data: pdf(["x"]) }), "NOT_FOUND");
  });

  it("revoking a share removes access immediately", async () => {
    await revokeShare(officerA, sharedDocId, sellerParticipant);
    expect((await listDocuments(seller, txA)).map((d) => d.id)).not.toContain(sharedDocId);
    await shareDocument(officerA, sharedDocId, sellerParticipant);
  });

  it("revoking portal access removes all access", async () => {
    await db.participant.update({ where: { id: sellerParticipant }, data: { portalAccess: false } });
    await expectAppError(loadTransaction(seller, txA), "NOT_FOUND");
    expect(await listTransactions(seller)).toHaveLength(0);
    await db.participant.update({ where: { id: sellerParticipant }, data: { portalAccess: true } });
  });

  it("message threads are visible only to their members", async () => {
    const t = await createThread(officerA, txA, { subject: "Buyer only", participantIds: [buyerParticipant], body: "Hello buyer" });
    const internal = await createThread(officerA, txA, { subject: "Internal", participantIds: [], internalOnly: true, body: "staff only" });
    expect((await listThreads(buyer, txA)).map((x) => x.id)).toEqual([t.id]);
    expect(await listThreads(seller, txA)).toHaveLength(0);
    await expectAppError(postMessage(seller, t.id, "let me in"), "NOT_FOUND");
    await expectAppError(postMessage(buyer, internal.id, "let me in"), "NOT_FOUND");
    await postMessage(buyer, t.id, "Thanks");
  });

  it("external users and other tenants cannot decide approvals", async () => {
    const { requestSignerReview, addEntitySigner, addParticipant } = await import("@/server/services/transactions");
    const llc = await addParticipant(officerA, txA, { role: "BUYER", partyType: "LLC", displayName: "Test Holdings LLC" });
    const doc = await uploadDocument(officerA, { transactionId: txA, filename: "op.pdf", data: pdf(["resolution"]), category: "ENTITY_DOCUMENTS" });
    const signer = await addEntitySigner(officerA, llc.id, { name: "Pat Signer", title: "Manager", authorityDocumentId: doc.document.id });
    const approval = await requestSignerReview(officerA, signer.id);
    await expectAppError(decideApproval(buyer, approval.id, "APPROVED"), "NOT_FOUND");
    await expectAppError(decideApproval(officerB, approval.id, "APPROVED"), "NOT_FOUND");
  });
});
