const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  cliLaneEnvironment,
  readLaneConfig,
  resolveLiveLanePaths,
  validateCliLaneConfig,
} = require("./dev-live-lanes.cjs");

const paths = resolveLiveLanePaths();

const SESSION_SUBCOMMANDS = new Set(["exec", "resume", "fork"]);
const NON_SESSION_SUBCOMMANDS = new Set([
  "login",
  "logout",
  "mcp",
  "app-server",
  "completion",
  "sandbox",
  "features",
  "doctor",
  "apply",
  "cloud",
  "debug",
]);

function hasFlag(args, longName, shortName) {
  return args.some(arg => (
    arg === longName
    || arg === shortName
    || arg.startsWith(`${longName}=`)
    || (shortName && arg.startsWith(`${shortName}=`))
  ));
}

function optionValue(args, longName, shortName) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === longName || arg === shortName) return args[index + 1];
    if (arg.startsWith(`${longName}=`)) return arg.slice(longName.length + 1);
    if (shortName && arg.startsWith(`${shortName}=`)) return arg.slice(shortName.length + 1);
  }
  return undefined;
}

function explicitProfileSelection(args) {
  return hasFlag(args, "--profile", "-p");
}

function explicitModelSelection(args) {
  return hasFlag(args, "--model", "-m") || explicitProfileSelection(args);
}

function configOverrideValue(args, key) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let override;
    if (arg === "-c" || arg === "--config") override = args[index + 1];
    else if (arg.startsWith("--config=")) override = arg.slice("--config=".length);
    else if (arg.startsWith("-c") && arg.length > 2) override = arg.slice(2);
    if (typeof override !== "string") continue;
    const separator = override.indexOf("=");
    if (separator < 0) continue;
    if (override.slice(0, separator).trim() === key) return override.slice(separator + 1).trim();
  }
  return undefined;
}

function explicitReasoningSelection(args) {
  return explicitProfileSelection(args)
    || configOverrideValue(args, "model_reasoning_effort") !== undefined;
}

function sessionSubcommand(args) {
  return args.find(arg => SESSION_SUBCOMMANDS.has(arg) || NON_SESSION_SUBCOMMANDS.has(arg));
}

function isSessionInvocation(args) {
  const command = sessionSubcommand(args);
  return command === undefined || SESSION_SUBCOMMANDS.has(command);
}

function defaultCliModel(config) {
  const override = process.env.CODEX_WEB_GPT_LIVE_CLI_MODEL?.trim();
  if (override) return override;
  return config.solAvailable === false
    ? "chatgpt-web/gpt-5.6-luna"
    : "chatgpt-web/gpt-5.6-sol";
}

function defaultReasoningEffort(model) {
  const override = process.env.CODEX_WEB_GPT_LIVE_CLI_EFFORT?.trim();
  if (override) return override;
  switch (model) {
    case "chatgpt-web/gpt-5.6-sol":
    case "chatgpt-web/high":
      return "high";
    case "chatgpt-web/gpt-5.6-sol-instant":
    case "chatgpt-web/gpt-5.6-luna":
    case "chatgpt-web/light":
      return "low";
    case "chatgpt-web/medium":
      return "medium";
    case "chatgpt-web/extra-high":
      return "xhigh";
    case "chatgpt-web/gpt-5.6-pro":
    case "chatgpt-web/gpt-6-pro":
      return "max";
    case "chatgpt-web/pro":
      return "ultra";
    default:
      return undefined;
  }
}

function normalizeCodexArgs(rawArgs, config, platform = process.platform) {
  const args = [...rawArgs];
  const session = isSessionInvocation(rawArgs);
  let defaultedModel;
  let defaultedEffort;
  let disabledDaemon = false;

  if (session && !explicitModelSelection(rawArgs)) {
    defaultedModel = defaultCliModel(config);
    args.unshift("--model", defaultedModel);
  }

  const selectedModel = defaultedModel || optionValue(rawArgs, "--model", "-m");
  if (session && selectedModel && !explicitReasoningSelection(rawArgs)) {
    defaultedEffort = defaultReasoningEffort(selectedModel);
    if (defaultedEffort) {
      args.unshift("-c", `model_reasoning_effort="${defaultedEffort}"`);
    }
  }

  const command = sessionSubcommand(rawArgs);
  const interactiveDaemonPath = command === undefined || command === "resume" || command === "fork";
  if (platform === "win32" && interactiveDaemonPath && !hasFlag(rawArgs, "--no-daemon")) {
    // Codex 0.157.x can fail to detach its managed app-server daemon when the parent is already
    // constrained by a Windows Job Object. DEV live does not need that shared daemon, so bypass it
    // only for TUI/resume/fork; exec already uses the direct one-shot path.
    args.unshift("--no-daemon");
    disabledDaemon = true;
  }

  return { args, defaultedModel, defaultedEffort, disabledDaemon };
}

