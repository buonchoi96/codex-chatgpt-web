const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { exportFullDebugBundle } = require("../electron/debug-export.cjs");

test("full debug export includes safe logs, raw launcher logs, and browser-turn diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-full-debug-"));
  try {
    const coreHome = path.join(root, "core");
    const userData = path.join(root, "launcher");
    const logs = path.join(userData, "logs");
    const launcherLogPath = path.join(logs, "launcher.jsonl");
    fs.mkdirSync(path.join(coreHome, "diagnostics", "browser-turns", "trace-1"), { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(launcherLogPath, JSON.stringify({
      at: new Date().toISOString(), level: "info", event: "test",
      detail: { prompt: "secret prompt", path: "C:\\Users\\Alice\\repo" },
    }) + "\n");
    fs.writeFileSync(path.join(coreHome, "diagnostics", "browser-turns", "trace-1", "01.json"), "{}");
    fs.writeFileSync(path.join(coreHome, "diagnostics", "browser-turns", "trace-1", "01.png"), Buffer.from([1, 2, 3, 4]));
    const destinationPath = path.join(root, "full-debug.zip");
    const result = exportFullDebugBundle({
      destinationPath, coreHome, launcherLogPath, launcherUserData: userData,
      version: "test", profile: "development",
    });
    const archive = fs.readFileSync(destinationPath);
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    const text = archive.toString("latin1");
    assert.match(text, /manifest\.json/);
    assert.match(text, /safe\/codex-web-gpt-diagnostics\.jsonl/);
    assert.match(text, /launcher\/raw\/launcher\.jsonl/);
    assert.match(text, /core\/diagnostics\/browser-turns\/trace-1\/01\.json/);
    assert.match(text, /core\/diagnostics\/browser-turns\/trace-1\/01\.png/);
    assert.ok(result.fileCount >= 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
