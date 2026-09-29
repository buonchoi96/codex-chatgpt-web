const DEFAULT_POLL_INTERVAL_MS = 250;
const ELECTRON_SHUTDOWN_WAIT_MS = 30_000;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForElectronShutdown(child, waitForExit, onDelayed = () => {}) {
  while (child && child.exitCode === null && child.signalCode === null) {
    const exited = await waitForExit(child, ELECTRON_SHUTDOWN_WAIT_MS, { forceKill: false });
    if (exited || child.exitCode !== null || child.signalCode !== null) return true;
    onDelayed("Electron is still shutting down; keeping dev:live alive until runtime cleanup finishes");
  }
  return true;
}

function validHealth(config, value) {
  return Boolean(value
    && typeof value === "object"
    && value.status === "ok"
    && value.service === "codex-chatgpt-web"
    && value.mode === config.mode
    && (config.releaseVersion === undefined || value.version === config.releaseVersion)
    && Number.isSafeInteger(value.pid)
    && value.pid > 0);
}

function matchesTunnelIdentity(actual, expected) {
  return Boolean(expected
    && actual
    && typeof actual === "object"
    && actual.alias === expected.alias
    && actual.tunnelIdHash === expected.tunnelIdHash);
}

async function resumeAdmission(config, control) {
  try {
    const result = await control(config, "resume");
    return result?.status === "ok" && result.accepting_turns === true;
  } catch {
    return false;
  }
}

function recoverableTunnelHandoff(state, ownerAlive = () => false) {
  const identity = state?.tunnelIdentity;
  const hasPid = Number.isSafeInteger(state?.tunnelPid) && state.tunnelPid > 0;
  const hasFingerprint = state?.tunnelPid === null
    && typeof state?.tunnelHealthFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(state.tunnelHealthFingerprint);
  return Boolean(state?.status === "handoff"
    && Number.isSafeInteger(state.ownerPid)
    && state.ownerPid > 0
    && !ownerAlive(state.ownerPid)
    && (hasPid || hasFingerprint)
    && identity
    && typeof identity === "object"
    && !Array.isArray(identity)
    && typeof identity.alias === "string"
    && identity.alias.length > 0
    && typeof identity.tunnelIdHash === "string"
    && /^[a-f0-9]{64}$/.test(identity.tunnelIdHash));
}