function firstCommandPath(name) {
  const locator = process.platform === "win32"
    ? spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", [name], { encoding: "utf8" });
  if (locator.error || locator.status !== 0) return undefined;
  return String(locator.stdout || "")
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(Boolean);
}

function windowsNpmShimInvocation(shimPath) {
  const directory = path.dirname(shimPath);
  const codexJs = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!fs.existsSync(codexJs)) {
    throw new Error(
      `Codex resolved to ${shimPath}, but its npm entrypoint was not found at ${codexJs}. `
      + "Set CODEX_WEB_GPT_CODEX_BIN to a native codex.exe instead of using an unsafe shell fallback.",
    );
  }
  const localNode = path.join(directory, "node.exe");
  const node = fs.existsSync(localNode) ? localNode : firstCommandPath("node.exe");
  if (!node) {
    throw new Error(
      "Codex is installed through a Windows .cmd shim, but node.exe could not be resolved. "
      + "Set CODEX_WEB_GPT_CODEX_BIN to a native codex.exe.",
    );
  }
  return { command: node, prefixArgs: [codexJs] };
}

function codexInvocationForPath(executable) {
  const resolved = path.resolve(executable);
  if (process.platform !== "win32") return { command: resolved, prefixArgs: [] };
  if (/\.(?:cmd|bat)$/i.test(resolved)) return windowsNpmShimInvocation(resolved);
  if (/\.js$/i.test(resolved)) {
    const node = firstCommandPath("node.exe");
    if (!node) throw new Error("node.exe is required to launch a Codex JavaScript entrypoint");
    return { command: node, prefixArgs: [resolved] };
  }
  return { command: resolved, prefixArgs: [] };
}

function findCodexInvocation() {
  const override = process.env.CODEX_WEB_GPT_CODEX_BIN?.trim();
  if (override) return codexInvocationForPath(override);

  if (process.platform === "win32") {
    const nativeExecutable = firstCommandPath("codex.exe");
    if (nativeExecutable) return { command: nativeExecutable, prefixArgs: [] };
    const shim = firstCommandPath("codex.cmd") || firstCommandPath("codex.bat");
    if (shim) return windowsNpmShimInvocation(shim);
    throw new Error(
      "Could not locate codex.exe or a supported npm Codex shim; "
      + "set CODEX_WEB_GPT_CODEX_BIN to the Codex CLI executable.",
    );
  }

  const executable = firstCommandPath("codex");
  if (!executable) {
    throw new Error("Could not locate the Codex CLI; set CODEX_WEB_GPT_CODEX_BIN to its executable path");
  }
  return { command: executable, prefixArgs: [] };
}

async function health(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const desktopConfig = readLaneConfig(paths.desktopConfigPath);
  const cliConfig = readLaneConfig(paths.cliConfigPath);
  if (!desktopConfig || !cliConfig) {
    throw new Error(
      "DEV live Desktop/CLI lane configuration is incomplete; "
      + "run bun run dev:live and bun run dev:live:cli-setup first",
    );
  }
  validateCliLaneConfig(cliConfig, desktopConfig, paths);
  const runtime = await health(cliConfig);
  if (runtime?.status !== "ok" || runtime.accepting_turns !== true) {
    throw new Error(
      "DEV live CLI lane is not ready; keep bun run dev:live running "
      + "and check the [dev-live-cli] diagnostics",
    );
  }

  const invocation = findCodexInvocation();
  const normalized = normalizeCodexArgs(process.argv.slice(2), cliConfig);
  if (normalized.defaultedModel) {
    process.stdout.write(
      `[dev-codex] default model: ${normalized.defaultedModel} (pass -m/--model or --profile to override)\n`,
    );
  }
  if (normalized.defaultedEffort) {
    process.stdout.write(
      `[dev-codex] compatible reasoning effort: ${normalized.defaultedEffort} `
      + "(pass -c model_reasoning_effort=... or --profile to override)\n",
    );
  }
  if (normalized.disabledDaemon) {
    process.stdout.write("[dev-codex] Windows DEV TUI: using --no-daemon to avoid Job Object detach failures\n");
  }
  const args = [...invocation.prefixArgs, ...normalized.args];
  const child = spawn(invocation.command, args, {
    cwd: process.cwd(),
    env: cliLaneEnvironment(paths),
    stdio: "inherit",
    windowsHide: false,
  });
  child.once("error", error => {
    process.stderr.write(`[dev-codex] ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`[dev-codex] Codex exited from signal ${signal}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

main().catch(error => {
  process.stderr.write(`[dev-codex] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
