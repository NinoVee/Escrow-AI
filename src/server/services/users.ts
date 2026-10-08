import { randomBytes } from "node:crypto";
import { db } from "../db";
import { auth } from "../auth/auth";
import { isExternal, requirePermission, requireUser, systemCtx, type Ctx } from "../context";
import { conflict, forbidden, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import { loadTransaction } from "./access";
import type { Role } from "@/generated/prisma/enums";

const INVITE_TTL_DAYS = 7;

/**
 * Creates a Better Auth user with an email/password credential. Public sign-up
 * is disabled, so this is the only account-creation path (used by invitations
 * and the seed script).
 */
export async function createUserWithPassword(email: string, name: string, password: string) {
  if (password.length < 12) throw invalid("Passwords must be at least 12 characters.");
  const actx = await auth.$context;
  const normalized = email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email: normalized } });
  if (existing) throw conflict("An account with that email already exists.");
  const user = await actx.internalAdapter.createUser({ email: normalized, name: name.trim(), emailVerified: true }, { method: "admin" });
  await actx.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await actx.password.hash(password),
  });
  return user;
}

function newToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

export async function listMembers(ctx: Ctx) {
  requirePermission(ctx, "users.manage");
  return db.membership.findMany({
    where: { companyId: ctx.companyId },
    include: { user: { select: { id: true, name: true, email: true, twoFactorEnabled: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
}

export async function listStaff(ctx: Ctx) {
  if (isExternal(ctx)) return [];
  return db.membership.findMany({
    where: { companyId: ctx.companyId, status: "ACTIVE", role: { not: "EXTERNAL" } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}

/** Returns the one-time invite link. The token itself is never stored. */
export async function inviteStaff(ctx: Ctx, input: { email: string; name: string; role: Role }) {
  requirePermission(ctx, "users.manage");
  const userId = requireUser(ctx);
  if (input.role === "EXTERNAL") throw invalid("Use portal invitations for external participants.");
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !input.name?.trim()) throw invalid("Name and a valid email are required.");
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    const m = await db.membership.findUnique({ where: { userId_companyId: { userId: existing.id, companyId: ctx.companyId } } });
    if (m) throw conflict("That person is already a member of this company.");
  }
  const { token, tokenHash } = newToken();
  await db.$transaction(async (client) => {
    const inv = await client.invitation.create({
      data: { companyId: ctx.companyId, email, name: input.name.trim(), role: input.role, tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000), createdById: userId },
    });
    await audit(ctx, { action: "user.invited", entityType: "Invitation", entityId: inv.id, summary: `Invited ${email} as ${input.role.toLowerCase().replaceAll("_", " ")}` }, client);
  });
  return { inviteUrl: `/invite/${token}` };
}

/**
 * Grants portal access to a participant. Existing accounts are linked
 * directly; otherwise a one-time invitation link is returned for delivery
 * through an approved channel (external email is off by default).
 */
export async function inviteParticipantToPortal(ctx: Ctx, participantId: string) {
  requirePermission(ctx, "portal.invite");
  const userId = requireUser(ctx);
  const p = await db.participant.findFirst({ where: { id: participantId, companyId: ctx.companyId } });
  if (!p) throw notFound("Participant");
  await loadTransaction(ctx, p.transactionId);
  if (!p.email) throw precondition("Add an email address for this participant first.");
  const email = p.email.toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    const staff = await db.membership.findFirst({ where: { userId: existing.id, companyId: ctx.companyId, role: { not: "EXTERNAL" } } });
    if (staff) throw forbidden("Company staff accounts cannot be given participant portal access in the same company.");
    await db.$transaction(async (client) => {
      await client.membership.upsert({
        where: { userId_companyId: { userId: existing.id, companyId: ctx.companyId } },
        create: { userId: existing.id, companyId: ctx.companyId, role: "EXTERNAL" },
        update: { status: "ACTIVE" },
      });
      await client.participant.update({ where: { id: p.id }, data: { userId: existing.id, portalAccess: true, invitedAt: new Date() } });
      await audit(ctx, { action: "portal.access_granted", entityType: "Participant", entityId: p.id, transactionId: p.transactionId, summary: `Portal access granted to ${p.displayName} (existing account)` }, client);
    });
    return { linkedExisting: true as const };
  }
  const { token, tokenHash } = newToken();
  await db.$transaction(async (client) => {
    await client.invitation.updateMany({ where: { participantId: p.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const inv = await client.invitation.create({
      data: { companyId: ctx.companyId, email, name: p.displayName, role: "EXTERNAL", participantId: p.id, tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000), createdById: userId },
    });
    await client.participant.update({ where: { id: p.id }, data: { invitedAt: new Date() } });
    await audit(ctx, { action: "portal.invited", entityType: "Invitation", entityId: inv.id, transactionId: p.transactionId, summary: `Portal invitation created for ${p.displayName}` }, client);
  });
  return { linkedExisting: false as const, inviteUrl: `/invite/${token}` };
}

export async function revokePortalAccess(ctx: Ctx, participantId: string, reason: string) {
  requirePermission(ctx, "portal.invite");
  const p = await db.participant.findFirst({ where: { id: participantId, companyId: ctx.companyId } });
  if (!p) throw notFound("Participant");
  await db.$transaction(async (client) => {
    await client.participant.update({ where: { id: p.id }, data: { portalAccess: false } });
    await client.invitation.updateMany({ where: { participantId: p.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(ctx, { action: "portal.access_revoked", entityType: "Participant", entityId: p.id, transactionId: p.transactionId, summary: `Portal access revoked for ${p.displayName}`, details: { reason } }, client);
  });
}

export async function lookupInvitation(token: string) {
  const inv = await db.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) return null;
  const company = await db.company.findUnique({ where: { id: inv.companyId }, select: { name: true } });
  const existingUser = await db.user.findUnique({ where: { email: inv.email }, select: { id: true } });
  return { email: inv.email, name: inv.name, role: inv.role, companyName: company?.name ?? "", hasAccount: Boolean(existingUser) };
}

export async function acceptInvitation(token: string, password: string) {
  const inv = await db.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw invalid("This invitation is invalid or has expired.");
  const existing = await db.user.findUnique({ where: { email: inv.email }, select: { id: true, name: true } });
  const user = existing ?? (await createUserWithPassword(inv.email, inv.name, password));
  const ctx = { ...systemCtx(inv.companyId, "invitation"), userId: user.id, actorType: "USER" as const, userName: user.name };
  await db.$transaction(async (client) => {
    const claimed = await client.invitation.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (claimed.count !== 1) throw invalid("This invitation was already used.");
    await client.membership.upsert({
      where: { userId_companyId: { userId: user.id, companyId: inv.companyId } },
      create: { userId: user.id, companyId: inv.companyId, role: inv.role },
      update: { status: "ACTIVE" },
    });
    if (inv.participantId) {
      await client.participant.update({ where: { id: inv.participantId }, data: { userId: user.id, portalAccess: true } });
    }
    await audit(ctx, { action: "user.invitation_accepted", entityType: "Invitation", entityId: inv.id, summary: `${inv.email} accepted invitation` }, client);
  });
  return { email: inv.email };
}

export async function setMembership(ctx: Ctx, membershipId: string, input: { role?: Role; status?: "ACTIVE" | "DISABLED" }) {
  requirePermission(ctx, "users.manage");
  const m = await db.membership.findFirst({ where: { id: membershipId, companyId: ctx.companyId } });
  if (!m) throw notFound("Member");
  if (m.userId === ctx.userId && (input.status === "DISABLED" || (input.role && input.role !== m.role))) {
    throw precondition("You cannot change your own role or disable yourself.");
  }
  if (m.role === "COMPANY_ADMIN" && (input.status === "DISABLED" || (input.role && input.role !== "COMPANY_ADMIN"))) {
    const admins = await db.membership.count({ where: { companyId: ctx.companyId, role: "COMPANY_ADMIN", status: "ACTIVE" } });
    if (admins <= 1) throw precondition("A company must keep at least one active administrator.");
  }
  if (input.role === "EXTERNAL" || (m.role === "EXTERNAL" && input.role)) throw invalid("External participant roles are managed from the transaction.");
  await db.$transaction(async (client) => {
    await client.membership.update({ where: { id: m.id }, data: input });
    if (input.status === "DISABLED") await client.session.deleteMany({ where: { userId: m.userId } });
    await audit(ctx, { action: "user.membership_changed", entityType: "Membership", entityId: m.id, summary: `Membership updated`, details: input }, client);
  });
}
