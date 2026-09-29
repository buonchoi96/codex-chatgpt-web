const assert = require("node:assert/strict");
const test = require("node:test");
const {
  drainRuntimeForElectronRestart,
  recoverableTunnelHandoff,
  waitForElectronShutdown,
  waitForReplacementRuntime,
} = require("../scripts/dev-live-lifecycle.cjs");

const config = { mode: "full", releaseVersion: "0.2.0" };
const tunnelIdentity = { alias: "codex-chatgpt-web", tunnelIdHash: "a".repeat(64) };
const healthy = { status: "ok", service: "codex-chatgpt-web", mode: "full", version: "0.2.0", pid: 4100, accepting_turns: true };

test("normal dev-live shutdown keeps waiting for a delayed Electron tunnel cleanup without force-killing", async () => {
  const child = { exitCode: null, signalCode: null };
  const waits = [];
  const warnings = [];
  const stopped = await waitForElectronShutdown(
    child,
    async (candidate, timeoutMs, options) => {
      waits.push({ candidate, timeoutMs, options });
      if (waits.length === 2) {
        candidate.exitCode = 0;
        return true;
      }
      return false;
    },
    message => warnings.push(message),
  );

  assert.equal(stopped, true);
  assert.equal(waits.length, 2);
  assert.ok(waits.every(wait => wait.candidate === child));
  assert.ok(waits.every(wait => wait.timeoutMs >= 30_000));
  assert.ok(waits.every(wait => wait.options.forceKill === false));
  assert.equal(warnings.length, 1);
});

