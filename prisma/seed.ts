/**
 * Seeds FICTIONAL demo data: two escrow companies (for tenant-isolation demos),
 * staff in every role, external participants, and residential and commercial
 * transactions at different stages. Everything goes through the service layer
 * so workflow rules, provenance and audit records apply exactly as in the app.
 *
 * Run on an empty database: `npm run db:seed` (after `npx prisma migrate deploy`).
 */
import "dotenv/config";
// Run background work in-process while seeding so results exist without a worker.
process.env.JOBS_MODE ??= "inline";
import { db } from "../src/server/db";
import { symmetricEncrypt } from "better-auth/crypto";
import { systemCtx, userCtx, type Ctx } from "../src/server/context";
import { audit } from "../src/server/audit";
import { createUserWithPassword, inviteParticipantToPortal } from "../src/server/services/users";
import { installDefaultTemplates } from "../src/server/services/templates";
import { installDefaultLedger } from "../src/server/services/reconciliation";
import { installDefaultAutomation } from "../src/server/services/automation";
import { addEntitySigner, addParcel, addParticipant, addProperty, createTransaction, requestSignerReview } from "../src/server/services/transactions";
import { createDeadline, createTask, resolveTask } from "../src/server/services/tasks";
import { createDocumentRequest, shareDocument, uploadDocument } from "../src/server/services/documents";
import { addTitleException, linkTitleReport, recordTitleOrder, setExceptionDisposition } from "../src/server/services/title";
import { createThread } from "../src/server/services/messages";
import { changeStatus, transitionStage } from "../src/server/workflow/engine";
import { parseSettings } from "../src/server/settings";
import { DEMO_EXTERNAL, DEMO_PASSWORD, DEMO_STAFF, DEMO_TOTP_SECRET } from "./demo-accounts";
import { commercialPsa, preliminaryTitleReport, residentialPurchaseAgreement, simpleDoc } from "./fixtures";
import type { Role } from "../src/generated/prisma/enums";
import { seedPhase2 } from "./seed-phase2";
import { seedPhase3 } from "./seed-phase3";
import { seedPhase4 } from "./seed-phase4";

async function enableDemoMfa(userId: string) {
  const key = process.env.BETTER_AUTH_SECRET!;
  await db.twoFactor.create({
    data: {
      id: `tf_${userId}`,
      userId,
      secret: await symmetricEncrypt({ key, data: DEMO_TOTP_SECRET }),
      backupCodes: await symmetricEncrypt({ key, data: JSON.stringify(["demo1-codes", "demo2-codes"]) }),
      verified: true,
    },
  });
  await db.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
}

export interface SeedContext {
  companies: Record<string, string>;
  users: Record<string, string>;
  ctx: (key: string) => Ctx;
  tx: Record<string, string>;
}

const DEMO_SLUGS = ["golden-oak-escrow", "harbor-line-escrow"];
const COMPLETED_ACTION = "demo.seed_completed";

/**
 * Seed state: "complete" (skip), "empty" (seed), or "partial" (an earlier run
 * failed part-way). Partial demo data is cleared only when the database holds
 * nothing but the demo companies, so real data is never touched.
 */
async function prepare(): Promise<boolean> {
  const golden = await db.company.findUnique({ where: { slug: DEMO_SLUGS[0] } });
  if (!golden) return true;
  if (await db.auditEvent.findFirst({ where: { companyId: golden.id, action: COMPLETED_ACTION } })) {
    console.log("Demo data already present. Reset the database first (see README) to reseed.");
    return false;
  }
  const others = await db.company.count({ where: { slug: { notIn: DEMO_SLUGS } } });
  if (others > 0) throw new Error("Found partial demo data next to other companies; refusing to clear anything. Remove the demo companies manually, then seed again.");
  console.log("Found partial demo data from an earlier failed run; clearing it before seeding again.");
  // TRUNCATE (not DELETE) because audit and ledger tables reject row deletes by design.
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  return true;
}

