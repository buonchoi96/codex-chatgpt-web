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
  const args = [...invocation.prefixArgs, ...process.argv.slice(2)];
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
