export interface ComputerObservation {
  id: string;
  revision: number;
  /** revision is retained as an alias for stateRevision. */
  stateRevision: number;
  /** Native action attempts, including attempts blocked by native safety. */
  actionRevision: number;
  hash: string | null;
  unchanged: boolean;
  cacheHit: boolean;
  evidence: "fresh_native_accessibility" | "unavailable";
  scope: "window_accessibility";
  observedAt: number;
}

/** Runs both locally and as a finite embedded factory in node_repl. Keep dependencies injected:
 * the REPL cannot import bridge-local files. This cache stores comparisons, never screens or
 * action permissions. Every observe() must follow a fresh native get_window_state() call. */
export function createComputerObservationEngine(
  hash: (canonical: string) => string,
  namespace: string,
  limits = { maxEntries: 16, maxBytes: 1_048_576, maxEntryBytes: 262_144 },
) {
  if (!namespace || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Invalid observation cache limits or namespace");
  }
  type Entry = { canonical: string; bytes: number; id: string; revision: number; hash: string };
  const entries = new Map<string, Entry>();
  let bytes = 0, epoch = 0, revision = 0, actionRevision = 0;

  function invalidate() { entries.clear(); bytes = 0; epoch++; }
  function recordAction() { actionRevision++; invalidate(); return actionRevision; }

  // Reject non-JSON/partial evidence rather than dropping unknown fields. Compare canonical
  // content as well as the hash, so a digest collision cannot establish unchanged state.
  function canonicalize(value: unknown): string | null {
    const seen = new Set<object>();
    let size = 0;
    function encode(item: unknown, depth: number): string {
      if (depth > 64) throw new Error("Deep observation");
      if (item === null || typeof item === "boolean" || typeof item === "string"
        || (typeof item === "number" && Number.isFinite(item))) {
        const encoded = JSON.stringify(item);
        size += encoded.length * 2;
        if (size > limits.maxEntryBytes) throw new Error("Large observation");
        return encoded;
      }
      if (!item || typeof item !== "object" || seen.has(item)) throw new Error("Non-JSON observation");
      seen.add(item);
      let encoded: string;
      if (Array.isArray(item)) {
        encoded = "[" + Array.from(item, child => encode(child, depth + 1)).join(",") + "]";
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw new Error("Non-JSON observation");
        if (Object.getOwnPropertySymbols(item).length) throw new Error("Non-JSON observation");
        const descriptors = Object.getOwnPropertyDescriptors(item);
        encoded = "{" + Object.keys(descriptors).filter(key => descriptors[key]!.enumerable).sort().map(key => {
          const descriptor = descriptors[key]!;
          if (!("value" in descriptor)) throw new Error("Non-JSON observation");
          return encode(key, depth + 1) + ":" + encode(descriptor.value, depth + 1);
        }).join(",") + "}";
      }
      seen.delete(item);
      if (encoded.length * 2 > limits.maxEntryBytes) throw new Error("Large observation");
      return encoded;
    }
    try { return encode(value, 0); } catch { return null; }
  }

  function observe(target: { id: number; app: string }, value: unknown, captureEpoch: number, knownObservationId?: string) {
    if (captureEpoch !== epoch) throw new Error("Observation invalidated during native capture");
    const state = value as { window?: { id?: unknown; app?: unknown }; accessibility?: { tree?: unknown; document_text?: unknown }; screenshots?: unknown[] } | null;
    if (!state || state.window?.id !== target.id || state.window?.app !== target.app) {
      invalidate();
      throw new Error("Native window identity changed");
    }
    const a = state.accessibility;
    const usable = a && typeof a.tree === "string" && (a.tree.trim()
      || (typeof a.document_text === "string" && a.document_text.trim()));
    // Accessibility equality says nothing about pixels; never retain/replay screenshot data.
    const canonical = usable && Array.isArray(state.screenshots) && state.screenshots.length === 0
      ? canonicalize(state) : null;
    const key = JSON.stringify([target.app, target.id]);
    const previous = entries.get(key);
    const unchanged = canonical !== null && previous?.canonical === canonical;
    const fingerprint = canonical !== null ? (unchanged ? previous!.hash : hash(canonical)) : null;
    const nextRevision = unchanged ? previous!.revision : ++revision;
    const id = unchanged ? previous!.id : namespace + ":" + nextRevision;
    const cacheHit = unchanged && knownObservationId === id;
    const observation: ComputerObservation = { id, revision: nextRevision, stateRevision: nextRevision, actionRevision, hash: fingerprint, unchanged, cacheHit,
      evidence: canonical === null ? "unavailable" : "fresh_native_accessibility", scope: "window_accessibility", observedAt: Date.now() };
    if (previous) { bytes -= previous.bytes; entries.delete(key); }
    if (canonical !== null && canonical.length * 2 + key.length * 2 <= Math.min(limits.maxBytes, limits.maxEntryBytes)) {
      const entry = { canonical, bytes: (canonical.length + key.length) * 2, id, revision: nextRevision, hash: fingerprint! };
      entries.set(key, entry); bytes += entry.bytes;
      while (entries.size > limits.maxEntries || bytes > limits.maxBytes) {
        const oldest = entries.keys().next().value!;
        bytes -= entries.get(oldest)!.bytes; entries.delete(oldest);
      }
    }
    return cacheHit ? { window: state.window, observation } : { ...state, observation };
  }

  return { observe, invalidate, recordAction, captureEpoch: () => epoch, actionRevision: () => actionRevision };
}
