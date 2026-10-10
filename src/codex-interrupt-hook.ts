import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import type { AppConfig } from "./config";
import { getConfigDir, stripUtf8Bom } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";

function canonicalJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
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

function tomlAstSource(text: string): string {
  const normalized = text.replace(/\r(?!\n)/g, "\n");
  // toml-eslint-parser source ranges are used against the original config. Replace a leading
  // UTF-8 BOM with one same-width character instead of removing it so every AST offset remains
  // aligned with the source we later edit.
  return normalized.startsWith("\uFEFF") ? " " + normalized.slice(1) : normalized;
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

function interruptStateKeyParts(stateKey: string): { prefix: string; suffix: string } | undefined {
  const match = /^(.*:interrupt:)\d+(:0)$/.exec(stateKey);
  return match ? { prefix: match[1]!, suffix: match[2]! } : undefined;
}

function interruptStateKeyForGroup(stateKey: string, groupIndex: number): string | undefined {
  const parts = interruptStateKeyParts(stateKey);
  return parts ? `${parts.prefix}${groupIndex}${parts.suffix}` : undefined;
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
  const groups = parseHookDocument(text).hooks?.Interrupt;
  if (groups !== undefined && !Array.isArray(groups)) throw new Error("Codex Interrupt hooks must be an array");
  const groupIndex = groups?.length ?? 0;
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const trustSection = [
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    trustSection,
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
  const ast = parseTOML(tomlAstSource(text), { tomlVersion: "1.0" });
  const inline = inlineInterruptArray(ast);
  let installedText = `${text}${fragment}`;
  if (inline) {
    const end = inline.range[1] - 1;
    const last = inline.elements.at(-1);
    const comma = last && !ast.tokens.some(token => token.value === "," && token.range[0] >= last.range[1] && token.range[1] <= end)
      ? "," : "";
    const item = `${comma} { hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 3 }] } `;
    installedText = text.slice(0, end) + item + text.slice(end) + leading + trustSection + trailing;
  }
  return {
    text: installedText,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

type SourceRange = { start: number; end: number };
type HookDocument = { hooks?: { Interrupt?: unknown[]; state?: Record<string, unknown> } };

function inlineInterruptArray(ast: AST.TOMLProgram): AST.TOMLArray | undefined {
  const visit = (value: AST.TOMLContentNode, path: string[]): AST.TOMLArray | undefined => {
    if (path.length === 2 && path[0] === "hooks" && path[1] === "Interrupt" && value.type === "TOMLArray") return value;
    if (value.type === "TOMLInlineTable") {
      for (const entry of value.body) {
        const found = visit(entry.value, [...path, ...getStaticTOMLValue(entry.key)]);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLTable") {
      if (node.resolvedKey.some(part => typeof part !== "string")) continue;
      for (const entry of node.body) {
        const found = visit(entry.value, [...node.resolvedKey as string[], ...getStaticTOMLValue(entry.key)]);
        if (found) return found;
      }
    } else {
      const found = visit(node.value, getStaticTOMLValue(node.key));
      if (found) return found;
    }
  }
  return undefined;
}

function parseHookDocument(text: string): HookDocument {
  return Bun.TOML.parse(stripUtf8Bom(text).replace(/\r\n?/g, "\n")) as HookDocument;
}

/**
 * Reclaim one intact codex-chatgpt-web Interrupt hook left behind when launcher state was removed
 * before the Codex config. The semantic TOML representation is authoritative: config path, group
 * index, command shape and trust hash must all agree before any source is removed.
 */
export function reclaimOrphanedCodexInterruptHook(
  text: string,
  configPath: string,
): { text: string; reclaimed: boolean } {
  const startCount = managedMarkerCount(text);
  const endCount = text.split(MANAGED_INTERRUPT_HOOK_END).length - 1;
  if (startCount === 0 && endCount === 0) return { text, reclaimed: false };

  let document: HookDocument;
  let ast: AST.TOMLProgram;
  try {
    document = parseHookDocument(text);
    ast = parseTOML(tomlAstSource(text), { tomlVersion: "1.0" });
  } catch {
    throw new Error("Codex config contains a malformed stale codex-chatgpt-web interrupt hook; refusing automatic repair");
  }

  // Codex can preserve old comments after normalizing/reinstalling hook tables.
  // Treat only actual TOML comments as markers: a marker inside a string is never
  // evidence of ownership. Never remove a foreign hook or an unverified trust entry.
  const markers = [MANAGED_INTERRUPT_HOOK_START, MANAGED_INTERRUPT_HOOK_END];
  const comments = ast.comments.filter(comment =>
    markers.some(marker => text.slice(...comment.range) === marker));
  if (comments.length !== startCount + endCount) {
    throw new Error("Codex config contains an ambiguous stale codex-chatgpt-web interrupt hook; refusing automatic repair");
  }

  const groups = document.hooks?.Interrupt;
  const state = document.hooks?.state;
  if (!Array.isArray(groups) || !state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Codex config stale interrupt hook no longer matches the managed shape; refusing automatic repair");
  }
  const statePrefix = canonicalConfigPath(configPath) + ":interrupt:";
  const pathEntries = Object.entries(state).filter(([key]) =>
    key.startsWith(statePrefix) && /^\d+:0$/.test(key.slice(statePrefix.length)));
  if (pathEntries.length === 0) {
    throw new Error("Codex config stale interrupt hook belongs to a different config path; refusing automatic repair");
  }

  const candidates: InstalledCodexInterruptHook[] = [];
  for (const [stateKey, rawState] of pathEntries) {
    const groupIndex = Number(stateKey.slice(statePrefix.length, -2));
    if (!Number.isSafeInteger(groupIndex) || groupIndex < 0 || groupIndex >= groups.length) {
      throw new Error("Codex config stale interrupt hook no longer matches the managed shape; refusing automatic repair");
    }
    if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
      throw new Error("Codex config stale interrupt hook trust state changed; refusing automatic repair");
    }
    const entry = rawState as Record<string, unknown>;
    if (Object.keys(entry).length !== 1 || typeof entry.trusted_hash !== "string") {
      throw new Error("Codex config stale interrupt hook trust state changed; refusing automatic repair");
    }
    const group = groups[groupIndex];
    const hooks = group && typeof group === "object" && !Array.isArray(group)
      ? (group as { hooks?: unknown }).hooks : undefined;
    if (!Array.isArray(hooks) || hooks.length !== 1
      || !hooks[0] || typeof hooks[0] !== "object" || Array.isArray(hooks[0])) {
      throw new Error("Codex config stale interrupt hook no longer matches the managed shape; refusing automatic repair");
    }
    const hook = hooks[0] as Record<string, unknown>;
    if (JSON.stringify(Object.keys(hook).sort()) !== JSON.stringify(["command", "timeout", "type"])
      || hook.type !== "command" || typeof hook.command !== "string" || !hook.command
      || hook.timeout !== 3) {
      throw new Error("Codex config stale interrupt hook contains unexpected fields; refusing automatic repair");
    }
    const trustedHash = entry.trusted_hash;
    if (trustedHash !== codexInterruptHookHash(hook.command)) {
      throw new Error("Codex config stale interrupt hook trust hash changed; refusing automatic repair");
    }
    const fragment = [
      MANAGED_INTERRUPT_HOOK_START,
      "[[hooks.Interrupt]]",
      "",
      "[[hooks.Interrupt.hooks]]",
      'type = "command"',
      "command = " + JSON.stringify(hook.command),
      "timeout = 3",
      "",
      "[hooks.state." + JSON.stringify(stateKey) + "]",
      "trusted_hash = " + JSON.stringify(trustedHash),
      MANAGED_INTERRUPT_HOOK_END,
    ].join(lineEnding(text));
    candidates.push({ command: hook.command, groupIndex, stateKey, trustedHash, fragment });
  }

  // Remove only full-line, parser-confirmed comments; then the existing semantic
  // restoration path validates the precise command/group/hash before removing it.
  const ranges: SourceRange[] = comments.map(comment => {
    const start = Math.max(text.lastIndexOf("\n", comment.range[0] - 1), text.lastIndexOf("\r", comment.range[0] - 1)) + 1;
    const prefix = text.slice(start, comment.range[0]);
    const rest = text.slice(comment.range[1]);
    const suffix = /^[ \t]*(?:\r\n|\n|\r|$)/.exec(rest);
    if (!/^[ \t]*$/.test(prefix) || !suffix) {
      throw new Error("Codex config contains an ambiguous stale codex-chatgpt-web interrupt hook; refusing automatic repair");
    }
    return { start, end: comment.range[1] + suffix[0].length };
  });
  let repaired = removeRanges(text, ranges);
  // Highest group first: its original index remains stable while it is removed.
  for (const installed of candidates.sort((a, b) => b.groupIndex - a.groupIndex)) {
    repaired = restoreCodexInterruptHook(repaired, installed);
  }
  verifyCodexInterruptHookRestored(repaired);
  return { text: repaired, reclaimed: true };
}

function invalidConfig(): Error {
  return new Error("Codex config.toml could not be parsed as TOML. Back up the file, repair its syntax "
    + "or restore a known-good backup, then retry Setup > Install into Codex > Reinstall. "
    + "The launcher has not overwritten the file.");
}

const HOOK_RECOVERY = " Back up Codex config.toml, restore only the launcher's hook sections from a known-good "
  + "backup made after successful setup, then retry Setup > Install into Codex > Reinstall. "
  + "Keep unrelated settings and hooks. If no suitable backup exists, export Activity > Export safe log and ask for help.";

function withoutEmptyHookContainers(document: HookDocument): unknown {
  const result = structuredClone(document);
  const hooks = result.hooks;
  if (hooks) {
    if (hooks.Interrupt?.length === 0) delete hooks.Interrupt;
    if (hooks.state && Object.keys(hooks.state).length === 0) delete hooks.state;
    if (Object.keys(hooks).length === 0) delete result.hooks;
  }
  return canonicalJson(result);
}

function removeRanges(text: string, ranges: SourceRange[]): string {
  for (const { start, end } of [...ranges].sort((left, right) => right.start - left.start)) {
    text = text.slice(0, start) + text.slice(end);
  }
  return text;
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): SourceRange[] {
  const changed = (detail = "The launcher's entries in hooks.Interrupt and hooks.state cannot be safely identified.") =>
    new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it. " + detail + HOOK_RECOVERY);
  const invalidJournal = () => new Error("Codex interrupt lifecycle hook journal is invalid. "
    + "The launcher's saved setup record is inconsistent; this does not establish that config.toml is damaged. "
    + "Export Activity > Export safe log and ask for help. Do not delete or edit the integration journal.");
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw invalidJournal();
  }
  let document: HookDocument;
  let ast: AST.TOMLProgram;
  let journalAst: AST.TOMLProgram;
  const expectedGroup = { hooks: [{ type: "command", command: installed.command, timeout: 3 }] };
  const expectedState = { trusted_hash: installed.trustedHash };
  const equal = (left: unknown, right: unknown) => JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
  try {
    const journal = parseHookDocument(installed.fragment);
    if (!equal(journal.hooks?.Interrupt, [expectedGroup])
      || !equal(journal.hooks?.state, { [installed.stateKey]: expectedState })) throw invalidJournal();
    journalAst = parseTOML(installed.fragment.replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" });
  } catch {
    throw invalidJournal();
  }
  try {
    document = parseHookDocument(text);
    // Normalize bare CR without moving offsets; the parser retains every source range and comment.
    ast = parseTOML(tomlAstSource(text), { tomlVersion: "1.0" });
    journalAst = parseTOML(installed.fragment.replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" });
  } catch {
    throw invalidConfig();
  }
  const groups = document.hooks?.Interrupt;
  const state = document.hooks?.state;
  if (!Array.isArray(groups) || !state || typeof state !== "object" || Array.isArray(state)) throw changed();

  let effectiveGroupIndex = installed.groupIndex;
  let effectiveStateKey = installed.stateKey;
  const installedPositionStillMatches = equal(groups[installed.groupIndex], expectedGroup)
    && equal(state[installed.stateKey], expectedState);
  if (!installedPositionStillMatches) {
    const stateKeyParts = interruptStateKeyParts(installed.stateKey);
    if (!stateKeyParts) throw changed();

    const matchingGroupIndices = groups
      .map((group, index) => equal(group, expectedGroup) ? index : -1)
      .filter(index => index >= 0);
    const matchingStateKeys = Object.entries(state)
      .filter(([key, value]) => {
        if (!key.startsWith(stateKeyParts.prefix) || !key.endsWith(stateKeyParts.suffix)) return false;
        const indexText = key.slice(stateKeyParts.prefix.length, key.length - stateKeyParts.suffix.length);
        return /^\d+$/.test(indexText) && equal(value, expectedState);
      })
      .map(([key]) => key);
    const relocated = matchingGroupIndices.flatMap(groupIndex => {
      const stateKey = interruptStateKeyForGroup(installed.stateKey, groupIndex);
      return stateKey && matchingStateKeys.includes(stateKey) ? [{ groupIndex, stateKey }] : [];
    });

    // Codex may insert another Interrupt group and rewrite the trust-state index. That is a
    // serialization/layout change, not a semantic ownership change, but it is safe to follow only
    // when both the exact managed command and its exact trust state are unique.
    if (relocated.length !== 1 || matchingGroupIndices.length !== 1 || matchingStateKeys.length !== 1) {
      if (matchingGroupIndices.length > 0) {
        throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
      }
      throw changed();
    }
    effectiveGroupIndex = relocated[0]!.groupIndex;
    effectiveStateKey = relocated[0]!.stateKey;
  }

  const ranges: SourceRange[] = [];
  // A native config edit may discard comments. Authority comes from the exact journal, command,
  // group index and trust hash; a marker inside a value or duplicate marker is never authority.
  for (const marker of [MANAGED_INTERRUPT_HOOK_START, MANAGED_INTERRUPT_HOOK_END]) {
    const comments = ast.comments.filter(comment => text.slice(...comment.range) === marker);
    if (comments.length > 1 || text.split(marker).length - 1 !== comments.length) {
      throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them. "
        + "The launcher's identifying comments in Codex config.toml are duplicated or embedded in a value." + HOOK_RECOVERY);
    }
    for (const comment of comments) {
      let start = comment.range[0];
      if (marker === MANAGED_INTERRUPT_HOOK_START) {
        const separatorCount = installed.fragment.match(/^(?:\r\n|\n|\r)*/)?.[0].match(/\r\n|\n|\r/g)?.length ?? 0;
        const prefix = new RegExp(`(?:\\r\\n|\\n|\\r){0,${separatorCount}}$`).exec(text.slice(0, start));
        start -= prefix?.[0].length ?? 0;
      }
      ranges.push({ start, end: comment.range[1] });
    }
  }
  const groupPath = ["hooks", "Interrupt", effectiveGroupIndex];
  const statePath = ["hooks", "state", effectiveStateKey];
  const startsWith = (path: (string | number)[], prefix: (string | number)[]) =>
    prefix.every((part, index) => path[index] === part);
  let groupLocated = false;
  let stateLocated = false;
  const owned = (path: (string | number)[]) => {
    if (startsWith(path, groupPath)) { groupLocated = true; return true; }
    if (startsWith(path, statePath)) { stateLocated = true; return true; }
    return false;
  };
  const removeNode = (node: AST.TOMLNode, siblings?: AST.TOMLNode[]) => {
    let end = node.range[1];
    if (node.type === "TOMLTable") {
      const path = [...node.resolvedKey];
      if (startsWith(path, groupPath)) path[2] = 0;
      const original = journalAst.body[0].body.find(item => item.type === "TOMLTable" && equal(item.resolvedKey, path));
      if (original) {
        const count = installed.fragment.slice(original.range[1]).match(/^(?:\r\n|\n|\r)*/)?.[0].match(/\r\n|\n|\r/g)?.length ?? 0;
        end += new RegExp(`^(?:\\r\\n|\\n|\\r){0,${count}}`).exec(text.slice(end))?.[0].length ?? 0;
      }
    }
    ranges.push({ start: node.range[0], end });
    if (!siblings || siblings.length < 2) return;
    const index = siblings.indexOf(node);
    const left = index > 0 ? siblings[index - 1]!.range[1] : node.range[1];
    const right = index > 0 ? node.range[0] : siblings[index + 1]!.range[0];
    const comma = ast.tokens.find(token => token.value === "," && token.range[0] >= left && token.range[1] <= right);
    if (!comma) throw changed();
    ranges.push({ start: comma.range[0], end: comma.range[1] });
  };
  const visitValue = (value: AST.TOMLContentNode, path: (string | number)[]) => {
    if (value.type === "TOMLInlineTable") {
      for (const entry of value.body) visitEntry(entry, path, value.body);
    } else if (value.type === "TOMLArray") {
      value.elements.forEach((element, index) => {
        const elementPath = [...path, index];
        if (owned(elementPath)) removeNode(element, value.elements);
        else visitValue(element, elementPath);
      });
    }
  };
  const visitEntry = (entry: AST.TOMLKeyValue, prefix: (string | number)[], siblings?: AST.TOMLNode[]) => {
    const path = [...prefix, ...getStaticTOMLValue(entry.key)];
    if (owned(path)) removeNode(entry, siblings);
    else if (equal(path, ["hooks", "Interrupt"]) && entry.value.type === "TOMLArray" && entry.value.elements.length === 1) {
      if (!owned([...path, 0])) throw changed();
      removeNode(entry, siblings);
    } else visitValue(entry.value, path);
  };
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLTable") {
      if (owned(node.resolvedKey)) removeNode(node);
      else for (const entry of node.body) visitEntry(entry, node.resolvedKey);
    } else visitEntry(node, []);
  }
  if (!groupLocated || !stateLocated) throw changed();
  // Keep byte-exact restoration when the owned fragment has not been reformatted.
  const exact = effectiveGroupIndex === installed.groupIndex && effectiveStateKey === installed.stateKey
    ? text.indexOf(installed.fragment)
    : -1;
  if (exact >= 0 && text.indexOf(installed.fragment, exact + 1) < 0) {
    ranges.splice(0, ranges.length, { start: exact, end: exact + installed.fragment.length });
  } else {
    for (const range of ranges) {
      const lineStart = Math.max(text.lastIndexOf("\n", range.start - 1), text.lastIndexOf("\r", range.start - 1)) + 1;
      if (/^[ \t]*$/.test(text.slice(lineStart, range.start))) range.start = lineStart;
      const tail = /[\r\n]/.test(text[range.end - 1] ?? "")
        ? null : /^[ \t]*(?:\r\n|\n|\r|$)/.exec(text.slice(range.end));
      if (tail) range.end += tail[0].length;
    }
  }
  const merged: SourceRange[] = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && (range.start <= previous.end || /^\s*$/.test(text.slice(previous.end, range.start)))) {
      previous.end = Math.max(previous.end, range.end);
    } else merged.push({ ...range });
  }
  const expectedRestored = structuredClone(document);
  expectedRestored.hooks!.Interrupt!.splice(effectiveGroupIndex, 1);
  delete expectedRestored.hooks!.state![effectiveStateKey];
  try {
    if (!equal(withoutEmptyHookContainers(parseHookDocument(removeRanges(text, merged))),
      withoutEmptyHookContainers(expectedRestored))) throw changed();
  } catch { throw changed(); }
  return merged;
}

