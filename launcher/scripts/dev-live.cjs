const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { createLiveTunnelLease, removeLiveTunnelLease } = require("../electron/live-tunnel-lease.cjs");
const { readLaneConfig, resolveLiveLanePaths } = require("./dev-live-lanes.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const vitePackage = require.resolve("vite/package.json", { paths: [launcherRoot] });
const viteBin = path.join(path.dirname(vitePackage), "bin", "vite.js");
const electronBin = require("electron");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;
const {
  drainRuntimeForElectronRestart,
  recoverableTunnelHandoff,
  waitForElectronShutdown,
  waitForReplacementRuntime,
} = require("./dev-live-lifecycle.cjs");
function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

const liveLanePaths = resolveLiveLanePaths(process.env, os.homedir());
const liveHome = liveLanePaths.desktopHome;
const liveCliHome = liveLanePaths.cliHome;
const productionHome = resolveUserPath(
  process.env.CODEX_CHATGPT_WEB_HOME || path.join(os.homedir(), ".codex-chatgpt-web"),
);
const liveUserData = path.join(liveHome, "launcher");
const liveTunnelLeasePath = path.join(liveHome, "runtime", "live-tunnel-handoff.json");
const runtimeStatePath = path.join(liveHome, "runtime", "launcher-supervisor.json");
const liveTunnelSessionId = randomUUID().replaceAll("-", "");
const preferredVitePort = Number(process.env.CODEX_WEB_GPT_LIVE_VITE_PORT || 4178);
let vitePort = preferredVitePort;
let viteUrl = `http://127.0.0.1:${vitePort}`;
const reloadDelayMs = 250;
const idleRestartTimeoutMs = Number(process.env.CODEX_WEB_GPT_LIVE_RESTART_TIMEOUT_MS || 60_000);

let vite;
let electron;
let cliLaneSupervisor;
let cliLaneRetryTimer;
let stopped = false;
let ownsLiveLease = false;
let electronRestarting = false;
let electronReloadInFlight = false;
let reloadTimer;
let electronRetryTimer;
let routeTimer;
let liveRouteConnected = false;
let productionRouteWasActive = false;
let viteRestartTimer;
let reloadRunning = false;
let reloadAgain = false;
const watchers = [];
const pending = { runtime: false, electron: false };

const log = message => process.stdout.write(`[dev-live] ${message}\n`);
const warn = message => process.stderr.write(`[dev-live] ${message}\n`);

function liveEnvironment(extra = {}) {
  const env = {
    ...process.env,
    CODEX_CHATGPT_WEB_HOME: liveHome,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: liveUserData,
    CODEX_WEB_GPT_LIVE_MODE: "1",
    CODEX_WEB_GPT_LIVE_TUNNEL_LEASE: liveTunnelLeasePath,
    CODEX_WEB_GPT_BUN: bun,
    CODEX_CHATGPT_WEB_BUN: bun,
    ...extra,
  };
  delete env.CODEX_WEB_GPT_DEV_HOME;
  return env;
}

function productionRouteEnvironment() {
  const env = {
    ...process.env,
    CODEX_CHATGPT_WEB_HOME: productionHome,
    CODEX_WEB_GPT_BUN: bun,
    CODEX_CHATGPT_WEB_BUN: bun,
  };
  delete env.CODEX_WEB_GPT_DEV_HOME;
  delete env.CODEX_WEB_GPT_LIVE_MODE;
  delete env.CODEX_WEB_GPT_LIVE_TUNNEL_LEASE;
  delete env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR;
  return env;
}

function installedWindowsLauncherRunning() {
  if (process.platform !== "win32") return false;
  try {
    const output = execFileSync(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq Codex Web GPT.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    return /Codex Web GPT\.exe/i.test(output);
  } catch {
    return false;
  }
}

function assertProductionLauncherStopped() {
  if (!installedWindowsLauncherRunning()) return;
  throw new Error(
    "The installed Codex Web GPT launcher is still running. Quit it before dev:live so the source launcher can exclusively own Codex Native2 and its tunnel.",
  );
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: options.stdio || "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with status ${result.status ?? 1}`);
}

function buildBrowserHelper() {
  const started = Date.now();
  runChecked(bun, ["run", "scripts/build-browser-helper.ts"], { cwd: repoRoot });
  log(`browser helper rebuilt in ${Date.now() - started} ms`);
}

async function freeLoopbackPort(preferredPort) {
  const canBind = port => new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address && typeof address === "object" ? address.port : false));
    });
  });
  if (Number.isInteger(preferredPort) && preferredPort > 0 && preferredPort <= 65_535) {
    const preferred = await canBind(preferredPort);
    if (preferred) return preferredPort;
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForVite() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(viteUrl);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Vite did not become ready on ${viteUrl}`);
}

function startVite() {
  const child = spawn(process.execPath, [
    viteBin,
    "--host", "127.0.0.1",
    "--port", String(vitePort),
    "--strictPort",
  ], {
    cwd: launcherRoot,
    stdio: "inherit",
    env: process.env,
  });
  vite = child;
  const recover = reason => {
    if (vite === child) vite = undefined;
    if (stopped || viteRestartTimer) return;
    warn(`Vite ${reason}; restarting dev server without stopping the live runtime`);
    viteRestartTimer = setTimeout(() => {
      viteRestartTimer = undefined;
      if (stopped || vite) return;
      startVite();
      void waitForVite().then(async () => {
        log(`Vite recovered on ${viteUrl}`);
        if (!stopped && electron) await restartElectron();
      }).catch(error => warn(`Vite recovery failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 500);
  };
  child.once("error", error => recover(`failed to start: ${error.message}`));
  child.once("exit", code => {
    if (!stopped) recover(`exited with code ${code ?? 0}`);
  });
}

