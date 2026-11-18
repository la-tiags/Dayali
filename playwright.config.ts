import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 40000,
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  },
  webServer: {
    command: "pnpm dev --mode screenshots",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  projects: [
    {
      name: "webkit-1280",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "webkit-900",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 900, height: 640 },
      },
    },
  ],
});
