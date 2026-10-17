import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defaultConfig, loadConfig, type AppConfig } from "../src/config";
import { mcpCommand } from "../src/tunnel";

const roots: string[] = [];
const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
const validObserver = {
  readerPipe: "\\\\.\\pipe\\codex_screen_observer_observer_v1",
  grantWireName: "mcp__computer_use_swift__swift_observer_reader_grant",
};

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
  for (const root of roots.splice(0)) {
    const canonical = realpathSync(root);
    if (canonical !== resolve(root) || dirname(canonical) !== realpathSync(tmpdir())
      || !basename(canonical).startsWith("cgw-observer-config-")) {
      throw new Error("Refusing config fixture cleanup outside its owned temporary directory");
    }
    rmSync(canonical, { recursive: true, force: true });
  }
});

async function observerParser(): Promise<((value: unknown) => unknown) | undefined> {
  const module = await import("../src/native-screen-observer-config").catch(() => undefined);
  return module?.parseNativeScreenObserverConfig;
}

function privateConfigHome<T extends object>(makeConfig: () => T): T {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "cgw-observer-config-"));
  roots.push(home);
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  const config = makeConfig();
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
  return config;
}

function fullConfig(): AppConfig & { nativeScreenObserver?: unknown } {
  const config = defaultConfig("full") as AppConfig & { nativeScreenObserver?: unknown };
  config.runtimeCommand = ["C:\\Codex Web\\runtime\\bun.exe", "C:\\Codex Web\\app\\cli.js"];
  config.brokerSocketPath = "\\\\.\\pipe\\codex-web-broker";
  return config;
}

function parseWindowsTunnelCommand(command: string): string[] {
  return [...command.matchAll(/"((?:\\\\|[^"])*)"/g)]
    .map(match => match[1]!.replaceAll("\\\\", "\\"));
}

test("observer parser returns a fresh normalized copy for the explicit local Windows grant", async () => {
  const parse = await observerParser();
  expect(parse).toBeFunction();
  if (!parse) return;
  const input = { ...validObserver };
  const parsed = parse(input);
  expect(parsed).toEqual(validObserver);
  expect(parsed).not.toBe(input);
  expect(parse(undefined)).toBeUndefined();
});

test("observer parser rejects malformed, nonlocal, ambiguous, and oversized settings without echoing them", async () => {
  const parse = await observerParser();
  expect(parse).toBeFunction();
  if (!parse) return;
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...validObserver, unexpected: true },
    { readerPipe: " ", grantWireName: validObserver.grantWireName },
    { readerPipe: "\\\\server\\pipe\\codex_screen_observer_observer_v1", grantWireName: validObserver.grantWireName },
    { readerPipe: "\\\\.\\pipe\\folder\\codex_screen_observer_observer_v1", grantWireName: validObserver.grantWireName },
    { readerPipe: "\\\\.\\pipe\\bad name_observer_v1", grantWireName: validObserver.grantWireName },
    { readerPipe: "\\\\.\\pipe\\bad;whoami_observer_v1", grantWireName: validObserver.grantWireName },
    { readerPipe: validObserver.readerPipe, grantWireName: "mcp__computer_use_swift__desktop_observe" },
    { readerPipe: `\\\\.\\pipe\\${"a".repeat(300)}_observer_v1`, grantWireName: validObserver.grantWireName },
    { readerPipe: validObserver.readerPipe, grantWireName: `mcp__${"a".repeat(300)}__swift_observer_reader_grant` },
  ];
  for (const value of invalid) expect(() => parse(value)).toThrow();
  let invalidValueError: unknown;
  try {
    parse({
      readerPipe: "\\\\.\\pipe\\secret;do-not-echo_observer_v1",
      grantWireName: validObserver.grantWireName,
    });
  } catch (error) {
    invalidValueError = error;
  }
  expect(invalidValueError).toBeInstanceOf(Error);
  expect((invalidValueError as Error).message).not.toContain("secret;do-not-echo");
});

test("loadConfig validates and returns only a normalized copy of the optional observer setting", () => {
  const config = privateConfigHome(() => {
    const next = defaultConfig("browser-only") as AppConfig & { nativeScreenObserver?: unknown };
    next.nativeScreenObserver = { ...validObserver };
    return next;
  }) as AppConfig & { nativeScreenObserver?: unknown };
  const loaded = loadConfig() as AppConfig & { nativeScreenObserver?: unknown };
  expect(loaded.nativeScreenObserver).toEqual(validObserver);
  expect(loaded.nativeScreenObserver).not.toBe(config.nativeScreenObserver);

  privateConfigHome(() => ({
    ...defaultConfig("browser-only"),
    nativeScreenObserver: { ...validObserver, grantWireName: "wrong" },
  }));
  expect(() => loadConfig()).toThrow(/nativeScreenObserver/);
});

test("generated Windows MCP command includes the observer flags only for Full automatic native opt-in", () => {
  const active = fullConfig();
  active.nativeScreenObserver = { ...validObserver };
  expect(parseWindowsTunnelCommand(mcpCommand(active, "win32"))).toEqual([
    "C:\\Codex Web\\runtime\\bun.exe",
    "C:\\Codex Web\\app\\cli.js",
    "mcp", "--contract", "native", "--broker-socket", "\\\\.\\pipe\\codex-web-broker",
    "--screen-observer-pipe", validObserver.readerPipe,
    "--screen-observer-grant-tool", validObserver.grantWireName,
  ]);

  const manual = fullConfig();
  manual.browserInteractionMode = "manual";
  manual.nativeScreenObserver = { ...validObserver };
  const manualArgs = parseWindowsTunnelCommand(mcpCommand(manual, "win32"));
  expect(manualArgs).toContain("safe");
  expect(manualArgs).not.toContain("--screen-observer-pipe");

  const browserOnly = { ...fullConfig(), mode: "browser-only" as const, nativeScreenObserver: { ...validObserver } };
  expect(parseWindowsTunnelCommand(mcpCommand(browserOnly, "win32"))).not.toContain("--screen-observer-pipe");
  expect(mcpCommand(browserOnly, "win32")).not.toContain("--screen-observer-grant-tool");
});

test("active Windows observer configuration is rejected on a non-Windows target", () => {
  const config = fullConfig();
  config.nativeScreenObserver = { ...validObserver };
  expect(() => mcpCommand(config, "linux")).toThrow(/Windows/);
});

test("absent observer opt-in leaves existing generated MCP command unchanged", () => {
  const config = fullConfig();
  expect(parseWindowsTunnelCommand(mcpCommand(config, "win32"))).toEqual([
    "C:\\Codex Web\\runtime\\bun.exe",
    "C:\\Codex Web\\app\\cli.js",
    "mcp", "--contract", "native", "--broker-socket", "\\\\.\\pipe\\codex-web-broker",
  ]);
});
