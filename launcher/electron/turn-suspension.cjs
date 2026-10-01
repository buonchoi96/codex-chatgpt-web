"use strict";

/**
 * System sleep freezes both sides of the turn-lease protocol at once: the helper cannot send
 * heartbeats and the launcher cannot observe them. The first sweep after wake must re-baseline
 * active leases instead of treating the suspended interval as process failure.
 */

/**
 * The turn-lease sweep runs on a short fixed interval for the whole life of the launcher. A gap
 * between consecutive sweeps far larger than that interval means the process was suspended, not
 * busy: nothing the launcher does blocks its event loop for multiples of the sweep interval.
 */
function sweepGapIndicatesSuspension(lastSweepAt, now, sweepIntervalMs) {
  if (typeof lastSweepAt !== "number" || !Number.isFinite(lastSweepAt)) return false;
  return now - lastSweepAt >= sweepIntervalMs * 6;
}

/**
 * Re-baseline every lease that depends on time passing. A running tab's helper gets a full
 * heartbeat window to prove it survived the sleep; a tab still bootstrapping gets its bootstrap
 * budget back. Returns the refreshed trace ids so the caller can log the decision.
 */
function refreshTurnLeasesAfterSuspension(tabs, now, bootstrapTimeoutMs) {
  const refreshed = [];
  for (const tab of tabs) {
    if (tab.status !== "running") continue;
    tab.lastHeartbeatAt = now;
    if (tab.bootstrapReady !== true) tab.bootstrapDeadlineAt = now + bootstrapTimeoutMs;
    refreshed.push(tab.traceId);
  }
  return refreshed;
}

/**
 * A power-save blocker belongs up exactly while at least one browser turn is running on platforms
 * where the Electron app-suspension blocker does not interfere with the user's display timeout.
 *
 * On Windows, real systems can expose Electron's prevent-app-suspension request under DISPLAY in
 * powercfg /requests, preventing the monitor from turning off even though Electron documents the
 * mode as display-safe. Do not install a Launcher power request on Windows. The existing
 * suspension/resume lease re-baselining keeps browser turns recoverable if Windows later sleeps.
 */
function shouldBlockSleepForTurns(tabs, platform = process.platform) {
  if (platform === "win32") return false;
  for (const tab of tabs) {
    if (tab.status === "running") return true;
  }
  return false;
}

module.exports = {
  sweepGapIndicatesSuspension,
  refreshTurnLeasesAfterSuspension,
  shouldBlockSleepForTurns,
};
