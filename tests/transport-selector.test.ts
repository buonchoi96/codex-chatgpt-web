import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { validateContextArchive } from "../src/adapters/chatgpt-web/context-archive";
import { selectChatGptWebTransport } from "../src/adapters/chatgpt-web/transport-selector";

const capabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: true,
};
const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
const liveToken = `turn_${"b".repeat(32)}`;

function selectorInput() {
  return {
    composerChars: 500,
    composerCharLimit: 1_000,
    messageTokens: 100,
    messageTokenLimit: 1_000,
    attachmentTokenReserve: 16_384,
    canonicalTokens: 16_484,
    accountCanonicalTokenLimit: 80_000,
    attachmentCount: 4,
    attachmentBytes: 4_000,
    attachmentTypes: ["image/png", "image/jpeg", "image/png", "image/png"],
    supportedAttachmentTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"],
    maxAttachmentCount: 10,
    maxAttachmentBytes: 50_000_000,
  };
}

function retainedBudgetInput(canonicalTokens: number) {
  return {
    ...selectorInput(),
    retainedHistoryProven: true,
    canonicalTokens,
    accountCanonicalTokenLimit: 80_000,
    composerChars: 240_000,
    composerCharLimit: 250_000,
    messageTokens: canonicalTokens - 16_384,
    messageTokenLimit: 70_000,
  };
}

function expectRetainedBudgetFitsMessage(decision: ReturnType<typeof selectChatGptWebTransport>, canonicalTokens: number) {
  const measured = decision.measurements;
  expect(measured.canonicalTokens).toBe(canonicalTokens);
  expect(measured.canonicalTokens).toBe(measured.messageTokens + measured.attachmentTokenReserve);
  expect(measured.messageTokens).toBeLessThanOrEqual(measured.messageTokenLimit);
  expect(measured.composerChars).toBeLessThanOrEqual(measured.composerCharLimit!);
  expect(measured.attachmentCount).toBeLessThanOrEqual(measured.maxAttachmentCount);
  expect(measured.attachmentBytes).toBeLessThanOrEqual(measured.maxAttachmentBytes);
}

test("selector returns immutable versioned decisions for inline and proven retained deltas", () => {
  const inline = selectChatGptWebTransport(selectorInput());
  expect(inline).toMatchObject({ version: 1, choice: "INLINE" });
  expect(Object.isFrozen(inline)).toBe(true);
  expect(Object.isFrozen(inline.measurements)).toBe(true);
  expect(Object.isFrozen(inline.measurements.attachmentTypes)).toBe(true);

  expect(selectChatGptWebTransport({ ...selectorInput(), retainedHistoryProven: true }))
    .toMatchObject({ version: 1, choice: "RETAINED_DELTA" });
});

test("retained delta at the measured account budget stays delta even when archive is available", () => {
  const decision = selectChatGptWebTransport({
    ...retainedBudgetInput(80_000),
    archive: { eligible: true, mediaType: "application/zip", imageCount: 4, skillCount: 0, promptChars: 300, promptTokens: 60, bytes: 2_000, maxBytes: 50_000_000 },
  });

  expect(decision.choice).toBe("RETAINED_DELTA");
  expect(decision.measurements.accountCanonicalTokenLimit).toBe(80_000);
  expectRetainedBudgetFitsMessage(decision, 80_000);
});

test("retained delta over the account token budget blocks despite fitting message limits", () => {
  const decision = selectChatGptWebTransport(retainedBudgetInput(80_001));

  expect(decision.choice).toBe("BLOCK");
  expect(decision.reason).toContain("exceeding the measured account budget");
  expect(decision.measurements.accountCanonicalTokenLimit).toBe(80_000);
  expectRetainedBudgetFitsMessage(decision, 80_001);
});

test("retained delta over the account budget cannot fall back to verified multipart or archive", () => {
  const input = retainedBudgetInput(80_001);
  const archive = { eligible: true, mediaType: "application/zip" as const, imageCount: 4, skillCount: 0, promptChars: 300, promptTokens: 60, bytes: 2_000, maxBytes: 50_000_000 };
  const multipart = { verified: true, canonicalTokenLimit: 100_000 };

  for (const alternatives of [{ archive }, { multipart }, { archive, multipart }]) {
    const decision = selectChatGptWebTransport({ ...input, ...alternatives });
    expect(decision.choice).toBe("BLOCK");
    expect(decision.reason).toContain("exceeding the measured account budget");
    expectRetainedBudgetFitsMessage(decision, 80_001);
  }
});

test("required history compaction uses multipart even when its compact control prompt fits inline", () => {
  expect(selectChatGptWebTransport({
    ...selectorInput(),
    requiredMultipart: true,
    multipart: { verified: true, canonicalTokenLimit: 80_000 },
  })).toMatchObject({ choice: "VERIFIED_MULTIPART", reason: expect.stringContaining("required") });
});

