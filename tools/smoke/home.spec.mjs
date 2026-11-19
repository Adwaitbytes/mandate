import { expect, test } from "@playwright/test";

// SMOKE_TITLE and SMOKE_TEXT are case-insensitive regular expressions set per repo in preview-e2e.yml.
const title = new RegExp(process.env.SMOKE_TITLE ?? ".", "i");
const text = process.env.SMOKE_TEXT ? new RegExp(process.env.SMOKE_TEXT, "i") : undefined;

test("home page loads, shows its headline and logs no errors", async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  const response = await page.goto("/", { waitUntil: "load" });
  expect(response, "no response for /").not.toBeNull();
  expect(response?.status(), `GET / answered ${response?.status()}`).toBeLessThan(400);

  await expect(page).toHaveTitle(title);
  await expect(page.locator("h1").first()).toBeVisible();
  if (text) await expect(page.getByText(text).first()).toBeVisible();

  // Hydration mismatches and failed client fetches surface a moment after load.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  expect(errors).toEqual([]);
});
