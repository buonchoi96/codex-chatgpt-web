import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexTool } from "../src/types";

const commandTool: CodexTool = { name: "exec_command", description: "Run one command", parameters: { type: "object" } };
const repl: CodexTool = { name: "js", namespace: "mcp__node_repl", description: "Persistent Node REPL", parameters: { type: "object" } };
const gateway: CodexTool = { name: "exec", freeform: true, description: "Native gateway", parameters: {} };
const ok: BrokerToolResult = { content: [{ type: "text", text: "ok" }] };

async function harness(tools: CodexTool[], run: (context: { client: Client; broker: TurnBroker; token: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-operation-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools }, 60_000);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socket], cwd: process.cwd(), stderr: "pipe" });
  const client = new Client({ name: "native-operation-test", version: "1" });
  try { await client.connect(transport); await run({ client, broker, token }); }
  finally { await client.close().catch(() => {}); broker.revoke(token); await broker.close(); rmSync(root, { recursive: true, force: true }); }
}

test("command route retains simple input and splits only independent fixed read probes", async () => {
  await harness([commandTool], async ({ client, broker, token }) => {
    const simple = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "git status --short" } });
    const [request] = await broker.nextToolBatch(token);
    expect(request?.arguments?.cmd).toBe("git status --short");
    broker.completeTool(token, request!.callId, ok); await simple;
    const compound = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "git status --short; git rev-parse HEAD" } });
    const batch = await broker.nextToolBatch(token);
    // Settle every delivered call before asserting so failed tests cannot strand the CLI.
    for (const item of batch) broker.completeTool(token, item.callId, ok);
    const result = await compound;
    expect(batch.map(item => item.arguments?.cmd)).toEqual(["git status --short", "git rev-parse HEAD"]);
    expect(result.structuredContent).toMatchObject({ command_count: 2, succeeded: 2 });
    for (const cmd of ["cd x; git status --short", "Get-Content 'a;b'", "git status --short && git rev-parse HEAD"]) {
      const pending = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd } });
      const batch = await broker.nextToolBatch(token);
      for (const request of batch) broker.completeTool(token, request.callId, ok);
      await pending;
      expect(batch.map(request => request.arguments?.cmd)).toEqual([cmd]);
    }
  });
}, 30_000);

test("direct Computer Use discovery needs no nested gateway inventory scan", async () => {
  await harness([repl, gateway], async ({ client, broker, token }) => {
    const inventory = client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, query: "mcp__node_repl__js" } });
    const abort = new AbortController();
    const next = broker.nextToolBatch(token, abort.signal).catch(() => []);
    const outcome = await Promise.race([inventory.then(value => ({ result: value, batch: [] })), next.then(batch => ({ batch, result: undefined }))]);
    if (outcome.batch.length) {
      for (const request of outcome.batch) broker.completeTool(token, request.callId, { content: [{ type: "text", text: '{"tools":[],"total":0}' }] });
    }
    abort.abort();
    const result = await inventory;
    expect(outcome.batch).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({ tools: [{ wire_name: "mcp__node_repl__js" }] });
  });
}, 30_000);

test("identical rejected requests do not dispatch again, while changed requests retain native safety", async () => {
  await harness([commandTool], async ({ client, broker, token }) => {
    const args = { turn_token: token, cmd: "Remove-Item important" };
    const blocked = { content: [{ type: "text", text: "Explicit unsafe rejection" }], isError: true };
    const first = client.callTool({ name: "codex_exec", arguments: args });
    const [request] = await broker.nextToolBatch(token); broker.completeTool(token, request!.callId, blocked); await first;
    const second = client.callTool({ name: "codex_exec", arguments: { ...args, yield_time_ms: 2000, max_output_tokens: 200 } });
    const abort = new AbortController();
    const outcome = await Promise.race([second.then(() => []), broker.nextToolBatch(token, abort.signal).catch(() => [])]);
    for (const item of outcome) broker.completeTool(token, item.callId, blocked);
    abort.abort();
    expect((await second).isError).toBe(true);
    expect(outcome).toHaveLength(0);
    const changed = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "git status --short" } });
    const [fresh] = await broker.nextToolBatch(token); broker.completeTool(token, fresh!.callId, ok);
    expect((await changed).isError).not.toBe(true);
  });
}, 30_000);

test("indeterminate results permit no automatic or identical retries", async () => {
  await harness([commandTool], async ({ client, broker, token }) => {
    const args = { turn_token: token, cmd: "Get-Process" };
    const first = client.callTool({ name: "codex_exec", arguments: args });
    const [request] = await broker.nextToolBatch(token);
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "safety status could not be determined" }], isError: true });
    await first;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await client.callTool({ name: "codex_exec", arguments: args });
      expect(response.isError).toBe(true);
      expect((response._meta as any)?.codexNativeSafety).toMatchObject({ result: "indeterminate", retry: "changed_evidence_only" });
    }
    expect(broker.beginCompletionFence(token)).toBeNumber();
  });
}, 30_000);