function restoreExactCodexInterruptHookFragment(
  text: string,
  installed: InstalledCodexInterruptHook,
): string | undefined {
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  const exact = text.indexOf(installed.fragment);
  if (exact < 0 || text.indexOf(installed.fragment, exact + 1) >= 0) return undefined;
  if (managedMarkerCount(text) !== 1 || text.split(MANAGED_INTERRUPT_HOOK_END).length - 1 !== 1) return undefined;

  const expectedGroup = { hooks: [{ type: "command", command: installed.command, timeout: 3 }] };
  const expectedState = { trusted_hash: installed.trustedHash };
  const equal = (left: unknown, right: unknown) =>
    JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));

  let source: HookDocument;
  let fragment: HookDocument;
  try {
    source = parseHookDocument(text);
    fragment = parseHookDocument(installed.fragment);
  } catch {
    return undefined;
  }
  if (!equal(fragment.hooks?.Interrupt, [expectedGroup])
    || !equal(fragment.hooks?.state, { [installed.stateKey]: expectedState })) return undefined;
  if (!equal(source.hooks?.Interrupt?.[installed.groupIndex], expectedGroup)
    || !equal(source.hooks?.state?.[installed.stateKey], expectedState)) return undefined;

  const repaired = text.slice(0, exact) + text.slice(exact + installed.fragment.length);
  try {
    const expectedRestored = structuredClone(source);
    expectedRestored.hooks!.Interrupt!.splice(installed.groupIndex, 1);
    delete expectedRestored.hooks!.state![installed.stateKey];
    if (!equal(
      withoutEmptyHookContainers(parseHookDocument(repaired)),
      withoutEmptyHookContainers(expectedRestored),
    )) return undefined;
  } catch {
    return undefined;
  }
  return repaired;
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  if (restoreExactCodexInterruptHookFragment(text, installed) !== undefined) return;
  locateCodexInterruptHook(text, installed);
}

