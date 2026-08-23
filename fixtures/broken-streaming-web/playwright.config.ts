import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  timeout: 15_000,
  use: {
    baseURL: "http://127.0.0.1:4178",
    viewport: { width: 1280, height: 720 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "vite --host 127.0.0.1 --port 4178 --strictPort",
    port: 4178,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
