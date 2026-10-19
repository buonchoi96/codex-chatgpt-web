/**
 * Start Codex Web GPT from source with an EXISTING production profile.
 *
 * No file watchers, HMR, restart loops, or automatic profile initialization.
 * Refuses to start if an existing launcher or its runtime children are alive.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER_DIR = join(ROOT, "launcher");
const WINDOWS_INSTALL_GUID = "d1a6026a-6210-588e-9a2b-da3936f94e02";
const BUN = process.execPath;
const DIAGNOSE = process.argv.includes("--diagnose");
const pathKey = (value) => resolve(value).toLowerCase();

function fail(message) {
  throw new Error(`app:live: ${message}`);
}

function isFile(pathname) {
  try { return statSync(pathname).isFile(); } catch { return false; }
}

function isDirectory(pathname) {
  try { return statSync(pathname).isDirectory(); } catch { return false; }
}

function registeredInstallLocation() {
  const result = spawnSync("reg.exe", [
    "query", `HKCU\\Software\\${WINDOWS_INSTALL_GUID}`, "/v", "InstallLocation",
  ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  const match = result.stdout.match(/^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/mi);
  return match?.[1]?.trim() || null;
}

function installedDataHome() {
  const location = registeredInstallLocation()
    || (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs", "Codex Web GPT")
      : null);
  if (!location) return null;
  const installDir = resolve(location);
  const installRoot = basename(installDir).toLowerCase() === "app"
    ? dirname(installDir) : installDir;
  return join(installRoot, "Data");
}

function configInfo(home) {
  const configPath = join(home, "config.json");
  if (!isFile(configPath)) return { home, configPath, found: false };
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { home, configPath, found: true, error: "unreadable JSON" };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)
      || Object.prototype.hasOwnProperty.call(config, "purpose")
      || (config.mode !== "full" && config.mode !== "browser-only")
      || config.version !== 3) {
    return { home, configPath, found: true, error: "not a supported production configuration" };
  }
  return { home, configPath, found: true, mode: config.mode };
}

function uniquePaths(values) {
  const seen = new Set();
  return values.filter(Boolean).map((value) => resolve(value)).filter((value) => {
    const key = pathKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveCoreHome() {
  const override = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  const candidates = uniquePaths(override
    ? [override]
    : [installedDataHome(), join(homedir(), ".codex-chatgpt-web")]);
  const scanned = candidates.map(configInfo);
  if (DIAGNOSE) {
    console.log("[app:live] Production configuration candidates:");
    for (const item of scanned) {
      console.log(`  ${item.configPath}: ${item.error || (item.found ? `VALID (${item.mode})` : "not found")}`);
    }
  }

  // A specifically provided production home must never silently fall back.
  if (override) {
    const selected = scanned[0];
    if (!selected || !selected.found || selected.error) {
      fail(`CODEX_CHATGPT_WEB_HOME is not a valid configured LIVE home: ${override}`);
    }
    return selected.home;
  }

  // Installer-managed Data is authoritative when configured. Otherwise use
  // the legacy production home, but never use an invalid DEV/foreign config.
  const selected = scanned.find((item) => item.found);
  if (!selected) {
    fail(`No existing production config.json found. Checked:\n  ${scanned.map(x => x.configPath).join("\n  ")}\nSet CODEX_CHATGPT_WEB_HOME to the exact LIVE home; no new profile was created.`);
  }
  if (selected.error) fail(`${selected.configPath}: ${selected.error}; refusing to switch profiles`);
  return selected.home;
}

function resolveLauncherData(coreHome) {
  const override = process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR?.trim();
  const roaming = process.env.APPDATA
    ? join(process.env.APPDATA, "Codex Web GPT")
    : join(homedir(), "AppData", "Roaming", "Codex Web GPT");
  const candidates = uniquePaths(override
    ? [override]
    : [join(coreHome, "Launcher"), roaming]);
  const present = candidates.filter((pathname) => isFile(join(pathname, "launcher-state.json")));
  if (DIAGNOSE) {
    console.log("[app:live] Launcher userData candidates:");
    for (const pathname of candidates) {
      console.log(`  ${pathname}: ${isFile(join(pathname, "launcher-state.json")) ? "launcher-state.json found" : "no launcher-state.json"}`);
    }
  }
  if (present.length === 0) {
    fail(`Existing LIVE launcher-state.json not found. Checked:\n  ${candidates.join("\n  ")}\nSet CODEX_WEB_GPT_LAUNCHER_DATA_DIR to the existing LIVE userData folder.`);
  }
  if (present.length > 1 && !override) {
    fail(`Multiple launcher userData folders found; refusing to guess:\n  ${present.join("\n  ")}\nSet CODEX_WEB_GPT_LAUNCHER_DATA_DIR explicitly.`);
  }
  return present[0];
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // Read-only existence check, never kills anything.
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true; // EPERM or unknown: fail closed.
  }
}

function assertNoOwnedRuntime(coreHome) {
  const descriptorPath = join(coreHome, "runtime", "launcher-browser.json");
  if (existsSync(descriptorPath)) {
    let descriptor;
    try { descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")); }
    catch { fail(`Unreadable launcher descriptor: ${descriptorPath}`); }
    if (descriptor?.profile !== "production" || !Number.isSafeInteger(descriptor.pid)) {
      fail(`Unrecognized LIVE launcher descriptor: ${descriptorPath}`);
    }
    if (pidAlive(descriptor.pid)) {
      fail(`LIVE launcher PID ${descriptor.pid} is still running. Quit it normally after its current turns finish.`);
    }
  }

  const statePath = join(coreHome, "runtime", "launcher-supervisor.json");
  if (!existsSync(statePath)) return;
  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); }
  catch { fail(`Unreadable supervisor ownership state: ${statePath}`); }
  if (state?.version !== 1) fail(`Unrecognized supervisor ownership state: ${statePath}`);
  for (const key of ["ownerPid", "daemonPid", "tunnelPid"]) {
    if (pidAlive(state[key])) {
      fail(`LIVE ${key} ${state[key]} is still running according to ${statePath}; app:live will not interrupt or adopt it.`);
    }
  }
}

function assertNoInstalledLauncher() {
  // Separate guard: catches an installed LIVE window even when the wrong home
  // was selected or its browser descriptor is missing.
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-CimInstance Win32_Process -Filter \"Name='Codex Web GPT.exe' OR Name='electron.exe'\")",
    "$items | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail("Could not verify running launcher processes. Close LIVE normally and rerun; not starting blindly.");
  }
  const output = result.stdout.trim();
  if (!output) return;
  let items;
  try { items = JSON.parse(output); }
  catch { fail("Could not parse the launcher process inventory"); }
  for (const item of Array.isArray(items) ? items : [items]) {
    if (!item) continue;
    const name = String(item.Name || "").toLowerCase();
    const cmd = String(item.CommandLine || "").toLowerCase();
    if (name === "codex web gpt.exe" || (name === "electron.exe" && cmd.includes(ROOT.toLowerCase()))) {
      fail(`An existing launcher process (${item.Name}, PID ${item.ProcessId}) is running; close it normally before app:live.`);
    }
  }
}

function runBun(args, env) {
  const result = spawnSync(BUN, args, {
    cwd: ROOT,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  if (process.platform !== "win32") fail("app:live is only configured for Windows");
  const coreHome = resolveCoreHome();
  const userData = resolveLauncherData(coreHome);
  if (!isDirectory(coreHome) || !isDirectory(userData)) fail("Selected LIVE paths must already exist");

  console.log(`[app:live] LIVE core home: ${coreHome}`);
  console.log(`[app:live] LIVE launcher data: ${userData}`);
  console.log(`[app:live] Codex home: ${process.env.CODEX_HOME || "(default Codex home)"}`);
  console.log("[app:live] No watchers, HMR, or automatic restart.");

  if (DIAGNOSE) {
    console.log("[app:live] Profile discovery succeeded. --diagnose makes no changes or process checks.");
    return;
  }

  assertNoInstalledLauncher();
  assertNoOwnedRuntime(coreHome);
  if (!isDirectory(join(LAUNCHER_DIR, "node_modules", "electron"))) {
    fail('Launcher dependencies missing. Run bun install --frozen-lockfile in both repository root and launcher.');
  }

  const env = {
    ...process.env,
    CODEX_CHATGPT_WEB_HOME: coreHome,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: userData,
    CODEX_WEB_GPT_BUN: BUN,
    CODEX_CHATGPT_WEB_BUN: BUN,
  };
  delete env.VITE_DEV_SERVER_URL;
  delete env.CODEX_WEB_GPT_DEV_HOME;

  runBun(["run", "scripts/build-browser-helper.ts"], env);
  runBun(["run", "--cwd", "launcher", "build"], env);

  // Guard again after build in case the installed LIVE app was opened meanwhile.
  assertNoInstalledLauncher();
  assertNoOwnedRuntime(coreHome);
  console.log("[app:live] Starting the one-shot source launcher using LIVE production profile.");
  runBun(["run", "--cwd", "launcher", "start"], env);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
