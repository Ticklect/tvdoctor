import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(packageDirectory, "../../fixtures/broken-streaming-web");

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  retries: 0,
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4179",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 4179 --strictPort",
    cwd: fixtureDirectory,
    port: 4179,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
