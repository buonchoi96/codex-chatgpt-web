import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const DEPRECATED_MCP_TOOLS = new Set([
  "codex_windows_computer_use_observe", "codex_windows_computer_use_action", "codex_windows_computer_use_call",
]);

/** Slim only tools/list replies. Cached clients can still invoke registered compatibility handlers. */
export function filterMcpAdvertisements(transport: Transport, hidden: ReadonlySet<string>): Transport {
  const lists = new Set<string | number>();
  const send = transport.send.bind(transport);
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const receive = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ("id" in message && "method" in message && message.method === "tools/list" && lists.size < 128) lists.add(message.id);
      receive?.(message, extra);
    };
    const close = transport.onclose;
    transport.onclose = () => { lists.clear(); close?.(); };
    await start();
  };
  transport.send = async (message, options) => {
    if ("id" in message && message.id !== undefined && !("method" in message) && lists.delete(message.id)
      && "result" in message && Array.isArray(message.result.tools)) {
      message = { ...message, result: { ...message.result,
        tools: message.result.tools.filter((tool: unknown) => !tool || typeof tool !== "object"
          || !("name" in tool) || typeof tool.name !== "string" || !hidden.has(tool.name)) } };
    }
    await send(message, options);
  };
  return transport;
}
