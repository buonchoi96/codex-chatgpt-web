const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");
const {
  CLI_CONNECTOR_NAME,
  CLI_TUNNEL_ALIAS,
  cliLaneEnvironment,
  mirrorCliCodexToolingConfig,
  normalizeCliLaneConfig,
  resolveCliToolingSourceCodexHome,
  resolveLiveLanePaths,
  validateCliLaneConfig,
} = require("../scripts/dev-live-lanes.cjs");

function tunnel(id, alias) {
  return {
    binaryPath: path.resolve("tunnel-client"),
    tunnelId: id,
    runtimeKeyFile: path.resolve(`${alias}.key`),
    profileDir: path.resolve("profiles"),
    profileName: alias,
    alias,
  };
}

function config({ port, connector, tunnelId, alias, broker, descriptor }) {
  const activeTunnel = tunnel(tunnelId, alias);
  return {
    version: 3,
    releaseVersion: "6.1.3",
    mode: "full",
    browserInteractionMode: "automatic",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptor,
    appName: connector,
    automaticAppName: connector,
    manualAppName: "Codex Zero Risk",
    port,
    brokerSocketPath: broker,
    controlToken: `${port}`.padEnd(48, "a"),
    tunnel: activeTunnel,
    automaticTunnel: activeTunnel,
  };
}

test("DEV live resolves an isolated CLI home and Codex home", () => {
  const home = path.join(os.tmpdir(), "dev-live-lanes-home");
  const paths = resolveLiveLanePaths({ CODEX_WEB_GPT_LIVE_HOME: path.join(home, "desktop") }, home);
  assert.equal(paths.cliHome, path.join(home, "desktop", "cli-lane"));
  assert.equal(paths.cliCodexHome, path.join(home, "desktop", "cli-lane", "codex-home"));
  assert.notEqual(paths.cliCodexHome, path.join(home, ".codex"));
  const environment = cliLaneEnvironment(paths, { CODEX_HOME: path.join(home, ".codex") });
  assert.equal(environment.CODEX_HOME, paths.cliCodexHome);
  assert.equal(environment.CODEX_CHATGPT_WEB_HOME, paths.cliHome);
  assert.equal(environment.CODEX_WEB_GPT_LIVE_LANE, "cli");
});

test("DEV live mirrors Computer/Browser tooling without overwriting the isolated Web route", () => {
  const source = [
    'notify = [ "C:\\\\runtime\\\\codex-computer-use.exe", "turn-ended" ]',
    'openai_base_url = "http://127.0.0.1:17841/v1"',
    "",
    "[marketplaces.openai-bundled]",
    "source_type = \"local\"",
    "source = 'E:\\Codex\\marketplace'",
    "",
    '[plugins."browser@openai-bundled"]',
    "enabled = true",
    "",
    '[plugins."unified-computer-use@openai-bundled"]',
    "enabled = true",
    "",
    '[plugins."computer-use@openai-bundled"]',
    "enabled = true",
    "",
    "[mcp_servers.node_repl]",
    "command = 'C:\\runtime\\node_repl.exe'",
    "",
    "[mcp_servers.node_repl.env]",
    "CODEX_HOME = 'E:\\Codex'",
    "SKY_CUA_NATIVE_PIPE = \"1\"",
    "",
    "[mcp_servers.playwright]",
    'command = "npx"',
    "",
    "[mcp_servers.unrelated]",
    'command = "do-not-copy"',
    "",
  ].join("\r\n");
  const target = [
    'openai_base_url = "http://127.0.0.1:17842/v1"',
    "",
    "[features]",
    "multi_agent = true",
    "",
    "[mcp_servers.keep_me]",
    'command = "keep"',
    "",
  ].join("\r\n");

  const merged = mirrorCliCodexToolingConfig(
    source,
    target,
    "C:\\Users\\dev\\.codex-chatgpt-web-live\\cli-lane\\codex-home",
  );
  assert.equal(merged.changed, true);
  assert.equal(merged.mirroredNotify, true);
  assert.deepEqual(merged.mirroredTables, [
    "marketplaces.openai-bundled",
    'plugins."browser@openai-bundled"',
    'plugins."unified-computer-use@openai-bundled"',
    'plugins."computer-use@openai-bundled"',
    "mcp_servers.node_repl",
    "mcp_servers.node_repl.env",
    "mcp_servers.playwright",
  ]);
  assert.match(merged.text, /openai_base_url = "http:\/\/127\.0\.0\.1:17842\/v1"/);
  assert.doesNotMatch(merged.text, /17841\/v1/);
  assert.match(merged.text, /codex-computer-use\.exe/);
  assert.match(merged.text, /\[mcp_servers\.keep_me\]/);
  assert.doesNotMatch(merged.text, /\[mcp_servers\.unrelated\]/);
  assert.match(merged.text, /CODEX_HOME = 'C:\\Users\\dev\\\.codex-chatgpt-web-live\\cli-lane\\codex-home'/);

  const second = mirrorCliCodexToolingConfig(source, merged.text, "C:\\Users\\dev\\.codex-chatgpt-web-live\\cli-lane\\codex-home");
  assert.equal(second.changed, false);
  assert.equal(second.text, merged.text);
});