test("Electron reload gate allows restart only after both turn counters are idle", async () => {
  const actions = [];
  const result = await drainRuntimeForElectronRestart({
    config,
    health: async () => healthy,
    control: async (_config, action) => {
      actions.push(action);
      return { status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 };
    },
    timeoutMs: 20,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.daemonPid, healthy.pid);
  assert.deepEqual(actions, ["drain"]);
});

test("Electron reload gate resumes daemon admission and refuses restart when turns remain active", async () => {
  const actions = [];
  let clock = 0;
  const result = await drainRuntimeForElectronRestart({
    config,
    health: async () => healthy,
    control: async (_config, action) => {
      actions.push(action);
      return action === "resume"
        ? { status: "ok", accepting_turns: true }
        : { status: "ok", accepting_turns: false, active_http_turns: 1, active_browser_turns: 2 };
    },
    timeoutMs: 10,
    pollIntervalMs: 5,
    now: () => clock,
    wait: async duration => { clock += duration; },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.resumed, true);
  assert.match(result.reason, /1 HTTP and 2 browser turn/);
  assert.equal(actions.at(-1), "resume");
  assert.ok(actions.filter(action => action === "drain").length > 1);
});

test("Electron reload gate compensates when daemon health is unavailable", async () => {
  const actions = [];
  const result = await drainRuntimeForElectronRestart({
    config,
    health: async () => undefined,
    control: async (_config, action) => {
      actions.push(action);
      return { status: "ok", accepting_turns: true };
    },
    timeoutMs: 10,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.resumed, true);
  assert.deepEqual(actions, ["resume"]);
});

test("Electron reload gate resumes admission when health reports a different daemon PID", async () => {
  const actions = [];
  const result = await drainRuntimeForElectronRestart({
    config,
    expectedDaemonPid: 4999,
    health: async () => healthy,
    control: async (_config, action) => {
      actions.push(action);
      return { status: "ok", accepting_turns: true };
    },
    timeoutMs: 10,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.resumed, true);
  assert.match(result.reason, /PID did not match/);
  assert.deepEqual(actions, ["resume"]);
});

test("Electron reload gate compensates when drain status arrives after its deadline", async () => {
  const actions = [];
  let clock = 0;
  const result = await drainRuntimeForElectronRestart({
    config,
    health: async () => healthy,
    control: async (_config, action) => {
      actions.push(action);
      if (action === "drain") {
        clock = 11;
        return { status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 };
      }
      return { status: "ok", accepting_turns: true };
    },
    timeoutMs: 10,
    now: () => clock,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.resumed, true);
  assert.match(result.reason, /timed out/);
  assert.deepEqual(actions, ["drain", "resume"]);
});

test("replacement launcher readiness requires the same tunnel PID and a new live owner", async () => {
  const result = await waitForReplacementRuntime({
    config,
    expectedTunnelPid: 5100,
    expectedTunnelIdentity: tunnelIdentity,
    previousOwnerPid: 4200,
    health: async () => ({ ...healthy, pid: 6100 }),
    readState: async () => ({ status: "ready", ownerPid: 4300, daemonPid: 6100, tunnelPid: 5100, tunnelIdentity }),
    isElectronAlive: () => true,
    ownerAlive: pid => pid === 4300,
    timeoutMs: 0,
  });
  assert.deepEqual(result, { ready: true, tunnelPid: 5100, ownerPid: 4300 });
});

test("replacement launcher readiness rejects a changed tunnel PID", async () => {
  const result = await waitForReplacementRuntime({
    config,
    expectedTunnelPid: 5100,
    expectedTunnelIdentity: tunnelIdentity,
    previousOwnerPid: 4200,
    health: async () => ({ ...healthy, pid: 6100 }),
    readState: async () => ({ status: "ready", ownerPid: 4300, daemonPid: 6100, tunnelPid: 5200, tunnelIdentity }),
    isElectronAlive: () => true,
    ownerAlive: () => true,
    timeoutMs: 0,
  });
  assert.equal(result.ready, false);
  assert.match(result.reason, /same tunnel PID/);
});

test("replacement launcher readiness accepts the same fingerprint when the native manager omits its PID", async () => {
  const fingerprint = "b".repeat(64);
  const result = await waitForReplacementRuntime({
    config,
    expectedTunnelPid: null,
    expectedTunnelHealthFingerprint: fingerprint,
    expectedTunnelIdentity: tunnelIdentity,
    previousOwnerPid: 4200,
    health: async () => ({ ...healthy, pid: 6100 }),
    readState: async () => ({
      status: "ready", ownerPid: 4300, daemonPid: 6100,
      tunnelPid: null, tunnelHealthFingerprint: fingerprint, tunnelIdentity,
    }),
    isElectronAlive: () => true,
    ownerAlive: pid => pid === 4300,
    timeoutMs: 0,
  });
  assert.deepEqual(result, {
    ready: true, tunnelPid: null, tunnelHealthFingerprint: fingerprint, ownerPid: 4300,
  });
});

test("replacement launcher readiness rejects a tunnel ID that changed during restart", async () => {
  const result = await waitForReplacementRuntime({
    config,
    expectedTunnelPid: 5100,
    expectedTunnelIdentity: tunnelIdentity,
    previousOwnerPid: 4200,
    health: async () => ({ ...healthy, pid: 6100 }),
    readState: async () => ({
      status: "ready", ownerPid: 4300, daemonPid: 6100, tunnelPid: 5100,
      tunnelIdentity: { alias: tunnelIdentity.alias, tunnelIdHash: "c".repeat(64) },
    }),
    isElectronAlive: () => true,
    ownerAlive: () => true,
    timeoutMs: 0,
  });
  assert.equal(result.ready, false);
  assert.match(result.reason, /tunnel identity did not match/);
});

test("late Electron exit recovery accepts a handoff only after its old owner has exited", () => {
  const state = {
    status: "handoff",
    ownerPid: 4200,
    tunnelPid: 5100,
    tunnelIdentity: { alias: "codex-chatgpt-web", tunnelIdHash: "a".repeat(64) },
  };
  assert.equal(recoverableTunnelHandoff(state, pid => pid === 4200), false);
  assert.equal(recoverableTunnelHandoff(state, () => false), true);
  assert.equal(recoverableTunnelHandoff({
    ...state,
    tunnelPid: null,
    tunnelHealthFingerprint: "b".repeat(64),
  }, () => false), true);
  assert.equal(recoverableTunnelHandoff({ ...state, tunnelIdentity: undefined }), false);
  assert.equal(recoverableTunnelHandoff({ ...state, tunnelPid: null }, () => false), false);
});
