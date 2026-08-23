import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(packageDirectory, "../../fixtures/broken-streaming-web");

export default defineConfig({
  testDir: "./integration",
  fullyParallel: false,
  retries: 1,
  timeout: 150_000,
  use: {
    baseURL: "http://127.0.0.1:4183",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 4183 --strictPort",
    cwd: fixtureDirectory,
    port: 4183,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
