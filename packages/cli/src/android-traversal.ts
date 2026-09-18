export const ANDROID_TRAVERSAL_STRATEGIES = ["adaptive", "brute-force"] as const;

export type AndroidTraversalStrategy = (typeof ANDROID_TRAVERSAL_STRATEGIES)[number];

export function isAndroidTraversalStrategy(value: unknown): value is AndroidTraversalStrategy {
  return typeof value === "string"
    && (ANDROID_TRAVERSAL_STRATEGIES as readonly string[]).includes(value);
}

export function parseAndroidTraversalStrategy(
  value: string | undefined,
): AndroidTraversalStrategy {
  if (value === undefined) return "adaptive";
  if (!isAndroidTraversalStrategy(value)) {
    throw new TypeError("--strategy must be adaptive or brute-force.");
  }
  return value;
}
