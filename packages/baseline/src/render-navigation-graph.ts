import { parseBaseline } from "./baseline.js";
import type { BaselineTransitionObservation, TVDoctorBaselineV1 } from "./types.js";

function mermaidLabel(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/gu, " ")
    .trim();
}

function focusIdentity(screenKey: string, focusKey: string | null): string {
  return `${screenKey}\u001f${focusKey ?? ""}`;
}

function transitionEndpointLabel(transition: BaselineTransitionObservation, side: "from" | "to"): string {
  const screenKey = side === "from" ? transition.fromScreenKey : transition.toScreenKey;
  const focusKey = side === "from" ? transition.fromFocusKey : transition.toFocusKey;
  return focusKey === null ? `Screen: ${screenKey}` : `${screenKey} · ${focusKey}`;
}

/** Mermaid graph built only from baseline inventory observations. */
export function renderNavigationGraphMermaid(baselineInput: TVDoctorBaselineV1): string {
  const baseline = parseBaseline(baselineInput);
  const nodeIds = new Map<string, string>();
  const lines = ["flowchart LR"];
  let nextNode = 0;

  const ensureNode = (identity: string, label: string): string => {
    const existing = nodeIds.get(identity);
    if (existing !== undefined) return existing;
    const id = `N${String(nextNode)}`;
    nextNode += 1;
    nodeIds.set(identity, id);
    lines.push(`  ${id}["${mermaidLabel(label)}"]`);
    return id;
  };

  for (const screen of baseline.inventory.screens) {
    ensureNode(focusIdentity(screen.key, null), `Screen: ${screen.label ?? screen.key}`);
  }
  for (const focus of baseline.inventory.focusTargets) {
    ensureNode(
      focusIdentity(focus.screenKey, focus.key),
      `${focus.screenKey} · ${focus.name ?? focus.key}${focus.role === null ? "" : ` (${focus.role})`}`,
    );
  }
  for (const transition of baseline.inventory.transitions) {
    const fromIdentity = focusIdentity(transition.fromScreenKey, transition.fromFocusKey);
    const toIdentity = focusIdentity(transition.toScreenKey, transition.toFocusKey);
    const from = ensureNode(fromIdentity, transitionEndpointLabel(transition, "from"));
    const to = ensureNode(toIdentity, transitionEndpointLabel(transition, "to"));
    lines.push(`  ${from} -- "${transition.action}" --> ${to}`);
  }
  return `${lines.join("\n")}\n`;
}
