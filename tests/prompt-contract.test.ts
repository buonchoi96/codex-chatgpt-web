import { expect, test } from "bun:test";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET,
  CHATGPT_BIGGER_CONTEXT_PARTS,
  chatGptPromptJsonBytes,
  chatGptReadOnlyContextWarning,
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  withoutRetiredTurnHandles,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { biggerContextPartCount } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";
import { validateContextArchive } from "../src/adapters/chatgpt-web/context-archive";

function validImageUrl(marker: string): string {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==", "base64");
  const metadata = Buffer.from(`fixture\0${marker}`);
  const chunk = Buffer.alloc(metadata.length + 12);
  chunk.writeUInt32BE(metadata.length, 0);
  chunk.write("tEXt", 4);
  metadata.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return `data:image/png;base64,${Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]).toString("base64")}`;
}

function unavoidableMultipart(parsed: CodexParsedRequest): void {
  parsed.context.systemPrompt = [...parsed.context.systemPrompt ?? [],
    ...Array.from({ length: 6 }, (_, index) => `whole-system-record-${index}: ${"x".repeat(90_000)}`)];
}

function request(reasoning: "low" | "medium" | "high" | "xhigh" | "max"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "preserve-developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning },
  };
}

test("native parallel guidance requires current inventory and stays out of control-only and manual turns", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const token = "turn_12345678901234567890123456789012";
  const ordinary = compileChatGptWebPrompt(request("high"), capabilities, token);
  expect(ordinary.text).toContain("codex.control.parallel_exec");
  expect(ordinary.text).toContain("current connector advertises");
  expect(ordinary.text).toContain("Never parallelize UI input");
  expect(ordinary.text).toContain("every child receipt");
  const compact = request("high"); compact._compactionRequest = true;
  expect(compileChatGptWebPrompt(compact, capabilities, token).text).not.toContain("codex.control.parallel_exec");
  expect(compileChatGptWebPrompt(request("high"), capabilities, token, { manualControl:true }).text).not.toContain("codex.control.parallel_exec");
  expect(compileChatGptWebPrompt(request("max"), { ...capabilities, localToolsEnabled:false }).text).not.toContain("codex.control.parallel_exec");
});

test("inline and staged history escape Markdown delimiters without changing decoded code", () => {
  const parsed = request("high");
  const code = '```ts\nconst value = "`key`";\n``` '.repeat(20) + '\\u0060 \\` [text](https://example.com) 中文';
  parsed.context.systemPrompt = [code];
  parsed.context.messages[1]!.content = code;
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const inline = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
  const encoded = inline.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)![1]!;
  expect(encoded).not.toContain("`");
  const decoded = JSON.parse(encoded);
  expect(decoded.system).toEqual([code]);
  expect(decoded.messages[1].content).toBe(code);
  unavoidableMultipart(parsed);
  const staged = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", {
    experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS,
  });
  const records = staged.multipart!.parts.flatMap(part => {
    expect(part).not.toContain("`");
    return JSON.parse(part).records;
  });
  expect(records.filter(record => record.kind === "system").map(record => record.content)).toEqual(parsed.context.systemPrompt);
  expect(staged.transportDecision!.measurements.composerChars).toBeGreaterThan(staged.transportDecision!.measurements.composerCharLimit!);
  expect(records.find(record => record.kind === "message" && record.message_index === 1).message.content)
    .toEqual(decoded.messages[1].content);
  expect(records.filter(record => record.kind === "message").map(record => record.message)).toEqual(decoded.messages);
  // A literal escape in source code stays literal; it is not decoded into a backtick twice.
  expect(decoded.messages[1].content).toContain("\\u0060");
});

