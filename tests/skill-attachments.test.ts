import { estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { estimateCompiledChatGptWebInputTokens, estimateCompiledChatGptWebMessageTokens } from "../src/adapters/chatgpt-web/input-tokens";
import {
  externalizeSelectedSkillMessages,
  SelectedSkillFileStore,
  selectedSkillFile,
  selectedSkillFileReferenceForMessage,
  restoreSelectedSkillMessagesForThread,
  skillFileTokens,
} from "../src/adapters/chatgpt-web/skill-attachments";
import { buildCompactV1Output, extractCompactUserMessages } from "../src/responses/compaction";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = "turn_12345678901234567890123456789012";
const text = (name = "testing", body = "Read references/checks.md. Verify café 日本語.") =>
  `<skill>\n<name>${name}</name>\n<path>/workspace/skills/${name}/SKILL.md</path>\n${body}\n</skill>`;
const input = (content: string, kinds = ["skills.selected_skill_instructions"]) => ({
  role: "user", content: [{ type: "input_text", text: content }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
});
const parse = (items: unknown[]) => parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: items, reasoning: { effort: "high" } });
const compile = (items: unknown[], enabled = true) => compileChatGptWebPrompt(parse(items), capabilities, token, { experimentalSkillAttachments: enabled });

test("only native selected-skill provenance enables attachment transport; default stays inline", () => {
  const skill = text();
  const compiled = compile([input(skill), input("Use $testing", ["user.text"])]);
  expect(compiled.skillFiles).toHaveLength(1);
  expect(compiled.text).not.toContain("Read references/checks.md");
  expect(compiled.text).toContain('"origin":"codex_skill"');
  expect(compiled.text).toContain('"filename":"testing--');
  const [file] = chatGptPromptFilePayloads(compiled);
  expect(file!.name).toMatch(/^testing--[a-f0-9]{16}\.txt$/);
  expect(file!.mimeType).toBe("text/plain");
  expect(file!.buffer.toString("utf8")).toBe(skill);
  expect(compile([input(skill)], false).text).toContain("Read references/checks.md");
  expect(compile([input(skill)], false).skillFiles).toBeUndefined();
  for (const item of [
    { role: "user", content: skill },
    input(skill, ["user.text"]),
    input(skill, ["skills.selected_skill_instructions", "user.text"]),
    { ...input(skill), role: "developer" },
  ]) {
    const literal = compile([input("$testing", ["user.text"]), item]);
    expect(literal.skillFiles).toBeUndefined();
    expect(literal.text).toContain("Read references/checks.md");
  }
});

test("files preserve resource authority and distinguish same-named versions without a persistent cache", () => {
  const first = text("../plugin:test", '<resource_access>{"main_resource":"skill://test","package":"plugin"}</resource_access>\nfirst');
  const changed = first.replace("\nfirst", "\nsecond");
  const compiled = compile([input(first), input(first), input(changed)]);
  expect(compiled.skillFiles).toHaveLength(2);
  const files = chatGptPromptFilePayloads(compiled);
  expect(files[0]!.name).not.toBe(files[1]!.name);
  expect(files[0]!.name).not.toMatch(/[/:\\]/);
  expect(files[0]!.buffer.toString()).toBe(first);
  expect(files[1]!.buffer.toString()).toBe(changed);
  expect(compile([input(first)]).skillFiles).toEqual([compiled.skillFiles![0]!]);
  const tampered = structuredClone(compiled);
  tampered.skillFiles![0]!.text += " changed";
  expect(() => chatGptPromptFilePayloads(tampered)).toThrow("does not match");
});