test("selector chooses ZIP for attachment caps, multipart only when verified, and blocks over-budget context", () => {
  const inline = selectorInput();
  expect(selectChatGptWebTransport({
    ...inline,
    attachmentCount: 12,
    attachmentTypes: Array(12).fill("image/png"),
    archive: { eligible: true, mediaType: "application/zip", imageCount: 12, skillCount: 0, promptChars: 300, promptTokens: 60, bytes: 2_000, maxBytes: 50_000_000 },
  })).toMatchObject({ choice: "ZIP_SINGLE_MESSAGE" });

  expect(selectChatGptWebTransport({
    ...inline,
    composerChars: 2_000,
    archive: { eligible: false, mediaType: "application/zip", imageCount: 0, skillCount: 0, promptChars: 200, promptTokens: 50, bytes: 1_000, maxBytes: 50_000_000 },
    multipart: { verified: true, canonicalTokenLimit: 200_000 },
  })).toMatchObject({ choice: "VERIFIED_MULTIPART" });

  expect(selectChatGptWebTransport({
    ...inline,
    canonicalTokens: 272_000,
    accountCanonicalTokenLimit: 80_000,
    archive: { eligible: true, mediaType: "application/zip", imageCount: 0, skillCount: 0, promptChars: 200, promptTokens: 50, bytes: 1_000, maxBytes: 50_000_000 },
    multipart: { verified: true, canonicalTokenLimit: 270_000 },
  })).toMatchObject({ choice: "BLOCK" });
});

test("selector blocks twelve-image history when its complete ZIP exceeds the native upload byte cap", () => {
  const decision = selectChatGptWebTransport({
    ...selectorInput(),
    attachmentCount: 12,
    attachmentTypes: Array(12).fill("image/png"),
    archive: { eligible: true, mediaType: "application/zip", imageCount: 12, skillCount: 0, promptChars: 300, promptTokens: 60, bytes: 50_000_001, maxBytes: 50_000_000 },
  });

  expect(decision).toMatchObject({ choice: "BLOCK", measurements: { attachmentCount: 12, archive: { imageCount: 12 } } });
  expect(decision.measurements.archive!.bytes).toBeGreaterThan(decision.measurements.archive!.maxBytes);
});

test("selector blocks twelve-image ZIP when canonical history exceeds the account token budget", () => {
  const decision = selectChatGptWebTransport({
    ...selectorInput(),
    canonicalTokens: 80_001,
    attachmentCount: 12,
    attachmentTypes: Array(12).fill("image/png"),
    archive: { eligible: true, mediaType: "application/zip", imageCount: 12, skillCount: 0, promptChars: 300, promptTokens: 60, bytes: 2_000, maxBytes: 50_000_000 },
  });

  expect(decision).toMatchObject({
    choice: "BLOCK",
    measurements: { canonicalTokens: 80_001, accountCanonicalTokenLimit: 80_000, attachmentCount: 12, archive: { imageCount: 12 } },
  });
  expect(decision.reason).toContain("exceeding the measured account budget");
});

test("ZIP selection refuses incomplete archive asset inventory even if marked eligible", () => {
  const original = selectorInput();
  const images = Array(12).fill("image/png");
  const base = {
    ...original, composerChars: 2_000, attachmentCount: 12, attachmentTypes: images,
    archive: { eligible: true, mediaType: "application/zip" as const, imageCount: 11,
      skillCount: 0, promptChars: 300, promptTokens: 60, bytes: 2_000, maxBytes: 50_000_000 },
  };
  expect(selectChatGptWebTransport(base).choice).toBe("BLOCK");
  expect(selectChatGptWebTransport({ ...base, archive: { ...base.archive, imageCount: 12 } }).choice)
    .toBe("ZIP_SINGLE_MESSAGE");
  const mixed = { ...base, attachmentTypes: [...images.slice(0, 11), "text/plain"],
    archive: { ...base.archive, imageCount: 12, skillCount: 0 } };
  expect(selectChatGptWebTransport(mixed).choice).toBe("BLOCK");
});

test("explicit inline rejection permits ZIP while a failed ZIP is never retried silently", () => {
  const inline = selectorInput();
  const archive = { eligible: true, mediaType: "application/zip" as const, imageCount: 4, skillCount: 0, promptChars: 200, promptTokens: 50, bytes: 1_000, maxBytes: 50_000_000 };
  expect(selectChatGptWebTransport({ ...inline, composerChars: 2_000, archive }))
    .toMatchObject({ choice: "ZIP_SINGLE_MESSAGE", measurements: { canonicalTokens: 16_484, accountCanonicalTokenLimit: 80_000 } });
  expect(selectChatGptWebTransport({
    ...inline,
    priorFailure: { transport: "INLINE", code: "message_length_exceeded" },
    archive,
  })).toMatchObject({ choice: "ZIP_SINGLE_MESSAGE" });
  expect(selectChatGptWebTransport({
    ...inline,
    priorFailure: { transport: "ZIP_SINGLE_MESSAGE", code: "transport_rejected" },
    archive,
  })).toMatchObject({
    choice: "INLINE",
    reason: expect.stringContaining("prior ZIP failure"),
    measurements: { priorFailure: { transport: "ZIP_SINGLE_MESSAGE", code: "transport_rejected" } },
  });
});