/**
 * A native Codex rewrite, or manual removal of the entire launcher fragment, may leave
 * unrelated Interrupt hooks in place. Treat the managed hook as fully absent only if
 * its original journal is internally valid, neither ownership marker survives, and
 * neither the command nor ANY matching trust state survives at a relocated index.
 * This is not permission to discard malformed or user-owned hooks.
 */
export function codexInterruptHookProvablyAbsent(
  text: string,
  installed: InstalledCodexInterruptHook,
): boolean {
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) return false;
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) return false;
  // A fragment or comment injected inside a TOML value must not be considered a clean removal.
  let document: HookDocument;
  try {
    document = parseHookDocument(text);
  } catch {
    return false;
  }
  const hooks = document.hooks;
  if (hooks === undefined) return true;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const groups = hooks.Interrupt;
  if (groups !== undefined) {
    if (!Array.isArray(groups) || groups.length === 0) return false;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) return false;
      const entries = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(entries)) return false;
      if (entries.some(entry => entry && typeof entry === "object" && !Array.isArray(entry)
        && (entry as Record<string, unknown>).command === installed.command)) return false;
    }
  }
  const state = hooks.state;
  if (state !== undefined && (!state || typeof state !== "object" || Array.isArray(state))) return false;
  if (state && Object.values(state).some(entry => entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Record<string, unknown>).trusted_hash === installed.trustedHash)) return false;
  if (groups && groups.length > installed.groupIndex) {
    // Codex can replace the removed launcher's index with a NEW foreign hook.
    // Never overwrite or remove that hook. It is a separate owner only when its
    // own command, group shape and per-index trust state form a complete proof.
    // An untrusted or partially edited group still fails closed.
    for (let index = installed.groupIndex; index < groups.length; index++) {
      const group = groups[index] as { hooks?: unknown };
      const entries = group.hooks;
      if (!Array.isArray(entries) || entries.length !== 1) return false;
      const entry = entries[0];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const hook = entry as Record<string, unknown>;
      if (JSON.stringify(Object.keys(hook).sort()) !== JSON.stringify(["command", "timeout", "type"])
        || hook.type !== "command" || typeof hook.command !== "string" || !hook.command
        || hook.timeout !== 3 || hook.command === installed.command) return false;
      const key = interruptStateKeyForGroup(installed.stateKey, index);
      if (!key || !state || !Object.hasOwn(state, key)) return false;
      const trusted = state[key];
      if (!trusted || typeof trusted !== "object" || Array.isArray(trusted)) return false;
      const trustEntry = trusted as Record<string, unknown>;
      if (Object.keys(trustEntry).length !== 1
        || trustEntry.trusted_hash !== codexInterruptHookHash(hook.command)) return false;
    }
  } else if (state && Object.hasOwn(state, installed.stateKey)) {
    // No independently trusted replacement: the original trust slot survives.
    return false;
  }
  return true;
}