async function main() {
  if (!(await prepare())) return;
  console.log("Seeding fictional demo data…");

  const golden = await db.company.create({
    data: { name: "Golden Oak Escrow, Inc. (Demo)", slug: "golden-oak-escrow", settings: parseSettings({ escrowNumberPrefix: "GOE" }) as object },
  });
  const harbor = await db.company.create({
    data: { name: "Harbor Line Escrow Services (Demo)", slug: "harbor-line-escrow", settings: parseSettings({ escrowNumberPrefix: "HLE" }) as object },
  });
  const companies: Record<string, string> = { "golden-oak": golden.id, "harbor-line": harbor.id };

  const users: Record<string, string> = {};
  const roles: Record<string, { role: Role; companyId: string; name: string }> = {};
  for (const s of DEMO_STAFF) {
    const u = await createUserWithPassword(s.email, s.name, DEMO_PASSWORD);
    users[s.key] = u.id;
    roles[s.key] = { role: s.role as Role, companyId: companies[s.company], name: s.name };
    await db.membership.create({ data: { userId: u.id, companyId: companies[s.company], role: s.role as Role } });
    await enableDemoMfa(u.id);
  }
  for (const e of DEMO_EXTERNAL) {
    const u = await createUserWithPassword(e.email, e.name, DEMO_PASSWORD);
    users[e.key] = u.id;
  }
  const ctx = (key: string): Ctx => userCtx({ userId: users[key], companyId: roles[key].companyId, role: roles[key].role, userName: roles[key].name, sessionId: `seed-${key}` });

  await db.$transaction(
    async (client) => {
    await installDefaultTemplates(client, golden.id, users.admin);
    await installDefaultTemplates(client, harbor.id, users.harborAdmin);
    await installDefaultLedger(client, golden.id, { name: "Escrow trust account (demo)", bankName: "Sierra Community Bank (fictional)", last4: "4821" });
    await installDefaultLedger(client, harbor.id, { name: "Escrow trust account (demo)", bankName: "Bayshore Bank (fictional)", last4: "7710" });
    await installDefaultAutomation(client, golden.id);
    await installDefaultAutomation(client, harbor.id);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  const officer = ctx("officer");
  const assistant = ctx("assistant");
  const tx: Record<string, string> = {};

  // -------------------------------------------------------------------------
  // Residential 1: in document collection, portal participants, title report.
  // -------------------------------------------------------------------------
  const r1 = await createTransaction(officer, {
    type: "RESIDENTIAL",
    escrowNumber: "GOE-2026-0101",
    title: "Natarajan purchase",
    officerId: users.officer,
    assistantId: users.assistant,
    property: { street: "1428 Elm Haven Ct", city: "Sacramento", county: "Sacramento", state: "CA", postalCode: "95822", apn: "019-0123-045-0000", legalDescription: "Lot 45, Willow Creek Unit 3 (fictional)" },
    parties: [
      { role: "BUYER", displayName: "Priya Natarajan", email: "buyer@example.com" },
      { role: "SELLER", displayName: "Daniel Whitfield", email: "seller@example.com" },
    ],
    fields: {
      purchasePriceCents: "875,000.00",
      initialDepositCents: "26,250.00",
      loanAmountCents: "700,000.00",
      financingType: "CONVENTIONAL",
      acceptanceDate: "2026-09-28",
      proposedClosingDate: "2026-10-30",
      hasHoa: true,
    },
  });
  tx.r1 = r1.id;
  const r1Parts = await db.participant.findMany({ where: { transactionId: r1.id } });
  const buyerP = r1Parts.find((p) => p.role === "BUYER")!;
  const sellerP = r1Parts.find((p) => p.role === "SELLER")!;
  await addParticipant(assistant, r1.id, { role: "LENDER", displayName: "Elena Marsh", organization: "Cascade Ridge Home Loans (fictional)", email: "loanofficer@example.net" });
  await addParticipant(assistant, r1.id, { role: "BUYER_AGENT", displayName: "Hannah Liu", organization: "Riverbend Realty (fictional)", email: "hliu@riverbend.example" });
  await addParticipant(assistant, r1.id, { role: "LISTING_AGENT", displayName: "Tomás Ibarra", organization: "Capitol Homes Group (fictional)", email: "tibarra@capitolhomes.example" });

  const pa = await uploadDocument(officer, {
    transactionId: r1.id,
    filename: "Natarajan-Whitfield-RPA.pdf",
    title: "Residential purchase agreement",
    category: "PURCHASE_AGREEMENT",
    data: residentialPurchaseAgreement({ buyer: "Priya Natarajan", seller: "Daniel Whitfield", address: "1428 Elm Haven Ct, Sacramento, CA 95822", apn: "019-0123-045-0000", price: "875,000.00", deposit: "26,250.00", loan: "700,000.00", acceptance: "September 28, 2026", closing: "October 30, 2026" }),
  });
  const preapproval = await uploadDocument(officer, { transactionId: r1.id, filename: "preapproval.pdf", title: "Buyer loan pre-approval letter", category: "LENDER_INSTRUCTIONS", data: simpleDoc("LOAN PRE-APPROVAL (FICTIONAL)", ["Borrower: Priya Natarajan", "Lender: Cascade Ridge Home Loans (fictional)", "Approved amount: $700,000.00"]) });
  const payoff = await uploadDocument(officer, { transactionId: r1.id, filename: "payoff.pdf", title: "Seller payoff statement", category: "PAYOFF_STATEMENT", data: simpleDoc("PAYOFF STATEMENT (FICTIONAL)", ["Borrower: Daniel Whitfield", "Lender: Redwood Coast Mortgage (fictional)", "Payoff good through: November 5, 2026", "Total payoff: $398,412.77"]) });
  const prelim = await uploadDocument(officer, { transactionId: r1.id, filename: "prelim.pdf", title: "Preliminary title report", category: "TITLE_REPORT", data: preliminaryTitleReport({ address: "1428 Elm Haven Ct, Sacramento, CA", apn: "019-0123-045-0000", vestee: "Daniel Whitfield, a married man as his sole and separate property" }) });

  // Explicit sharing: both principals see the agreement; each side sees only its own private documents.
  await shareDocument(officer, pa.document.id, buyerP.id);
  await shareDocument(officer, pa.document.id, sellerP.id);
  await shareDocument(officer, preapproval.document.id, buyerP.id);
  await shareDocument(officer, payoff.document.id, sellerP.id);

  // Portal accounts for buyer and seller (existing fictional accounts are linked directly).
  await inviteParticipantToPortal(officer, buyerP.id);
  await inviteParticipantToPortal(officer, sellerP.id);
  await createDocumentRequest(assistant, r1.id, { participantId: buyerP.id, title: "Buyer information statement", category: "OTHER", dueDate: "2026-10-12", description: "Complete and upload the signed buyer information statement." });
  await createDocumentRequest(assistant, r1.id, { participantId: sellerP.id, title: "Seller information statement", category: "OTHER", dueDate: "2026-10-12" });

  for (const key of ["open-file", "upload-contract", "review-contract", "record-deposit", "send-opening-package"]) {
    const t = await db.task.findFirstOrThrow({ where: { transactionId: r1.id, templateKey: key } });
    await resolveTask(key === "review-contract" ? officer : assistant, t.id, { status: "DONE", note: key === "record-deposit" ? "Deposit receipt GOE-R-1001 (fictional)" : undefined, evidenceDocumentId: key === "upload-contract" ? pa.document.id : undefined });
  }
  await transitionStage(officer, r1.id, { toStage: "OPEN", reason: "Instructions received; parties and property confirmed" });
  await transitionStage(officer, r1.id, { toStage: "DOCUMENT_COLLECTION", reason: "Opening tasks complete" });

  const order = await recordTitleOrder(assistant, r1.id, { provider: "Sierra Pine Title Company (fictional)", externalRef: "SPT-55021" });
  await linkTitleReport(assistant, order.id, prelim.document.id);
  const ex1 = await addTitleException(assistant, r1.id, { documentId: prelim.document.id, itemNumber: "1", category: "TAXES", description: "General and special taxes for fiscal year 2026-2027, a lien not yet due or payable.", page: 1 });
  await addTitleException(assistant, r1.id, { documentId: prelim.document.id, itemNumber: "2", category: "DEED_OF_TRUST", description: "Deed of Trust to secure an original indebtedness of $412,000.00 recorded as Instrument No. 2019-0088123.", page: 1 });
  await addTitleException(assistant, r1.id, { documentId: prelim.document.id, itemNumber: "3", category: "EASEMENT", description: "Easement for public utilities over the rear 5 feet.", page: 1 });
  await setExceptionDisposition(officer, ex1.id, "NO_ACTION_NEEDED", "Current-year taxes; prorated at closing");
  for (const key of ["order-title", "upload-title-report"]) {
    const t = await db.task.findFirstOrThrow({ where: { transactionId: r1.id, templateKey: key } });
    await resolveTask(assistant, t.id, { status: "DONE", evidenceDocumentId: key === "upload-title-report" ? prelim.document.id : undefined });
  }
  await createDeadline(officer, r1.id, { title: "Seller disclosures due", type: "CONTRACT", dueDate: "2026-10-05", notes: "Per purchase agreement" });
  await createDeadline(officer, r1.id, { title: "Loan contingency removal", type: "CONTINGENCY", dueDate: "2026-10-15" });
  await createDeadline(officer, r1.id, { title: "Appraisal contingency removal", type: "CONTINGENCY", dueDate: "2026-10-15" });
  await createDeadline(officer, r1.id, { title: "Close of escrow", type: "CLOSING", dueDate: "2026-10-30" });
  await createTask(officer, r1.id, { title: "HOA demand not yet received from Willow Creek HOA", isBlocker: true, dueDate: "2026-10-07" });
  await createThread(officer, r1.id, { subject: "Welcome to your escrow", participantIds: [buyerP.id], body: "Welcome! Your escrow is open. Please complete the buyer information statement in the portal. We will never send wiring instructions by email; call our office at the number on our website to verify any instructions." });
  await createThread(officer, r1.id, { subject: "Seller items", participantIds: [sellerP.id], body: "Please upload your seller information statement. Payoff demand has been ordered from your lender." });

  // -------------------------------------------------------------------------
  // Residential 2: new draft file. Residential 3: on hold.
  // -------------------------------------------------------------------------
  const r2 = await createTransaction(assistant, {
    type: "RESIDENTIAL",
    escrowNumber: "GOE-2026-0102",
    officerId: users.officer2,
    assistantId: users.assistant,
    property: { street: "77 Larkspur Lane", city: "Davis", county: "Yolo", state: "CA", postalCode: "95616" },
    parties: [
      { role: "BUYER", displayName: "Wen & Amara Osei" },
      { role: "SELLER", displayName: "Gloria Fenwick Trust", partyType: "TRUST" },
    ],
    fields: { purchasePriceCents: "612,500.00", financingType: "CASH", proposedClosingDate: "2026-11-14" },
  });
  tx.r2 = r2.id;

  const r3 = await createTransaction(officer, {
    type: "RESIDENTIAL",
    escrowNumber: "GOE-2026-0103",
    officerId: users.officer,
    property: { street: "2501 Quarry Rd Unit 4", city: "Roseville", county: "Placer", state: "CA", postalCode: "95678" },
    parties: [
      { role: "BUYER", displayName: "Leo Brandvold" },
      { role: "SELLER", displayName: "Sunrise Ridge Homes LLC", partyType: "LLC" },
    ],
    fields: { purchasePriceCents: "455,000.00", financingType: "FHA", loanAmountCents: "439,075.00", acceptanceDate: "2026-09-15", proposedClosingDate: "2026-10-20" },
  });
  tx.r3 = r3.id;
  await transitionStage(officer, r3.id, { toStage: "OPEN", reason: "Opened" });
  await changeStatus(officer, r3.id, "HOLD", "Buyer requested pause pending job relocation confirmation");

  // -------------------------------------------------------------------------
  // Commercial: multiple properties/parcels, entity buyer, trust seller,
  // tenants, 1031 exchange, commercial loan. In review stage.
  // -------------------------------------------------------------------------
  const c1 = await createTransaction(officer, {
    type: "COMMERCIAL",
    escrowNumber: "GOE-2026-0201",
    title: "Mission Gateway Business Park",
    officerId: users.officer,
    assistantId: users.assistant,
    property: { street: "4100 Gateway Oaks Dr, Bldg A", city: "Sacramento", county: "Sacramento", state: "CA", postalCode: "95834", propertyType: "OFFICE", apn: "512-040-011", legalDescription: "Parcel 1 of Parcel Map 18-114 (fictional)" },
    parties: [
      { role: "BUYER", displayName: "Bayline Industrial Holdings LLC", partyType: "LLC", email: "manager@bayline.example.org" },
      { role: "SELLER", displayName: "Thornbury Family Trust", partyType: "TRUST" },
    ],
    fields: {
      purchasePriceCents: "14,250,000.00",
      initialDepositCents: "427,500.00",
      loanAmountCents: "9,262,500.00",
      financingType: "COMMERCIAL_LOAN",
      acceptanceDate: "2026-08-20",
      proposedClosingDate: "2026-10-23",
      hasTenants: true,
      is1031Exchange: true,
    },
  });
  tx.c1 = c1.id;
  const props = await db.property.findMany({ where: { transactionId: c1.id } });
  await addParcel(officer, props[0].id, { apn: "512-040-012", legalDescription: "Parcel 2 of Parcel Map 18-114 (fictional)" });
  const bldgB = await addProperty(officer, c1.id, { label: "Building B", street: "4120 Gateway Oaks Dr, Bldg B", city: "Sacramento", county: "Sacramento", postalCode: "95834", propertyType: "INDUSTRIAL" });
  await addParcel(officer, bldgB.id, { apn: "512-040-019" });
  await addParticipant(assistant, c1.id, { role: "LENDER", displayName: "Delta Commerce Bank (fictional)", organization: "Delta Commerce Bank", email: "cre-lending@deltacommerce.example" });
  await addParticipant(assistant, c1.id, { role: "ATTORNEY", displayName: "Ines Carvalho, Esq.", organization: "Carvalho & Stone LLP (fictional)", side: "BUYER" });
  await addParticipant(assistant, c1.id, { role: "EXCHANGE_ACCOMMODATOR", displayName: "Keystone Exchange Services (fictional)" });
  const c1Parts = await db.participant.findMany({ where: { transactionId: c1.id } });
  const llc = c1Parts.find((p) => p.role === "BUYER")!;
  const psa = await uploadDocument(officer, { transactionId: c1.id, filename: "PSA.pdf", title: "Purchase and sale agreement", category: "PURCHASE_AGREEMENT", data: commercialPsa({ buyer: "Bayline Industrial Holdings LLC", seller: "Thornbury Family Trust", price: "14,250,000.00", deposit: "427,500.00", closing: "October 23, 2026", acceptance: "August 20, 2026" }) });
  const opAgreement = await uploadDocument(officer, { transactionId: c1.id, filename: "operating-agreement.pdf", title: "Bayline LLC operating agreement and manager resolution", category: "ENTITY_DOCUMENTS", data: simpleDoc("WRITTEN CONSENT OF MANAGER (FICTIONAL)", ["Bayline Industrial Holdings LLC", "Resolved: Marcus Delgado, Manager, is authorized to execute all documents to acquire Mission Gateway Business Park."]) });
  await uploadDocument(officer, { transactionId: c1.id, filename: "rent-roll.pdf", title: "Certified rent roll", category: "RENT_ROLL", data: simpleDoc("RENT ROLL (FICTIONAL)", ["Suite 100 - Northgate Dental Group - $18,400/mo", "Suite 200 - Vacant", "Bldg B - Arcadia Logistics - $41,250/mo"]) });
  const signer = await addEntitySigner(officer, llc.id, { name: "Marcus Delgado", title: "Manager", authorityDocumentId: opAgreement.document.id });
  await requestSignerReview(assistant, signer.id);
  await shareDocument(officer, psa.document.id, llc.id);
  await inviteParticipantToPortal(officer, llc.id);
  for (const key of ["open-file", "upload-contract", "review-contract", "record-deposit", "confirm-parcels"]) {
    const t = await db.task.findFirstOrThrow({ where: { transactionId: c1.id, templateKey: key } });
    await resolveTask(officer, t.id, { status: "DONE" });
  }
  await transitionStage(officer, c1.id, { toStage: "OPEN", reason: "PSA executed and opening deposit received" });
  await transitionStage(officer, c1.id, { toStage: "DOCUMENT_COLLECTION", reason: "Opening complete" });
  await createDeadline(officer, c1.id, { title: "Due diligence period expires", type: "CONTINGENCY", dueDate: "2026-09-19" });
  await createDeadline(officer, c1.id, { title: "1031 identification period (45 days) - confirm with QI", type: "OTHER", dueDate: "2026-10-04", notes: "Dates must be confirmed by the qualified intermediary." });
  await createDeadline(officer, c1.id, { title: "Closing date", type: "CLOSING", dueDate: "2026-10-23" });

  // -------------------------------------------------------------------------
  // Harbor Line (second tenant) - used to demonstrate isolation.
  // -------------------------------------------------------------------------
  const h1 = await createTransaction(ctx("harborOfficer"), {
    type: "RESIDENTIAL",
    escrowNumber: "HLE-2026-0007",
    officerId: users.harborOfficer,
    property: { street: "9 Pelican Point", city: "Half Moon Bay", county: "San Mateo", state: "CA", postalCode: "94019" },
    parties: [
      { role: "BUYER", displayName: "Coastal Buyer (fictional)" },
      { role: "SELLER", displayName: "Coastal Seller (fictional)" },
    ],
    fields: { purchasePriceCents: "1,995,000.00", proposedClosingDate: "2026-11-20" },
  });
  tx.h1 = h1.id;

  const seedCtx: SeedContext = { companies, users, ctx, tx };
  await seedPhase2(seedCtx);
  await seedPhase3(seedCtx);
  await seedPhase4(seedCtx);
  await audit(systemCtx(golden.id, "seed"), { action: COMPLETED_ACTION, entityType: "Company", entityId: golden.id, summary: "Fictional demo data loaded" });

  console.log("Done. Sign in with any demo account from the README (password: EscrowFlow-Demo-2026!).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