function startElectron() {
  electronRestarting = false;
  electron = spawn(electronBin, [launcherRoot], {
    cwd: launcherRoot,
    stdio: "inherit",
    env: liveEnvironment({ VITE_DEV_SERVER_URL: viteUrl }),
  });
  const child = electron;
  electron.once("error", error => {
    warn(`Electron failed to start: ${error.message}`);
    if (!stopped) void stop(1);
  });
  electron.once("exit", code => {
    electron = undefined;
    if (stopped || electronRestarting) return;
    warn(`Electron exited unexpectedly (${code ?? 0}); restarting source launcher`);
    setTimeout(() => {
      if (!stopped && !electron) {
        if (electronRetryTimer) clearTimeout(electronRetryTimer);
        electronRetryTimer = undefined;
        void restartElectron();
      }
    }, 500);
  });
  log(`source launcher started with persistent state at ${liveHome}`);
  return child;
}

function startCliLaneSupervisor() {
  if (stopped || cliLaneSupervisor) return;
  const child = spawn(bun, [
    "run",
    path.join(launcherRoot, "scripts", "dev-live-cli-lane.cjs"),
    "supervise",
  ], {
    cwd: launcherRoot,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_WEB_GPT_LIVE_HOME: liveHome,
      CODEX_WEB_GPT_LIVE_CLI_HOME: liveCliHome,
      CODEX_WEB_GPT_BUN: bun,
      CODEX_CHATGPT_WEB_BUN: bun,
    },
  });
  cliLaneSupervisor = child;
  child.once("error", error => {
    warn(`CLI lane supervisor failed to start: ${error.message}`);
  });
  child.once("exit", code => {
    if (cliLaneSupervisor === child) cliLaneSupervisor = undefined;
    if (stopped) return;
    warn(`CLI lane supervisor exited (${code ?? 0}); restarting it without touching the Desktop tunnel`);
    clearTimeout(cliLaneRetryTimer);
    cliLaneRetryTimer = setTimeout(() => {
      cliLaneRetryTimer = undefined;
      startCliLaneSupervisor();
    }, 1_000);
  });
}

