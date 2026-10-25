import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import type { CodexUserMessage } from "../../types";
import { estimateTokens } from "../../lib/token-estimate";

export interface ChatGptSkillFile {
  name: string;
  text: string;
}

export interface SelectedSkillFileReference {
  name: string;
  sha256: string;
}

const SKILL_REFERENCE_PREFIX = "CODEX_SKILL_FILE_REF_V1:";
const MAX_SKILL_FILE_BYTES = 20_000_000;
const MAX_SKILL_CACHE_BYTES = 512_000_000;
const selectedSkillNamePattern = /^[\p{L}\p{N}_-]{1,64}--[a-f0-9]{16}\.txt$/u;
const selectedSkillReferencePattern =
  /^CODEX_SKILL_FILE_REF_V1:([\p{L}\p{N}_-]{1,64}--[a-f0-9]{16}\.txt):([a-f0-9]{64})$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function skillText(content: CodexUserMessage["content"]): string {
  if (Array.isArray(content) && content.some(part => part.type !== "text")) {
    throw new Error("Selected skill instructions must contain only text");
  }
  return typeof content === "string" ? content : content.map(part => (part as { text: string }).text).join("\n");
}

function skillNameStem(text: string): string {
  const name = /^<skill>\s*<name>([^<>\r\n]+)<\/name>/.exec(text)?.[1]?.trim();
  if (!name || !text.trimEnd().endsWith("</skill>")) {
    throw new Error("Selected skill instructions have an invalid Codex envelope; disable Skills as files to send them inline");
  }
  return name.normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 64).replace(/^-+|-+$/g, "") || "skill";
}

function deriveSkillFile(text: string): ChatGptSkillFile {
  const bytes = Buffer.byteLength(text, "utf8");
  if (!text.trim() || bytes > MAX_SKILL_FILE_BYTES) {
    throw new Error("Selected skill instructions are empty or exceed the 20 MB attachment limit");
  }
  const stem = skillNameStem(text);
  const digest = createHash("sha256").update(text).digest("hex");
  return { name: stem + "--" + digest.slice(0, 16) + ".txt", text };
}

/** Reference text is transport metadata only when native Codex selected-skill provenance is present. */
export function parseSelectedSkillFileReference(value: unknown): SelectedSkillFileReference | undefined {
  if (typeof value !== "string") return undefined;
  const match = selectedSkillReferencePattern.exec(value.trim());
  return match ? { name: match[1]!, sha256: match[2]! } : undefined;
}

export function isSelectedSkillFileReferenceText(value: unknown): value is string {
  return parseSelectedSkillFileReference(value) !== undefined;
}

export function selectedSkillFileReference(file: ChatGptSkillFile): string {
  return SKILL_REFERENCE_PREFIX + file.name + ":" + createHash("sha256").update(file.text).digest("hex");
}

/**
 * Content-addressed local storage for skill instructions removed from compacted native history.
 * Files are private, immutable by identity, and never evicted automatically: compacted history
 * may keep a reference for the lifetime of a Codex task.
 */
export class SelectedSkillFileStore {
  constructor(private readonly directory = join(getConfigDir(), "skill-files")) {}

  put(file: ChatGptSkillFile): ChatGptSkillFile {
    const derived = deriveSkillFile(file.text);
    if (derived.name !== file.name) throw new Error("Selected skill content does not match its content-addressed filename");
    const path = join(this.directory, file.name);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== file.text) {
        throw new Error("Selected skill cache filename collision; refusing to replace existing content");
      }
      return { ...file };
    }

    let totalBytes = 0;
    if (existsSync(this.directory)) {
      for (const entry of readdirSync(this.directory)) {
        if (!selectedSkillNamePattern.test(entry)) continue;
        try {
          const stat = statSync(join(this.directory, entry));
          if (stat.isFile()) totalBytes += stat.size;
        } catch {
          // A concurrently removed cache entry does not count against the quota.
        }
      }
    }
    const bytes = Buffer.byteLength(file.text, "utf8");
    if (totalBytes + bytes > MAX_SKILL_CACHE_BYTES) {
      throw new Error("Selected-skill cache quota exceeded; no existing skill reference was evicted");
    }
    atomicWriteFile(path, file.text, { mode: 0o600, protectDirectory: true });
    return { ...file };
  }

  get(reference: SelectedSkillFileReference): ChatGptSkillFile | undefined {
    if (!selectedSkillNamePattern.test(reference.name) || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
      return undefined;
    }
    const path = join(this.directory, reference.name);
    if (!existsSync(path)) return undefined;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    if (createHash("sha256").update(text).digest("hex") !== reference.sha256) return undefined;
    try {
      const file = deriveSkillFile(text);
      return file.name === reference.name ? file : undefined;
    } catch {
      return undefined;
    }
  }

  resolveReference(value: unknown): ChatGptSkillFile | undefined {
    const reference = parseSelectedSkillFileReference(value);
    if (!reference) return undefined;
    const file = this.get(reference);
    if (!file) {
      throw new Error("Selected-skill cache entry is missing or failed integrity validation; restore the referenced skill file before continuing");
    }
    return file;
  }
}

