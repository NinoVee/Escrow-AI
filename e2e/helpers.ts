import { createHmac } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { DEMO_PASSWORD, DEMO_TOTP_SECRET } from "../prisma/demo-accounts";

/** RFC 6238 TOTP (HMAC-SHA1, 30s, 6 digits) over the UTF-8 demo secret. */
export function totp(secret = DEMO_TOTP_SECRET, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", Buffer.from(secret, "utf8")).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export async function signIn(page: Page, email: string, opts: { mfa?: boolean } = { mfa: true }) {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (opts.mfa !== false) {
    await expect(page.getByLabel("Authenticator code")).toBeVisible();
    await page.getByLabel("Authenticator code").fill(totp());
    await page.getByRole("button", { name: "Verify and sign in" }).click();
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: true });
}