async function stopCliLaneSupervisor() {
  clearTimeout(cliLaneRetryTimer);
  cliLaneRetryTimer = undefined;
  const child = cliLaneSupervisor;
  cliLaneSupervisor = undefined;
  if (!child) return;
  await waitForElectronExit(child, 15_000);
}

async function waitForElectronExit(child, timeoutMs = 10_000, { forceKill = true } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = await new Promise(resolve => {
    let settled = false;
    const done = didExit => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(didExit);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
    if (child.exitCode !== null || child.signalCode !== null) done(true);
    else {
      try { child.kill("SIGTERM"); } catch { done(false); }
    }
  });
  if (!exited && forceKill && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && Number.isInteger(child.pid)) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try { child.kill("SIGKILL"); } catch {}
    }
    return true;
  }
  return exited || child.exitCode !== null || child.signalCode !== null;
}

function readRuntimeState() {
  try {
    const stat = fs.lstatSync(runtimeStatePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return undefined;
    const state = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)
      || !Number.isSafeInteger(state.ownerPid) || state.ownerPid < 1
      || !(state.daemonPid === null || (Number.isSafeInteger(state.daemonPid) && state.daemonPid > 0))
      || !(state.tunnelPid === null || (Number.isSafeInteger(state.tunnelPid) && state.tunnelPid > 0))
      || (state.tunnelHealthFingerprint !== undefined
        && (typeof state.tunnelHealthFingerprint !== "string"
          || !/^[a-f0-9]{64}$/.test(state.tunnelHealthFingerprint)))
      || typeof state.status !== "string") return undefined;
    return state;
  } catch {
    return undefined;
  }
}

function pidRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function configuredTunnelIdentity(config) {
  if (config?.mode !== "full" || !config.tunnel
    || typeof config.tunnel.alias !== "string"
    || typeof config.tunnel.tunnelId !== "string") return undefined;
  return {
    alias: config.tunnel.alias,
    tunnelIdHash: createHash("sha256").update(config.tunnel.tunnelId).digest("hex"),
  };
}

function sameTunnelIdentity(actual, expected) {
  return Boolean(actual && expected
    && actual.alias === expected.alias
    && actual.tunnelIdHash === expected.tunnelIdHash);
}

function scheduleElectronRestartRetry() {
  if (stopped || electronRetryTimer) return;
  electronRetryTimer = setTimeout(() => {
    electronRetryTimer = undefined;
    if (!stopped) void restartElectron();
  }, 5_000);
}

