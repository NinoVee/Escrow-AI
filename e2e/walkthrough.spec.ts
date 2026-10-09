import { expect, test, type Page } from "@playwright/test";
import { shot, signIn } from "./helpers";

const TABS = ["Overview", "Parties", "Property", "Documents", "Tasks", "Deadlines", "Title", "Finances", "Communications", "Approvals", "Activity"];

async function checkPage(page: Page) {
  await expect(page.getByText(/Application error|Internal Server Error|This page could not be found/)).toHaveCount(0);
  const culprits = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth - W <= 1) return [];
    const out: string[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      if (el.getBoundingClientRect().right <= W + 1) return;
      for (let a = el.parentElement; a; a = a.parentElement) if (["auto", "hidden", "scroll"].includes(getComputedStyle(a).overflowX)) return;
      if (el.parentElement && el.parentElement.getBoundingClientRect().right > W + 1) return;
      out.push(`<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 80)}"> ${(el.textContent ?? "").trim().slice(0, 50)}`);
    });
    return out.length ? out.slice(0, 5) : ["(unknown element)"];
  });
  expect(culprits, `horizontal overflow on ${page.url()}`).toEqual([]);
}

async function walkFile(page: Page, escrow: string) {
  await page.goto(`/transactions?q=${escrow}`);
  await page.getByRole("link", { name: escrow }).click();
  await page.waitForURL(/\/transactions\/[a-z0-9]+$/);
  const base = page.url();
  for (const tab of TABS) {
    const path = tab === "Overview" ? "" : `/${tab.toLowerCase()}`;
    const res = await page.goto(base + path);
    expect(res?.status(), `${escrow} ${tab}`).toBe(200);
    await checkPage(page);
  }
  return base;
}

test.describe("Walkthrough: every screen renders, empty states, responsive layout", () => {
  test("commercial file: all tabs at desktop and phone width", async ({ page }) => {
    await signIn(page, "officer@goldenoak.example");
    const base = await walkFile(page, "GOE-2026-0201");
    await page.setViewportSize({ width: 390, height: 844 });
    await walkFile(page, "GOE-2026-0201");
    for (const path of ["/approvals", "/approvals?view=decided", "/reconciliation", "/dashboard"]) {
      await page.goto(path);
      await checkPage(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/title`);
    await expect(page.getByText("Provider title order")).toBeVisible();
  });

  test("residential file: all tabs at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "officer@goldenoak.example");
    await walkFile(page, "GOE-2026-0101");
  });

  test("a sparse file shows empty states rather than errors (tablet width)", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await signIn(page, "officer@harborline.example");
    await page.goto("/transactions?q=HLE-2026-0007");
    await page.getByRole("link", { name: "HLE-2026-0007" }).click();
    await page.waitForURL(/\/transactions\/[a-z0-9]+$/);
    const base = page.url();
    for (const [path, text] of [
      ["/communications", "No emails"],
      ["/title", "No provider orders."],
      ["/property", "No lookups yet"],
    ] as const) {
      await page.goto(base + path);
      await expect(page.getByText(text).first()).toBeVisible();
      await checkPage(page);
    }
    await shot(page, "23-empty-states-tablet");
  });

  test("staff settings and queues render for each role", async ({ page }) => {
    for (const email of ["admin@goldenoak.example", "manager@goldenoak.example", "accounting@goldenoak.example", "assistant@goldenoak.example"]) {
      await signIn(page, email);
      for (const path of ["/dashboard", "/transactions", "/approvals", "/notifications", "/settings", "/settings/templates", "/settings/integrations"]) {
        const res = await page.goto(path);
        expect(res?.status(), `${email} ${path}`).toBe(200);
        await checkPage(page);
      }
    }
  });

  test("portal at phone width shows only the participant's own file", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "seller@example.com", { mfa: false });
    await page.goto("/portal");
    await checkPage(page);
    await expect(page.getByText("GOE-2026-0101").first()).toBeVisible();
    await expect(page.getByText("GOE-2026-0201")).toHaveCount(0);
    await page.goto("/dashboard");
    expect(page.url()).not.toMatch(/\/dashboard$/);
  });
});
