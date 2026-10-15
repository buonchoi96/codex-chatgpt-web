/** Routed catalog policy; browser request capacity and effective recall are independent. */
export const WEB_CONTEXT_POLICY_VERSION = 1;
export const WEB_CONTEXT_TARGET_TOKENS = 272_000;
export const WEB_CONTEXT_COMPACT_RATIO = 0.95;
export const WEB_CONTEXT_COMPACT_TARGET_TOKENS = Math.floor(WEB_CONTEXT_TARGET_TOKENS * WEB_CONTEXT_COMPACT_RATIO);

export const WEB_CONTEXT_POLICY = Object.freeze({
  contextWindow: WEB_CONTEXT_TARGET_TOKENS,
  effectiveContextWindowPercent: 100,
  autoCompactTokenLimit: WEB_CONTEXT_COMPACT_TARGET_TOKENS,
});

/** Measured with isolated Codex 0.162.1 app-server tokenUsage telemetry.
 * Codex clamps the compact threshold against 90% of the raw model window,
 * while modelContextWindow applies effective_context_window_percent.
 * floor(302223 * 90 / 100) = 272000; the raw clamp leaves 258400 reachable.
 */
export const WEB_CONTEXT_CATALOG_POLICY = Object.freeze({
  contextWindow: 302_223,
  effectiveContextWindowPercent: 90,
  autoCompactTokenLimit: WEB_CONTEXT_COMPACT_TARGET_TOKENS,
});

export function classifyWebContextUsage(tokens: number): { compact: boolean; atCapacity: boolean } {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Web context usage must be a nonnegative integer');
  return { compact: tokens >= WEB_CONTEXT_COMPACT_TARGET_TOKENS, atCapacity: tokens >= WEB_CONTEXT_TARGET_TOKENS };
}
