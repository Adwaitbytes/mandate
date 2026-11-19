import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SMOKE_URL;
if (!baseURL) throw new Error("SMOKE_URL is not set (the deployment to test, e.g. https://example.vercel.app)");

// Protected Vercel previews answer 401 without this header; the secret comes from the project's
// Deployment Protection settings ("Protection Bypass for Automation").
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  timeout: 45_000,
  // A cold preview can time out on its first request; a retry is the honest fix, the test itself is strict.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    extraHTTPHeaders: bypass ? { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