test("history handle cleanup works on decoded text and preserves native call identities", () => {
  const call = `call_${"A".repeat(32)}`;
  const context = {
    tool_call_id: call,
    content: ["turn", "request", "binding"].map(kind => `first line\n${kind}_${"B".repeat(32)}\tlast line`),
    ordinary: [`my_turn_${"C".repeat(32)}`, `turn_${"D".repeat(33)}`, `turn_${"E".repeat(31)}`],
    literal: "Keep \\\\path, \\\"quotes\\\", and $& exactly.",
  };
  const cleaned = JSON.parse(withoutRetiredTurnHandles(JSON.stringify(context)));
  expect(cleaned.content).toEqual(["turn", "request", "binding"].map(kind => `first line\n[retired ${kind} handle]\tlast line`));
  expect(cleaned.tool_call_id).toBe(call);
  expect(cleaned.ordinary).toEqual(context.ordinary);
  expect(cleaned.literal).toBe(context.literal);
});

test("Full-mode Pro prompts pass one stable turn token directly to native actions", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("max");
  parsed.context.messages[1]!.content = `Diagnose an invalid binding_id safety failure without replaying ${token}`;
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );
  const envelopeEnd = compiled.text.indexOf("</codex_context_json>");
  const resume = compiled.text.indexOf("<codex_transport_resume>", envelopeEnd);
  const tokenMatches = compiled.text.match(new RegExp(token, "g"));
  const transportOnly = compiled.text.replace(
    /<codex_context_json>[\s\S]*<\/codex_context_json>/,
    "<codex_context_json>[task context]</codex_context_json>",
  );

  expect(envelopeEnd).toBeGreaterThan(0);
  expect(resume).toBeGreaterThan(envelopeEnd);
  expect(tokenMatches).toHaveLength(1);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(transportOnly).toContain("For local work required by the task, use the attached Codex Native tools directly according to their declared descriptions and schemas.");
  expect(transportOnly).toContain("Call a Codex Native tool only when the latest active request requires a local effect or fresh local evidence that is not already present in the supplied context; otherwise answer the request directly without a tool call.");
  expect(transportOnly).toContain("Use actual Codex Native results as evidence for local observations and effects.");
  expect(transportOnly).toContain("A Codex Native MCP tool result may require context compaction. If it does, follow the compaction instructions in that result exactly.");
  expect(transportOnly).toContain("After a deterministic tool failure, update the working hypothesis from that result");
  expect(transportOnly).toContain("do not repeat the same call unless its inputs or observable state changed.");
  expect(transportOnly).toContain("Continue using the available tools until the requested work is complete and verified.");
  expect(transportOnly).toContain("Write the user-facing final answer only after the last required tool result has settled.");
  expect(transportOnly).toContain(`The task context is complete. Pass turn_token ${token} unchanged to every Codex Native call in this response, including continuations after tool results; do not expose it in the answer. Execute the latest active user request now.`);
  expect(transportOnly).not.toMatch(/codex_bind_turn|binding_id|outer_tool_gateway|command_tool/);
  expect(transportOnly).not.toMatch(/codex_exec|codex_write_stdin|codex_apply_patch|codex_view_image|codex_tool_inventory|codex\.control\.turn_complete/);
  expect(transportOnly).toContain("Do not claim a safety or permission block without an explicit tool result or platform error supporting it.");
  expect(transportOnly).not.toMatch(/expired|invalid|revoked|blocked|security layer|permission gate/i);
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
  expect(compiled.text).not.toContain("internally compacts this response");
});

test("Pro preserves the same native Codex delegation contract as Extra High", () => {
  const token = "turn_12345678901234567890123456789012";
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const pro = compileChatGptWebPrompt(request("max"), capabilities, token);
  const extraHigh = compileChatGptWebPrompt(request("xhigh"), capabilities, token);

  for (const compiled of [pro, extraHigh]) {
    expect(compiled.text).toContain("For local work required by the task, use the attached Codex Native tools directly according to their declared descriptions and schemas.");
    expect(compiled.text).toContain(`Pass turn_token ${token} unchanged to every Codex Native call in this response`);
    expect(compiled.text).not.toContain("Complete this task directly in the current parent response.");
    expect(compiled.text).not.toContain("Do not create, spawn, delegate to, or wait on sub-agents");
    expect(compiled.text).not.toContain("Use non-agent tools directly instead.");
  }
});