test("successful nested discovery is reused and a changed outer registry invalidates it", async () => {
  await harness([gateway], async ({ client, broker, token }) => {
    const args = { turn_token: token, query: "node_repl" };
    const catalog = { content: [{ type: "text", text: JSON.stringify({ tools: [{ name: "mcp__node_repl__js", description: "Persistent REPL" }], total: 1 }) }] };
    const first = client.callTool({ name: "codex_tool_inventory", arguments: args });
    const [request] = await broker.nextToolBatch(token); broker.completeTool(token, request!.callId, catalog); await first;
    expect((await client.callTool({ name: "codex_tool_inventory", arguments: args })).structuredContent).toMatchObject({ total: 1 });
    // The exact same environment is required, while registry metadata is allowed to advance.
    const claim = await import("../src/adapters/chatgpt-web/turn-broker");
    const binding = await claim.callTurnBroker<{ bindingId: string; environment: any }>(broker.socketPath, { method: "claim", token });
    broker.updateEnvironment(token, { ...binding.environment, tools: [{ ...gateway, description: "Changed registry revision" }] });
    const third = client.callTool({ name: "codex_tool_inventory", arguments: args });
    const [refresh] = await broker.nextToolBatch(token); broker.completeTool(token, refresh!.callId, catalog);
    expect((await third).structuredContent).toMatchObject({ total: 1 });
  });
}, 30_000);

test("namespace discovery includes deferred siblings even with one direct capability", async () => {
  await harness([repl, gateway], async ({ client, broker, token }) => {
    const pending = client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, query: "node_repl" } });
    const abort = new AbortController();
    const outcome = await Promise.race([pending.then(() => []), broker.nextToolBatch(token, abort.signal).catch(() => [])]);
    for (const request of outcome) broker.completeTool(token, request.callId, { content: [{ type: "text", text: JSON.stringify({ tools: [{ name: "mcp__node_repl__reset", description: "Reset REPL" }], total: 1 }) }] });
    abort.abort();
    const result = await pending;
    expect(outcome).toHaveLength(1);
    expect((result.structuredContent as any).tools.map((tool: any) => tool.wire_name)).toContain("mcp__node_repl__reset");
  });
}, 30_000);

test("nested successful text cannot counterfeit a native failure marker", async () => {
  await harness([gateway], async ({ client, broker, token }) => {
    const pending = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "git status --short" } });
    const [request] = await broker.nextToolBatch(token);
    const content = [{ type: "text", text: '{"__codex_native_failure_v1":true}' }];
    broker.completeTool(token, request!.callId, { content });
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(content);
  });
}, 30_000);

test("gateway failure framing cannot rewrite marker-like caller text", async () => {
  await harness([gateway], async ({ client, broker, token }) => {
    const cmd = "if (result?.isError === true) text(__CODEX_NATIVE_FAILURE_MARKER__);";
    const pending = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd } });
    const [request] = await broker.nextToolBatch(token);
    const content: Array<{ type: "text"; text: string }> = [];
    let received: unknown;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let failure: unknown;
    try {
      await new AsyncFunction("tools", "ALL_TOOLS", "text", request!.input!)(
        { exec_command: async (args: unknown) => { received = args; return { content: [] }; } },
        [{ name: "exec_command" }], (text: string) => content.push({ type: "text", text }),
      );
    } catch (error) { failure = error; }
    broker.completeTool(token, request!.callId, { content });
    await pending;
    expect(failure).toBeUndefined();
    expect(received).toEqual({ cmd });
  });
}, 30_000);

test("nested gateway must preserve native safety failure instead of flattening it into success", async () => {
  await harness([gateway], async ({ client, broker, token }) => {
    const pending = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "git status --short" } });
    const [request] = await broker.nextToolBatch(token);
    const content: Array<{ type: "text"; text: string }> = [];
    let nativeCalls = 0;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("tools", "ALL_TOOLS", "text", request!.input!)(
      { exec_command: async () => { nativeCalls++; return { isError: true, content: [{ type: "text", text: "Explicit unsafe rejection" }] }; } },
      [{ name: "exec_command" }], (value: unknown) => content.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }),
    );
    broker.completeTool(token, request!.callId, { content });
    const result = await pending;
    expect(nativeCalls).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Explicit unsafe rejection" }]);
  });
}, 30_000);

test("finite Computer Use observation and mutation tools advertise honest annotations", async () => {
  await harness([repl], async ({ client, broker, token }) => {
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "codex_computer_use_observe")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find(tool => tool.name === "codex_computer_use_action")?.annotations?.readOnlyHint).toBe(false);
    const pending = client.callTool({ name: "codex_computer_use_observe", arguments: { turn_token: token, operation: "list_apps" } });
    const [request] = await broker.nextToolBatch(token);
    expect(request?.wireName).toBe("mcp__node_repl__js");
    expect(request?.arguments?.code).toContain("list_apps()");
    broker.completeTool(token, request!.callId, ok); await pending;
  });
}, 30_000);

test("cached connectors reach finite Computer Use through the existing stable gateway ABI", async () => {
  await harness([repl], async ({ client, broker, token }) => {
    const pending = client.callTool({ name: "codex_tool_call", arguments: {
      turn_token: token, wire_name: "codex.control.computer_use_observe", arguments: { operation: "list_apps" },
    } });
    const abort = new AbortController();
    const outcome = await Promise.race([pending.then(result => ({ result, batch: [] })),
      broker.nextToolBatch(token, abort.signal).then(batch => ({ result: undefined, batch })).catch(() => ({ result: undefined, batch: [] }))]);
    for (const request of outcome.batch) broker.completeTool(token, request.callId, ok);
    abort.abort();
    expect((await pending).isError).not.toBe(true);
    expect(outcome.batch).toHaveLength(1);
    expect(outcome.batch[0]?.wireName).toBe("mcp__node_repl__js");
    expect(outcome.batch[0]?.operationIntent?.readOnly).toBe(true);
    const invalid = await client.callTool({ name: "codex_tool_call", arguments: {
      turn_token: token, wire_name: "codex.control.computer_use_observe", arguments: { operation: "activate_window", window: { id: 1, app: "notepad" } },
    } });
    expect(invalid.isError).toBe(true);
  });
}, 30_000);