async function restartElectron() {
  if (stopped || electronReloadInFlight) return false;
  electronReloadInFlight = true;
  try {
    const cliConfigBeforeReload = liveCliConfig();
    const cliStateBeforeReload = cliConfigBeforeReload ? await health(cliConfigBeforeReload) : undefined;
    if ((cliStateBeforeReload?.active_http_turns ?? 0) > 0
      || (cliStateBeforeReload?.active_browser_turns ?? 0) > 0) {
      warn(
        `Electron reload deferred because the isolated CLI lane still has ${cliStateBeforeReload.active_http_turns ?? "?"} HTTP `
        + `and ${cliStateBeforeReload.active_browser_turns ?? "?"} browser turn(s)`,
      );
      scheduleElectronRestartRetry();
      return false;
    }

    const configPresent = fs.existsSync(path.join(liveHome, "config.json"));
    const config = liveConfig();
    if (configPresent && !config) {
      warn("Electron reload deferred because the live runtime configuration could not be read safely");
      scheduleElectronRestartRetry();
      return false;
    }
    const previousState = config ? readRuntimeState() : undefined;
    const expectedTunnelIdentity = configuredTunnelIdentity(config);
    const runtimeReady = previousState?.status === "ready"
      && Number.isSafeInteger(previousState.daemonPid)
      && previousState.daemonPid > 0;
    const handoffRecovery = config?.mode === "full"
      && recoverableTunnelHandoff(previousState, pidRunning);
    if (config && !runtimeReady && !handoffRecovery) {
      warn("Electron reload deferred because the live runtime ownership state is not ready");
      scheduleElectronRestartRetry();
      return false;
    }
    if (config?.mode === "full"
      && !sameTunnelIdentity(previousState?.tunnelIdentity, expectedTunnelIdentity)) {
      warn("Electron reload deferred because the live tunnel identity does not match the configured alias and tunnel ID");
      scheduleElectronRestartRetry();
      return false;
    }
    const expectedTunnelPid = config?.mode === "full" ? previousState?.tunnelPid : null;
    const expectedTunnelHealthFingerprint = config?.mode === "full"
      ? previousState?.tunnelHealthFingerprint
      : undefined;
    const tunnelHandoffIdentityReady = config?.mode !== "full"
      || (Number.isSafeInteger(expectedTunnelPid) && expectedTunnelPid > 0)
      || (expectedTunnelPid === null
        && typeof expectedTunnelHealthFingerprint === "string"
        && /^[a-f0-9]{64}$/.test(expectedTunnelHealthFingerprint));
    if (!tunnelHandoffIdentityReady) {
      warn("Electron reload deferred because the live tunnel has neither a verified PID nor a saved health fingerprint");
      scheduleElectronRestartRetry();
      return false;
    }
    if (config && runtimeReady) {
      const drained = await drainRuntimeForElectronRestart({
        config,
        expectedDaemonPid: previousState.daemonPid,
        health,
        control,
        timeoutMs: Math.max(1_000, idleRestartTimeoutMs),
      });
      if (!drained.allowed) {
        warn(`Electron reload deferred; daemon admission ${drained.resumed ? "was resumed" : "could not be confirmed resumed"}: ${drained.reason}`);
        scheduleElectronRestartRetry();
        return false;
      }
    }

    log("Electron-side source changed; draining turns and restarting while retaining the live tunnel");
    electronRestarting = true;
    const child = electron;
    const oldOwnerPid = previousState?.ownerPid;
    electron = undefined;
    const oldExited = await waitForElectronExit(child, 10_000, { forceKill: false });
    if (!oldExited) {
      electron = child;
      electronRestarting = false;
      if (config) {
        const resumed = await control(config, "resume").then(value => value?.accepting_turns === true).catch(() => false);
        warn(`Electron reload deferred because the current launcher did not exit cleanly; daemon admission ${resumed ? "was resumed" : "could not be confirmed resumed"}`);
      } else {
        warn("Electron reload deferred because the current launcher did not exit cleanly");
      }
      scheduleElectronRestartRetry();
      return false;
    }
    if (stopped) return false;
    if (electronRetryTimer) clearTimeout(electronRetryTimer);
    electronRetryTimer = undefined;
    const replacement = startElectron();
    if (!config) return true;
    const readiness = await waitForReplacementRuntime({
      config,
      expectedTunnelPid,
      expectedTunnelHealthFingerprint,
      expectedTunnelIdentity,
      previousOwnerPid: oldOwnerPid,
      health,
      readState: async () => readRuntimeState(),
      isElectronAlive: () => replacement
        && replacement.exitCode === null
        && replacement.signalCode === null,
      ownerAlive: pidRunning,
      timeoutMs: 30_000,
    });
    if (!readiness.ready) {
      warn(`Replacement launcher readiness was not confirmed: ${readiness.reason}`);
      return false;
    }
    log(readiness.tunnelPid === null
      ? "replacement launcher is ready; verified the existing PID-less tunnel health fingerprint"
      : `replacement launcher is ready; verified tunnel PID ${readiness.tunnelPid ?? "none"}`);
    return true;
  } finally {
    electronReloadInFlight = false;
  }
}

