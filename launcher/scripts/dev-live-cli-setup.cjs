const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:net");
const { spawnSync } = require("node:child_process");
const {
  CLI_CONNECTOR_NAME,
  CLI_TUNNEL_ALIAS,
  cliLaneEnvironment,
  normalizeCliLaneConfig,
  readLaneConfig,
  resolveLiveLanePaths,
  validateCliLaneConfig,
  writeJsonFileAtomic,
} = require("./dev-live-lanes.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const sourceCli = path.join(repoRoot, "src", "cli.ts");
const tunnelScript = path.join(repoRoot, "scripts", "dev-live-cli-tunnel.ts");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;
const paths = resolveLiveLanePaths();
const setupMarker = path.join(paths.cliHome, "runtime", "setup-in-progress");

function fail(message) {
  process.stderr.write(`[dev-live-cli-setup] ${message}\n`);
  process.exitCode = 1;
}

async function health(config, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function control(config, action, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok) throw new Error(`${action} returned HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function portAvailable(host, port) {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function stopExistingTunnel() {
  const result = spawnSync(bun, ["run", tunnelScript, "stop"], {
    cwd: repoRoot,
    env: cliLaneEnvironment(paths, {
      ...process.env,
      CODEX_WEB_GPT_BUN: bun,
      CODEX_CHATGPT_WEB_BUN: bun,
    }),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`Could not pause the existing CLI tunnel${detail ? `: ${detail}` : ""}`);
  }
}

async function quiesceExistingLane(config) {
  if (!config) return;

  const initial = await health(config);
  if (initial?.status === "ok") {
    process.stdout.write("[dev-live-cli-setup] pausing the running CLI lane before reconfiguration\n");
    const deadline = Date.now() + 15_000;
    for (;;) {
      const state = await control(config, "drain").catch(() => undefined);
      if (!state || (state.active_http_turns === 0 && state.active_browser_turns === 0)) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the CLI lane to become idle (${state.active_http_turns ?? "?"} HTTP, `
          + `${state.active_browser_turns ?? "?"} browser turn(s))`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await control(config, "shutdown", 5_000).catch(() => undefined);
  }

  stopExistingTunnel();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await portAvailable(config.host, config.port)) return;
    const state = await health(config);
    if (state?.status === "ok") await control(config, "shutdown", 2_000).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(
    `CLI lane port ${config.host}:${config.port} is still busy after pausing dev:live; `
    + "check for a foreign process using that port",
  );
}

function shouldRefreshAccountCapabilities(existingCliConfig) {
  if (process.env.CODEX_WEB_GPT_LIVE_CLI_REFRESH_ACCOUNT_CAPABILITIES === "1") return true;
  return !existingCliConfig
    || typeof existingCliConfig.solAvailable !== "boolean"
    || typeof existingCliConfig.extraHighAvailable !== "boolean"
    || typeof existingCliConfig.proAvailable !== "boolean";
}

function setupPort(desktopConfig, existingCliConfig) {
  const override = Number(process.env.CODEX_WEB_GPT_LIVE_CLI_PORT || 0);
  if (override) {
    if (!Number.isInteger(override) || override < 1 || override > 65_535) {
      throw new Error("CODEX_WEB_GPT_LIVE_CLI_PORT must be an integer from 1 to 65535");
    }
    if (override === desktopConfig.port) throw new Error("CLI lane port must differ from the Desktop lane port");
    return override;
  }
  if (Number.isInteger(existingCliConfig?.port)
    && existingCliConfig.port >= 1
    && existingCliConfig.port <= 65_535
    && existingCliConfig.port !== desktopConfig.port) {
    return existingCliConfig.port;
  }
  const candidate = desktopConfig.port < 65_535 ? desktopConfig.port + 1 : 17_842;
  if (candidate === desktopConfig.port) throw new Error("Could not choose a distinct CLI lane port");
  return candidate;
}