function request(content: unknown) {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      systemPrompt: ["Native policy"],
      messages: [{ role: "user" as const, content, timestamp: 1 }],
    },
  } as Parameters<typeof compileChatGptWebPrompt>[0];
}

test("actual compiler keeps four fitting images inline even when ZIP and multipart are available", () => {
  const prompt = request([
    { type: "text", text: "Inspect these four screenshots." },
    ...Array.from({ length: 4 }, () => ({ type: "image", imageUrl, detail: "low" })),
  ]);
  const compiled = compileChatGptWebPrompt(prompt, capabilities, liveToken, {
    contextArchive: true,
    experimentalMultipartParts: 2,
  });

  expect(compiled.transportDecision).toMatchObject({ version: 1, choice: "INLINE" });
  expect(compiled.transportDecision?.measurements).toMatchObject({
    composerCharLimit: expect.any(Number),
    messageTokenLimit: expect.any(Number),
    accountCanonicalTokenLimit: expect.any(Number),
    maxAttachmentCount: expect.any(Number),
    maxAttachmentBytes: expect.any(Number),
    priorFailure: null,
    archive: null,
    multipart: expect.objectContaining({ verified: true }),
  });
  expect(compiled.contextArchive).toBeUndefined();
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.images).toHaveLength(4);
});

test("actual compiler archives all twelve historical images with in-turn ingestion instructions", () => {
  const prompt = request([
    { type: "text", text: "Use the complete screenshot history." },
    ...Array.from({ length: 12 }, () => ({ type: "image", imageUrl, detail: "low" })),
  ]);
  const compiled = compileChatGptWebPrompt(prompt, capabilities, liveToken, { contextArchive: true });

  expect(compiled.transportDecision).toMatchObject({ version: 1, choice: "ZIP_SINGLE_MESSAGE" });
  expect(compiled.contextArchive).toBeDefined();
  const archive = compiled.contextArchive!;
  const files = validateContextArchive(Buffer.from(archive.base64, "base64"), archive.sha256);
  expect(Object.keys(files).filter(path => path.startsWith("images/"))).toHaveLength(12);
  expect(compiled.text).toContain("attached to this same message");
  expect(compiled.text).toContain("exactly one codex_tool_call");
  expect(compiled.text).toContain('wire_name "codex_context_archive_ack"');
  expect(compiled.text).toContain("context_head_sha256");
  expect(compiled.text).toContain("context_tail_sha256");
  expect(compiled.text).toContain("image_count");
  expect(compiled.text).toContain("skill_count");
  expect(compiled.text).toContain("256 raw UTF-8 bytes");
  expect(compiled.text).toContain("SHA-256");
  expect(compiled.text).toContain("attached-file tools");
  expect(compiled.text).toContain("successful acknowledgment response");
  expect(compiled.text).toContain("integer from 0 through 1024");
  expect(compiled.text).toContain("before any ordinary task tool call or final answer");
  expect(compiled.transportDecision?.measurements).toMatchObject({
    attachmentCount: 12,
    maxAttachmentCount: expect.any(Number),
    archive: {
      eligible: true,
      imageCount: 12,
      skillCount: 0,
      promptChars: expect.any(Number),
      promptTokens: expect.any(Number),
      bytes: expect.any(Number),
      maxBytes: 50_000_000,
    },
    multipart: null,
  });
  expect(compiled.text).toContain(liveToken);
  expect(compiled.text).not.toContain("was acknowledged");
  expect(archive.contextText).not.toContain(liveToken);
});

test("actual compiler marks a proven retained history as a delta and never rearchives it", () => {
  const prompt = request([
    { type: "text", text: "Follow up on the retained conversation." },
    ...Array.from({ length: 4 }, () => ({ type: "image", imageUrl, detail: "low" })),
  ]);
  const compiled = compileChatGptWebPrompt(prompt, capabilities, liveToken, {
    contextArchive: true,
    retainedHistoryProven: true,
  });

  expect(compiled.transportDecision).toMatchObject({ version: 1, choice: "RETAINED_DELTA" });
  expect(compiled.contextArchive).toBeUndefined();
  expect(compiled.multipart).toBeUndefined();
});
