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

  assert.equal(rootPackage.scripts["dev:live"], "bun run --cwd launcher dev:live");
  assert.equal(launcherPackage.scripts["dev:live"], "bun run scripts/dev-live.cjs");
  assert.match(source, /\.codex-chatgpt-web-live/);
  assert.match(source, /CODEX_CHATGPT_WEB_HOME: liveHome/);
  assert.match(source, /CODEX_WEB_GPT_LAUNCHER_DATA_DIR: liveUserData/);
  assert.match(source, /Codex Native2 and its tunnel/);
  assert.doesNotMatch(source, /electronBin, \[launcherRoot, ["']--dev-profile/);
  assert.match(source, /scripts\/build-browser-helper\.ts/);
  assert.match(source, /control\(config, "drain"\)/);
  assert.match(source, /control\(config, "shutdown"\)/);
  assert.match(source, /next\.pid !== oldPid/);
  assert.match(source, /routeCommand\("connect"\)/);
  assert.match(source, /routeCommand\("disconnect"\)/);
  assert.match(source, /launcher\/electron/);
  assert.match(source, /Vite HMR/);
});
