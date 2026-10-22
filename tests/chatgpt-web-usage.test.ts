import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { validateContextArchive } from "../src/adapters/chatgpt-web/context-archive";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";
import { resolveChatGptWebMessageTokenBudget, resolveChatGptWebStagingTokenBudget } from "../src/chatgpt-web-models";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function usageFixtureImage(index:number):string {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==','base64');
  const data=Buffer.from(`fixture\0partition-image-${index}`),chunk=Buffer.alloc(data.length+12);
  chunk.writeUInt32BE(data.length,0);chunk.write('tEXt',4);data.copy(chunk,8);let crc=0xffffffff;
  for(const byte of chunk.subarray(4,-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return `data:image/png;base64,${Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]).toString('base64')}`;
}

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test("usage counts the configured plugin name carried by the submitted prompt", () => {
  const parsed = request("Inspect the repository.");
  const caps = { ...capabilities, localToolsEnabled: true };
  const appName = `Codex ${"測試_".repeat(16)}`;
  const token = `turn_${"0".repeat(32)}`;
  const compiled = compileChatGptWebPrompt(parsed, caps, token, { appName });
  const expected = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(expected).not.toBe(estimateChatGptWebInputTokens(parsed, caps));
  for (const biggerContext of [false, true]) {
    expect(estimateChatGptWebUsage(parsed, {}, caps, biggerContext, false, appName).inputTokens).toBe(expected);
  }
});

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("usage estimation accounts for twelve images through the canonical archive path", () => {
  const parsed = request("");
  const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
  parsed.context.messages = [{
    role: "user",
    content: [
      { type: "text", text: "Review these historical images." },
      ...Array.from({ length: 12 }, () => ({ type: "image" as const, imageUrl, detail: "low" as const })),
    ],
    timestamp: 1,
  }];

  expect(estimateChatGptWebInputTokens(parsed, capabilities)).toBeGreaterThan(0);
  expect(estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities).inputTokens).toBeGreaterThan(0);
});

test("measurement reports oversized canonical history while ordinary prompt compilation remains blocked", () => {
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 9 }, (_, index) => ({
    role: "user",
    content: `synthetic-fill-${index}: ${"word ".repeat(30_000)}`,
    timestamp: index + 1,
  }));

  expect(() => compileChatGptWebPrompt(parsed, capabilities)).toThrow(/canonical context requires \d+ tokens, exceeding the measured account budget/);
  try {
    compileChatGptWebPrompt(parsed, capabilities);
    throw new Error("Expected oversized canonical history to be blocked");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect((error as ChatGptWebAdapterError).code).toBe("canonical_context_budget_exceeded");
  }
  expect(estimateChatGptWebInputTokens(parsed, capabilities)).toBeGreaterThanOrEqual(258_400);
});

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), "BLOCK"],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), undefined],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    if (expected === "BLOCK") {
      expect(parts).toBeUndefined();
      expect(() => compileChatGptWebPrompt(parsed, plus, undefined, { contextArchive: true }))
        .toThrow(/canonical context requires \d+ tokens, exceeding the measured account budget/);
      continue;
    }
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, {
      contextArchive: true,
      experimentalMultipartParts: parts,
    });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    } else if (compiled.contextArchive) {
      expect(compiled.transportDecision?.choice).toBe("ZIP_SINGLE_MESSAGE");
      const files = validateContextArchive(Buffer.from(compiled.contextArchive!.base64, "base64"), compiled.contextArchive!.sha256);
      const archivedContext = JSON.parse(Buffer.from(files["context.txt"]!).toString());
      expect(archivedContext.messages.map((message: { content: unknown }) => message.content)).toEqual(contents);
    }
  }
  // Low-token text can exceed the composer ceiling while its canonical token budget remains safe.
  // The adaptive compiler packages it in one ZIP message rather than forcing staging.
  const sparsePro = request("x".repeat(600_000));
  expect(resolveBiggerContextMultipartParts(sparsePro, capabilities)).toBeUndefined();
  const archivedPro = compileChatGptWebPrompt(sparsePro, capabilities, undefined, { contextArchive: true });
  expect(archivedPro.transportDecision?.choice).toBe("ZIP_SINGLE_MESSAGE");
  expect(JSON.parse(archivedPro.contextArchive!.contextText).messages.map((message: { content: unknown }) => message.content))
    .toEqual([sparsePro.context.messages[0]!.content]);
}, 60_000);