async function drainRuntimeForElectronRestart({
  config,
  expectedDaemonPid,
  health,
  expectedTunnelHealthFingerprint,
  control,
  timeoutMs,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  now = Date.now,
  wait = sleep,
}) {
  let before;
  try { before = await health(config); } catch {}
  if (!validHealth(config, before)
    || before.accepting_turns !== true
    || (expectedDaemonPid !== undefined && before.pid !== expectedDaemonPid)) {
    const resumed = await resumeAdmission(config, control);
    return {
      allowed: false,
      resumed,
      reason: !validHealth(config, before)
        ? "Responses daemon health was unavailable or invalid"
        : before.accepting_turns !== true
          ? "Responses daemon was already not accepting turns"
          : "Responses daemon PID did not match launcher ownership state",
    };
  }

  const deadline = now() + Math.max(0, timeoutMs);
  let lastDrainState;
  for (;;) {
    if (now() >= deadline) {
      const resumed = await resumeAdmission(config, control);
      const activeHttp = lastDrainState?.active_http_turns;
      const activeBrowser = lastDrainState?.active_browser_turns;
      return {
        allowed: false,
        resumed,
        reason: Number.isSafeInteger(activeHttp) && Number.isSafeInteger(activeBrowser)
          ? `reload timed out with ${activeHttp} HTTP and ${activeBrowser} browser turn(s) active`
          : "reload deadline expired before daemon idle was confirmed",
      };
    }
    let state;
    try {
      state = await control(config, "drain", {
        timeoutMs: Math.max(1, Math.min(2_000, deadline - now())),
      });
    } catch (error) {
      const resumed = await resumeAdmission(config, control);
      return {
        allowed: false,
        resumed,
        reason: `daemon drain failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    lastDrainState = state;
    if (now() >= deadline) {
      const resumed = await resumeAdmission(config, control);
      return {
        allowed: false,
        resumed,
        reason: Number.isSafeInteger(state?.active_http_turns)
          && Number.isSafeInteger(state?.active_browser_turns)
          ? `reload timed out with ${state.active_http_turns} HTTP and ${state.active_browser_turns} browser turn(s) active`
          : "reload deadline expired while waiting for daemon drain status",
      };
    }
    const validDrain = state?.accepting_turns === false
      && Number.isSafeInteger(state.active_http_turns)
      && state.active_http_turns >= 0
      && Number.isSafeInteger(state.active_browser_turns)
      && state.active_browser_turns >= 0;
    if (!validDrain) {
      const resumed = await resumeAdmission(config, control);
      return { allowed: false, resumed, reason: "daemon drain status was incomplete or invalid" };
    }
    if (state.active_http_turns === 0 && state.active_browser_turns === 0) {
      return { allowed: true, daemonPid: before.pid };
    }
    if (now() >= deadline) {
      const resumed = await resumeAdmission(config, control);
      return {
        allowed: false,
        resumed,
        reason: `reload timed out with ${state.active_http_turns} HTTP and ${state.active_browser_turns} browser turn(s) active`,
      };
    }
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
}

async function waitForReplacementRuntime({
  config,
  expectedTunnelPid,
  expectedTunnelHealthFingerprint,
  expectedTunnelIdentity,
  previousOwnerPid,
  health,
  readState,
  isElectronAlive = () => true,
  ownerAlive = () => true,
  timeoutMs,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  now = Date.now,
  wait = sleep,
}) {
  const deadline = now() + Math.max(0, timeoutMs);
  let lastFailureReason = "replacement launcher did not report ready";
  do {
    if (!isElectronAlive()) return { ready: false, reason: "replacement Electron exited before runtime readiness" };
    let runtime;
    let state;
    try {
      [runtime, state] = await Promise.all([health(config), readState()]);
    } catch {}
    const ready = validHealth(config, runtime)
      && runtime.accepting_turns === true
      && state?.status === "ready"
      && Number.isSafeInteger(state.ownerPid)
      && state.ownerPid > 0
      && state.ownerPid !== previousOwnerPid
      && ownerAlive(state.ownerPid)
      && state.daemonPid === runtime.pid
      && (config.mode === "full"
        ? matchesTunnelIdentity(state.tunnelIdentity, expectedTunnelIdentity)
          && (Number.isSafeInteger(expectedTunnelPid) && expectedTunnelPid > 0
          ? state.tunnelPid === expectedTunnelPid
          : expectedTunnelPid === null
            && typeof expectedTunnelHealthFingerprint === "string"
            && /^[a-f0-9]{64}$/.test(expectedTunnelHealthFingerprint)
            && state.tunnelPid === null
            && state.tunnelHealthFingerprint === expectedTunnelHealthFingerprint)
        : state.tunnelPid === null);
    if (ready) return {
      ready: true,
      tunnelPid: state.tunnelPid,
      ...(state.tunnelHealthFingerprint ? { tunnelHealthFingerprint: state.tunnelHealthFingerprint } : {}),
      ownerPid: state.ownerPid,
    };
    if (config.mode === "full" && !matchesTunnelIdentity(state?.tunnelIdentity, expectedTunnelIdentity)) {
      lastFailureReason = "replacement launcher tunnel identity did not match the configured alias and tunnel ID";
    } else if (config.mode === "full"
      && Number.isSafeInteger(expectedTunnelPid) && expectedTunnelPid > 0
      && state?.tunnelPid !== expectedTunnelPid) {
      lastFailureReason = "replacement launcher did not keep the same tunnel PID";
    } else if (config.mode === "full" && expectedTunnelPid === null
      && state?.tunnelHealthFingerprint !== expectedTunnelHealthFingerprint) {
      lastFailureReason = "replacement launcher did not keep the same tunnel health fingerprint";
    } else {
      lastFailureReason = "replacement launcher exited or did not report the owned daemon ready";
    }
    if (now() >= deadline) break;
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  } while (now() <= deadline);
  return { ready: false, reason: lastFailureReason };
}

module.exports = {
  drainRuntimeForElectronRestart,
  recoverableTunnelHandoff,
  waitForElectronShutdown,
  waitForReplacementRuntime,
};