test("DEV live tooling source follows the ordinary Codex home and supports an explicit override", () => {
  const home = path.join(os.tmpdir(), "dev-live-tooling-source");
  assert.equal(
    resolveCliToolingSourceCodexHome({ CODEX_HOME: path.join(home, "ordinary") }, home),
    path.join(home, "ordinary"),
  );
  assert.equal(
    resolveCliToolingSourceCodexHome({
      CODEX_HOME: path.join(home, "ordinary"),
      CODEX_WEB_GPT_LIVE_CLI_SOURCE_CODEX_HOME: path.join(home, "override"),
    }, home),
    path.join(home, "override"),
  );
});

test("DEV live normalizes the CLI connector and tunnel identity", () => {
  const source = config({
    port: 17842,
    connector: "Codex Temporary",
    tunnelId: "tunnel_22222222222222222222222222222222",
    alias: "codex-chatgpt-web",
    broker: path.resolve("cli.sock"),
    descriptor: path.resolve("launcher-browser.json"),
  });
  const normalized = normalizeCliLaneConfig(source);
  assert.equal(normalized.appName, CLI_CONNECTOR_NAME);
  assert.equal(normalized.automaticAppName, CLI_CONNECTOR_NAME);
  assert.equal(normalized.tunnel.alias, CLI_TUNNEL_ALIAS);
  assert.equal(normalized.tunnel.profileName, CLI_TUNNEL_ALIAS);
  assert.deepEqual(normalized.tunnel, normalized.automaticTunnel);
});

test("DEV live rejects a CLI lane that shares Desktop tunnel identity or transport", () => {
  const home = path.join(os.tmpdir(), "dev-live-lanes-isolation");
  const paths = resolveLiveLanePaths({ CODEX_WEB_GPT_LIVE_HOME: path.join(home, "desktop") }, home);
  const desktop = config({
    port: 17841,
    connector: "Codex Native2",
    tunnelId: "tunnel_11111111111111111111111111111111",
    alias: "codex-chatgpt-web",
    broker: path.resolve("desktop.sock"),
    descriptor: paths.desktopBrowserDescriptorPath,
  });
  const cli = normalizeCliLaneConfig(config({
    port: 17842,
    connector: "Codex Temporary",
    tunnelId: "tunnel_22222222222222222222222222222222",
    alias: "temporary",
    broker: path.resolve("cli.sock"),
    descriptor: paths.desktopBrowserDescriptorPath,
  }));
  assert.equal(validateCliLaneConfig(cli, desktop, paths), cli);

  assert.throws(
    () => validateCliLaneConfig({ ...cli, port: desktop.port }, desktop, paths),
    /different Responses ports/,
  );
  assert.throws(
    () => validateCliLaneConfig({ ...cli, brokerSocketPath: desktop.brokerSocketPath }, desktop, paths),
    /different MCP broker endpoints/,
  );
  const sharedTunnel = { ...cli.tunnel, tunnelId: desktop.tunnel.tunnelId };
  assert.throws(
    () => validateCliLaneConfig({ ...cli, tunnel: sharedTunnel, automaticTunnel: sharedTunnel }, desktop, paths),
    /different Tunnel IDs/,
  );
});

test("dev:live wires the isolated CLI lane without replacing the production workflow", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(launcherRoot, "..");
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live.cjs"), "utf8");
  assert.equal(rootPackage.scripts["dev:live"], "bun run --cwd launcher dev:live");
  assert.equal(rootPackage.scripts["dev:live:cli-setup"], "bun run launcher/scripts/dev-live-cli-setup.cjs");
  assert.equal(rootPackage.scripts["dev:codex"], "bun run launcher/scripts/dev-codex.cjs");
  assert.match(source, /startCliLaneSupervisor/);
  assert.match(source, /restartCliLaneDaemonFromSource/);
  assert.match(source, /config: cliConfigBeforeReload/);
  assert.match(source, /isolated CLI lane admission/);
  assert.match(source, /could not be confirmed resumed after Electron reload/);
  assert.match(source, /bun run dev:codex -- <codex arguments>/);
  assert.match(source, /handoffProductionRoute/);
  assert.match(source, /restoreProductionRoute/);
});

