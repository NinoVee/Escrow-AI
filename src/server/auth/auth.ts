import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { db } from "../db";

/**
 * Better Auth: email/password with TOTP second factor.
 * - Public self sign-up is disabled; accounts are created by company admins
 *   (staff) or by portal invitations (external participants).
 * - Sessions are short (8h) and rate limits are stored in the database so they
 *   apply across instances.
 */
export const auth = betterAuth({
  appName: "EscrowFlow",
  baseURL: process.env.APP_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
  },
  session: {
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 30,
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 60,
    customRules: {
      // AUTH_SIGNIN_MAX_ATTEMPTS can be raised for automated local test runs only.
      "/sign-in/email": { window: 300, max: Number(process.env.AUTH_SIGNIN_MAX_ATTEMPTS ?? 10) },
      "/two-factor/verify-totp": { window: 300, max: Number(process.env.AUTH_SIGNIN_MAX_ATTEMPTS ?? 10) },
      "/two-factor/verify-backup-code": { window: 300, max: 5 },
    },
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    cookiePrefix: "escrowflow",
    defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
  },
  plugins: [twoFactor({ issuer: "EscrowFlow" }), nextCookies()],
});

export type Auth = typeof auth;
