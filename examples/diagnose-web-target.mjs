#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const target = process.argv[2];
const output = resolve(process.argv[3] ?? "artifacts/web-target-diagnosis.json");
if (!target) {
  console.error("Usage: node examples/diagnose-web-target.mjs <url> [output]");
  process.exit(2);
}

const { PlaywrightWebDriver } = await import("@tvdoctor/driver-web");
const driver = new PlaywrightWebDriver({
  navigationTimeoutMs: 25_000,
  settle: {
    noResponseGraceMs: 500,
    quietWindowMs: 120,
    timeoutMs: 2_000,
    ambientChurnEscape: true,
  },
});

function flatten(nodes, result = []) {
  for (const node of nodes ?? []) {
    result.push(node);
    flatten(node.children, result);
  }
  return result;
}

async function snapshotAfterNavigation(currentDriver) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const snapshot = await currentDriver.snapshot();
      if (snapshot.uiTree.status === "available") return snapshot;
      lastError = new Error(snapshot.uiTree.status === "unavailable"
        ? snapshot.uiTree.reason
        : "UI tree was unavailable");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw lastError ?? new Error("The target did not produce an available UI tree.");
}

async function framesAfterNavigation(currentDriver) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await currentDriver.getPage().evaluate(() => Array.from(
        document.querySelectorAll("iframe"),
      ).map((frame) => {
        let access;
        try {
          access = frame.contentDocument ? "same-origin" : "inaccessible";
        } catch {
          access = "cross-origin";
        }
        return {
          title: frame.getAttribute("title"),
          visible: frame.getBoundingClientRect().width > 0
            && frame.getBoundingClientRect().height > 0,
          access,
        };
      }));
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw lastError ?? new Error("Frame inspection failed.");
}

try {
  try {
    await driver.launch({ id: "target-diagnosis", launchUri: target });
  } catch (error) {
    const diagnosis = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      target,
      loaded: false,
      launchFailure: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
    await mkdir(resolve(output, ".."), { recursive: true });
    const text = `${JSON.stringify(diagnosis, null, 2)}\n`;
    await writeFile(output, text);
    console.log(text);
    await driver.close();
    process.exit(0);
  }

  const before = await snapshotAfterNavigation(driver);
  const beforeFocus = before.focusedElement.status === "available"
    ? before.focusedElement.value
    : null;
  const right = await driver.press("RIGHT");
  const after = await snapshotAfterNavigation(driver);
  const afterFocus = after.focusedElement.status === "available"
    ? after.focusedElement.value
    : null;
  const nodes = before.uiTree.status === "available" ? flatten(before.uiTree.value) : [];
  const frames = await framesAfterNavigation(driver);
  const logs = await driver.getLogs();
  const network = driver.getNetworkSnapshot();
  const diagnosis = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    target,
    loaded: before.uiTree.status === "available",
    dom: {
      elementCount: before.uiTree.status === "available"
        ? before.uiTreeMetadata.status === "available"
          ? before.uiTreeMetadata.value.domElementCount
          : null
        : null,
      capturedSemanticNodes: before.uiTree.status === "available"
        ? before.uiTreeMetadata.status === "available"
          ? before.uiTreeMetadata.value.capturedNodeCount
          : null
        : null,
      truncated: before.uiTree.status === "available"
        ? before.uiTreeMetadata.status === "available"
          ? before.uiTreeMetadata.value.truncated
          : null
        : null,
    },
    focus: {
      initial: beforeFocus === null ? "none" : (beforeFocus.stableId ?? beforeFocus.name ?? beforeFocus.role),
      afterRight: afterFocus === null ? "none" : (afterFocus.stableId ?? afterFocus.name ?? afterFocus.role),
      changed: beforeFocus?.stableId !== afterFocus?.stableId,
      rightOutcome: right.outcome,
      rightMessage: right.message ?? null,
    },
    interactive: {
      semanticNodes: nodes.length,
      visibleFocusable: nodes.filter((node) => node.visible === true && node.focusable === true).length,
      samples: nodes.filter((node) => node.visible === true && node.focusable === true)
        .slice(0, 24)
        .map((node) => ({
          stableId: node.stableId,
          role: node.role,
          name: node.name,
        })),
      modalNodes: nodes.filter((node) => node.modal === true).map((node) => ({
        stableId: node.stableId,
        role: node.role,
        name: node.name,
      })),
      consentTermsObserved: /\b(?:consent|cookies?|privacy choice|privacy notice|privacy settings)\b/iu.test(
        nodes.map((node) => `${node.name ?? ""} ${node.text ?? ""}`).join(" "),
      ),
    },
    iframes: frames,
    errors: {
      consoleErrors: logs.filter((entry) => entry.source === "console" && entry.level === "error"),
      pageErrors: logs.filter((entry) => entry.source === "page-error"),
      browserErrors: logs.filter((entry) => entry.source === "browser"),
    },
    network: {
      requestsStarted: network.requestsStarted,
      requestsSucceeded: network.requestsSucceeded,
      requestsFailed: network.requestsFailed,
      requestsInFlight: network.requestsInFlight,
      failedSamples: network.recentEntries.filter((entry) => entry.outcome === "failed").slice(0, 20),
    },
  };
  await mkdir(resolve(output, ".."), { recursive: true });
  const text = `${JSON.stringify(diagnosis, null, 2)}\n`;
  await writeFile(output, text);
  console.log(text);
} finally {
  await driver.close();
}
