import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/control-plane/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command:
      "pnpm --filter @responder/control-plane exec vite --host 127.0.0.1 --port 4173 --strictPort",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://127.0.0.1:4173",
  },
});
