import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { filterMcpAdvertisements, DEPRECATED_MCP_TOOLS } from "../src/adapters/chatgpt-web/mcp-advertisement";

test("new tool lists hide legacy stubs while cached clients still get their exact compatibility result", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  server.registerTool("codex_exec", { inputSchema: {} }, async () => ({ content: [] }));
  for (const name of DEPRECATED_MCP_TOOLS) server.registerTool(name, { inputSchema: {} }, async () => ({
    isError: true, content: [{ type: "text", text: "legacy_windows_computer_use_disabled" }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture-client", version: "1" });
  await server.connect(filterMcpAdvertisements(serverTransport, DEPRECATED_MCP_TOOLS));
  await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["codex_exec"]);
    for (const name of DEPRECATED_MCP_TOOLS) expect(await client.callTool({ name, arguments: {} })).toMatchObject({
      isError: true, content: [{ text: "legacy_windows_computer_use_disabled" }] });
    expect((await client.listTools()).tools).toHaveLength(1);
  } finally { await client.close(); await server.close(); }
});
