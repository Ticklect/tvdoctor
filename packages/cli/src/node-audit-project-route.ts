import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { TestCommandRequest } from "./cli.js";

/** The configured authenticated route must survive startup and every reset. */
export class ProjectRouteMismatchError extends Error {
  constructor() {
    super("The configured project route changed during browser restoration.");
  }
}

/**
 * The browser may redirect a protected route onto another authenticated page.
 * Successful focus assertions or a reproducible UI fingerprint alone do not
 * establish that findings belong to the original project route. Fail closed
 * without serializing the browser's actual (potentially private) location.
 */
export function requireOriginalProjectRoute(driver: PlaywrightWebDriver, request: TestCommandRequest): void {
  if (request.requireTargetRoute !== true) return;
  try {
    if (new URL(driver.getPage().url()).href === new URL(request.target).href) return;
  } catch {
    // Neither browser URL nor exception details are safe to emit in reports.
  }
  throw new ProjectRouteMismatchError();
}
