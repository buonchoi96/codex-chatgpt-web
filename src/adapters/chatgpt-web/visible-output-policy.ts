/** User-visible summary gating. Native work/tool calls remain untouched.
 * Private chain-of-thought is never accessed or exposed by this function.
 */
export function showPublicReasoning(
  event: { kind: string },
  hideThinkingSummary = false,
): boolean {
  return !hideThinkingSummary && event.kind === "reasoning";
}
