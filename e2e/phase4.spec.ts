import { createHmac, randomUUID } from "node:crypto";
import { config } from "dotenv";
import { expect, test, type Page } from "@playwright/test";
import { shot, signIn } from "./helpers";

config();

async function openFile(page: Page, escrow: string, tab?: string) {
  await page.goto(`/transactions?q=${escrow}`);
  await page.getByRole("link", { name: escrow }).click();
  if (tab) await page.getByRole("link", { name: tab, exact: true }).click();
}

function sign(secret: string, body: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

test.describe("Phase 4: integrations, automation and jobs", () => {
  test("integrations page labels every integration with its mode", async ({ page }) => {
    await signIn(page, "admin@goldenoak.example");
    await page.goto("/settings/integrations");
    await expect(page.getByRole("heading", { name: "E-signature" })).toBeVisible();
    await expect(page.getByText("A simulated signature is NOT a legally completed e-signature.")).toBeVisible();
    await expect(page.getByText("Payment execution is disabled. CSV statement import is available for reconciliation.")).toBeVisible();
    await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Not configured", { exact: true }).first()).toBeVisible();
    await shot(page, "17-integrations");

    // Vendor integrations cannot be switched to Live without an implemented adapter.
    const title = page.locator("form", { has: page.getByLabel("Mode for Title orders") });
    await title.getByLabel("Mode for Title orders").selectOption("LIVE");
    await title.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/cannot be set to live/)).toBeVisible();
  });

  test("automation rules are off or in review mode; jobs page shows background work", async ({ page }) => {
    await signIn(page, "admin@goldenoak.example");
    await page.goto("/settings/automation");
    await expect(page.getByText("Remind agents of upcoming deadlines")).toBeVisible();
    await expect(page.getByText("Drafts for review").first()).toBeVisible();
    await expect(page.getByText("Not approved").first()).toBeVisible();
    await shot(page, "18-automation");
    await page.goto("/settings/jobs");
    await expect(page.getByText("document.process").first()).toBeVisible();
    await expect(page.getByText("esign-demo").first()).toBeVisible();
    await shot(page, "19-jobs");
  });

  test("email needs approval by someone else, and is blocked while external sending is off", async ({ page }) => {
    await signIn(page, "assistant@goldenoak.example");
    await openFile(page, "GOE-2026-0101", "Communications");
    await expect(page.getByText("External sending is off")).toBeVisible();
    await page.getByText("Compose email").click();
    await page.locator("form", { has: page.locator("#ob-subj") }).getByRole("checkbox", { name: /Priya Natarajan/ }).check();
    const subject = `Open items ${randomUUID().slice(0, 6)}`;
    const compose = page.locator("form", { has: page.locator("#ob-subj") });
    await compose.getByLabel("Subject").fill(subject);
    await compose.getByLabel("Message").fill("Please upload the insurance binder through your portal.");
    await page.getByRole("button", { name: "Save draft" }).click();
    const item = page.locator("li", { hasText: subject });
    await expect(item.getByText("Draft", { exact: true })).toBeVisible();
    await item.getByRole("button", { name: "Request approval to send" }).click();
    await expect(page.locator("li", { hasText: subject }).getByText("Pending approval")).toBeVisible();

    // Sensitive content is blocked before it can be sent.
    if (!(await page.locator("#ob-subj").isVisible())) await page.getByText("Compose email").click();
    await compose.getByRole("checkbox", { name: /Priya Natarajan/ }).check();
    await compose.getByLabel("Subject").fill("Wire details");
    await compose.getByLabel("Message").fill("Wire to routing 121000358 account 000123456789");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Saved as blocked/)).toBeVisible();

    await signIn(page, "officer@goldenoak.example");
    await page.goto("/approvals");
    const approval = page.locator("li", { hasText: `Send email: "${subject}"` });
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("li", { hasText: `Send email: "${subject}"` })).toHaveCount(0);
    await openFile(page, "GOE-2026-0101", "Communications");
    const sent = page.locator("li", { hasText: subject });
    await expect(sent.getByText("Blocked", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(sent.getByText(/External sending is off/)).toBeVisible();
    await shot(page, "20-email-blocked");
  });

  test("demo e-signature and recording advance only through signed provider events", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await openFile(page, "GOE-2026-0101", "Title");
    const envelope = page.locator("li", { hasText: "Escrow instructions for signature (demo)" });
    await expect(envelope.getByText("Delivered")).toBeVisible();
    await expect(envelope.getByText("Simulated")).toBeVisible();
    await envelope.getByRole("button", { name: "Simulate next event" }).click();
    await expect(page.locator("li", { hasText: "Escrow instructions for signature (demo)" }).getByText("Completed")).toBeVisible({ timeout: 15_000 });
    await shot(page, "21-esign");
    await openFile(page, "GOE-2026-0101", "Tasks");
    await expect(page.getByText("Review documents returned from e-signature (provider reports completed)")).toBeVisible();

    await openFile(page, "GOE-2026-0101", "Property");
    await expect(page.getByText("Results are simulated with fictional owners", { exact: false })).toBeVisible();
    await expect(page.getByText("SIMULATED OWNER (demo)", { exact: false }).first()).toBeVisible();
  });

  test("webhook endpoint rejects unsigned requests and de-duplicates signed ones", async ({ request }) => {
    const body = JSON.stringify({ id: `e2e-${randomUUID()}`, type: "envelope.status", occurredAt: new Date().toISOString(), data: { externalId: "DEMO-ENV-UNKNOWN", status: "DELIVERED" } });
    const unsigned = await request.post("/api/webhooks/esign-demo", { data: body, headers: { "content-type": "application/json" } });
    expect(unsigned.status()).toBe(401);
    const bad = await request.post("/api/webhooks/esign-demo", { data: body, headers: { "content-type": "application/json", "x-escrowflow-signature": sign("not-the-secret-value", body) } });
    expect(bad.status()).toBe(401);
    const secret = process.env.ESIGN_WEBHOOK_SECRET!;
    const ok = await request.post("/api/webhooks/esign-demo", { data: body, headers: { "content-type": "application/json", "x-escrowflow-signature": sign(secret, body) } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ received: true, duplicate: false });
    const dup = await request.post("/api/webhooks/esign-demo", { data: body, headers: { "content-type": "application/json", "x-escrowflow-signature": sign(secret, body) } });
    expect(await dup.json()).toMatchObject({ received: true, duplicate: true });
    const unknown = await request.post("/api/webhooks/nope", { data: body, headers: { "x-escrowflow-signature": sign(secret, body) } });
    expect(unknown.status()).toBe(404);
  });

  test("assistants cannot reach automation or jobs; mobile layout of integrations", async ({ page }) => {
    await signIn(page, "assistant@goldenoak.example");
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: "Automation" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Jobs" })).toHaveCount(0);
    const res = await page.goto("/settings/jobs");
    expect(res?.status()).not.toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/integrations");
    await expect(page.getByRole("heading", { name: "E-recording" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, "22-integrations-mobile");
  });
});
