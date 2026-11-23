import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: [
    {
      command: "node tests/browser/server.mjs",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm exec --workspace=apps/web vite -- --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173/mirror/playground",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
