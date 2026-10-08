import { expect, test } from "@playwright/test";
import { shot, signIn } from "./helpers";
import { residentialPurchaseAgreement } from "../prisma/fixtures";

test.describe("Phase 2: document assistant", () => {
  test("officer reviews a conflicting amendment value and accepts it with confirmation", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/transactions?q=GOE-2026-0101");
    await page.getByRole("link", { name: "GOE-2026-0101" }).click();
    await page.getByRole("link", { name: "Documents", exact: true }).click();
    await expect(page.getByText(/Proposed changes awaiting review/)).toBeVisible();
    const card = page.locator("li", { hasText: "Proposed closing date" }).filter({ hasText: "Conflict" }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText("Accepted value:")).toBeVisible();
    await shot(page, "09-proposals");
    await card.getByRole("checkbox").check();
    await card.getByRole("button", { name: "Accept" }).click();
    await expect(page.locator("li", { hasText: "Proposed closing date" }).filter({ hasText: "Conflict" })).toHaveCount(0);
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    const row = page.locator("tr", { hasText: "Proposed closing date" });
    await expect(row.getByRole("cell", { name: "Nov 6, 2026", exact: true })).toBeVisible();
    await expect(row.getByText("Document extraction").first()).toBeVisible();
    await expect(row.getByText(/Amendment No. 1/).first()).toBeVisible();
  });

  test("document review screen shows cited text and injection warnings", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/transactions?q=GOE-2026-0102");
    await page.getByRole("link", { name: "GOE-2026-0102" }).click();
    await page.getByRole("link", { name: "Documents", exact: true }).click();
    await page.locator("section", { hasText: "Miscellaneous addendum" }).getByRole("link", { name: /Review & extraction/ }).click();
    await expect(page.getByText("This document contains text that looks like instructions to an AI system")).toBeVisible();
    await expect(page.getByText("Low confidence").first()).toBeVisible();
    await expect(page.locator("mark").first()).toBeVisible();
    await shot(page, "10-document-review-injection");
  });

  test("assistant answers with citations", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/transactions?q=GOE-2026-0101");
    await page.getByRole("link", { name: "GOE-2026-0101" }).click();
    await page.getByRole("link", { name: "Documents", exact: true }).click();
    await page.getByLabel("Question").fill("When does the loan contingency expire?");
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.getByText(/Residential purchase agreement, p\. 2/).first()).toBeVisible();
    await shot(page, "11-assistant");
  });

  test("start a file from an uploaded agreement and accept proposals", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    await page.goto("/transactions/new");
    const pdf = residentialPurchaseAgreement({ buyer: "Rosa Quintero", seller: "Henry Adeyemi", address: "58 Sycamore Bend, Elk Grove, CA 95624", apn: "132-0400-017-0000", price: "689,000.00", deposit: "20,670.00", loan: "551,200.00", acceptance: "October 2, 2026", closing: "November 13, 2026" });
    await page.getByLabel("Executed agreement (PDF or image)").setInputFiles({ name: "Quintero-RPA.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByRole("button", { name: "Upload and extract" }).click();
    await expect(page).toHaveURL(/\/documents\/[a-z0-9]+$/);
    await expect(page.getByText(/Proposals from this document/)).toBeVisible();
    const price = page.locator("li", { hasText: "Purchase price" }).first();
    await expect(price.getByText("$689,000.00", { exact: true })).toBeVisible();
    await price.getByRole("button", { name: "Accept" }).click();
    await expect(page.locator("li", { hasText: "Purchase price" }).filter({ hasText: "Proposed" })).toHaveCount(0);
    const buyer = page.locator("li", { hasText: "Rosa Quintero" }).first();
    await buyer.getByRole("button", { name: "Accept" }).click();
    await expect(page.locator("li", { hasText: "Rosa Quintero" }).filter({ hasText: "Proposed" })).toHaveCount(0);
    await shot(page, "12-intake-review");
  });

  test("assistants see proposals but cannot accept them", async ({ page }) => {
    await signIn(page, "assistant@goldenoak.example");
    await page.goto("/transactions?q=GOE-2026-0101");
    await page.getByRole("link", { name: "GOE-2026-0101" }).click();
    await page.getByRole("link", { name: "Documents", exact: true }).click();
    await expect(page.getByText(/Proposed changes awaiting review/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
  });
});
