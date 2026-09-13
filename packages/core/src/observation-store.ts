import type { StateSnapshot } from "@tvdoctor/protocol";

export type ObservationCapability =
  | "navigation-identity"
  | "focus-semantics"
  | "accessibility-tree"
  | "viewport-layout"
  | "media-state"
  | "network-summary"
  | "performance-summary";

export interface ObservationStoreKey {
  readonly sessionId: string;
  readonly preparationId: string;
  readonly stateIdentity: string;
  readonly observationVersion: string;
}

interface ObservationEntry<TSnapshot extends StateSnapshot> {
  readonly snapshot: TSnapshot;
  readonly capabilities: ReadonlySet<ObservationCapability>;
}

function keyPart(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty.`);
  return value;
}

function serialiseKey(key: ObservationStoreKey): string {
  return JSON.stringify([
    keyPart(key.sessionId, "sessionId"),
    keyPart(key.preparationId, "preparationId"),
    keyPart(key.stateIdentity, "stateIdentity"),
    keyPart(key.observationVersion, "observationVersion"),
  ]);
}

/**
 * Run-scoped cache for exact canonical observations. Consumers only receive a
 * cached observation when every capability they require is present; otherwise
 * they must enrich/recollect while the exact state is still verified.
 */
export class CanonicalObservationStore<TSnapshot extends StateSnapshot = StateSnapshot> {
  readonly #entries = new Map<string, ObservationEntry<TSnapshot>>();

  put(
    key: ObservationStoreKey,
    snapshot: TSnapshot,
    capabilities: readonly ObservationCapability[],
  ): void {
    this.#entries.set(serialiseKey(key), {
      snapshot,
      capabilities: new Set(capabilities),
    });
  }

  get(
    key: ObservationStoreKey,
    requiredCapabilities: readonly ObservationCapability[] = [],
  ): TSnapshot | null {
    const entry = this.#entries.get(serialiseKey(key));
    if (entry === undefined) return null;
    if (requiredCapabilities.some((capability) => !entry.capabilities.has(capability))) return null;
    return entry.snapshot;
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
