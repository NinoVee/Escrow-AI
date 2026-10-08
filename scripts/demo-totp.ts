/**
 * Prints the current TOTP code for the FICTIONAL demo staff accounts.
 * Development only: refuses to run when NODE_ENV=production.
 */
import "dotenv/config";
import { auth } from "../src/server/auth/auth";
import { DEMO_TOTP_SECRET } from "../prisma/demo-accounts";

if (process.env.NODE_ENV === "production") {
  console.error("demo:totp is disabled in production.");
  process.exit(1);
}
const { code } = await auth.api.generateTOTP({ body: { secret: DEMO_TOTP_SECRET } });
const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`Demo authenticator code: ${code} (valid ~${remaining}s)`);
process.exit(0);