export const defaultSelectedSkillFileStore = new SelectedSkillFileStore();

/** Only callers holding Codex's selected-skill metadata may use this transport. */
export function selectedSkillFile(
  message: CodexUserMessage,
  store: SelectedSkillFileStore = defaultSelectedSkillFileStore,
): ChatGptSkillFile {
  if (message.origin !== "codex_skill") throw new Error("Missing Codex selected-skill provenance");
  const text = skillText(message.content);
  const reference = parseSelectedSkillFileReference(text);
  if (reference) {
    const cached = store.get(reference);
    if (!cached) {
      throw new Error("Selected-skill cache entry is missing or failed integrity validation; restore the referenced skill file before continuing");
    }
    return cached;
  }
  return deriveSkillFile(text);
}

/** Resolve a compacted skill pointer back into the original skill envelope for inline fallback. */
export function resolveSelectedSkillMessage(
  message: CodexUserMessage,
  store: SelectedSkillFileStore = defaultSelectedSkillFileStore,
): CodexUserMessage {
  if (message.origin !== "codex_skill") return message;
  const text = skillText(message.content);
  if (!parseSelectedSkillFileReference(text)) return message;
  const file = selectedSkillFile(message, store);
  return { ...message, content: file.text };
}

function isSelectedSkillInstructionItem(value: unknown): value is Record<string, unknown> {
  const item = record(value);
  const kinds = record(item?.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  return item?.type === "message" && item.role === "user"
    && Array.isArray(kinds) && kinds.length === 1
    && kinds[0] === "skills.selected_skill_instructions";
}

function responseItemText(value: Record<string, unknown>): string {
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) throw new Error("Selected skill message has unsupported compacted content");
  const blocks = value.content.map(record);
  if (blocks.some(block => !block || !["input_text", "text"].includes(String(block.type))
    || typeof block.text !== "string")) {
    throw new Error("Selected skill instructions must contain only text");
  }
  return blocks.map(block => (block as Record<string, unknown>).text as string).join("\n");
}

export function selectedSkillFileReferenceForMessage(value: unknown): SelectedSkillFileReference | undefined {
  if (!isSelectedSkillInstructionItem(value)) return undefined;
  return parseSelectedSkillFileReference(responseItemText(value));
}

/**
 * Replace selected-skill payloads with stable pointers before native v1 compaction. The exact full
 * text remains in the private cache and can be reattached on cold bootstrap, even after restart.
 */
export function externalizeSelectedSkillMessages<T extends Record<string, unknown>>(
  messages: T[],
  enabled: boolean,
  store: SelectedSkillFileStore = defaultSelectedSkillFileStore,
): T[] {
  if (!enabled) return messages;
  return messages.map(value => {
    if (!isSelectedSkillInstructionItem(value)) return value;
    const itemText = responseItemText(value);
    let file: ChatGptSkillFile;
    if (parseSelectedSkillFileReference(itemText)) {
      const resolved = store.resolveReference(itemText);
      if (!resolved) throw new Error("Selected-skill cache entry is unavailable");
      file = resolved;
    } else {
      file = deriveSkillFile(itemText);
    }
    const cached = store.put(file);
    return {
      ...structuredClone(value),
      content: [{ type: "input_text", text: selectedSkillFileReference(cached) }],
    } as T;
  });
}

export function skillFileTokens(files: readonly ChatGptSkillFile[] | undefined, modelId?: string): number {
  return (files ?? []).reduce((sum, file) => sum + estimateTokens(file.text, modelId), 0);
}

/** Validate before either touching the composer or acknowledging an IPC payload. */
export function validateSkillFiles(value: unknown): asserts value is ChatGptSkillFile[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 10) throw new Error("Invalid skill attachment list");
  const names = new Set<string>();
  for (const file of value) {
    if (!file || typeof file.name !== "string" || typeof file.text !== "string"
      || !selectedSkillNamePattern.test(file.name)
      || file.text.length === 0 || Buffer.byteLength(file.text, "utf8") > MAX_SKILL_FILE_BYTES
      || names.has(file.name)) throw new Error("Invalid or duplicate skill attachment");
    const digest = createHash("sha256").update(file.text).digest("hex").slice(0, 16);
    if (!file.name.endsWith("--" + digest + ".txt")) throw new Error("Skill attachment content does not match its name");
    names.add(file.name);
  }
}