test("read-only prompts resume without exposing a bind capability", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("The task context is complete. Execute the latest active user request now under the capability contract above.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).toContain("web search, browsing, research");
  expect(compiled.text).toContain("The missing local-computer bridge says nothing about whether those ChatGPT capabilities are available");
  expect(compiled.text).not.toContain("No local computer tool, MCP app");
  expect(compiled.text).not.toContain("evidence inside");
  expect(compiled.text).toContain("Do not mention this transport contract, context packaging, or capability routing");
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
});

test("Bigger Context sends six semantic record envelopes and starts work from the final part", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("high");
  parsed.context.systemPrompt = ["system-one", "system-two"];
  parsed.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "prior-answer" }], timestamp: 3 },
    { role: "user", content: "latest-request", timestamp: 4 },
  );
  unavoidableMultipart(parsed);
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart?.parts).toHaveLength(6);
  const records = compiled.multipart!.parts.flatMap(part => {
    const payload = JSON.parse(part) as { version: number; records: unknown[] };
    expect(payload.version).toBe(1);
    return payload.records;
  }) as Array<Record<string, unknown>>;
  expect(records.filter(record => record.kind === "system").map(record => record.content)).toEqual(parsed.context.systemPrompt);
  expect(compiled.transportDecision!.measurements.composerChars).toBeGreaterThan(compiled.transportDecision!.measurements.composerCharLimit!);
  expect(records.filter(record => record.kind === "message").map(record => (
    (record.message as { role: string }).role
  ))).toEqual(["developer", "user", "assistant", "user"]);
  expect(records.filter(record => record.kind === "message").map(record => record.message)).toEqual([
    { role: "developer", content: "preserve-developer" },
    { role: "user", content: "perform the task" },
    { role: "assistant", content: [{ type: "text", text: "prior-answer" }] },
    { role: "user", content: "latest-request" },
  ]);
  expect(compiled.multipart!.parts.join("\n")).not.toContain(token);
  expect(compiled.multipart!.commit.match(new RegExp(token, "g"))).toHaveLength(1);
  expect(compiled.text).toBe(compiled.multipart!.commit);
  expect(compiled.text).not.toContain("<codex_context_json>");

  const transactionId = `ctx_${"a".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1)
  ));
  expect(stages).toHaveLength(5);
  for (const [index, stage] of stages.entries()) {
    expect(stage.text).toContain(`part: ${index + 1}/6`);
    expect(stage.text).toContain(stage.sha256);
    expect(stage.acknowledgement).toBe(
      `CODEX_MULTIPART_ACK ${transactionId} ${index + 1}/6 ${stage.sha256}`,
    );
    expect(stage.text).toContain("```json\n");
    expect(stage.text).toContain("<codex_multipart_stage_end>");
    expect(stage.text).toEndWith("</codex_multipart_stage_end>");
    expect(stage.text.lastIndexOf(stage.acknowledgement)).toBeGreaterThan(
      stage.text.indexOf("</codex_context_part_json>"),
    );
  }
  const commit = formatChatGptWebMultipartCommit(compiled.multipart!, transactionId);
  expect(commit).toContain(`transaction_id: ${transactionId}`);
  expect(commit).toContain("acknowledged_parts: 5/6");
  expect(commit).toContain("The final part is included in this same message and starts the task");
  expect(commit).toContain(compiled.multipart!.parts.at(-1)!);
  expect(commit).toContain("latest-request");
  expect(commit.match(new RegExp(token, "g"))).toHaveLength(1);
});

