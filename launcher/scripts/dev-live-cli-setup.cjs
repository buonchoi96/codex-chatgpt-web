const fs = require("node:fs");
const path = require("node:path");
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
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;
const paths = resolveLiveLanePaths();
const setupMarker = path.join(paths.cliHome, "runtime", "setup-in-progress");

function fail(message) {
  process.stderr.write(`[dev-live-cli-setup] ${message}\n`);
  process.exitCode = 1;
}

function setupPort(desktopConfig) {
  const override = Number(process.env.CODEX_WEB_GPT_LIVE_CLI_PORT || 0);
  if (override) {
    if (!Number.isInteger(override) || override < 1 || override > 65_535) {
      throw new Error("CODEX_WEB_GPT_LIVE_CLI_PORT must be an integer from 1 to 65535");
    }
    if (override === desktopConfig.port) throw new Error("CLI lane port must differ from the Desktop lane port");
    return override;
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

function main() {
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

  fs.mkdirSync(path.dirname(setupMarker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(setupMarker, `${process.pid}\n`, { flag: "w", mode: 0o600 });
  try {
    const args = [
      "run", sourceCli,
      "setup",
      "--full",
      "--port", String(setupPort(desktopConfig)),
      "--browser-host-descriptor", paths.desktopBrowserDescriptorPath,
      "--automatic-browser-interaction",
      "--connector-name-suffix", CLI_CONNECTOR_NAME.slice("Codex ".length),
      "--replace-codex-route",
      "--refresh-account-capabilities",
      "--acknowledge-unofficial",
      ...mirroredOptions(desktopConfig),
    ];
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

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
