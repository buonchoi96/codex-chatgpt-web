import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "../src/adapters/chatgpt-web/native-compaction-control";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

async function createCompactionControlFixture(label: string) {
  const root = mkdtempSync(join(shortSocketTempRoot(), `cgw-${label}-${crypto.randomUUID()}-`));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `compaction-${label}-fixture`, version: "1" });
  let server: Awaited<ReturnType<typeof createChatGptMcpServer>> | undefined;
  try {
    server = await createChatGptMcpServer({
      brokerSocketPath: broker.socketPath,
      transport: serverTransport,
    });
    await client.connect(clientTransport);
  } catch (error) {
    await Promise.allSettled([
      client.close(),
      ...(server ? [server.close()] : []),
      broker.close(),
    ]);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    broker,
    client,
    server,
    root,
    close: async () => {
      const shutdown = await Promise.allSettled([
        client.close(),
        server.close(),
        broker.close(),
      ]);
      rmSync(root, { recursive: true, force: true });
      const failure = shutdown.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

async function submitHandoff(
  client: Client,
  binding: { token: string; handoffId: string },
  summary: string,
) {
  return client.callTool({
    name: "codex_tool_call",
    arguments: {
      turn_token: binding.token,
      wire_name: CODEX_COMPACTION_CONTROL_WIRE_NAME,
      arguments: { handoff_id: binding.handoffId, summary },
    },
  });
}

test("an aborted operator cannot consume or resubmit an MCP-submitted compaction summary", async () => {
  const fixture = await createCompactionControlFixture("cancelled-handoff");
  try {
    const binding = await fixture.broker.beginCompactionTransaction("cancelled-handoff-test");
    const receipt = await submitHandoff(fixture.client, binding, "Checkpoint submitted before cancellation");
    expect(receipt.isError).not.toBe(true);
    expect(receipt.structuredContent).toEqual({ submitted: true });

    const operator = new AbortController();
    operator.abort();
    await expect(fixture.broker.waitForCompactionHandoff(binding.token, operator.signal))
      .rejects.toMatchObject({ name: "AbortError" });

    const retry = await submitHandoff(fixture.client, binding, "Attempted summary resubmission");
    expect(retry.isError).toBe(true);
    await expect(fixture.broker.waitForCompactionHandoff(binding.token))
      .rejects.toThrow(/invalid, expired, or consumed/);
  } finally {
    await fixture.close();
  }
});

test("an uncancelled MCP compaction handoff is acknowledged and consumed exactly once", async () => {
  const fixture = await createCompactionControlFixture("valid-handoff");
  try {
    const binding = await fixture.broker.beginCompactionTransaction("valid-handoff-test");
    const receipt = await submitHandoff(fixture.client, binding, "Valid checkpoint summary");
    expect(receipt.isError).not.toBe(true);
    expect(receipt.structuredContent).toEqual({ submitted: true });

    await expect(fixture.broker.waitForCompactionHandoff(binding.token))
      .resolves.toBe("Valid checkpoint summary");
    await expect(fixture.broker.waitForCompactionHandoff(binding.token))
      .rejects.toThrow(/invalid, expired, or consumed/);
    const duplicate = await submitHandoff(fixture.client, binding, "Duplicate checkpoint summary");
    expect(duplicate.isError).toBe(true);
  } finally {
    await fixture.close();
  }
});
