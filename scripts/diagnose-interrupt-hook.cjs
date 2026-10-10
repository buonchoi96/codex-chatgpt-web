#!/usr/bin/env bun
"use strict";

// Read-only local diagnostic. Never logs command text, hashes, MCP values, or journal secrets.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const homeFlag = process.argv.indexOf("--home");
if (homeFlag !== -1 && !process.argv[homeFlag + 1]) {
  console.error("Usage: bun scripts/diagnose-interrupt-hook.cjs [--home <launcher-live-home>]");
  process.exitCode = 2;
} else {
  const home = path.resolve(
    homeFlag === -1
      ? process.env.CODEX_CHATGPT_WEB_HOME || path.join(os.homedir(), ".codex-chatgpt-web-live")
      : process.argv[homeFlag + 1],
  );
  const journalPath = path.join(home, "codex", "integration-journal.json");
  const recoveryPath = path.join(home, "codex", "integration-journal.recovery.json");
  const output = {
    diagnostic: "interrupt-hook-ownership",
    readOnly: true,
    journalPresent: fs.existsSync(journalPath),
    recoveryJournalPresent: fs.existsSync(recoveryPath),
  };
  try {
    if (!output.journalPresent) {
      output.result = "NO_LIVE_JOURNAL";
    } else {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8").replace(/^\uFEFF/, ""));
      const installed = journal.interruptHook;
      output.journalVersion = journal.version ?? null;
      output.active = journal.active ?? null;
      output.hasOwnedHookRecord = Boolean(installed && typeof installed.command === "string"
        && typeof installed.trustedHash === "string"
        && typeof installed.stateKey === "string");
      if (!output.hasOwnedHookRecord) {
        output.result = "JOURNAL_MISSING_OWNERSHIP_EVIDENCE";
      } else {
        const configPath = journal.configPath;
        output.codexConfigPresent = typeof configPath === "string" && fs.existsSync(configPath);
        if (!output.codexConfigPresent) {
          output.result = "CODEX_CONFIG_NOT_FOUND";
        } else {
          const raw = fs.readFileSync(configPath, "utf8");
          const config = Bun.TOML.parse(raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
          const groups = config.hooks?.Interrupt;
          const state = config.hooks?.state;
          output.interruptGroupCount = Array.isArray(groups) ? groups.length : null;
          output.trustStateEntryCount = state && typeof state === "object" && !Array.isArray(state)
            ? Object.keys(state).length : null;
          output.startMarkerCount = raw.split("# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.").length - 1;
          output.endMarkerCount = raw.split("# End codex-chatgpt-web interrupt lifecycle hook.").length - 1;
          const match = [];
          const explicitAsyncFalse = [];
          const unusualManagedShape = [];
          if (Array.isArray(groups)) {
            for (let index = 0; index < groups.length; index++) {
              const group = groups[index];
              const hooks = group && typeof group === "object" && !Array.isArray(group) ? group.hooks : undefined;
              if (!Array.isArray(hooks)) continue;
              for (const hook of hooks) {
                if (!hook || typeof hook !== "object" || Array.isArray(hook)
                    || hook.command !== installed.command) continue;
                match.push(index);
                if (hook.async === false) explicitAsyncFalse.push(index);
                if (hook.type !== "command" || hook.timeout !== 3 || (hook.async !== undefined && hook.async !== false)
                    || hooks.length !== 1 || Object.keys(group).some(key => key !== "hooks")
                    || Object.keys(hook).some(key => !["command", "timeout", "type", "async"].includes(key))) {
                  unusualManagedShape.push(index);
                }
              }
            }
          }
          output.ownedCommandIndices = [...new Set(match)];
          output.explicitDefaultAsyncFalseIndices = [...new Set(explicitAsyncFalse)];
          output.unusualOwnedCommandShapeIndices = [...new Set(unusualManagedShape)];
          const prefix = installed.stateKey.replace(/\d+:0$/, "");
          output.ownedTrustIndices = state && typeof state === "object" && !Array.isArray(state)
            ? Object.entries(state).filter(([key, value]) =>
                key.startsWith(prefix) && /^\d+:0$/.test(key.slice(prefix.length))
                && value && typeof value === "object" && !Array.isArray(value)
                && value.trusted_hash === installed.trustedHash)
              .map(([key]) => Number(key.slice(prefix.length, -2))) : [];
          output.originalJournalGroupIndex = installed.groupIndex;
          output.originalJournalTrustStillPresent = Boolean(state && Object.prototype.hasOwnProperty.call(state, installed.stateKey));
          output.result = "READ_ONLY_INSPECTION_COMPLETE";
        }
      }
    }
  } catch (error) {
    output.result = "INSPECTION_FAILED";
    output.errorType = error instanceof SyntaxError ? "PARSE_ERROR" : "READ_ERROR";
  }
  console.log(JSON.stringify(output, null, 2));
}
