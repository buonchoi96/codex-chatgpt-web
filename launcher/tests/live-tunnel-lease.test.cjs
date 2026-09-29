const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createLiveTunnelLease,
  isLiveTunnelLeaseActive,
  readLiveTunnelLease,
  removeLiveTunnelLease,
} = require("../electron/live-tunnel-lease.cjs");

test("live tunnel lease is atomically persisted with a finite owner record", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-live-tunnel-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime", "live-tunnel-handoff.json");
  const createdAt = "2026-09-29T07:00:00.000Z";
  const lease = createLiveTunnelLease(file, process.pid, "a".repeat(32), createdAt);

  assert.deepEqual(lease, {
    version: 1,
    ownerPid: process.pid,
    sessionId: "a".repeat(32),
    createdAt,
  });
  assert.deepEqual(readLiveTunnelLease(file), lease);
  assert.equal(isLiveTunnelLeaseActive(file), true);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.includes(".tmp-")), false);
});

test("malformed and non-canonical lease records are rejected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-live-tunnel-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "lease.json");
  for (const contents of [
    "not-json\n",
    JSON.stringify({ version: 2, ownerPid: process.pid, sessionId: "a".repeat(32), createdAt: "2026-09-29T07:00:00.000Z" }),
    JSON.stringify({ version: 1, ownerPid: process.pid, sessionId: "short", createdAt: "2026-09-29T07:00:00.000Z" }),
    JSON.stringify({ version: 1, ownerPid: process.pid, sessionId: "a".repeat(32), createdAt: "2026-09-29 07:00:00" }),
    JSON.stringify({ version: 1, ownerPid: process.pid, sessionId: "a".repeat(32), createdAt: "2026-09-29T07:00:00.000Z", token: "must-not-be-accepted" }),
  ]) {
    fs.writeFileSync(file, contents);
    assert.equal(readLiveTunnelLease(file), undefined);
    assert.equal(isLiveTunnelLeaseActive(file), false);
  }
  assert.throws(() => createLiveTunnelLease(file, 0, "a".repeat(32)), /lease/i);
  assert.throws(() => createLiveTunnelLease(file, process.pid, "bad-session"), /lease/i);
});

test("a well-formed lease from a dead owner is inactive and can be removed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-live-tunnel-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "lease.json");
  createLiveTunnelLease(file, Number.MAX_SAFE_INTEGER, "b".repeat(32));
  assert.ok(readLiveTunnelLease(file));
  assert.equal(isLiveTunnelLeaseActive(file), false);
  removeLiveTunnelLease(file);
  assert.equal(fs.existsSync(file), false);
  assert.doesNotThrow(() => removeLiveTunnelLease(file));
});