test("Bigger Context compaction selects six parts before the legacy inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("GPT-6 Sol keeps complete Plus and Pro history inline when one message fits", () => {
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 4 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(10_000)}`, timestamp: index + 1,
  }));
  const original = structuredClone(parsed);
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    const parts = resolveBiggerContextMultipartParts(parsed, caps);
    expect(parts).toBeUndefined();
    const staged = compileChatGptWebPrompt(parsed, caps);
    expect(staged.transportDecision?.choice).toBe("INLINE");
    expect(staged.text).toContain("record-0:");
    expect(staged.text).toContain("record-3:");
    expect(estimateChatGptWebUsage(parsed, { answer: "done" }, caps, true).inputTokens)
      .toBe(estimateCompiledChatGptWebInputTokens(staged, parsed.modelId));
    expect(parsed).toEqual(original);
  }
}, 30_000);

test("GPT-6 compaction respects the selected account and effort", () => {
  const parsed = { ...request("Summarize this task."), _chatgptModelFamily: "6" as const, _compactionRequest: true };
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      parsed.options.reasoning = effort;
      const supported = effort !== "low";
      const parts = resolveBiggerContextMultipartParts(parsed, caps);
      if (supported) {
        expect(parts).toBe(6);
        expect(compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts }).multipart!.parts).toHaveLength(6);
      } else {
        expect(parts).toBeUndefined();
        expect(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, true))
          .toEqual(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, false));
        expect(() => compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 }))
          .toThrow("GPT-6 Instant uses standard context");
      }
    }
  }
  parsed.options.reasoning = "max";
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  expect(compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts }).multipart!.parts).toHaveLength(6);
});

test("Plus history is rebalanced into smaller Instant uploads and a larger selected-mode final message", () => {
  const plus = { ...capabilities, proAvailable: false, extraHighAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 60 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(3000)}`, timestamp: index + 1,
  }));
  for (const compaction of [false, true]) {
    parsed._compactionRequest = compaction;
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message.content)).toEqual(parsed.context.messages.map(message => message.content));
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    const messages = compiledChatGptWebMessages(compiled);
    const stagingTokens = messages.slice(0, -1).map(text => estimateTokens(text));
    const stagingBudget = resolveChatGptWebStagingTokenBudget("gpt-5.6-sol", "low", plus);
    expect(Math.max(...stagingTokens)).toBeLessThanOrEqual(stagingBudget);
    expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus,
      Math.max(...stagingTokens), Math.max(...messages.slice(0, -1).map(text => text.length))).effort).toBe("low");
    const finalTokens = estimateTokens(messages.at(-1)!);
    expect(finalTokens).toBeGreaterThan(Math.max(...stagingTokens));
    expect(finalTokens).toBeLessThanOrEqual(resolveChatGptWebMessageTokenBudget("gpt-5.6-sol", "high", plus));
  }
}, 30_000);

test("multipart planning preserves final attachments and rejects transactions beyond 272K without losing history", () => {
  for (const scenario of [
    { extraHighAvailable: false, proAvailable: false, images: 3, schema: false },
    { extraHighAvailable: true, proAvailable: true, images: 10, schema: false },
    { extraHighAvailable: false, proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: usageFixtureImage(index), detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    const preflight = () => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 6,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    );
    if (scenario.images === 10) {
      expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeGreaterThan(272_000);
      expect(preflight).toThrow("272,000-token six-part ceiling");
    } else expect(preflight).not.toThrow();
  }
}, 30_000);
