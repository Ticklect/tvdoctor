import type {
  ActionResult,
  DriverOperationOptions,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
} from "@tvdoctor/protocol";
import { focusedWebEntry, normaliseWebSemanticText } from "@tvdoctor/pack-web";
import { idlessFocusedSafeLink } from "./node-audit-navigation.js";

/** Only semantic UI-navigation activations; never arbitrary buttons, forms or links. */
const SAFE_NAVIGATION_LABELS = new Set([
  "menu", "open menu", "close menu", "show menu", "hide menu",
  "open navigation", "close navigation", "show navigation",
  "dismiss", "dismiss dialog", "close", "close dialog", "maybe later",
]);

function openModal(snapshot: StateSnapshot): boolean {
  if (snapshot.uiTree.status !== "available") return false;
  const pending = [...snapshot.uiTree.value];
  let visits = 0;
  while (pending.length > 0 && visits < 2_048) {
    const node = pending.pop();
    if (node === undefined) break;
    visits += 1;
    if (node.visible === true && node.modal === true
      && (node.role === "dialog" || node.role === "alertdialog")) return true;
    pending.push(...node.children);
  }
  return false;
}

function safeEnter(snapshot: StateSnapshot, safeLinks: boolean): boolean {
  const entry = focusedWebEntry(snapshot);
  // Discovery ONLY: idless links cannot pass safeKeyboardDriver's normal
  // SELECT policy. The opt-in link runtime applies a separate live DOM gate.
  if (entry === null) return safeLinks && idlessFocusedSafeLink(snapshot) !== null;
  const node = entry.node;
  if (node.visible !== true || node.enabled !== true || node.focusable !== true
    || node.selectionState !== null || node.valueNow !== null) return false;
  // Actual href/mutation safety is checked again by the opt-in live Playwright
  // document-link observer before any SELECT can reach a browser driver.
  if (node.role === "link") return safeLinks;
  if (node.role !== "button") return false;
  const label = normaliseWebSemanticText(node.name ?? node.text);
  if (!SAFE_NAVIGATION_LABELS.has(label)) return false;
  // A generic page button named "close" may dismiss a purchase or account
  // workflow. Restrict modal dismissals to a dialog ancestor, or menu controls
  // to a navigation landmark with explicit navigational semantics.
  const insideModal = entry.ancestors.some((ancestor) => ancestor.modal === true
    && ancestor.visible === true && (ancestor.role === "dialog" || ancestor.role === "alertdialog"));
  if (insideModal && (label === "dismiss" || label === "dismiss dialog"
    || label === "close" || label === "close dialog" || label === "maybe later")) return true;
  return entry.ancestors.some((ancestor) => ancestor.role === "navigation")
    && /\b(?:menu|navigation)\b/u.test(label);
}

/** State-aware keyboard action policy; preserves pure Tab-only default. */
export function keyboardActionsForState(snapshot: StateSnapshot, options: { readonly safeLinks?: boolean } = {}): readonly RemoteKey[] {
  const actions: RemoteKey[] = ["TAB", "SHIFT_TAB"];
  if (openModal(snapshot)) actions.push("BACK");
  if (safeEnter(snapshot, options.safeLinks === true)) actions.push("SELECT");
  return actions;
}

/** Recheck the live target immediately before Enter; a restored tab can mutate. */
export function safeKeyboardDriver(driver: TVDoctorDriver): TVDoctorDriver {
  return {
    capabilities: (options) => driver.capabilities(options),
    snapshot: (options) => driver.snapshot(options),
    ...(driver.reset === undefined ? {} : { reset: (strategy: Parameters<NonNullable<TVDoctorDriver["reset"]>>[0], options?: DriverOperationOptions) => driver.reset?.(strategy, options) ?? Promise.resolve() }),
    press: async (key, options): Promise<ActionResult> => {
      if (key === "SELECT" || key === "BACK") {
        options?.signal?.throwIfAborted();
        const current = await driver.snapshot(options);
        const eligible = keyboardActionsForState(current);
        if (!eligible.includes(key)) return {
          key, outcome: "unsupported", timing: { inputSentAtMs: Date.now() },
          message: `${key} withheld: current keyboard target is not on the bounded safe-interaction allowlist.`,
        };
      }
      return driver.press(key, options);
    },
  };
}
