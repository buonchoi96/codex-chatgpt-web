/** Read-only bridge display hint, never a change to the native tool identity.
 * Codex's tool-call header is platform-owned; emit a separate commentary label.
 */
export function swiftToolActivityTitle(request: {
  wireName: string;
  arguments?: Record<string, unknown>;
}): string | undefined {
  let name = request.wireName;
  let input: unknown = request.arguments;
  if (name === "codex_tool_call" || name.endsWith("__codex_tool_call")) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const wrapper = input as Record<string, unknown>;
    name = typeof wrapper.wire_name === "string" ? wrapper.wire_name : "";
    input = wrapper.arguments;
  }
  // Only trust title data for this named MCP, never arbitrary shell/tool input.
  if (!/^(?:mcp__)?computer_use_swift__(?:desktop|game|swift)[._][a-z_]+$/i.test(name)) return;
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const title = (input as Record<string, unknown>).title;
  if (typeof title !== "string") return;
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 120 || /[\x00-\x1f\x7f\u202a-\u202e]/.test(trimmed)) return;
  return trimmed;
}