function liveConfig() {
  const configPath = path.join(liveHome, "config.json");
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.host !== "string"
      || !Number.isInteger(value.port)
      || typeof value.controlToken !== "string"
      || typeof value.releaseVersion !== "string"
      || !["full", "browser-only", "pro-only"].includes(value.mode)) return undefined;
    return { ...value, mode: value.mode === "pro-only" ? "browser-only" : value.mode };
  } catch {
    return undefined;
  }
}

function liveCliConfig() {
  return readLaneConfig(liveLanePaths.cliConfigPath);
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

async function control(config, action, { timeoutMs = 2_000 } = {}) {
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
    if (!response.ok) {
      throw new Error(`${action} returned HTTP ${response.status}${body ? `: ${JSON.stringify(body)}` : ""}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function restartDaemonFromSource() {
  const config = liveConfig();
  if (!config) {
    log("runtime source changed; live profile is not configured yet, so only the browser helper was rebuilt");
    return;
  }
  const before = await health(config);
  if (!before || !Number.isInteger(before.pid)) {
    warn("runtime source changed while Responses daemon is unavailable; restarting the source launcher to recover it now");
    await restartElectron();
    return;
  }

  const oldPid = before.pid;
  const deadline = Date.now() + Math.max(1_000, idleRestartTimeoutMs);
  log(`draining Responses daemon pid ${oldPid} before source reload`);
  for (;;) {
    const state = await control(config, "drain");
    if (state?.active_http_turns === 0 && state?.active_browser_turns === 0) break;
    if (Date.now() >= deadline) {
      await control(config, "resume").catch(() => {});
      throw new Error(
        `source reload timed out waiting for ${state?.active_http_turns ?? "?"} HTTP and ${state?.active_browser_turns ?? "?"} browser turn(s) to finish`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  await control(config, "shutdown");
  const restartDeadline = Date.now() + 20_000;
  while (Date.now() < restartDeadline) {
    const next = await health(config);
    if (next && Number.isInteger(next.pid) && next.pid !== oldPid && next.accepting_turns === true) {
      log(`Responses daemon reloaded from source: ${oldPid} -> ${next.pid}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("source launcher did not recover the Responses daemon within 20 seconds");
}

async function restartCliLaneDaemonFromSource() {
  const config = liveCliConfig();
  if (!config) return;
  const before = await health(config);
  if (!before || !Number.isInteger(before.pid)) return;

  const oldPid = before.pid;
  const deadline = Date.now() + Math.max(1_000, idleRestartTimeoutMs);
  log(`draining isolated CLI Responses daemon pid ${oldPid} before source reload`);
  for (;;) {
    const state = await control(config, "drain");
    if (state?.active_http_turns === 0 && state?.active_browser_turns === 0) break;
    if (Date.now() >= deadline) {
      await control(config, "resume").catch(() => {});
      throw new Error(
        `CLI lane source reload timed out waiting for ${state?.active_http_turns ?? "?"} HTTP and `
        + `${state?.active_browser_turns ?? "?"} browser turn(s) to finish`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  await control(config, "shutdown");
  const restartDeadline = Date.now() + 20_000;
  while (Date.now() < restartDeadline) {
    const next = await health(config);
    if (next && Number.isInteger(next.pid) && next.pid !== oldPid && next.accepting_turns === true) {
      log(`isolated CLI Responses daemon reloaded from source: ${oldPid} -> ${next.pid}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("isolated CLI lane did not recover its Responses daemon within 20 seconds");
}

function routeCommand(action, env = liveEnvironment()) {
  return spawnSync(bun, ["run", path.join(repoRoot, "src", "cli.ts"), "route", action], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

function routeCommandDetail(result) {
  return String(result.stderr || result.stdout || result.error || "").trim();
}

function parseRouteStatus(result, owner) {
  if (result.error || result.status !== 0) {
    throw new Error(`${owner} Codex route status failed${routeCommandDetail(result) ? `: ${routeCommandDetail(result)}` : ""}`);
  }
  let status;
  try {
    status = JSON.parse(String(result.stdout || ""));
  } catch {
    throw new Error(`${owner} Codex route status returned invalid JSON`);
  }
  if (!status || typeof status !== "object" || Array.isArray(status)
    || typeof status.installed !== "boolean" || typeof status.active !== "boolean"
    || !Array.isArray(status.errors)) {
    throw new Error(`${owner} Codex route status returned an invalid payload`);
  }
  return status;
}

function handoffProductionRoute() {
  if (samePath(productionHome, liveHome)) return;
  const status = parseRouteStatus(routeCommand("status", productionRouteEnvironment()), "installed launcher");
  if (!status.installed || !status.active) return;
  if (status.errors.length > 0) {
    throw new Error(`installed launcher Codex route is not healthy enough to hand off: ${status.errors.join("; ")}`);
  }
  const disconnected = routeCommand("disconnect", productionRouteEnvironment());
  if (disconnected.error || disconnected.status !== 0) {
    throw new Error(
      `could not temporarily disconnect the installed launcher Codex route`
      + (routeCommandDetail(disconnected) ? `: ${routeCommandDetail(disconnected)}` : ""),
    );
  }
  productionRouteWasActive = true;
  log("temporarily disconnected the installed launcher Codex route for live source ownership");
}

function restoreProductionRoute() {
  if (!productionRouteWasActive || samePath(productionHome, liveHome)) return;
  const connected = routeCommand("connect", productionRouteEnvironment());
  if (connected.error || connected.status !== 0) {
    warn(
      `could not reconnect the installed launcher Codex route`
      + (routeCommandDetail(connected) ? `: ${routeCommandDetail(connected)}` : ""),
    );
    return;
  }
  productionRouteWasActive = false;
  log("restored the installed launcher Codex route");
}

function tryConnectRoute() {
  if (!liveConfig()) return false;
  const result = routeCommand("connect");
  if (result.error || result.status !== 0) {
    const detail = routeCommandDetail(result);
    warn(`could not connect the live Codex route yet${detail ? `: ${detail}` : ""}`);
    return false;
  }
  liveRouteConnected = true;
  log("real Codex route is connected to the source runtime");
  return true;
}

function startRouteMonitor() {
  if (routeTimer) clearInterval(routeTimer);
  routeTimer = setInterval(() => {
    if (stopped || !fs.existsSync(path.join(liveHome, "config.json"))) return;
    if (tryConnectRoute()) {
      clearInterval(routeTimer);
      routeTimer = undefined;
    }
  }, 1_000);
  routeTimer.unref?.();
}

function restorePreviousRoute() {
  if (!liveRouteConnected || !fs.existsSync(path.join(liveHome, "config.json"))) return;
  const result = routeCommand("disconnect");
  if (result.error || result.status !== 0) {
    const detail = routeCommandDetail(result);
    warn(`could not restore the previous Codex route${detail ? `: ${detail}` : ""}`);
    return;
  }
  liveRouteConnected = false;
  log("previous Codex route restored");
}

function watchPortable(root, callback) {
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (filename) callback(path.join(root, String(filename)));
    });
    watchers.push(watcher);
    return;
  } catch {}

  const attach = directory => {
    try {
      watchers.push(fs.watch(directory, (_event, filename) => {
        if (filename) callback(path.join(directory, String(filename)));
      }));
    } catch {
      return;
    }
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) attach(path.join(directory, entry.name));
    }
  };
  attach(root);
}

function scheduleReload(kind, changedPath) {
  if (stopped) return;
  pending[kind] = true;
  log(`${kind === "electron" ? "launcher" : "runtime"} change detected: ${path.relative(repoRoot, changedPath)}`);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { void flushReload(); }, reloadDelayMs);
}

async function flushReload() {
  if (reloadRunning) {
    reloadAgain = true;
    return;
  }
  reloadRunning = true;
  const electronChanged = pending.electron;
  const runtimeChanged = pending.runtime;
  pending.electron = false;
  pending.runtime = false;
  try {
    if (runtimeChanged) buildBrowserHelper();
    if (electronChanged) {
      const reloaded = await restartElectron();
      if (runtimeChanged && reloaded !== false) await restartCliLaneDaemonFromSource();
    } else if (runtimeChanged) {
      await restartDaemonFromSource();
      await restartCliLaneDaemonFromSource();
    }
  } catch (error) {
    warn(`reload failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    reloadRunning = false;
    if (reloadAgain || pending.electron || pending.runtime) {
      reloadAgain = false;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { void flushReload(); }, reloadDelayMs);
    }
  }
}

function startWatchers() {
  watchPortable(path.join(repoRoot, "src"), changed => {
    if (/\.(?:ts|tsx|js|cjs|mjs)$/.test(changed)) scheduleReload("runtime", changed);
  });
  watchPortable(path.join(launcherRoot, "electron"), changed => {
    if (/\.(?:js|cjs|mjs)$/.test(changed)) scheduleReload("electron", changed);
  });
  log("watching src/** for daemon hot reload and launcher/electron/** for Electron restart");
  log("launcher renderer changes continue to use Vite HMR without restarting ChatGPT");
}

async function stop(exitCode = 0) {
  if (stopped) return;
  stopped = true;
  clearTimeout(reloadTimer);
  if (electronRetryTimer) clearTimeout(electronRetryTimer);
  if (routeTimer) clearInterval(routeTimer);
  if (viteRestartTimer) clearTimeout(viteRestartTimer);
  if (cliLaneRetryTimer) clearTimeout(cliLaneRetryTimer);
  for (const watcher of watchers.splice(0)) watcher.close();
  await stopCliLaneSupervisor();
  if (ownsLiveLease) {
    restorePreviousRoute();
    restoreProductionRoute();
    removeLiveTunnelLease(liveTunnelLeasePath, process.pid, liveTunnelSessionId);
    ownsLiveLease = false;
  }
  electronRestarting = true;
  await waitForElectronShutdown(electron, waitForElectronExit, message => warn(message));
  electron = undefined;
  if (vite && vite.exitCode === null && vite.signalCode === null) {
    try { vite.kill("SIGTERM"); } catch {}
  }
  process.exitCode = exitCode;
}

async function main() {
  assertProductionLauncherStopped();
  fs.mkdirSync(liveHome, { recursive: true });
  fs.mkdirSync(liveUserData, { recursive: true });
  createLiveTunnelLease(liveTunnelLeasePath, process.pid, liveTunnelSessionId);
  ownsLiveLease = true;
  log(`persistent live home: ${liveHome}`);
  log("the installed launcher must stay closed while this process owns Codex Native2/tunnel resources");
  handoffProductionRoute();
  buildBrowserHelper();
  vitePort = await freeLoopbackPort(preferredVitePort);
  viteUrl = `http://127.0.0.1:${vitePort}`;
  if (vitePort !== preferredVitePort) {
    warn(`Vite port ${preferredVitePort} is busy; using ${vitePort} for this live session`);
  }
  startVite();
  await waitForVite();
  startElectron();
  startCliLaneSupervisor();
  startWatchers();
  startRouteMonitor();
  log(`isolated CLI lane home: ${liveCliHome}`);
  log("CLI tests use a separate tunnel via: bun run dev:codex -- <codex arguments>");
  log("LIVE READY: edit source files; installer/package rebuilds are no longer required for ordinary iterations");
}

process.once("SIGINT", () => { void stop(0); });
process.once("SIGTERM", () => { void stop(0); });

main().catch(error => {
  warn(error instanceof Error ? error.message : String(error));
  void stop(1);
});
