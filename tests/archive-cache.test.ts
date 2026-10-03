import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";
import type { CompiledChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";

test("archive retries reuse exact content while isolating returned buffer mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-archive-cache-"));
  const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const previousPerf = process.env.CODEX_CHATGPT_WEB_PERF;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  process.env.CODEX_CHATGPT_WEB_PERF = "1";
  try {
    const prompt: CompiledChatGptWebPrompt = { text: "wrapper", images: [],
      archive: { name: "same-name.zip", contextText: `unique context ${root}` } };
    const first = chatGptPromptFilePayloads(prompt)[0]!;
    const second = chatGptPromptFilePayloads(structuredClone(prompt))[0]!;
    expect(second.buffer.equals(first.buffer)).toBeTrue();
    first.buffer.fill(0);
    const third = chatGptPromptFilePayloads(prompt)[0]!;
    expect(strFromU8(unzipSync(third.buffer)["context.txt"]!)).toBe(prompt.archive!.contextText);
    const changed = structuredClone(prompt);
    changed.archive!.contextText = "updated context";
    expect(strFromU8(unzipSync(chatGptPromptFilePayloads(changed)[0]!.buffer)["context.txt"]!)).toBe("updated context");
    const events = readFileSync(join(root, "runtime/backend-perf.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line)).filter(e => e.stage === "archive_build");
    expect(events.map(e => e.cache_hit)).toEqual([false, true, true, false]);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
    if (previousPerf === undefined) delete process.env.CODEX_CHATGPT_WEB_PERF; else process.env.CODEX_CHATGPT_WEB_PERF = previousPerf;
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive names never authorize stale image reuse or bypass validation", () => {
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
  const prompt: CompiledChatGptWebPrompt = { text: "wrapper", images: [{ref: "image-1", imageUrl: image, detail: "high"}],
    archive: { name: "same-image-name.zip", contextText: "image context" } };
  chatGptPromptFilePayloads(prompt);
  const changed = structuredClone(prompt);
  changed.images[0]!.detail = "low";
  const manifest = JSON.parse(strFromU8(unzipSync(chatGptPromptFilePayloads(changed)[0]!.buffer)["manifest.json"]!));
  expect(manifest.images[0].detail).toBe("low");
  const changedBytes = Buffer.from("different valid base64 payload");
  changed.images[0]!.imageUrl = `data:image/png;base64,${changedBytes.toString("base64")}`;
  expect(Buffer.from(unzipSync(chatGptPromptFilePayloads(changed)[0]!.buffer)["images/image-1.png"]!)).toEqual(changedBytes);
  changed.images[0]!.imageUrl = "data:image/png;base64,invalid!";
  expect(() => chatGptPromptFilePayloads(changed)).toThrow("invalid base64");
});

test("archive compression stores already compressed images and preserves skill text", () => {
  const skill = (text: string) => ({name: `fixture--${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`, text});
  const prompt: CompiledChatGptWebPrompt = { text: "wrapper", images: [{ref: "image-1", imageUrl: "data:image/png;base64,YWJj", detail: "high"}],
    skillFiles: [skill("skill contents")],
    archive: {name: "compression.zip", contextText: "word ".repeat(10000)} };
  const first = chatGptPromptFilePayloads(prompt)[0]!;
  const entries = unzipSync(first.buffer);
  expect(strFromU8(entries["context.txt"]!)).toBe(prompt.archive!.contextText);
  expect(strFromU8(entries[`skills/${prompt.skillFiles![0]!.name}`]!)).toBe("skill contents");
  // Read ZIP central-directory compression methods; checking decompressed data alone
  // cannot detect a regression that deflates already compressed image bytes again.
  const methods = new Map<string, number>();
  for (let offset = 0; offset < first.buffer.length - 46; offset++) {
    if (first.buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = first.buffer.readUInt16LE(offset + 28);
    methods.set(first.buffer.subarray(offset + 46, offset + 46 + nameLength).toString(), first.buffer.readUInt16LE(offset + 10));
  }
  expect(methods.get("images/image-1.png")).toBe(0);
  expect(methods.get("context.txt")).toBe(8);
  const changed = structuredClone(prompt);
  changed.skillFiles![0] = skill("updated skill");
  expect(strFromU8(unzipSync(chatGptPromptFilePayloads(changed)[0]!.buffer)[`skills/${changed.skillFiles![0]!.name}`]!)).toBe("updated skill");
  changed.skillFiles![0]!.name = "../invalid.md";
  expect(() => chatGptPromptFilePayloads(changed)).toThrow();
});
