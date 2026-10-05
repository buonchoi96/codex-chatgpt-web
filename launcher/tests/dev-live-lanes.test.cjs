const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");
const {
  CLI_CONNECTOR_NAME,
  CLI_TUNNEL_ALIAS,
  cliLaneEnvironment,
  normalizeCliLaneConfig,
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
