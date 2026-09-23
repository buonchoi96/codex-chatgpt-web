import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: 3,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  // Codex executes command hooks through cmd.exe /C on Windows. Quoting every argument preserves
  // spaces and shell metacharacters in the installed runtime path.
  return `"${value}"`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return args.map(platform === "win32" ? cmdShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function interruptGroupCount(text: string): number {
  return text.split(/\r\n|\n|\r/).filter(line => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/.test(line)).length;
}

function managedMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return {
    text: `${text}${fragment}`,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}


/**
 * Reclaim one intact codex-chatgpt-web Interrupt hook left behind when the launcher data/journal
 * was removed before the Codex config. This is intentionally fail-closed: only the exact managed
 * marker pair, one generated Interrupt definition, and its matching trust-state entry for the
 * active config path are eligible. Any modification or ambiguity is left for explicit recovery.
 */
export function reclaimOrphanedCodexInterruptHook(
  text: string,
  configPath: string,
): { text: string; reclaimed: boolean } {
  const startCount = managedMarkerCount(text);
  const endCount = text.split(MANAGED_INTERRUPT_HOOK_END).length - 1;
  if (startCount === 0 && endCount === 0) return { text, reclaimed: false };
  if (startCount !== 1 || endCount !== 1) {
    throw new Error("Codex config contains an ambiguous stale codex-chatgpt-web interrupt hook; refusing automatic repair");
  }
  const start = text.indexOf(MANAGED_INTERRUPT_HOOK_START);
  const endMarker = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (start < 0 || endMarker < start) {
    throw new Error("Codex config contains a malformed stale codex-chatgpt-web interrupt hook; refusing automatic repair");
  }
  const fragment = text.slice(start, endMarker + MANAGED_INTERRUPT_HOOK_END.length);
  let parsed: {
    hooks?: {
      Interrupt?: Array<{ hooks?: Array<Record<string, unknown>> }>;
      state?: Record<string, Record<string, unknown>>;
    };
  };
  try {
    // Prove both the candidate fragment and the full config remain valid TOML before touching it.
    Bun.TOML.parse(text.replace(/\r\n?/g, "\n"));
    parsed = Bun.TOML.parse(fragment.replace(/\r\n?/g, "\n")) as typeof parsed;
  } catch {
    throw new Error("Codex config contains a malformed stale codex-chatgpt-web interrupt hook; refusing automatic repair");
  }
  const interrupts = parsed.hooks?.Interrupt;
  const state = parsed.hooks?.state;
  if (!Array.isArray(interrupts) || interrupts.length !== 1
    || !state || typeof state !== "object" || Array.isArray(state)
    || Object.keys(state).length !== 1) {
    throw new Error("Codex config stale interrupt hook no longer matches the managed shape; refusing automatic repair");
  }
  const hooks = interrupts[0]?.hooks;
  if (!Array.isArray(hooks) || hooks.length !== 1) {
    throw new Error("Codex config stale interrupt hook no longer matches the managed shape; refusing automatic repair");
  }
  const hook = hooks[0]!;
  const hookKeys = Object.keys(hook).sort();
  if (JSON.stringify(hookKeys) !== JSON.stringify(["command", "timeout", "type"])) {
    throw new Error("Codex config stale interrupt hook contains unexpected fields; refusing automatic repair");
  }
  const command = hook.command;
  if (hook.type !== "command" || typeof command !== "string" || command.length === 0 || hook.timeout !== 3) {
    throw new Error("Codex config stale interrupt hook no longer matches the managed command; refusing automatic repair");
  }
  const groupIndex = interruptGroupCount(text.slice(0, start));
  const stateKey = Object.keys(state)[0]!;
  const expectedStateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  if (stateKey !== expectedStateKey) {
    throw new Error("Codex config stale interrupt hook belongs to a different config path; refusing automatic repair");
  }
  const stateEntry = state[stateKey]!;
  if (Object.keys(stateEntry).length !== 1 || typeof stateEntry.trusted_hash !== "string") {
    throw new Error("Codex config stale interrupt hook trust state changed; refusing automatic repair");
  }
  const trustedHash = stateEntry.trusted_hash;
  if (trustedHash !== codexInterruptHookHash(command)) {
    throw new Error("Codex config stale interrupt hook trust hash changed; refusing automatic repair");
  }
  const installed: InstalledCodexInterruptHook = {
    command,
    groupIndex,
    stateKey,
    trustedHash,
    fragment,
  };
  const repaired = restoreCodexInterruptHook(text, installed);
  verifyCodexInterruptHookRestored(repaired);
  return { text: repaired, reclaimed: true };
}

function hookTextPattern(text: string): string {
  return text.split(/\r\n|\n|\r/)
    .map(line => line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("(?:\\r\\n|\\n|\\r)");
}

function definitionTextPattern(text: string): string {
  // Native TOML serialization can remove separator blank lines without changing a definition.
  // Match one canonical form, consuming at most the original separators for exact restoration.
  const leading = text.match(/^[\r\n]+/)?.[0] ?? "";
  const trailing = text.match(/[\r\n]+$/)?.[0] ?? "";
  const separator = (value: string) => `(?:\\r\\n|\\n|\\r){0,${value.match(/\r\n|\n|\r/g)?.length ?? 0}}`;
  return separator(leading) + hookTextPattern(text.slice(leading.length, text.length - trailing.length))
    + separator(trailing);
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): Array<{
  start: number; end: number;
}> {
  const marker = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (marker < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  const ownedPrefix = installed.fragment.slice(0, marker);
  const stateHeader = /(?:^|\r\n|\n|\r)(\[hooks\.state\.[^\r\n]+\])/.exec(ownedPrefix);
  if (!stateHeader || stateHeader[1] !== `[hooks.state.${JSON.stringify(installed.stateKey)}]`) {
    throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  }
  const stateOffset = stateHeader.index + stateHeader[0].length - stateHeader[1].length;
  // The native TOML writer can insert unrelated tables between the hook and its trust state.
  // Locate the two owned definitions separately, retaining exact command/field matching.
  // It also rewrites Windows trust keys as literal strings. Decode only candidate headers;
  // the complete document and the exact owned fields are still checked below.
  const stateHeaders = [...text.matchAll(/^\[hooks\.state\.[^\r\n]+\]/gm)]
    .map(match => match[0])
    .filter(header => {
      try {
        const parsed = Bun.TOML.parse(header) as { hooks: { state: Record<string, unknown> } };
        const keys = Object.keys(parsed.hooks.state);
        return keys.length === 1 && keys[0] === installed.stateKey;
      } catch {
        return false;
      }
    });
  const patterns = [
    definitionTextPattern(ownedPrefix.slice(0, stateOffset)),
    `(?:${stateHeaders.map(hookTextPattern).join("|")})`
      + definitionTextPattern(ownedPrefix.slice(stateOffset + stateHeader[1].length)),
  ];
  if (stateHeaders.length === 0) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const ranges = patterns.map(source => {
    const pattern = new RegExp(source, "g");
    const match = pattern.exec(text);
    if (!match || pattern.exec(text)) {
      throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
    }
    return { start: match.index, end: match.index + match[0].length };
  });
  const [hook, state] = ranges;
  const overlapStart = hook && state ? Math.max(hook.start, state.start) : 0;
  const overlapEnd = hook && state ? Math.min(hook.end, state.end) : 0;
  if (!hook || !state || (overlapStart < overlapEnd && /[^\r\n]/.test(text.slice(overlapStart, overlapEnd)))) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (interruptGroupCount(text.slice(0, hook.start)) !== installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  }
  const endMarker = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (managedMarkerCount(text) !== 1 || endMarker < 0
    || ranges.some(range => endMarker >= range.start && endMarker < range.end)
    || text.split(MANAGED_INTERRUPT_HOOK_END).length !== 2) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  const definitions = (value: unknown, groupIndex: number): string => {
    const { hooks } = value as { hooks: { Interrupt: unknown[]; state: Record<string, unknown> } };
    return JSON.stringify(canonicalJson([hooks.Interrupt[groupIndex], hooks.state[installed.stateKey]]));
  };
  // Check the complete document: an interleaved or later table must not extend either owned
  // definition, and a matching fragment inside a multiline string must not establish ownership.
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text.replace(/\r\n?/g, "\n"));
    const expected = Bun.TOML.parse(ownedPrefix.replace(/\r\n?/g, "\n"));
    if (definitions(parsed, installed.groupIndex) !== definitions(expected, 0)) {
      throw new Error("Modified owned definitions");
    }
  } catch {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const end = endMarker + MANAGED_INTERRUPT_HOOK_END.length;
  try {
    const withoutMarker = Bun.TOML.parse((text.slice(0, endMarker) + text.slice(end)).replace(/\r\n?/g, "\n"));
    if (JSON.stringify(canonicalJson(parsed)) !== JSON.stringify(canonicalJson(withoutMarker))) {
      throw new Error("Marker removal changes TOML values");
    }
  } catch {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  const trailing = installed.fragment.slice(marker + MANAGED_INTERRUPT_HOOK_END.length);
  const trailingLength = new RegExp("^" + hookTextPattern(trailing)).exec(text.slice(end))?.[0].length ?? 0;
  // Reordered adjacent definitions can share separator newlines; remove their union only once.
  const definitionsToRemove = overlapStart < overlapEnd
    ? [{ start: Math.min(hook.start, state.start), end: Math.max(hook.end, state.end) }]
    : ranges;
  return [...definitionsToRemove, { start: endMarker, end: end + trailingLength }];
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean } = {},
): string {
  // Explicit Setup can reinstall a fully removed hook. A stale journal alone does not mean
  // there is still a definition to remove; partial edits must retain the strict checks below.
  if (options.allowAbsent && managedMarkerCount(text) === 0 && !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    const { hooks } = Bun.TOML.parse(text) as { hooks?: unknown };
    if (hooks === undefined) return text;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks) && !Object.hasOwn(hooks, "Interrupt")) {
      const state = (hooks as Record<string, unknown>).state;
      if (state === undefined || (state && typeof state === "object" && !Array.isArray(state)
        && !Object.hasOwn(state, installed.stateKey))) return text;
    }
  }
  const owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
