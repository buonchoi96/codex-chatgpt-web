import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const projectRoot = process.cwd();
const fixturePath = "C:\\codex-image-fixtures\\relay.png";
// Fixed synthetic fixtures only; no challenge, oracle, or live screenshot bytes are used.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==";
const imageContent = [
  { type: "text" as const, text: "synthetic frame metadata" },
  { type: "image" as const, data: png, mimeType: "image/png" },
  { type: "image" as const, data: jpeg, mimeType: "image/jpeg" },
];

type Route = "direct" | "nested";

function environment(root: string, route: Route): ChatGptTurnEnvironment {
  return {
    cwd: root,
    roots: [root],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: route === "direct"
      ? [{ name: "view_image", description: "View the synthetic fixture", parameters: {} }]
      : [{ name: "exec", description: "Run the generated native tool call", parameters: {}, freeform: true }],
  };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded the 10 second test deadline`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function relayThroughCli(route: Route, isError: boolean): Promise<void> {
  // Keep Unix domain sockets short even when the platform's default temp path is long.
  const ownedParent = realpathSync(process.platform === "win32" ? tmpdir() : "/tmp");
  let ownedRoot: string | undefined;
  let broker: TurnBroker | undefined;
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  try {
    ownedRoot = mkdtempSync(join(ownedParent, "cgw-sr8-"));
    const privateWebHome = join(ownedRoot, "web-home");
    const privateCodexHome = join(ownedRoot, "codex-home");
    mkdirSync(privateWebHome);
    mkdirSync(privateCodexHome);
    const socketPath = defaultBrokerEndpoint(join(ownedRoot, "broker"));
    broker = TurnBroker.forSocket(socketPath);
    const turnToken = await broker.register(environment(ownedRoot, route), 30_000, `stdio-image-${route}`);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "src/cli.ts"), "mcp", "--contract", "native", "--broker-socket", socketPath],
      cwd: projectRoot,
      env: { CODEX_CHATGPT_WEB_HOME: privateWebHome, CODEX_HOME: privateCodexHome },
      stderr: "pipe",
    });
    client = new Client({ name: "mcp-stdio-image-relay-test", version: "1.0.0" });
    transport.stderr?.on("data", () => {});
    await bounded(client.connect(transport), "MCP stdio connection");

    const pendingResult = client.callTool({
      name: "codex_view_image",
      arguments: { turn_token: turnToken, path: fixturePath, detail: "original" },
    }, undefined, { timeout: 10_000, maxTotalTimeout: 10_000 });
    // Setup/assertion failure can close the transport before this result is awaited.
    void pendingResult.catch(() => {});
    const [request] = await bounded(broker.nextToolBatch(turnToken), "broker tool request");
    expect(request).toBeDefined();

    const nativeResult = {
      content: imageContent,
      structuredContent: { frame_id: "synthetic-frame-08", image_order: ["png", "jpeg"] },
      isError,
      _meta: { relay_fixture: "round8" },
    };

    if (route === "direct") {
      expect(request).toMatchObject({
        wireName: "view_image",
        arguments: { path: fixturePath, detail: "original" },
      });
      await broker.completeTool(turnToken, request!.callId, nativeResult);
    } else {
      expect(request).toMatchObject({ wireName: "exec", freeform: true });
      expect(request!.input).toContain('const nestedToolName = "view_image"');
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
      const generatedProgram = new AsyncFunction(
        "tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", request!.input!,
      );
      const emitted: Array<Record<string, unknown>> = [];
      let nativeArguments: unknown;
      await generatedProgram(
        { view_image: async (arguments_: unknown) => { nativeArguments = arguments_; return nativeResult; } },
        [{ name: "view_image", description: "View the synthetic fixture" }],
        (value: unknown) => emitted.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }),
        (value: unknown) => emitted.push(typeof value === "object" && value !== null ? value as Record<string, unknown> : { type: "image", data: value }),
        () => {},
        () => {},
      );
      expect(nativeArguments).toEqual({ path: fixturePath, detail: "original" });
      expect(emitted.filter(part => part.type === "image")).toEqual(imageContent.filter(part => part.type === "image"));
      expect(emitted.filter(part => part.type === "text").map(part => part.text).join("\n")).not.toContain(png);
      expect(emitted.filter(part => part.type === "text").map(part => part.text).join("\n")).not.toContain(jpeg);
      await broker.completeTool(turnToken, request!.callId, { content: emitted });
    }

    const received = await bounded(pendingResult, "MCP tool result");
    expect(received.content).toEqual(imageContent);
    expect(received.isError).toBe(isError);
    expect(received.structuredContent).toEqual(nativeResult.structuredContent);
    expect(received._meta).toEqual(nativeResult._meta);
    const textContent = (received.content as Array<Record<string, unknown>>)
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("\n");
    expect(textContent).toContain("synthetic frame metadata");
    expect(textContent).not.toContain(png);
    expect(textContent).not.toContain(jpeg);
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const close of [() => client?.close(), () => transport?.close(), () => broker?.close()]) {
      try { await close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (ownedRoot) {
      const resolvedRoot = realpathSync(ownedRoot);
      const relativeRoot = relative(ownedParent, resolvedRoot);
      if (resolvedRoot !== resolve(ownedRoot)
        || dirname(resolvedRoot) !== ownedParent
        || !basename(resolvedRoot).startsWith("cgw-sr8-")
        || relativeRoot === "" || relativeRoot === ".."
        || relativeRoot.startsWith(`..${sep}`)
        || isAbsolute(relativeRoot)) {
        throw new Error("Refusing cleanup outside the exact fixture-owned temporary directory");
      }
      rmSync(resolvedRoot, { recursive: true, force: true });
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Owned stdio fixture cleanup failed");
  }
}

for (const route of ["direct", "nested"] as const) {
  for (const isError of [false, true]) {
    test(`CLI stdio ${route} view_image relay preserves ordered PNG/JPEG content and metadata (isError=${isError})`, async () => {
      await relayThroughCli(route, isError);
    }, 30_000);
  }
}
