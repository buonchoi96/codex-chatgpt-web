import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";
import { connectTunnel, stopTunnel, tunnelStatus, waitForTunnelReady } from "../src/tunnel";

const action = process.argv[2] ?? "status";

// This helper is specifically for the isolated DEV CLI lane. Resolve that lane directly instead of
// inheriting CODEX_CHATGPT_WEB_HOME/CODEX_HOME from whichever PowerShell session invokes it.
const homeDir = os.homedir();
const desktopHome = path.resolve(
  process.env.CODEX_WEB_GPT_LIVE_HOME?.trim() || path.join(homeDir, ".codex-chatgpt-web-live"),
);
const cliHome = path.resolve(
  process.env.CODEX_WEB_GPT_LIVE_CLI_HOME?.trim() || path.join(desktopHome, "cli-lane"),
);
const cliCodexHome = path.resolve(
  process.env.CODEX_WEB_GPT_LIVE_CLI_CODEX_HOME?.trim() || path.join(cliHome, "codex-home"),
);
process.env.CODEX_CHATGPT_WEB_HOME = cliHome;
process.env.CODEX_HOME = cliCodexHome;

const config = loadConfig();

if (config.mode !== "full") throw new Error("DEV live CLI tunnel requires Full harness mode");

if (action === "start") {
  const current = tunnelStatus(config);
  if (!current.ok && current.processRunning) {
    // A live-but-unhealthy alias cannot be safely connected over itself. Recycle only the
    // isolated CLI lane runtime; the Desktop lane has a different alias and Tunnel ID.
    stopTunnel(config);
  }
  if (!current.ok) connectTunnel(config);
  const ready = await waitForTunnelReady(config);
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  if (!ready.ok) process.exitCode = 1;
} else if (action === "stop") {
  stopTunnel(config);
  process.stdout.write(`${JSON.stringify(tunnelStatus(config))}\n`);
} else if (action === "status") {
  const status = tunnelStatus(config);
  process.stdout.write(`${JSON.stringify(status)}\n`);
  if (!status.ok) process.exitCode = 1;
} else {
  throw new Error(`Unknown DEV live CLI tunnel action: ${action}`);
}
