import { expect, test, type Page } from "@playwright/test";
import { shot, signIn, totp } from "./helpers";

async function openFile(page: Page, escrow: string, tab?: string) {
  await page.goto(`/transactions?q=${escrow}`);
  await page.getByRole("link", { name: escrow }).click();
  if (tab) await page.getByRole("link", { name: tab, exact: true }).click();
}

async function completeStepUp(page: Page) {
  const prompt = page.getByRole("alert").filter({ hasText: "Confirm your identity" });
  await expect(prompt).toBeVisible();
  await prompt.getByLabel("Authenticator code").fill(totp());
  await prompt.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Identity confirmed for the next few minutes")).toBeVisible();
}

test.describe("Phase 3: ledger, settlement and payment controls", () => {
  test("finances tab shows the ledger, draft statement and masked bank details", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await openFile(page, "GOE-2026-0101", "Finances");
    await expect(page.getByText("Internal tracking ledger").first()).toBeVisible();
    await expect(page.getByText("$26,250.00").first()).toBeVisible();
    await expect(page.getByText("County property taxes 2026-27 (paid by seller)")).toBeVisible();
    await expect(page.getByText(/Estimated due from buyer/)).toBeVisible();
    await expect(page.getByText(/account ••••7999/)).toBeVisible();
    await expect(page.getByText("000555777999")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reveal full numbers" })).toHaveCount(0);
    await shot(page, "13-finances");
    await page.getByRole("link", { name: "Printable draft" }).click();
    await expect(page.getByText(/Draft estimate — not an official settlement statement/)).toBeVisible();
  });

  test("disbursement: preparer submits, a different person approves with step-up, release is recorded", async ({ page }) => {
    await signIn(page, "accounting@goldenoak.example");
    await openFile(page, "GOE-2026-0104", "Finances");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.locator("li", { hasText: "check to Irena Kowalczyk" }).getByText("Pending approval")).toBeVisible();

    // The preparer cannot approve their own disbursement.
    await page.goto("/approvals?view=pending");
    const own = page.locator("li", { hasText: "Check $524,615.00 to Irena Kowalczyk" });
    await expect(own.getByText("You requested this; someone else must decide it.")).toBeVisible();
    await expect(own.getByRole("button", { name: "Approve" })).toHaveCount(0);

    await signIn(page, "accounting2@goldenoak.example");
    await page.goto("/approvals");
    const item = page.locator("li", { hasText: "Check $524,615.00 to Irena Kowalczyk" });
    await item.getByRole("button", { name: "Approve" }).click();
    await completeStepUp(page);
    await shot(page, "14-step-up");
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("li", { hasText: "Check $524,615.00 to Irena Kowalczyk" })).toHaveCount(0);

    await openFile(page, "GOE-2026-0104", "Finances");
    const d = page.locator("li", { hasText: "check to Irena Kowalczyk" });
    await expect(d.getByText("Approved")).toBeVisible();
    await d.getByText("Record release (executed outside EscrowFlow)").click();
    await d.getByLabel("External reference").fill("CHK-55017");
    page.once("dialog", (dlg) => dlg.accept());
    await d.getByRole("button", { name: "Record release" }).click();
    await expect(page.getByText("Recorded as released")).toBeVisible();
    await expect(page.getByText("Balance held:")).toContainText("$15,385.00");
  });

  test("closing stays blocked while the file ledger is not zero", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await openFile(page, "GOE-2026-0104");
    const close = page.locator("div.rounded-md", { hasText: "Close file" }).first();
    await expect(close.getByText("Escrow file ledger balance is zero")).toBeVisible();
    await expect(close.getByText(/File ledger balance is not zero/)).toBeVisible();
    await expect(close.getByText("Cannot be overridden").first()).toBeVisible();
    await shot(page, "15-closing-blocked");
  });

  test("three-way reconciliation flags an unmatched bank fee", async ({ page }) => {
    await signIn(page, "accounting@goldenoak.example");
    await page.goto("/reconciliation");
    await expect(page.getByText("BANK SERVICE FEE")).toBeVisible();
    await page.getByRole("button", { name: "Run reconciliation" }).click();
    await expect(page.getByText("Reconciliation saved: out of balance.")).toBeVisible();
    await expect(page.getByText("1 unresolved bank item(s)").first()).toBeVisible();
    await expect(page.getByText("Bank vs book -$35.00").first()).toBeVisible();
    await shot(page, "16-reconciliation");
  });
});