function mirroredOptions(desktopConfig) {
  const args = [
    "--subagent-protocol", desktopConfig.subagentProtocol === "native" ? "native" : "compatibility-v1",
    desktopConfig.experimentalBiggerContext === true ? "--bigger-context" : "--standard-context",
    desktopConfig.experimentalSkillAttachments === true ? "--skill-attachments" : "--inline-skills",
    desktopConfig.experimentalFreshConversationPerTurn === true ? "--fresh-conversation" : "--retained-conversation",
    desktopConfig.useSavedChats === true ? "--saved-chats" : "--temporary-chats",
    desktopConfig.nativeFullAccess === true ? "--native-full-access" : "--native-default-access",
  ];
  if (desktopConfig.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
  if (Number.isInteger(desktopConfig.autoCompactPercent)) {
    args.push("--auto-compact-percent", String(desktopConfig.autoCompactPercent));
  }
  return args;
}

async function main() {
  const desktopConfig = readLaneConfig(paths.desktopConfigPath);
  if (!desktopConfig) {
    throw new Error(`Desktop live config is not ready at ${paths.desktopConfigPath}; start bun run dev:live and finish Desktop setup first`);
  }
  if (desktopConfig.mode !== "full") {
    throw new Error("Desktop live lane must be configured in Full harness mode before configuring the CLI lane");
  }
  if (!fs.existsSync(paths.desktopBrowserDescriptorPath)) {
    throw new Error(`Desktop browser host is not ready at ${paths.desktopBrowserDescriptorPath}; keep bun run dev:live running`);
  }
  const existingCliConfig = readLaneConfig(paths.cliConfigPath);

  fs.mkdirSync(path.dirname(setupMarker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(setupMarker, `${process.pid}\n`, { flag: "w", mode: 0o600 });
  try {
    await quiesceExistingLane(existingCliConfig);

    const args = [
      "run", sourceCli,
      "setup",
      "--full",
      "--port", String(setupPort(desktopConfig, existingCliConfig)),
      "--browser-host-descriptor", paths.desktopBrowserDescriptorPath,
      "--automatic-browser-interaction",
      "--connector-name-suffix", CLI_CONNECTOR_NAME.slice("Codex ".length),
      "--replace-codex-route",
      "--acknowledge-unofficial",
      ...mirroredOptions(desktopConfig),
    ];
    if (shouldRefreshAccountCapabilities(existingCliConfig)) args.push("--refresh-account-capabilities");
    const tunnelId = process.env.CODEX_WEB_GPT_LIVE_CLI_TUNNEL_ID?.trim();
    const runtimeKeyFile = process.env.CODEX_WEB_GPT_LIVE_CLI_RUNTIME_KEY_FILE?.trim();
    if (tunnelId) args.push("--tunnel-id", tunnelId);
    if (runtimeKeyFile) args.push("--runtime-key-file", path.resolve(runtimeKeyFile));

    const result = spawnSync(bun, args, {
      cwd: repoRoot,
      env: cliLaneEnvironment(paths),
      stdio: "inherit",
      windowsHide: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`CLI lane setup exited with status ${result.status ?? 1}`);

    const configured = readLaneConfig(paths.cliConfigPath);
    if (!configured) throw new Error("CLI lane setup completed without a readable config.json");
    const normalized = normalizeCliLaneConfig(configured);
    writeJsonFileAtomic(paths.cliConfigPath, normalized);
    validateCliLaneConfig(normalized, desktopConfig, paths);

    process.stdout.write(`\nDEV live CLI lane configured.\n`);
    process.stdout.write(`  Connector: ${CLI_CONNECTOR_NAME}\n`);
    process.stdout.write(`  Tunnel alias/profile: ${CLI_TUNNEL_ALIAS}\n`);
    process.stdout.write(`  Home: ${paths.cliHome}\n`);
    process.stdout.write(`  Codex home: ${paths.cliCodexHome}\n`);
    process.stdout.write("Create/attach the ChatGPT connector above to the CLI lane's dedicated Tunnel ID, then keep dev:live running.\n");
    process.stdout.write("Run CLI tests with: bun run dev:codex -- <codex arguments>\n");
    process.stdout.write("The CLI lane has an isolated CODEX_HOME; if Codex asks for authentication, run bun run dev:codex -- login once.\n");
  } finally {
    fs.rmSync(setupMarker, { force: true });
  }
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});