/**
 * Recover a launcher-owned trust record when native Codex has removed the corresponding
 * command group but left its exact, journal-verified [hooks.state] entry behind.
 *
 * This path never touches any other hook, MCP server, model or feature. A surviving
 * command, conflicting trust hash, nonstandard trust shape, marker, or malformed TOML
 * still fails closed. Returning undefined means Setup must use its existing error.
 */
function removeProvablyOrphanedCodexInterruptTrust(
  text: string,
  installed: InstalledCodexInterruptHook,
): string | undefined {
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash
    || managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) return undefined;
  let document: HookDocument;
  let ast: AST.TOMLProgram;
  try {
    document = parseHookDocument(text);
    ast = parseTOML(tomlAstSource(text), { tomlVersion: "1.0" });
  } catch { return undefined; }
  const state = document.hooks?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const record = state[installed.stateKey];
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const trust = record as Record<string, unknown>;
  if (Object.keys(trust).length !== 1 || trust.trusted_hash !== installed.trustedHash) return undefined;
  if (Object.entries(state).some(([key, value]) => key !== installed.stateKey
    && value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).trusted_hash === installed.trustedHash)) return undefined;
  if (document.hooks?.Interrupt?.some(group =>
    group && typeof group === "object" && !Array.isArray(group)
    && Array.isArray((group as { hooks?: unknown }).hooks)
    && (group as { hooks: unknown[] }).hooks.some(entry =>
      entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).command === installed.command))) return undefined;

  const tables = ast.body[0].body.filter(node => node.type === "TOMLTable"
    && JSON.stringify(node.resolvedKey) === JSON.stringify(["hooks", "state", installed.stateKey]));
  if (tables.length !== 1) return undefined;
  const table = tables[0]!;
  const start = Math.max(text.lastIndexOf("\n", table.range[0] - 1), text.lastIndexOf("\r", table.range[0] - 1)) + 1;
  if (!/^[ \t]*$/.test(text.slice(start, table.range[0]))) return undefined;
  const end = table.range[1];
  const newline = /^(?:[ \t]*(?:\r\n|\n|\r))?/.exec(text.slice(end))?.[0] ?? "";
  const repaired = text.slice(0, start) + text.slice(end + newline.length);
  const expected = structuredClone(document);
  delete expected.hooks!.state![installed.stateKey];
  try {
    if (JSON.stringify(withoutEmptyHookContainers(parseHookDocument(repaired)))
      !== JSON.stringify(withoutEmptyHookContainers(expected))) return undefined;
  } catch { return undefined; }
  return codexInterruptHookProvablyAbsent(repaired, installed) ? repaired : undefined;
}

/** Non-mutating proof used by Setup preflight and journal selection. */
export function recoverCodexInterruptHookAbsence(
  text: string,
  installed: InstalledCodexInterruptHook,
): string | undefined {
  if (codexInterruptHookProvablyAbsent(text, installed)) return text;
  return removeProvablyOrphanedCodexInterruptTrust(text, installed);
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean } = {},
): string {
  if (options.allowAbsent) {
    const recovered = recoverCodexInterruptHookAbsence(text, installed);
    if (recovered !== undefined) return recovered;
  }
  const exact = restoreExactCodexInterruptHookFragment(text, installed);
  if (exact !== undefined) return exact;
  const owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
