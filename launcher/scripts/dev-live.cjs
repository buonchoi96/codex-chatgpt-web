const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFileSync } = require("node:child_process");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");
const vitePackage = require.resolve("vite/package.json", { paths: [launcherRoot] });
const viteBin = path.join(path.dirname(vitePackage), "bin", "vite.js");
const electronBin = require("electron");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;
const liveHome = path.resolve(
  process.env.CODEX_WEB_GPT_LIVE_HOME || path.join(os.homedir(), ".codex-chatgpt-web-live"),
);
const liveUserData = path.join(liveHome, "launcher");
const viteUrl = "http://127.0.0.1:4178";
const reloadDelayMs = 250;
const idleRestartTimeoutMs = Number(process.env.CODEX_WEB_GPT_LIVE_RESTART_TIMEOUT_MS || 60_000);

let vite;
let electron;
let stopped = false;
let electronRestarting = false;
let reloadTimer;
let routeTimer;
let reloadRunning = false;
let reloadAgain = false;
const watchers = [];
const pending = { runtime: false, electron: false };

const log = message => process.stdout.write(\`[dev-live] \${message}\n\`);
const warn = message => process.stderr.write(\`[dev-live] \${message}\n\`);

function liveEnvironment(extra = {}) {
  const env = {
    ...process.env,
    CODEX_CHATGPT_WEB_HOME: liveHome,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: liveUserData,
    CODEX_WEB_GPT_LIVE_MODE: "1",
    CODEX_WEB_GPT_BUN: bun,
    CODEX_CHATGPT_WEB_BUN: bun,
    ...extra,
  };
  delete env.CODEX_WEB_GPT_DEV_HOME;
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
  if (result.status !== 0) throw new Error(\`\${path.basename(command)} exited with status \${result.status ?? 1}\`);
}

function buildBrowserHelper() {
  const started = Date.now();
  runChecked(bun, ["run", "scripts/build-browser-helper.ts"], { cwd: repoRoot });
  log(\`browser helper rebuilt in \${Date.now() - started} ms\`);
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
  throw new Error(\`Vite did not become ready on \${viteUrl}\`);
}

function startVite() {
  vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", "4178"], {
    cwd: launcherRoot,
    stdio: "inherit",
    env: process.env,
  });
  vite.once("exit", code => {
    if (!stopped && code !== 0) {
      warn(\`Vite exited with code \${code}\`);
      void stop(1);
    }
  });
}

function startElectron() {
  electronRestarting = false;
  electron = spawn(electronBin, [launcherRoot], {
    cwd: launcherRoot,
    stdio: "inherit",
    env: liveEnvironment({ VITE_DEV_SERVER_URL: viteUrl }),
  });
  electron.once("error", error => {
    warn(\`Electron failed to start: \${error.message}\`);
    if (!stopped) void stop(1);
  });
  electron.once("exit", code => {
    electron = undefined;
    if (stopped || electronRestarting) return;
    warn(\`Electron exited unexpectedly (\${code ?? 0}); restarting source launcher\`);
    setTimeout(() => {
      if (!stopped && !electron) startElectron();
    }, 500);
  });
  log(\`source launcher started with persistent state at \${liveHome}\`);
}

async function waitForElectronExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
    try { child.kill("SIGTERM"); } catch { done(); }
  });
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && Number.isInteger(child.pid)) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}

async function restartElectron() {
  if (stopped) return;
  log("Electron-side source changed; restarting source launcher while preserving the live profile");
  electronRestarting = true;
  const child = electron;
  electron = undefined;
  await waitForElectronExit(child);
  if (!stopped) startElectron();
}

function liveConfig() {
  const configPath = path.join(liveHome, "config.json");
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.host !== "string" || !Number.isInteger(value.port) || typeof value.controlToken !== "string") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function health(config, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(\`http://\${config.host}:\${config.port}/healthz\`, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function control(config, action) {
  const response = await fetch(\`http://\${config.host}:\${config.port}/admin/\${action}\`, {
    method: "POST",
    headers: { authorization: \`Bearer \${config.controlToken}\` },
  });
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    throw new Error(\`\${action} returned HTTP \${response.status}\${body ? \`: \${JSON.stringify(body)}\` : ""}\`);
  }
  return body;
}

async function restartDaemonFromSource() {
  const config = liveConfig();
  if (!config) {
    log("runtime source changed; live profile is not configured yet, so only the browser helper was rebuilt");
    return;
  }
  const before = await health(config);
  if (!before || !Number.isInteger(before.pid)) {
    log("runtime source changed; Responses daemon is not running yet; the next launcher start will load the new source");
    return;
  }

  const oldPid = before.pid;
  const deadline = Date.now() + Math.max(1_000, idleRestartTimeoutMs);
  log(\`draining Responses daemon pid \${oldPid} before source reload\`);
  for (;;) {
    const state = await control(config, "drain");
    if (state?.active_http_turns === 0 && state?.active_browser_turns === 0) break;
    if (Date.now() >= deadline) {
      await control(config, "resume").catch(() => {});
      throw new Error(
        \`source reload timed out waiting for \${state?.active_http_turns ?? "?"} HTTP and \${state?.active_browser_turns ?? "?"} browser turn(s) to finish\`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  await control(config, "shutdown");
  const restartDeadline = Date.now() + 20_000;
  while (Date.now() < restartDeadline) {
    const next = await health(config);
    if (next && Number.isInteger(next.pid) && next.pid !== oldPid && next.accepting_turns === true) {
      log(\`Responses daemon reloaded from source: \${oldPid} -> \${next.pid}\`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("source launcher did not recover the Responses daemon within 20 seconds");
}

function routeCommand(action) {
  return spawnSync(bun, ["run", path.join(repoRoot, "src", "cli.ts"), "route", action], {
    cwd: repoRoot,
    env: liveEnvironment(),
    encoding: "utf8",
    windowsHide: true,
  });
}

function tryConnectRoute() {
  if (!liveConfig()) return false;
  const result = routeCommand("connect");
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error || "").trim();
    warn(\`could not connect the live Codex route yet\${detail ? \`: \${detail}\` : ""}\`);
    return false;
  }
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
  if (!fs.existsSync(path.join(liveHome, "config.json"))) return;
  const result = routeCommand("disconnect");
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error || "").trim();
    warn(\`could not restore the previous Codex route\${detail ? \`: \${detail}\` : ""}\`);
    return;
  }
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
  log(\`\${kind === "electron" ? "launcher" : "runtime"} change detected: \${path.relative(repoRoot, changedPath)}\`);
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
    if (electronChanged) await restartElectron();
    else if (runtimeChanged) await restartDaemonFromSource();
  } catch (error) {
    warn(\`reload failed: \${error instanceof Error ? error.message : String(error)}\`);
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
  if (routeTimer) clearInterval(routeTimer);
  for (const watcher of watchers.splice(0)) watcher.close();
  restorePreviousRoute();
  electronRestarting = true;
  await waitForElectronExit(electron, 5_000);
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
  log(\`persistent live home: \${liveHome}\`);
  log("the installed launcher must stay closed while this process owns Codex Native2/tunnel resources");
  buildBrowserHelper();
  startVite();
  await waitForVite();
  startElectron();
  startWatchers();
  startRouteMonitor();
  log("LIVE READY: edit source files; installer/package rebuilds are no longer required for ordinary iterations");
}

process.once("SIGINT", () => { void stop(0); });
process.once("SIGTERM", () => { void stop(0); });

main().catch(error => {
  warn(error instanceof Error ? error.message : String(error));
  void stop(1);
});
