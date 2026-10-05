const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI_CONNECTOR_NAME = "Codex Native2 CLI DEV";
const CLI_TUNNEL_ALIAS = "codex-chatgpt-web-live-cli";
const DEFAULT_LIVE_HOME_NAME = ".codex-chatgpt-web-live";
const DEFAULT_CLI_LANE_DIR = "cli-lane";

function resolveUserPath(value, homeDir = os.homedir()) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(homeDir, value.slice(2));
  return path.resolve(value);
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function resolveLiveLanePaths(environment = process.env, homeDir = os.homedir()) {
  const desktopHome = resolveUserPath(
    environment.CODEX_WEB_GPT_LIVE_HOME?.trim() || path.join(homeDir, DEFAULT_LIVE_HOME_NAME),
    homeDir,
  );
  const cliHome = resolveUserPath(
    environment.CODEX_WEB_GPT_LIVE_CLI_HOME?.trim() || path.join(desktopHome, DEFAULT_CLI_LANE_DIR),
    homeDir,
  );
  if (samePath(desktopHome, cliHome)) {
    throw new Error("DEV live Desktop and CLI lanes must use different homes");
  }
  const cliCodexHome = resolveUserPath(
    environment.CODEX_WEB_GPT_LIVE_CLI_CODEX_HOME?.trim() || path.join(cliHome, "codex-home"),
    homeDir,
  );
  const defaultCodexHome = resolveUserPath(
    environment.CODEX_HOME?.trim() || path.join(homeDir, ".codex"),
    homeDir,
  );
  if (samePath(cliCodexHome, defaultCodexHome)) {
    throw new Error("DEV live CLI Codex home must differ from the Desktop/default Codex home");
  }
  return {
    desktopHome,
    cliHome,
    cliCodexHome,
    desktopConfigPath: path.join(desktopHome, "config.json"),
    cliConfigPath: path.join(cliHome, "config.json"),
    desktopBrowserDescriptorPath: path.join(desktopHome, "runtime", "launcher-browser.json"),
  };
}

function cliLaneEnvironment(paths, environment = process.env) {
  const child = {
    ...environment,
    CODEX_CHATGPT_WEB_HOME: paths.cliHome,
    CODEX_HOME: paths.cliCodexHome,
    CODEX_WEB_GPT_LIVE_MODE: "1",
    CODEX_WEB_GPT_LIVE_LANE: "cli",
  };
  delete child.CODEX_WEB_GPT_LAUNCHER_DATA_DIR;
  delete child.CODEX_WEB_GPT_LIVE_TUNNEL_LEASE;
  delete child.CODEX_WEB_GPT_DEV_HOME;
  return child;
}

function readJsonFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return undefined;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readLaneConfig(filePath) {
  const value = readJsonFile(filePath);
  if (!value || value.version !== 3 || typeof value.host !== "string" || !Number.isInteger(value.port)) return undefined;
  return value;
}

function activeAutomaticTunnel(config) {
  if (!config || config.mode !== "full") return undefined;
  return config.automaticTunnel || config.tunnel;
}

function normalizedPath(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
}

function validateCliLaneConfig(cliConfig, desktopConfig, paths) {
  if (!cliConfig || cliConfig.mode !== "full") {
    throw new Error("DEV live CLI lane must be configured in Full harness mode");
  }
  if (cliConfig.browserInteractionMode !== "automatic") {
    throw new Error("DEV live CLI lane currently requires Automatic browser interaction");
  }
  if (cliConfig.browserHost !== "launcher") {
    throw new Error("DEV live CLI lane must reuse the source launcher's browser host");
  }
  if (normalizedPath(cliConfig.browserHostDescriptorPath) !== normalizedPath(paths.desktopBrowserDescriptorPath)) {
    throw new Error("DEV live CLI lane browser descriptor does not match the Desktop lane");
  }
  if (cliConfig.appName !== CLI_CONNECTOR_NAME || cliConfig.automaticAppName !== CLI_CONNECTOR_NAME) {
    throw new Error(`DEV live CLI lane must use ChatGPT connector ${JSON.stringify(CLI_CONNECTOR_NAME)}`);
  }
  const cliTunnel = activeAutomaticTunnel(cliConfig);
  if (!cliTunnel || !/^tunnel_[a-f0-9]{32}$/.test(cliTunnel.tunnelId || "")) {
    throw new Error("DEV live CLI lane has no valid dedicated Tunnel ID");
  }
  if (cliTunnel.alias !== CLI_TUNNEL_ALIAS || cliTunnel.profileName !== CLI_TUNNEL_ALIAS) {
    throw new Error(`DEV live CLI lane tunnel alias/profile must be ${CLI_TUNNEL_ALIAS}`);
  }
  if (desktopConfig) {
    if (desktopConfig.port === cliConfig.port) {
      throw new Error("DEV live Desktop and CLI lanes must use different Responses ports");
    }
    if (desktopConfig.brokerSocketPath === cliConfig.brokerSocketPath) {
      throw new Error("DEV live Desktop and CLI lanes must use different MCP broker endpoints");
    }
    if (desktopConfig.controlToken === cliConfig.controlToken) {
      throw new Error("DEV live Desktop and CLI lanes must use different control tokens");
    }
    if (desktopConfig.appName === cliConfig.appName) {
      throw new Error("DEV live Desktop and CLI lanes must use different ChatGPT connector names");
    }
    const desktopTunnel = activeAutomaticTunnel(desktopConfig);
    if (desktopTunnel) {
      if (desktopTunnel.tunnelId === cliTunnel.tunnelId) {
        throw new Error("DEV live Desktop and CLI lanes require different Tunnel IDs");
      }
      if (desktopTunnel.alias === cliTunnel.alias) {
        throw new Error("DEV live Desktop and CLI lanes require different tunnel aliases");
      }
      if (desktopTunnel.profileName === cliTunnel.profileName) {
        throw new Error("DEV live Desktop and CLI lanes require different tunnel profiles");
      }
    }
  }
  return cliConfig;
}

function normalizeCliLaneConfig(config) {
  const next = structuredClone(config);
  const active = activeAutomaticTunnel(next);
  if (!active) throw new Error("DEV live CLI setup did not produce an Automatic tunnel configuration");
  const isolatedTunnel = {
    ...active,
    alias: CLI_TUNNEL_ALIAS,
    profileName: CLI_TUNNEL_ALIAS,
  };
  next.appName = CLI_CONNECTOR_NAME;
  next.automaticAppName = CLI_CONNECTOR_NAME;
  next.browserInteractionMode = "automatic";
  next.tunnel = isolatedTunnel;
  next.automaticTunnel = isolatedTunnel;
  return next;
}

function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

module.exports = {
  CLI_CONNECTOR_NAME,
  CLI_TUNNEL_ALIAS,
  activeAutomaticTunnel,
  cliLaneEnvironment,
  normalizeCliLaneConfig,
  readLaneConfig,
  resolveLiveLanePaths,
  samePath,
  validateCliLaneConfig,
  writeJsonFileAtomic,
};