test("CLI lane supervisor stays alive while waiting for first-time setup", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live-cli-lane.cjs"), "utf8");
  assert.match(source, /Keep this interval referenced even before CLI setup exists/);
  assert.match(source, /monitorTimer = setInterval/);
  assert.doesNotMatch(source, /monitorTimer\.unref/);
});

test("CLI setup ignores per-command CODEX_HOME overrides from CLI diagnostics", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live-cli-setup.cjs"), "utf8");
  assert.match(source, /const setupEnvironment = \{ \.\.\.process\.env \}/);
  assert.match(source, /const sourceCodexHome = resolveCliToolingSourceCodexHome\(process\.env\)/);
  assert.match(source, /delete setupEnvironment\.CODEX_HOME/);
  assert.match(source, /delete setupEnvironment\.CODEX_CHATGPT_WEB_HOME/);
  assert.match(source, /mirrorCliToolingConfig\(\)/);
  assert.match(source, /resolveLiveLanePaths\(setupEnvironment\)/);
});

test("DEV CLI tunnel helper always targets the isolated CLI lane", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "dev-live-cli-tunnel.ts"), "utf8");
  assert.match(source, /CODEX_WEB_GPT_LIVE_CLI_HOME/);
  assert.match(source, /CODEX_WEB_GPT_LIVE_CLI_CODEX_HOME/);
  assert.match(source, /process\.env\.CODEX_CHATGPT_WEB_HOME = cliHome/);
  assert.match(source, /process\.env\.CODEX_HOME = cliCodexHome/);
});

test("CLI lane setup preserves its configured port and recycles unhealthy tunnel state", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(launcherRoot, "..");
  const setup = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live-cli-setup.cjs"), "utf8");
  const lane = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live-cli-lane.cjs"), "utf8");
  const tunnelHelper = fs.readFileSync(path.join(repoRoot, "scripts", "dev-live-cli-tunnel.ts"), "utf8");
  assert.match(setup, /setupPort\(desktopConfig, existingCliConfig\)/);
  assert.match(setup, /existingCliConfig\?\.port/);
  assert.match(setup, /await quiesceExistingLane\(existingCliConfig\)/);
  assert.match(setup, /CODEX_WEB_GPT_LIVE_CLI_REFRESH_ACCOUNT_CAPABILITIES/);
  assert.doesNotMatch(setup, /"--replace-codex-route",\s*"--refresh-account-capabilities"/);
  assert.match(lane, /CLI lane setup requested; draining its daemon before reconfiguration/);
  assert.match(lane, /if \(fs\.existsSync\(setupMarker\)\) \{/);
  assert.match(tunnelHelper, /!current\.ok && current\.processRunning/);
  assert.match(tunnelHelper, /stopTunnel\(config\)/);
});

test("dev:codex defaults isolated sessions to a routed Web model and bypasses the Windows daemon", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-codex.cjs"), "utf8");
  assert.match(source, /CODEX_WEB_GPT_LIVE_CLI_MODEL/);
  assert.match(source, /CODEX_WEB_GPT_LIVE_CLI_EFFORT/);
  assert.match(source, /chatgpt-web\/gpt-5\.6-sol/);
  assert.match(source, /chatgpt-web\/gpt-5\.6-luna/);
  assert.match(source, /case "chatgpt-web\/gpt-5\.6-sol":\s+[\s\S]*?return "high"/);
  assert.match(source, /model_reasoning_effort=/);
  assert.match(source, /explicitReasoningSelection/);
  assert.match(source, /explicitModelSelection/);
  assert.match(source, /command === "resume" \|\| command === "fork"/);
  assert.match(source, /args\.unshift\("--no-daemon"\)/);
  assert.match(source, /exec already uses the direct one-shot path/);
});

test("dev:codex avoids shell execution for Windows npm shims", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-codex.cjs"), "utf8");
  assert.match(source, /firstCommandPath\("codex\.exe"\)/);
  assert.match(source, /windowsNpmShimInvocation/);
  assert.match(source, /node_modules", "@openai", "codex", "bin", "codex\.js"/);
  assert.doesNotMatch(source, /shell:\s*true/);
});
