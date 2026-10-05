const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  cliLaneEnvironment,
  readLaneConfig,
  resolveLiveLanePaths,
  validateCliLaneConfig,
} = require("./dev-live-lanes.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const sourceCli = path.join(repoRoot, "src", "cli.ts");
const tunnelScript = path.join(repoRoot, "scripts", "dev-live-cli-tunnel.ts");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;
const paths = resolveLiveLanePaths();
const env = cliLaneEnvironment(paths, {
  ...process.env,
  CODEX_WEB_GPT_BUN: bun,
  CODEX_CHATGPT_WEB_BUN: bun,
});
const setupMarker = path.join(paths.cliHome, "runtime", "setup-in-progress");

let stopping = false;
let daemon;
let tunnelOwned = false;
let monitorTimer;
let ensureTimer;
let lastConfigFingerprint;
let activeConfig;
let lastTunnelCheckAt = 0;
let lastWaitingMessage;
let lastErrorMessage;

const log = message => process.stdout.write(`[dev-live-cli] ${message}\n`);
const warn = message => process.stderr.write(`[dev-live-cli] ${message}\n`);

function fingerprint(config) {
  return config ? JSON.stringify(config) : "";
}

async function health(config, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function control(config, action, timeoutMs = 2_000) {
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

function runTunnel(action) {
  const result = spawnSync(bun, ["run", tunnelScript, action], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    detail: String(result.stderr || result.stdout || result.error || "").trim(),
  };
}

function routeReady(config) {
  const result = spawnSync(bun, ["run", sourceCli, "route", "status"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  try {
    const status = JSON.parse(String(result.stdout || ""));
    return status.installed === true
      && status.active === true
      && status.errors?.length === 0
      && status.routeUrl === `http://${config.host}:${config.port}/v1`;
  } catch {
    return false;
  }
}

async function waitForDaemon(config, previousPid, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    const state = await health(config);
    if (state?.status === "ok"
      && state.accepting_turns === true
      && Number.isInteger(state.pid)
      && (!previousPid || state.pid !== previousPid)) return state;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return undefined;
}

async function startDaemon(config) {
  const existing = await health(config);
  if (existing?.status === "ok" && existing.accepting_turns === true) return existing;
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    return waitForDaemon(config, undefined);
  }
  const child = spawn(bun, ["run", sourceCli, "serve"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  daemon = child;
  child.once("error", error => warn(`Responses daemon failed to start: ${error.message}`));
  child.once("exit", code => {
    if (daemon === child) daemon = undefined;
    if (!stopping) {
      warn(`Responses daemon exited (${code ?? 0}); scheduling CLI lane recovery`);
      scheduleEnsure(500);
    }
  });
  const ready = await waitForDaemon(config, undefined);
  if (!ready) throw new Error("CLI lane Responses daemon did not become ready within 20 seconds");
  log(`Responses daemon ready on ${config.host}:${config.port} (pid ${ready.pid})`);
  return ready;
}

async function stopDaemon(config, { restart = false } = {}) {
  const before = await health(config);
  if (!before || !Number.isInteger(before.pid)) return;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await control(config, "drain").catch(() => undefined);
    if (!state || (state.active_http_turns === 0 && state.active_browser_turns === 0)) break;
    if (Date.now() >= deadline) {
      warn(`daemon drain timed out with ${state.active_http_turns ?? "?"} HTTP and ${state.active_browser_turns ?? "?"} browser turn(s)`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await control(config, "shutdown", 5_000).catch(error => warn(`daemon shutdown failed: ${error.message}`));
  if (!restart) return;
  const next = await waitForDaemon(config, before.pid, 20_000);
  if (!next) throw new Error("CLI lane daemon did not recover after source reload");
}

function ensureTunnel() {
  const status = runTunnel("status");
  if (status.ok) {
    tunnelOwned = true;
    return;
  }
  const started = runTunnel("start");
  if (!started.ok) throw new Error(`CLI tunnel failed to start${started.detail ? `: ${started.detail}` : ""}`);
  tunnelOwned = true;
  log("dedicated CLI tunnel is healthy and ready");
}

async function ensureLane() {
  if (stopping || fs.existsSync(setupMarker)) return;
  const desktopConfig = readLaneConfig(paths.desktopConfigPath);
  const cliConfig = readLaneConfig(paths.cliConfigPath);
  if (!cliConfig) {
    const message = `CLI lane is not configured yet; run bun run dev:live:cli-setup while dev:live remains open`;
    if (lastWaitingMessage !== message) log(message);
    lastWaitingMessage = message;
    return;
  }
  if (!desktopConfig) {
    const message = "waiting for Desktop live configuration before starting the CLI lane";
    if (lastWaitingMessage !== message) log(message);
    lastWaitingMessage = message;
    return;
  }
  validateCliLaneConfig(cliConfig, desktopConfig, paths);
  if (!fs.existsSync(paths.desktopBrowserDescriptorPath)) {
    const message = "waiting for the Desktop browser host descriptor before starting the CLI lane";
    if (lastWaitingMessage !== message) log(message);
    lastWaitingMessage = message;
    return;
  }

  const nextFingerprint = fingerprint(cliConfig);
  if (lastConfigFingerprint === nextFingerprint && tunnelOwned) {
    const daemonState = await health(cliConfig);
    if (daemonState?.status === "ok" && daemonState.accepting_turns === true
      && Date.now() - lastTunnelCheckAt < 15_000) return;
    if (daemonState?.status === "ok" && daemonState.accepting_turns === true) {
      const tunnelState = runTunnel("status");
      lastTunnelCheckAt = Date.now();
      if (tunnelState.ok) return;
      tunnelOwned = false;
    }
  }
  if (lastConfigFingerprint && lastConfigFingerprint !== nextFingerprint) {
    log("CLI lane config changed; recycling its daemon and tunnel without touching the Desktop lane");
    await stopDaemon(activeConfig || cliConfig).catch(error => warn(error.message));
    const stoppedTunnel = runTunnel("stop");
    if (!stoppedTunnel.ok) warn(`CLI tunnel stop failed: ${stoppedTunnel.detail}`);
    tunnelOwned = false;
  }
  lastConfigFingerprint = nextFingerprint;
  lastWaitingMessage = undefined;

  await startDaemon(cliConfig);
  ensureTunnel();
  lastTunnelCheckAt = Date.now();
  if (!routeReady(cliConfig)) {
    throw new Error(`CLI Codex route in ${paths.cliCodexHome} is not active or does not target the CLI lane`);
  }
  activeConfig = cliConfig;
  lastErrorMessage = undefined;
  log("CLI lane ready: isolated Codex home + Responses daemon + broker + connector + tunnel");
}

function scheduleEnsure(delay = 0) {
  if (stopping || ensureTimer) return;
  ensureTimer = setTimeout(() => {
    ensureTimer = undefined;
    void ensureLane().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastErrorMessage) warn(message);
      lastErrorMessage = message;
    });
  }, delay);
  ensureTimer.unref?.();
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (monitorTimer) clearInterval(monitorTimer);
  if (ensureTimer) clearTimeout(ensureTimer);
  const config = activeConfig || readLaneConfig(paths.cliConfigPath);
  if (config) await stopDaemon(config).catch(error => warn(error.message));
  if (config) {
    const stoppedTunnel = runTunnel("stop");
    if (!stoppedTunnel.ok) warn(`CLI tunnel stop failed: ${stoppedTunnel.detail}`);
  }
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    try { daemon.kill("SIGTERM"); } catch {}
  }
  process.exitCode = exitCode;
}

async function main() {
  if ((process.argv[2] ?? "supervise") !== "supervise") {
    throw new Error("DEV live CLI lane accepts only the supervise action");
  }
  fs.mkdirSync(paths.cliHome, { recursive: true, mode: 0o700 });
  log(`home: ${paths.cliHome}`);
  log(`Codex home: ${paths.cliCodexHome}`);
  await ensureLane();
  monitorTimer = setInterval(() => scheduleEnsure(), 1_000);
  monitorTimer.unref?.();
}

process.once("SIGINT", () => { void stop(0); });
process.once("SIGTERM", () => { void stop(0); });

main().catch(error => {
  warn(error instanceof Error ? error.message : String(error));
  void stop(1);
});
