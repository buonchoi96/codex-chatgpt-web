import type { CodexTool } from "../../types";

/**
 * Native command authority belongs to the exact current Codex request, not to a
 * previously connected MCP plugin, a cached environment, or a prior turn.
 * Namespaced tools and discovery entries cannot substitute for this grant.
 */
export function nativeCommandSurface(tools: readonly CodexTool[] | undefined):
  "exec_command" | "shell_command" | "exec" | undefined {
  if (tools?.some(tool => !tool.namespace && tool.name === "exec_command")) return "exec_command";
  if (tools?.some(tool => !tool.namespace && tool.name === "shell_command")) return "shell_command";
  if (tools?.some(tool => !tool.namespace && tool.name === "exec" && tool.freeform === true)) return "exec";
  return undefined;
}
