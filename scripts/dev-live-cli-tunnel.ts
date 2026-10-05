import { loadConfig } from "../src/config";
import { connectTunnel, stopTunnel, tunnelStatus, waitForTunnelReady } from "../src/tunnel";

const action = process.argv[2] ?? "status";
const config = loadConfig();

if (config.mode !== "full") throw new Error("DEV live CLI tunnel requires Full harness mode");

if (action === "start") {
  const current = tunnelStatus(config);
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
