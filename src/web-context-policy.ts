/** Routed catalog policy; browser request capacity and effective recall are independent. */
export const WEB_CONTEXT_POLICY_VERSION = 2;
export const WEB_CONTEXT_TARGET_TOKENS = 272_000;
export const WEB_CONTEXT_COMPACT_RATIO = 0.95;
/**
 * The 272k context display describes Codex's archival / checkpoint capacity,
 * NOT one ChatGPT Plus browser request. Live Plus/High measurements on 2026-10-17
 * capped canonical browser input at 71,808 tokens, including a separate 8,192
 * platform reserve. On a new /goal turn the retained same-tab proof may expire,
 * making the complete canonical input mandatory again. A 258,400-token Codex
 * auto-compact threshold can therefore strand the task without a valid Send.
 *
 * Keep Codex's native auto-compaction comfortably below the measured fallback
 * limit. This is an explicit safety headroom, not a claim of a 272k recall span.
 * We never bypass a transport budget or silently truncate a normal request.
 */
export const WEB_CONTEXT_SAFE_BROWSER_COMPACT_TOKENS = 58_000;
export const WEB_CONTEXT_COMPACT_TARGET_TOKENS = Math.min(
  Math.floor(WEB_CONTEXT_TARGET_TOKENS * WEB_CONTEXT_COMPACT_RATIO),
  WEB_CONTEXT_SAFE_BROWSER_COMPACT_TOKENS,
);

export const WEB_CONTEXT_POLICY = Object.freeze({
  contextWindow: WEB_CONTEXT_TARGET_TOKENS,
  effectiveContextWindowPercent: 100,
  autoCompactTokenLimit: WEB_CONTEXT_COMPACT_TARGET_TOKENS,
});

/** Measured with isolated Codex 0.162.1 app-server tokenUsage telemetry.
 * Codex clamps the compact threshold against 90% of the raw model window,
 * while modelContextWindow applies effective_context_window_percent.
 * floor(302223 * 90 / 100) = 272000; the low measured browser safety threshold
 * is below that clamp and remains authoritative for routed Web models.
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