test("Bigger Context uses the minimum transport and reserves six parts for compaction", () => {
  expect(biggerContextPartCount(94_999, 95_000, false)).toBeUndefined();
  expect(biggerContextPartCount(95_000, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(189_999, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(190_000, 95_000, false)).toBe(6);
  expect(biggerContextPartCount(1, 95_000, true)).toBe(6);

  const fitting = compileChatGptWebPrompt(request("high"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined, { experimentalMultipartParts: 2 });
  expect(fitting.transportDecision?.choice).toBe("INLINE");
  expect(fitting.multipart).toBeUndefined();
  const oversized = request("high");
  unavoidableMultipart(oversized);
  const compiled = compileChatGptWebPrompt(
    oversized,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: 2 },
  );
  expect(compiled.multipart?.parts).toHaveLength(2);
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  expect(records.filter((record: { kind: string }) => record.kind === "system").map((record: { content: string }) => record.content)).toEqual(oversized.context.systemPrompt!);
  expect(records.filter((record: { kind: string }) => record.kind === "message")).toHaveLength(oversized.context.messages.length);
  expect(records.filter((record: { kind: string }) => record.kind === "message").map((record: { message: unknown }) => record.message)).toEqual([
    { role: "developer", content: "preserve-developer" },
    { role: "user", content: "perform the task" },
  ]);
  const transactionId = `ctx_${"b".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1, 2)
  ));
  expect(stages).toHaveLength(1);
  expect(stages.map(stage => stage.acknowledgement)).toEqual([
    `CODEX_MULTIPART_ACK ${transactionId} 1/2 ${stages[0]!.sha256}`,
  ]);
  expect(formatChatGptWebMultipartCommit(compiled.multipart!, transactionId))
    .toContain("acknowledged_parts: 1/2");
});

test("browser-only Medium directs users to the full harness", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const warning = chatGptReadOnlyContextWarning(request("medium"), capabilities);
  expect(warning).toStartWith("> **Local tools unavailable**");
  expect(warning).toContain("`MCP`");
  expect(warning).toContain("`Codex Web GPT`");
  expect(warning).toContain("`Full`");
  expect(warning).toContain("selected ChatGPT Web model");
  expect(warning).not.toContain("tool-capable ChatGPT Web model first");
  expect(chatGptReadOnlyContextWarning(request("medium"), {
    ...capabilities,
    localToolsEnabled: true,
  })).toBeUndefined();
});

test("compaction prompts are isolated summarization turns without local or native tool instructions", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is a Codex history-compaction checkpoint, not a normal task turn.");
  expect(compiled.text).toContain("Produce the requested checkpoint summary now without calling tools.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("web search, browsing, research");
  expect(compiled.text).not.toContain("missing local-computer bridge");
});

test("Web compaction trims only the oldest history until the browser request fits", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "developer", content: `oldest-static-${"a".repeat(10_000)}`, timestamp: 1 },
    { role: "developer", content: `newer-static-${"b".repeat(10_000)}`, timestamp: 2 },
    { role: "user", content: `real-task-${"c".repeat(100_000)}`, timestamp: 3 },
    {
      role: "assistant",
      content: [{ type: "text", text: "verified-progress" }],
      timestamp: 4,
    },
    { role: "user", content: "checkpoint-now", timestamp: 5 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<{ role: string; content: unknown }> };

  expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  expect(compiled.trimmedCompactionMessages).toBe(2);
  expect(compiled.text).not.toContain("oldest-static");
  expect(compiled.text).not.toContain("newer-static");
  expect(compiled.text).toContain("real-task-");
  expect(compiled.text).toContain("verified-progress");
  expect(envelope.messages.at(-1)).toEqual({ role: "user", content: "checkpoint-now" });

  const normal = structuredClone(compact);
  delete normal._compactionRequest;
  const untrimmed = compileChatGptWebPrompt(
    normal,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  expect(untrimmed.text).toContain("oldest-static");
  expect(untrimmed.text).toContain("newer-static");
  expect(untrimmed.trimmedCompactionMessages).toBeUndefined();
});

test("inline compaction carries the newest cumulative checkpoint across discarded tool output", () => {
  for (const textParts of [false, true]) {
    const compact = request("high");
    compact._compactionRequest = true;
    compact.context.systemPrompt = [];
    const checkpoint = `${SUMMARY_PREFIX}\n\nVerified cumulative scope: ${"s".repeat(20_000)}`;
    compact.context.messages = [
      { role: "user", content: `${SUMMARY_PREFIX}\nObsolete summary`, timestamp: 1 },
      { role: "user", content: textParts ? [{ type: "text", text: checkpoint }] : checkpoint, timestamp: 2 },
      { role: "toolResult", toolCallId: "old-output", toolName: "read", isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }, { type: "image", imageUrl: validImageUrl("old-image") }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 4 },
      { role: "user", content: "checkpoint-now", timestamp: 5 },
    ];
    const before = structuredClone(compact);
    const compiled = compileChatGptWebPrompt(compact, {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    const envelope = JSON.parse(compiled.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!);
    expect(envelope.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(envelope.messages[0])).toContain("Verified cumulative scope:");
    expect(envelope.messages.at(-1).content).toBe("checkpoint-now");
    expect(compiled.text).not.toContain("Obsolete summary");
    expect(compiled.images).toEqual([]);
    expect(compiled.trimmedCompactionMessages).toBe(2);
    expect(compiled.text).toContain("history is incomplete");
    expect(compiled.text).not.toContain("The task context is complete.");
    expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
    expect(compact).toEqual(before);
    const manual = compileChatGptWebPrompt(compact, {
      localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    }, "turn_12345678901234567890123456789012", { manualControl: true });
    expect(manual.text).toContain("Verified cumulative scope:");
    expect(manual.text).toContain("history is incomplete");
    expect(manual.text).not.toContain("without calling tools");
    expect(chatGptPromptJsonBytes(manual.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  }
});

test("inline compaction rejects a required checkpoint that cannot fit instead of forgetting it", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\n${"s".repeat(120_000)}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "recent progress" }], timestamp: 2 },
    { role: "user", content: "checkpoint-now", timestamp: 3 },
  ];
  expect(() => compileChatGptWebPrompt(compact, {
    localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  })).toThrow("cumulative checkpoint");
});

test("authorized inline compaction trims an over-composer old record before enforcing transport limits", () => {
  for (const staleInvalidImage of [false, true]) {
    const compact = request("high");
    compact._compactionRequest = true;
    compact.context.systemPrompt = [];
    const checkpoint = `${SUMMARY_PREFIX}\nVerified cumulative scope: ${"s".repeat(20_000)}`;
    compact.context.messages = [
      { role: "toolResult", toolCallId: "old-output", toolName: "read", isError: false,
        content: staleInvalidImage
          ? [{ type: "text", text: `discardable-old-output-${"x".repeat(600_000)}` },
            { type: "image", imageUrl: "data:image/png;base64,stale-invalid-image" }]
          : `discardable-old-output-${"x".repeat(600_000)}`, timestamp: 1 },
      { role: "user", content: checkpoint, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 3 },
      { role: "user", content: "checkpoint-now", timestamp: 4 },
    ];
    const before = structuredClone(compact);
    const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    const compiled = compileChatGptWebPrompt(compact, capabilities);
    const envelope = JSON.parse(compiled.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!);
    expect(envelope.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(envelope.messages[0].content).toBe(checkpoint);
    expect(envelope.messages.at(-1).content).toBe("checkpoint-now");
    expect(compiled.trimmedCompactionMessages).toBe(1);
    expect(compiled.images).toEqual([]);
    expect(compiled.text).not.toContain("discardable-old-output");
    expect(compiled.text).toContain("history is incomplete");
    expect(compiled.transportDecision?.choice).toBe("INLINE");
    expect(compact).toEqual(before);
    const normal = structuredClone(compact);
    delete normal._compactionRequest;
    expect(() => compileChatGptWebPrompt(normal, capabilities)).toThrow("transport blocked");
  }
});

test("Bigger Context compaction preserves history above the retired inline byte budget", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = Array.from({ length: 6 }, (_unused, index) => ({
    role: "user" as const,
    content: `multipart-history-${index + 1}-${String.fromCharCode(97 + index).repeat(160_000)}`,
    timestamp: index + 1,
  }));

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(multipart.trimmedCompactionMessages).toBeUndefined();
  expect(multipart.multipart?.parts).toHaveLength(6);
  const transactionId = `ctx_${"0".repeat(32)}`;
  const stageBytes = multipart.multipart!.parts.map((payload, index) => chatGptPromptJsonBytes(
    formatChatGptWebMultipartStage(payload, transactionId, index + 1).text,
  ));
  expect(Math.max(...stageBytes)).toBeGreaterThan(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  const staged = multipart.multipart!.parts.join("\n");
  for (let index = 1; index <= 6; index += 1) {
    expect(staged).toContain(`multipart-history-${index}-`);
  }
}, 30_000);

test("Bigger Context keeps preliminary parts small and preserves all records in order", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = ["system".repeat(1_000)];
  compact.context.messages = [
    ...Array.from({ length: 6 }, (_unused, index) => ({
      role: "user" as const,
      content: `history-${index}-${"x".repeat(100_000)}`,
      timestamp: index + 1,
    })),
    { role: "user", content: "compact now", timestamp: 7 },
  ];

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );
  const parts = multipart.multipart!.parts.map(part => JSON.parse(part) as { records: unknown[] });

  expect(parts).toHaveLength(6);
  expect(parts.flatMap(part => part.records)).toHaveLength(8);
  expect(Math.max(...multipart.multipart!.parts.slice(0, -1).map(part => part.length))).toBeLessThan(120_000);
  // The selected High mode can carry a larger final part than an Instant upload.
  expect(multipart.multipart!.parts.at(-1)!.length).toBeLessThan(1_048_572);
}, 30_000);

test("Web compaction rebuilds attachments after trimming an oversized oldest image message", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `discard-${"x".repeat(120_000)}` },
        { type: "image", imageUrl: validImageUrl("discarded-image") },
      ],
      timestamp: 1,
    },
    { role: "user", content: "preserve-latest-checkpoint", timestamp: 2 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!;
  expect(compiled.images).toEqual([]);
  expect(compiled.trimmedCompactionMessages).toBe(1);
  expect(compiled.text).not.toContain("discard-");
  expect(envelope).not.toContain("image_attachment");
  expect(compiled.text).toContain("preserve-latest-checkpoint");
});

test("Luna rejects a separate compaction prompt because continuity is already rolling", () => {
  const compact = request("low");
  compact.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  compact._compactionRequest = true;
  expect(() => compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false },
  )).toThrow("does not accept a separate compaction turn");
});

test("Web compaction fails closed when its final instruction alone exceeds the transport budget", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [{ role: "user", content: "z".repeat(120_000), timestamp: 1 }];

  expect(() => compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  )).toThrow("final compaction instruction alone exceeds");
});

test("assigns prior assistant output to the model and never attributes Codex context to the human", () => {
  const attributed = request("max");
  attributed.context.messages = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi! How can I help?" }],
      timestamp: 2,
    },
    {
      role: "user",
      content: "what did I write before?\n<environment_context><cwd>/private/project</cwd></environment_context>",
      timestamp: 3,
    },
  ];
  const compiled = compileChatGptWebPrompt(
    attributed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<Record<string, unknown>> };

  expect(envelope.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Hi! How can I help?" }],
  });
  expect(compiled.text).toContain("assistant messages are your own earlier replies");
  expect(compiled.text).toContain("environment_context, are operational context rather than human-authored text");
  expect(compiled.text).toContain("answer only from the human-authored text in user messages");
  expect(compiled.text).toContain("do not attribute, quote, summarize, or otherwise mention them");
});

test("a normal task preserves every image through an eligible archive or blocks instead of dropping overflow", () => {
  const image = (marker: string) => ({
    type: "image" as const,
    imageUrl: validImageUrl(marker),
  });
  const markers = Array.from({ length: 13 }, (_unused, index) => `IMG${index + 1}`);
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: markers.map((marker, index) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `step ${index + 1}` }, image(marker)],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
  };

  expect(() => compileChatGptWebPrompt(replayed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012")).toThrow("10 attachments");
  const compiled = compileChatGptWebPrompt(
    replayed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { contextArchive: true },
  );

  expect(compiled.images.map(entry => entry.imageUrl)).toEqual(
    markers.map(validImageUrl),
  );
  const files = validateContextArchive(Buffer.from(compiled.contextArchive!.base64, "base64"), compiled.contextArchive!.sha256);
  const contextText = Buffer.from(files["context.txt"]!).toString("utf8");
  expect(contextText).not.toContain("older image not attached");
  expect(contextText).toContain("step 1");
  expect(contextText).toContain("step 13");
  expect(Object.keys(files).filter(path => path.startsWith("images/"))).toHaveLength(13);
  for (const [index, marker] of markers.entries()) expect(Buffer.from(files[`images/codex-input-image-${index + 1}.png`]!))
    .toEqual(Buffer.from(validImageUrl(marker).split(",")[1]!, "base64"));
});

test("Web compaction attaches the newest ten images as files and never embeds their base64 in prompt text", () => {
  const imagePayloads = Array.from({ length: 13 }, (_unused, index) =>
    validImageUrl(`compaction-image-${index + 1}`).split(",")[1]!);
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: imagePayloads.map((payload, index) => ({
        role: "user" as const,
        content: [
          { type: "text" as const, text: `checkpoint ${index + 1}` },
          { type: "image" as const, imageUrl: `data:image/png;base64,${payload}` },
        ],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
    _compactionRequest: true,
  };

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.images.map(image => image.imageUrl)).toEqual(
    imagePayloads.slice(-10).map(payload => `data:image/png;base64,${payload}`),
  );
  expect(compiled.text).not.toContain("data:image");
  for (const payload of imagePayloads) expect(compiled.text).not.toContain(payload);
  expect(compiled.text.match(/"type":"image_attachment"/g)).toHaveLength(10);
  expect(compiled.text.match(/older image not attached/g)).toHaveLength(3);
});

test("persisted one-pixel image sentinels are not attached to ChatGPT", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect the real image" },
          ...Array.from({ length: 30 }, () => ({ type: "image" as const, imageUrl: placeholder })),
          { type: "image", imageUrl: validImageUrl("real-image") },
        ],
        timestamp: 1,
      }],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true });

  expect(compiled.images.map(image => image.imageUrl)).toEqual([validImageUrl("real-image")]);
  expect(compiled.text.match(/"type":"image_attachment"/g)).toHaveLength(1);
  expect(compiled.text).not.toContain("older image not attached");
});

test("remote, malformed and unsupported images remain blocked with ZIP and multipart enabled", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  for (const imageUrl of ["https://example.com/image.png", "data:image/png;base64,invalid-image", "data:image/svg+xml;base64,PHN2Zy8+"]) {
    const parsed = request("high");
    parsed.context.messages[1]!.content = [{ type: "image", imageUrl }];
    expect(() => compileChatGptWebPrompt(parsed, capabilities, undefined, {
      contextArchive: true, experimentalMultipartParts: 2,
    })).toThrow("supported inline base64 data URLs");
  }
});

test("the replayed context never carries a finished turn's broker handles", () => {
  const staleToken = "turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const staleBinding = "binding_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const token = "turn_12345678901234567890123456789012";
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "user", content: "keep working", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "codex_bind_turn", arguments: { turn_token: staleToken } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "codex_bind_turn",
          isError: false,
          content: `{"binding_id":"${staleBinding}"}`,
          timestamp: 3,
        },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(replayed, { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, token);

  expect(compiled.text).not.toContain(staleToken);
  expect(compiled.text).not.toContain(staleBinding);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(compiled.text).toContain("[retired binding handle]");
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain("keep working");
  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!.trim();
  expect(() => JSON.parse(envelope) as unknown).not.toThrow();
});

test("requires ChatGPT-native rich results to include a safe Markdown answer for Codex", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("also provide the relevant result as ordinary Markdown in the final answer");
  expect(compiled.text).toContain("A private ChatGPT UI widget never replaces the Markdown answer returned to Codex");
  expect(compiled.text).toContain("Never copy a ChatGPT widget's HTML, CSS, class names, or DOM markup");
});

test("uses the public Instant name without leaking the browser menu alias into the prompt", () => {
  const compiled = compileChatGptWebPrompt(
    request("low"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is ChatGPT Web Instant with no Codex Native bridge to the user's local computer");
  expect(compiled.text).not.toContain("Instant 5.5");
});

test("keeps large contexts intact in the inline text envelope", () => {
  const token = "turn_12345678901234567890123456789012";
  const largeContent = "x".repeat(220_000);
  const large = request("high");
  large.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: largeContent,
    isError: false,
    timestamp: 3,
  });
  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );

  expect(compiled.text.length).toBeGreaterThan(220_000);
  expect(compiled.text).toContain(largeContent);
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain(`<codex_context_json>`);
  expect(compiled.text).not.toContain(`<codex_context_attachment>`);
  expect(compiled.text).not.toContain("sha256");
  expect(compiled.text).not.toContain("SHA-256");
  large.context.messages.at(-1)!.content = "x".repeat(600_000);
  const archived = compileChatGptWebPrompt(large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, token,
    { contextArchive: true });
  expect(archived.transportDecision?.choice).toBe("ZIP_SINGLE_MESSAGE");
  expect(JSON.parse(archived.contextArchive!.contextText).messages.at(-1).content).toBe("x".repeat(600_000));
  large.context.messages.at(-1)!.content = "x".repeat(1_000_000);
  expect(() => compileChatGptWebPrompt(large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, token,
    { contextArchive: true })).toThrow("account budget");
});

test("serialized history cannot feed code-fence backtracking into ChatGPT's link lexer", () => {
  const original = {
    content: '```python\nprint("hello")\n``` '.repeat(20),
    nested: { '`key`': ["`inline`", "\\u0060", "\\`", "中文", "[link](url)"] },
  };
  const encoded = withoutRetiredTurnHandles(JSON.stringify(original));
  expect(encoded).not.toContain("`");
  expect(JSON.parse(encoded)).toEqual(original);
});

test("inline and multipart transports preserve code while escaping its Markdown delimiters", () => {
  const parsed = request("high");
  parsed.context.messages[1]!.content = '```python\nprint("hello")\n``` '.repeat(20);
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const inline = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
  const envelope = inline.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!;
  expect(envelope).not.toContain("`");
  expect(JSON.stringify(JSON.parse(envelope))).toContain("```python");
  unavoidableMultipart(parsed);
  const multipart = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS });
  expect(multipart.multipart).toBeDefined();
  for (const part of multipart.multipart!.parts) {
    expect(part).not.toContain("`");
    expect(() => JSON.parse(part)).not.toThrow();
  }
  expect(JSON.stringify(multipart.multipart!.parts.map(part => JSON.parse(part)))).toContain("```python");
  expect(multipart.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter((record: { kind: string }) => record.kind === "system")
    .map((record: { content: string }) => record.content)).toEqual(parsed.context.systemPrompt!);
  expect(multipart.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter((record: { kind: string }) => record.kind === "message")
    .map((record: { message: unknown }) => record.message)).toEqual(JSON.parse(envelope).messages);
});
