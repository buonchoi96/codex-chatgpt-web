const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Activity places full debug export next to safe logs and exposes IPC", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
  const types = fs.readFileSync(path.join(__dirname, "..", "src", "types.ts"), "utf8");
  assert.match(app, /activity-actions[\s\S]*exportLogs\(\)[\s\S]*exportFullDebug\(\)/);
  assert.match(preload, /exportFullDebug: \(\) => ipcRenderer\.invoke\("launcher:export-full-debug"\)/);
  assert.match(types, /exportFullDebug\(\): Promise<string \| null>/);
});
