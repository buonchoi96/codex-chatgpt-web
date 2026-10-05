const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const launcherRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(launcherRoot, "..");

test("source live mode preserves state while hot-reloading the real Codex runtime", () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const launcherPackage = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live.cjs"), "utf8");
  const main = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");

  assert.equal(rootPackage.scripts["dev:live"], "bun run --cwd launcher dev:live");
  assert.equal(launcherPackage.scripts["dev:live"], "bun run scripts/dev-live.cjs");
  assert.match(source, /\.codex-chatgpt-web-live/);
  assert.match(source, /CODEX_CHATGPT_WEB_HOME: liveHome/);
  assert.match(source, /CODEX_WEB_GPT_LAUNCHER_DATA_DIR: liveUserData/);
  assert.match(source, /CODEX_WEB_GPT_LIVE_LANE: "desktop"/);
  assert.match(source, /Codex Native2 and its tunnel/);
  assert.doesNotMatch(source, /electronBin, \[launcherRoot, ["']--dev-profile/);
  assert.match(source, /scripts\/build-browser-helper\.ts/);
  assert.match(source, /control\(config, "drain"\)/);
  assert.match(source, /control\(config, "shutdown"\)/);
  assert.match(source, /next\.pid !== oldPid/);
  assert.match(source, /routeCommand\("connect"\)/);
  assert.match(source, /routeCommand\("disconnect"\)/);
  assert.match(source, /path\.join\(launcherRoot, "electron"\)/);
  assert.match(source, /Vite HMR/);
  assert.match(source, /freeLoopbackPort/);
  assert.match(source, /--strictPort/);
  assert.match(source, /restarting dev server without stopping the live runtime/);
  assert.match(source, /restarting the source launcher to recover it now/);
  assert.match(source, /drainRuntimeForElectronRestart/);
  assert.match(source, /waitForReplacementRuntime/);
  assert.match(source, /recoverableTunnelHandoff/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /forceKill: false/);
  assert.match(main, /preserveTunnel: runtimeSupervisor\?\.liveTunnelHandoffActive\(\) === true/);
  assert.match(main, /cancelTurn: IS_DEV_PROFILE[\s\S]*cancelDevChatTurn\([\s\S]*brokerSocketPath[\s\S]*runtimeSupervisor\.cancelBrowserTurn/);
  assert.doesNotMatch(main, /cancelTurn: IS_DEV_PROFILE \? undefined/);
  assert.match(main, /runtime recovery failed/);
});

test("source live hands off an active installed route and restores it on exit", () => {
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live.cjs"), "utf8");
  assert.match(source, /productionHome/);
  assert.match(source, /productionRouteEnvironment/);
  assert.match(source, /handoffProductionRoute/);
  assert.match(source, /temporarily disconnected the installed launcher Codex route for live source ownership/);
  assert.match(source, /productionRouteWasActive = true/);
  assert.match(source, /restoreProductionRoute/);
  assert.match(source, /restored the installed launcher Codex route/);
  assert.match(source, /liveRouteConnected = true/);
  assert.match(source, /if \(!liveRouteConnected/);
  const stop = source.indexOf("async function stop");
  assert.ok(source.indexOf("restorePreviousRoute();", stop) < source.indexOf("restoreProductionRoute();", stop));
  const main = source.indexOf("async function main");
  assert.ok(source.indexOf("handoffProductionRoute();", main) < source.indexOf("startElectron();", main));
});

test("source live owns a tunnel handoff lease through Electron restarts and removes it before normal exit", () => {
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live.cjs"), "utf8");
  const lifecycle = fs.readFileSync(path.join(launcherRoot, "scripts", "dev-live-lifecycle.cjs"), "utf8");
  assert.match(source, /live-tunnel-lease\.cjs/);
  assert.match(source, /CODEX_WEB_GPT_LIVE_TUNNEL_LEASE/);
  assert.match(source, /createLiveTunnelLease/);
  assert.match(source, /removeLiveTunnelLease/);
  const mainStart = source.indexOf("async function main()");
  assert.ok(source.indexOf("createLiveTunnelLease(liveTunnelLeasePath", mainStart)
    < source.indexOf("startElectron();", mainStart));
  assert.ok(source.indexOf("removeLiveTunnelLease(liveTunnelLeasePath") < source.indexOf("await waitForElectronShutdown(electron"));
  assert.match(lifecycle, /waitForExit\(child, ELECTRON_SHUTDOWN_WAIT_MS, \{ forceKill: false \}\)/);
  assert.match(lifecycle, /while \(child && child\.exitCode === null && child\.signalCode === null\)/);
});