test("retained turns reuse prior attachments; fresh chats rebuild them and new skills still upload", () => {
  const history = [input(text()), { role: "assistant", content: [{ type: "output_text", text: "Done" }] }, input("Continue", ["user.text"])];
  const parsed = parse(history);
  const resumed = retainedConversationResumeRequest(parsed)!;
  expect(compileChatGptWebPrompt(resumed, capabilities, token, { experimentalSkillAttachments: true }).skillFiles).toBeUndefined();
  expect(compile(history).skillFiles).toHaveLength(1);
  const next = retainedConversationResumeRequest(parse([...history, input(text("next"))]))!;
  const compiled = compileChatGptWebPrompt(next, capabilities, token, { experimentalSkillAttachments: true });
  expect(compiled.skillFiles).toHaveLength(1);
  expect(compiled.skillFiles![0]!.name).toStartWith("next--");
});

test("skill content counts toward input and final-message budgets, including multipart", () => {
  const parsed = parse([input(text("testing", "check this carefully\n".repeat(1000))), input("Do it", ["user.text"])]);
  for (const parts of [undefined, 6] as const) {
    const full = structuredClone(parsed);
    if (parts) full.context.systemPrompt = Array.from({ length: 6 }, (_, index) => `whole-system-record-${index}: ${"x".repeat(90_000)}`);
    const compiled = compileChatGptWebPrompt(full, capabilities, token, { experimentalSkillAttachments: true, experimentalMultipartParts: parts });
    const withoutFiles = { ...compiled, skillFiles: undefined };
    const fileTokens = skillFileTokens(compiled.skillFiles, parsed.modelId);
    expect(fileTokens).toBeGreaterThan(1000);
    expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)
      - estimateCompiledChatGptWebInputTokens(withoutFiles, parsed.modelId)).toBe(fileTokens);
    expect(estimateCompiledChatGptWebMessageTokens(compiled, parsed.modelId)).toBeGreaterThan(fileTokens);
    if (parts) {
      expect(compiled.transportDecision!.measurements.composerChars).toBeGreaterThan(compiled.transportDecision!.measurements.composerCharLimit!);
      const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
      expect(records.filter((record: { kind: string }) => record.kind === "system").map((record: { content: string }) => record.content)).toEqual(full.context.systemPrompt!);
      expect(records.filter((record: { kind: string }) => record.kind === "message").map((record: { message: unknown }) => record.message)).toEqual([
        { role: "user", origin: "codex_skill", content: [{ type: "skill_attachment", filename: compiled.skillFiles![0]!.name }] },
        { role: "user", content: "Do it" },
      ]);
      expect(compiled.skillFiles![0]!.text).toBe(text("testing", "check this carefully\n".repeat(1000)));
      expect(compiled.multipart!.parts.join(" ")).not.toContain("check this carefully");
      expect(compiled.multipart!.commit).toContain("skill_attachment");
    }
  }
});

test("over-limit, malformed and manual requests fail explicitly without silently losing skill content", () => {
  const ten = Array.from({ length: 10 }, (_, i) => input(text(`skill-${i}`)));
  expect(chatGptPromptFilePayloads(compile(ten))).toHaveLength(10);
  expect(() => chatGptPromptFilePayloads(compile([...ten, input(text("eleventh"))]))).toThrow("10 attachments");
  const image = { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==" }] };
  expect(() => chatGptPromptFilePayloads(compile([...ten, image]))).toThrow("10 attachments");
  expect(() => compile([input("Not a skill envelope")])).toThrow("invalid Codex envelope");
  expect(() => compileChatGptWebPrompt(parse([input(text())]), capabilities, token, {
    experimentalSkillAttachments: true, manualControl: true,
  })).toThrow("Zero Risk");
});


test("usage accounts for skills accumulated over many turns without applying a per-message upload cap", () => {
  const parsed = parse(Array.from({ length: 11 }, (_, i) => input(text(`skill-${i}`))));
  const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities, false, true);
  expect(usage.inputTokens).toBeGreaterThan(0);
  expect(usage.estimated).toBe(true);
});


