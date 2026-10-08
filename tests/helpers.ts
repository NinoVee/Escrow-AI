import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { userCtx, type Ctx } from "@/server/context";
import { createUserWithPassword } from "@/server/services/users";
import { installDefaultTemplates } from "@/server/services/templates";
import { createTransaction, type CreateTransactionInput } from "@/server/services/transactions";
import { parseSettings } from "@/server/settings";
import type { Role } from "@/generated/prisma/enums";
import { AppError } from "@/server/errors";
import { buildPdf } from "@/lib/simple-pdf";

/** Truncates every application table. TRUNCATE bypasses the append-only row triggers by design (tests only). */
export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
}

export async function makeCompany(name = "Test Escrow Co") {
  const company = await db.company.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${randomUUID().slice(0, 6)}`, settings: parseSettings({}) as object } });
  const admin = await makeUser(company.id, "COMPANY_ADMIN");
  await db.$transaction((client) => installDefaultTemplates(client, company.id, admin.userId));
  return { company, admin };
}

export async function makeUser(companyId: string, role: Role, name?: string): Promise<Ctx> {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.example`;
  const user = await createUserWithPassword(email, name ?? `${role} user`, "correct-horse-battery-staple");
  await db.membership.create({ data: { userId: user.id, companyId, role } });
  return userCtx({ userId: user.id, companyId, role, userName: name ?? role, sessionId: `sess-${user.id}` });
}

export async function grantStepUp(ctx: Ctx) {
  await db.stepUpVerification.create({ data: { userId: ctx.userId!, sessionId: ctx.sessionId!, success: true, expiresAt: new Date(Date.now() + 10 * 60_000) } });
}

export async function makeTx(ctx: Ctx, input: Partial<CreateTransactionInput> = {}) {
  return createTransaction(ctx, {
    type: "RESIDENTIAL",
    officerId: ctx.role === "ESCROW_OFFICER" ? ctx.userId! : undefined,
    property: { street: "1 Test Way", city: "Sacramento", state: "CA", propertyType: "SINGLE_FAMILY" },
    parties: [
      { role: "BUYER", displayName: "Test Buyer", partyType: "INDIVIDUAL", email: "" },
      { role: "SELLER", displayName: "Test Seller", partyType: "INDIVIDUAL", email: "" },
    ],
    fields: { purchasePriceCents: "500,000.00", proposedClosingDate: "2026-12-01", financingType: "CASH" },
    ...input,
  });
}

/** Links a new external user to a participant with portal access. */
export async function makePortalUser(companyId: string, participantId: string): Promise<Ctx> {
  const ctx = await makeUser(companyId, "EXTERNAL");
  await db.participant.update({ where: { id: participantId }, data: { userId: ctx.userId, portalAccess: true } });
  return ctx;
}

export function pdf(lines: string[]) {
  return buildPdf([lines], "test");
}

export async function expectAppError(p: Promise<unknown>, code: AppError["code"]) {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code !== code) throw new Error(`Expected ${code} but got ${e.code}: ${e.message}`);
      return e;
    }
    throw e;
  }
  throw new Error(`Expected ${code} but the call succeeded`);
}

export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
