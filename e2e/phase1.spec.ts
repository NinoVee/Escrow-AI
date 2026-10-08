import { expect, test } from "@playwright/test";
import { shot, signIn } from "./helpers";

test.describe("Phase 1 walkthrough", () => {
  test("officer signs in with MFA and sees the dashboard", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Open blockers").first()).toBeVisible();
    await expect(page.getByText("HOA demand not yet received").first()).toBeVisible();
    await shot(page, "01-dashboard");
  });

  test("wrong TOTP code is rejected", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("officer@goldenoak.example");
    await page.getByLabel("Password").fill("EscrowFlow-Demo-2026!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("Authenticator code").fill("000000");
    await page.getByRole("button", { name: "Verify and sign in" }).click();
    await expect(page.getByText("That code was not accepted.")).toBeVisible();
  });

  test("transaction list search and filters", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/transactions");
    await expect(page.getByRole("link", { name: "GOE-2026-0101" })).toBeVisible();
    await expect(page.getByRole("link", { name: "HLE-2026-0007" })).toHaveCount(0);
    await page.getByPlaceholder("Search…").fill("Elm Haven");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("link", { name: "GOE-2026-0101" })).toBeVisible();
    await expect(page.getByRole("link", { name: "GOE-2026-0201" })).toHaveCount(0);
    await page.goto("/transactions?type=COMMERCIAL");
    await expect(page.getByRole("link", { name: "GOE-2026-0201" })).toBeVisible();
    await page.goto("/transactions?q=zzzz-no-match");
    await expect(page.getByText("No transactions match these filters")).toBeVisible();
    await page.goto("/transactions");
    await shot(page, "02-transactions");
  });

  test("workspace shows prerequisites, provenance and tabs", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/transactions");
    await page.getByRole("link", { name: "GOE-2026-0101" }).click();
    await expect(page.getByRole("heading", { name: "GOE-2026-0101" })).toBeVisible();
    await expect(page.getByText("Move to Review")).toBeVisible();
    await expect(page.getByText("Not ready").first()).toBeVisible();
    await expect(page.getByText("Purchase price")).toBeVisible();
    await shot(page, "03-workspace-overview");
    for (const tab of ["Parties", "Property", "Documents", "Tasks", "Deadlines", "Title", "Communications", "Approvals", "Activity"]) {
      await page.getByRole("navigation", { name: "Transaction sections" }).getByRole("link", { name: tab, exact: true }).click();
      await expect(page.getByRole("link", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
    }
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await expect(page.getByText("HOA demand not yet received from Willow Creek HOA")).toBeVisible();
    await shot(page, "04-workspace-tasks");
    await page.getByRole("link", { name: "Documents", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Residential purchase agreement" })).toBeVisible();
    await shot(page, "05-workspace-documents");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /Download v1/ }).first().click()]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    await page.getByRole("link", { name: "Title", exact: true }).click();
    await expect(page.getByText("Title tracking only")).toBeVisible();
    await shot(page, "06-workspace-title");
  });

  test("create a transaction manually", async ({ page }) => {
    await signIn(page, "assistant@goldenoak.example");
    await page.goto("/transactions/new");
    await page.getByLabel("Street address").fill("310 Juniper Row");
    await page.getByLabel("City").fill("Folsom");
    await page.getByLabel("Buyer name").fill("E2E Buyer");
    await page.getByLabel("Seller name").fill("E2E Seller");
    await page.getByLabel("Purchase price").fill("720,000.00");
    await page.getByLabel("Proposed closing date").fill("2026-12-15");
    await page.getByRole("button", { name: "Create transaction" }).click();
    await expect(page).toHaveURL(/\/transactions\/[a-z0-9]+$/);
    await expect(page.getByText("$720,000.00")).toBeVisible();
    await expect(page.getByText("Escrow officer assigned")).toBeVisible();
  });

  test("approval inbox enforces separation of duties", async ({ page }) => {
    await signIn(page, "assistant@goldenoak.example");
    await page.goto("/approvals?view=pending");
    await expect(page.getByText("You requested this; someone else must decide it.").first()).toBeVisible();
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/approvals");
    const item = page.locator("li", { hasText: "Signing authority: Marcus Delgado" });
    await expect(item).toBeVisible();
    await shot(page, "07-approvals");
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("li", { hasText: "Signing authority: Marcus Delgado" })).toHaveCount(0);
    await page.goto("/approvals?view=decided");
    await expect(page.locator("li", { hasText: "Signing authority: Marcus Delgado" }).getByText(/Approved by Morgan Ellison/)).toBeVisible();
  });

  test("other tenants and portal users cannot open a staff file", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/transactions?q=GOE-2026-0101");
    const href = await page.getByRole("link", { name: "GOE-2026-0101" }).getAttribute("href");
    await signIn(page, "officer@harborline.example");
    const res = await page.goto(href!);
    expect(res?.status()).toBe(404);
    await signIn(page, "buyer@example.com", { mfa: false });
    await page.goto(href!);
    await expect(page).toHaveURL(/\/portal/);
  });

  test("buyer portal shows only the buyer's items (mobile)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "buyer@example.com", { mfa: false });
    await expect(page).toHaveURL(/\/portal$/);
    await page.getByText("Escrow GOE-2026-0101").click();
    await expect(page.getByText("Buyer loan pre-approval letter")).toBeVisible();
    await expect(page.getByText("Residential purchase agreement", { exact: true })).toBeVisible();
    await expect(page.getByText("Seller payoff statement")).toHaveCount(0);
    await expect(page.getByText("Seller items")).toHaveCount(0);
    await expect(page.getByText("Buyer information statement", { exact: true })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    await shot(page, "08-portal-mobile");
  });

  test("seller portal does not show buyer documents", async ({ page }) => {
    await signIn(page, "seller@example.com", { mfa: false });
    await page.getByText("Escrow GOE-2026-0101").click();
    await expect(page.getByText("Seller payoff statement")).toBeVisible();
    await expect(page.getByText("Buyer loan pre-approval letter")).toHaveCount(0);
    await expect(page.getByText("Welcome to your escrow")).toHaveCount(0);
  });
});