const temporarySkillRoots: string[] = [];
afterEach(() => {
  for (const root of temporarySkillRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("selected skills survive native v1 compaction as durable references and rehydrate after a cold cache", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-selected-skill-store-"));
  temporarySkillRoots.push(root);
  const original = text("testing", "PERSISTED_SKILL_BODY " + "follow the exact repository instructions\n".repeat(500));
  const skillItem = {
    type: "message",
    role: "user",
    id: "msg_selected_skill",
    content: [{ type: "input_text", text: original }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn_before_compact",
      content_item_kinds: ["skills.selected_skill_instructions"],
    },
  };
  const latestTask = {
    type: "message",
    role: "user",
    id: "msg_current_task",
    content: [{ type: "input_text", text: "Finish the implementation and verify the focused tests." }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn_after_compact",
      content_item_kinds: ["user.text"],
    },
  };
  const rawInput = [skillItem, latestTask];
  const writer = new SelectedSkillFileStore(root);
  const externalized = externalizeSelectedSkillMessages(rawInput, true, writer);

  expect(JSON.stringify(externalized)).not.toContain("PERSISTED_SKILL_BODY");
  expect(selectedSkillFileReferenceForMessage(externalized[0])).toMatchObject({
    name: expect.stringMatching(/^testing--[a-f0-9]{16}\.txt$/),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const compacted = buildCompactV1Output(
    extractCompactUserMessages(externalized),
    "The task is in progress; finish implementation and tests.",
  );
  expect(JSON.stringify(compacted)).not.toContain("PERSISTED_SKILL_BODY");
  expect(compacted).toContainEqual(expect.objectContaining({
    id: "msg_current_task",
    content: [{ type: "input_text", text: "Finish the implementation and verify the focused tests." }],
  }));
  const compactedSkill = compacted.find(item => item.id === "msg_selected_skill")!;
  expect(selectedSkillFileReferenceForMessage(compactedSkill)).toBeDefined();

  // Construct a fresh store instance to emulate a restarted backend; only the on-disk cache survives.
  const restartedStore = new SelectedSkillFileStore(root);
  const reference = selectedSkillFileReferenceForMessage(compactedSkill)!;
  const rehydrated = selectedSkillFile(
    {
      role: "user",
      origin: "codex_skill",
      content: [{ type: "text", text: "CODEX_SKILL_FILE_REF_V1:" + reference.name + ":" + reference.sha256 }],
      timestamp: 1,
    },
    restartedStore,
  );
  expect(rehydrated.text).toBe(original);
  expect(rehydrated.name).toBe(reference.name);

  const parsedAfterCompact = parse(compacted as unknown[]);
  const compiled = compileChatGptWebPrompt(parsedAfterCompact, capabilities, token, {
    experimentalSkillAttachments: true,
    skillFileStore: restartedStore,
  });
  expect(compiled.skillFiles).toContainEqual({ name: reference.name, text: original });
  expect(compiled.text).not.toContain("PERSISTED_SKILL_BODY");
  expect(chatGptPromptFilePayloads(compiled)).toContainEqual(expect.objectContaining({
    name: reference.name,
    mimeType: "text/plain",
  }));
});

test("selected-skill references fail closed when their durable cache entry is missing or modified", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-selected-skill-corrupt-"));
  temporarySkillRoots.push(root);
  const original = text("durable", "Keep this exact skill content.");
  const item = {
    type: "message",
    role: "user",
    id: "msg_durable_skill",
    content: [{ type: "input_text", text: original }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ["skills.selected_skill_instructions"],
    },
  };
  const [pointer] = externalizeSelectedSkillMessages([item], true, new SelectedSkillFileStore(root));
  const reference = selectedSkillFileReferenceForMessage(pointer)!;
  const refText = "CODEX_SKILL_FILE_REF_V1:" + reference.name + ":" + reference.sha256;
  const missing = new SelectedSkillFileStore(join(root, "empty"));
  expect(() => selectedSkillFile({
    role: "user", origin: "codex_skill",
    content: [{ type: "text", text: refText }], timestamp: 1,
  }, missing)).toThrow("missing or failed integrity validation");

  writeFileSync(join(root, reference.name), original + "tampered");
  expect(() => selectedSkillFile({
    role: "user", origin: "codex_skill",
    content: [{ type: "text", text: refText }], timestamp: 1,
  }, new SelectedSkillFileStore(root))).toThrow("missing or failed integrity validation");
});


test("native v2 compaction can restore selected skills from a durable per-thread manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-selected-skill-thread-"));
  temporarySkillRoots.push(root);
  const original = text("long-lived", "THREAD_SKILL_BODY Keep the project conventions after remote compaction.");
  const originalSkill = {
    type: "message",
    role: "user",
    id: "msg_thread_skill",
    content: [{ type: "input_text", text: original }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn_skill_selected",
      content_item_kinds: ["skills.selected_skill_instructions"],
    },
  };
  const store = new SelectedSkillFileStore(root);
  store.rememberThreadSkills("thread_survives_v2", [originalSkill]);
  const restoredStore = new SelectedSkillFileStore(root);
  const compactedHistory = [{
    type: "message",
    role: "user",
    id: "msg_after_remote_compact",
    content: [{ type: "input_text", text: "Continue after remote compaction." }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn_current",
      content_item_kinds: ["user.text"],
    },
  }];
  const restored = restoreSelectedSkillMessagesForThread(
    "thread_survives_v2", compactedHistory, "turn_current", restoredStore,
  );

  expect(restored).toHaveLength(2);
  expect(restored[0]).toMatchObject({
    type: "message",
    role: "user",
    id: "msg_thread_skill",
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn_skill_selected",
      content_item_kinds: ["skills.selected_skill_instructions"],
    },
  });
  expect(selectedSkillFileReferenceForMessage(restored[0])).toMatchObject({
    name: expect.stringMatching(/^long-lived--[a-f0-9]{16}\.txt$/),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const parsed = parse(restored);
  const attached = compileChatGptWebPrompt(parsed, capabilities, token, {
    experimentalSkillAttachments: true,
    skillFileStore: restoredStore,
  });
  expect(attached.skillFiles?.[0]?.text).toBe(original);
  expect(attached.text).not.toContain("THREAD_SKILL_BODY");

  const inline = compileChatGptWebPrompt(parsed, capabilities, token, {
    experimentalSkillAttachments: false,
    skillFileStore: restoredStore,
  });
  expect(inline.text).toContain("THREAD_SKILL_BODY");
});


test("a full skill still present in canonical history repairs a missing cache before the thread is compacted", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-selected-skill-repair-"));
  temporarySkillRoots.push(root);
  const original = text("recoverable", "RECOVERABLE_SKILL_BODY Preserve the current repository conventions.");
  const skill = {
    type: "message",
    role: "user",
    id: "msg_recoverable_skill",
    content: [{ type: "input_text", text: original }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn_skill_old",
      content_item_kinds: ["skills.selected_skill_instructions"],
    },
  };
  const store = new SelectedSkillFileStore(root);
  store.rememberThreadSkills("thread_skill_repair", [skill]);
  const reference = store.threadSkills("thread_skill_repair")[0]!;
  rmSync(join(root, reference.name), { force: true });

  // The original typed message is still authoritative and must remain usable.
  const current = {
    type: "message",
    role: "user",
    id: "msg_current_repair",
    content: [{ type: "input_text", text: "Continue the task." }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn_current",
      content_item_kinds: ["user.text"],
    },
  };
  expect(restoreSelectedSkillMessagesForThread(
    "thread_skill_repair", [skill, current], "turn_current", store,
  )).toEqual([skill, current]);

  // Before the next compaction, the original skill body repopulates the content-addressed file.
  store.rememberThreadSkills("thread_skill_repair", [skill, current]);
  const coldStore = new SelectedSkillFileStore(root);
  const restored = restoreSelectedSkillMessagesForThread(
    "thread_skill_repair", [current], "turn_current", coldStore,
  );
  expect(selectedSkillFileReferenceForMessage(restored[0])).toMatchObject({
    name: reference.name,
    sha256: reference.sha256,
  });
});
