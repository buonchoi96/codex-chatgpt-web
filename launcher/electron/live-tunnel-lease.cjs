const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { processRunning } = require("./process-tree.cjs");

const MAX_LEASE_BYTES = 4 * 1024;

function isCanonicalIsoTimestamp(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validLiveTunnelLease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAt,ownerPid,sessionId,version") return false;
  return value.version === 1
    && Number.isSafeInteger(value.ownerPid) && value.ownerPid > 0
    && typeof value.sessionId === "string" && /^[a-f0-9]{32}$/.test(value.sessionId)
    && isCanonicalIsoTimestamp(value.createdAt);
}

function createLiveTunnelLease(filePath, ownerPid, sessionId, createdAt = new Date().toISOString()) {
  const lease = { version: 1, ownerPid, sessionId, createdAt };
  if (!validLiveTunnelLease(lease)) throw new Error("Live tunnel lease record is invalid");
  writePrivateFileAtomic(filePath, `${JSON.stringify(lease)}\n`);
  return lease;
}

function readLiveTunnelLease(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEASE_BYTES) return undefined;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return validLiveTunnelLease(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isLiveTunnelLeaseActive(filePath) {
  const lease = readLiveTunnelLease(filePath);
  return Boolean(lease && processRunning(lease.ownerPid));
}

function removeLiveTunnelLease(filePath) {
  fs.rmSync(filePath, { force: true });
}

module.exports = {
  createLiveTunnelLease,
  isLiveTunnelLeaseActive,
  readLiveTunnelLease,
  removeLiveTunnelLease,
  validLiveTunnelLease,
};
