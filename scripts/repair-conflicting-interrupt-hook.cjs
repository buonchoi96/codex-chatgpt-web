#!/usr/bin/env bun
"use strict";

// Backup-first, explicit recovery of one uniquely signed launcher lifecycle hook.
// Default mode is read-only. No MCP, route, or integration-journal edits.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  codexInterruptHookHash,
  reclaimOrphanedCodexInterruptHook,
} = require("../src/codex-interrupt-hook.ts");
const { getCodexConfigPath, getCodexJournalPath, getCodexJournalRecoveryPath } =
  require("../src/codex-integration-shared.ts");
const { atomicWriteFile } = require("../src/config.ts");

const args = process.argv.slice(2);
const at = args.indexOf("--home");
const home = at < 0 ? null : args[at + 1];
const apply = args.includes("--apply");
const remaining = args.filter((v, i) => v !== "--apply" && v !== "--home" && (i === 0 || args[i - 1] !== "--home"));
if (remaining.length || (at >= 0 && (!home || home.startsWith("--")))) {
  console.error("Usage: bun scripts/repair-conflicting-interrupt-hook.cjs --home <live-home> [--apply]");
  process.exit(2);
}
if (home) process.env.CODEX_CHATGPT_WEB_HOME = path.resolve(home);
const fail = message => { throw Error(message); };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const parse = value => Bun.TOML.parse(value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const identity = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const lifecycle = command => typeof command === "string"
  ? /(?:^|\s)((?:"--home"|'--home')\s+(?:"[^"\r\n]+"|'[^'\r\n]+')\s+(?:"hook"|'hook')\s+(?:"interrupt"|'interrupt'))\s*$/.exec(command)?.[1] : null;

function main() {
  const configPath = getCodexConfigPath();
  const primaryPath = getCodexJournalPath();
  const recoveryPath = getCodexJournalRecoveryPath();
  if (![configPath, primaryPath, recoveryPath].every(fs.existsSync)) fail("MISSING_CONFIG_OR_JOURNAL");
  const before = fs.readFileSync(configPath, "utf8");
  const primaryBytes = fs.readFileSync(primaryPath, "utf8");
  const recoveryBytes = fs.readFileSync(recoveryPath, "utf8");
  const journal = readJson(primaryPath);
  if (!same(journal, readJson(recoveryPath))) fail("JOURNAL_COPIES_DIFFER");
  if (journal.version !== 10 || journal.active !== true
    || typeof journal.configPath !== "string"
    || identity(journal.configPath) !== identity(configPath)) fail("JOURNAL_OWNERSHIP_UNPROVEN");
  const saved = journal.interruptHook;
  if (!saved || saved.groupIndex !== 0 || typeof saved.stateKey !== "string"
    || typeof saved.command !== "string" || typeof saved.trustedHash !== "string"
    || codexInterruptHookHash(saved.command) !== saved.trustedHash) fail("JOURNAL_HOOK_INVALID");

  const document = parse(before);
  const groups = document.hooks?.Interrupt;
  const states = document.hooks?.state;
  if (!Array.isArray(groups) || groups.length !== 1
    || !states || typeof states !== "object" || Array.isArray(states)
    || Object.keys(states).length !== 1 || !Object.hasOwn(states, saved.stateKey)) {
    fail("AMBIGUOUS_HOOK_OR_TRUST_STATE");
  }
  const group = groups[0];
  if (!group || typeof group !== "object" || Array.isArray(group)
    || Object.keys(group).length !== 1 || !Array.isArray(group.hooks)
    || group.hooks.length !== 1) fail("INVALID_HOOK_GROUP");
  const hook = group.hooks[0];
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) fail("INVALID_HOOK");
  const keys = JSON.stringify(Object.keys(hook).sort());
  const plain = JSON.stringify(["command", "timeout", "type"]);
  const withDefault = JSON.stringify(["async", "command", "timeout", "type"]);
  if (!(keys === plain || (keys === withDefault && hook.async === false))
    || hook.type !== "command" || hook.timeout !== 3 || typeof hook.command !== "string") {
    fail("HOOK_FIELDS_NOT_VERIFIED");
  }
  const trust = states[saved.stateKey];
  if (!trust || typeof trust !== "object" || Array.isArray(trust)
    || Object.keys(trust).length !== 1
    || trust.trusted_hash !== codexInterruptHookHash(hook.command)) fail("HOOK_TRUST_NOT_VERIFIED");
  const actualHome = lifecycle(hook.command);
  const savedHome = lifecycle(saved.command);
  if (!actualHome || !savedHome || actualHome === savedHome) fail("NOT_A_DIFFERENT_HOME_CONFLICT");
  const start = "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
  const end = "# End codex-chatgpt-web interrupt lifecycle hook.";
  if (before.split(start).length !== 2 || before.split(end).length !== 2) fail("AMBIGUOUS_MANAGED_MARKERS");

  // The existing AST-based implementation verifies actual comments, group and trust
  // identity, then proves the remaining document is semantically unchanged.
  const result = reclaimOrphanedCodexInterruptHook(before, configPath);
  if (!result.reclaimed) fail("COULD_NOT_VERIFY_RECLAMATION");
  const restored = parse(result.text);
  if (!same(document.mcp_servers, restored.mcp_servers)) fail("MCP_SERVERS_WOULD_CHANGE");
  if (restored.hooks?.Interrupt?.length || (restored.hooks?.state
    && Object.keys(restored.hooks.state).length)) fail("HOOK_NOT_FULLY_REMOVED");

  console.log(JSON.stringify({
    verified: true, action: apply ? "backup-and-remove-only-the-stale-hook" : "dry-run",
    trusted: true, conflictingLauncherHome: true, mcpServersPreserved: true,
    warning: "Another launcher home may need Reinstall after this explicitly authorized change."
  }, null, 2));
  if (!apply) return;
  const file = fs.lstatSync(configPath);
  if (!file.isFile() || file.isSymbolicLink()) fail("CONFIG_FILE_TYPE_UNSUPPORTED");
  if (fs.readFileSync(configPath, "utf8") !== before
    || fs.readFileSync(primaryPath, "utf8") !== primaryBytes
    || fs.readFileSync(recoveryPath, "utf8") !== recoveryBytes) fail("FILES_CHANGED_DURING_PREFLIGHT");

  const backup = path.join(path.dirname(primaryPath), "hook-recovery-backups",
    new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const inputs = [[configPath, "config.toml.bak"], [primaryPath, "integration-journal.json.bak"],
    [recoveryPath, "integration-journal.recovery.json.bak"]];
  for (const [source, filename] of inputs) {
    fs.copyFileSync(source, path.join(backup, filename), fs.constants.COPYFILE_EXCL);
    if (digest(fs.readFileSync(source)) !== digest(fs.readFileSync(path.join(backup, filename)))) {
      fail("BACKUP_VERIFICATION_FAILED");
    }
  }
  if (fs.readFileSync(configPath, "utf8") !== before) fail("CONFIG_CHANGED_BEFORE_WRITE");
  atomicWriteFile(configPath, result.text);
  if (!same(parse(fs.readFileSync(configPath, "utf8")).mcp_servers, document.mcp_servers)) {
    fail("POST_WRITE_MCP_CHECK_FAILED; restore the backup before restarting Codex");
  }
  console.log(JSON.stringify({
    result: "OLD_HOOK_RECLAIMED", backupDirectory: backup,
    next: "Start dev:live, then Install models > Reinstall if needed."
  }, null, 2));
}
try { main(); } catch (error) {
  console.error("REFUSED_SAFELY:", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
}
