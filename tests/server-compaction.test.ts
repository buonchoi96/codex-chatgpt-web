import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { COMPACT_PROMPT, SUMMARY_PREFIX, decodeCompactionSummary, encodeCompactionSummary } from "../src/responses/compaction";
import { compactRequest, responseRequest as respond } from "../src/server";
import type { CodexProviderConfig, CodexParsedRequest } from "../src/types";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";

const model = "chatgpt-web/high";
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

test("missing canonical compaction source rejects before starting any adapter or browser work", async () => {
  let adapterCalls = 0;
  const body = {
    model, stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_goal_preflight", turn_id: "turn_goal_compact", request_kind: "compaction",
    }) },
    input: [
      { type: "message", role: "user", id: "msg_goal_fragment",
        content: [{ type: "input_text", text: '<codex_internal_context source="goal">Continue working</codex_internal_context>' }] },
      { type: "compaction_trigger" },
    ],
  };
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(body),
  }), defaultConfig("full"), () => ({ name: "must-not-run", async runTurn() { adapterCalls++; } }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: {
    code: "COMPACTION_SOURCE_USER_MESSAGE_MISSING",
    message: expect.stringContaining("canonical source user message"),
  } });
  expect(adapterCalls).toBe(0);
});

for (const format of ["memento", "v2"] as const) {
  for (const nativeContext of [false, true]) {
  for (const stream of [false, true]) test(`${format} compaction completes for a native child with no human messages (stream=${stream}, nativeContext=${nativeContext})`, async () => {
    const metadata = {
      request_kind: format === "memento" ? "compaction" : "turn",
      thread_id: `thread_agent_only_${format}_${stream}_${nativeContext}`, turn_id: "turn_agent_only",
      parent_thread_id: "thread_parent", agent_name: "/root/independent_reviewer", subagent_kind: "thread_spawn",
      ...(format === "memento" ? { compaction: { trigger: "auto", reason: "context_limit",
        implementation: "responses", phase: "pre_turn", strategy: "memento" } } : {}),
    };
    const source = { type: "agent_message", id: "amsg_parent_instruction", author: "/root",
      recipient: "/root/independent_reviewer", content: [{ type: "input_text", text: "Finish the independent audit." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_agent_only" } };
    // Observed native children combine AGENTS and environment in a contextual user item.
    // It is not a human instruction, even if the v1 producer includes that item in its output.
    const context = { type: "message", id: "msg_native_context", role: "user", content: [
      { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Verify actual outcomes.</INSTRUCTIONS>" },
      { type: "input_text", text: "<environment_context><cwd>/workspace</cwd></environment_context>" },
    ], internal_chat_message_metadata_passthrough: { turn_id: "turn_agent_only",
      content_item_kinds: ["agents_md.instructions", "environments.environment_context"] } };
    const body = { model, stream, client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [...(nativeContext ? [context] : []), source, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(body),
    }), defaultConfig("full"), compactionAdapterFactory());
    const text = await response.text();
    expect(response.status).toBe(200);
    const result = stream
      ? JSON.parse(text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6)).response
      : JSON.parse(text);
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe(format === "memento" ? "message" : "compaction");
    const checkpoint = format === "v2" ? result.output[0]
      : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] };
    const continuation = { ...body, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn" }) },
      input: [checkpoint],
    };
    let continued: CodexParsedRequest | undefined;
    const resumed = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(continuation),
    }), defaultConfig("full"), () => ({ name: "agent-checkpoint-continuation", async runTurn(parsed, _incoming, emit) {
      continued = parsed;
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
      emit({ type: "text_delta", text: "Continued original child task", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } }));
    expect((await resumed.json()).status).toBe("completed");
    expect(continued).toBeDefined();
    const otherThread = { ...continued!, _rawBody: { ...continued!._rawBody as object,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn", thread_id: "unrelated_child" }) },
    } };
    expect(() => extractChatGptTurnUserRevision(otherThread)).toThrow("requires a current-turn user message");
  });
  }
}

test("native responses/memento compaction returns assistant text, not an encrypted compaction item", async () => {
  const metadata = {
    request_kind: "compaction", thread_id: "thread_memento", turn_id: "turn_memento",
    compaction: { trigger: "auto", reason: "context_limit", implementation: "responses", phase: "pre_turn", strategy: "memento" },
  };
  const body = {
    model, client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    input: [{ type: "message", id: "msg_source_memento", role: "user", content: [{ type: "input_text", text: "Summarize the previous work." }] }],
  };
  expect(parseRequest(body)._compactionRequest).toBe(true);
  for (const stream of [false, true]) {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...body, stream }),
    }), defaultConfig("full"), compactionAdapterFactory());
    expect(response.status).toBe(200);
    const text = await response.text();
    const result = stream
      ? JSON.parse(text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6)).response
      : JSON.parse(text);
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] });
  }
  const cwd = process.cwd();
  const continuation = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ model, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn", sandbox: "none", workspaces: { [cwd]: {} } }) },
      input: [
        { type: "message", role: "user", id: "msg_environment", content: [{ type: "input_text",
          text: `<environment_context><cwd>${cwd}</cwd><sandbox_mode>danger-full-access</sandbox_mode></environment_context>` }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] },
      ],
    }),
  }), defaultConfig("full"), () => ({ name: "verified-continuation", async runTurn(parsed, _incoming, emit) {
    expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(cwd);
    expect(extractChatGptTurnUserRevision(parsed)).toEqual(body.input[0]!.content);
    emit({ type: "text_delta", text: "Continued", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(continuation.status).toBe(200);
  expect((await continuation.json()).status).toBe("completed");
  expect(parseRequest({ ...body, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn" }) } })._compactionRequest).toBeUndefined();
  expect(() => parseRequest({ ...body, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, compaction: { strategy: "unknown" } }) } })).toThrow("Unsupported native text compaction");
});

// These fixtures test checkpoint authorization, not persisted previous_response_id storage.
const responseRequest: typeof respond = (request, config, factory, options) =>
  respond(request, config, factory, { ...options, rememberState: false });


for (const stream of [false, true]) for (const zstd of [false, true]) test(`browser prompt-too-long auto compacts and retries once (stream=${stream}, zstd=${zstd})`, async () => {
  const config = defaultConfig("full");
  let normalAttempts = 0;
  let compactionAttempts = 0;
  const body = {
    model,
    stream,
    client_metadata: {'x-codex-turn-metadata':JSON.stringify({thread_id:`thread_prompt_size_${stream}`,turn_id:'turn_prompt_size'})},
    input: [{
      type: "message",
      id: "msg_prompt_too_long_source",
      role: "user",
      content: [{ type: "input_text", text: "Continue the task after reducing browser prompt size." }],
    }],
  };

  const factory = (): ProviderAdapter => ({
    name: "prompt-too-long-auto-compact",
    async runTurn(parsed, _incoming, emit) {
      if (parsed._compactionRequest) {
        compactionAttempts += 1;
        emit({ type: "text_delta", text: "Compact checkpoint for retry", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
        return;
      }
      normalAttempts += 1;
      if (normalAttempts === 1) {
        emit({
          type: "error",
          message: "ChatGPT rejected the browser composer before submission because the prompt is too long",
          status: 413,
          errorType: "browser_transport_error",
          code: "browser_prompt_too_long",
          retryable: true,
        });
        return;
      }
      expect(parsed.context.messages.some(message => (
        typeof message.content === "string"
          ? message.content.includes(SUMMARY_PREFIX)
          : JSON.stringify(message.content).includes(SUMMARY_PREFIX)
      ))).toBeTrue();
      emit({ type: "text_delta", text: "Retried after automatic compaction", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });

  const wireJson = JSON.stringify(body);
  const compressed = Bun.zstdCompressSync(Buffer.from(wireJson));
  const compressedBytes = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(compressedBytes).set(compressed);
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(zstd ? { "content-encoding": "zstd" } : {}) },
    body: zstd ? compressedBytes : wireJson,
  }), config, factory);
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = stream
    ? JSON.parse(text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6)).response
    : JSON.parse(text);
  expect(json.status).toBe("completed");
  expect(JSON.stringify(json.output)).toContain("Retried after automatic compaction");
  expect(normalAttempts).toBe(2);
  expect(compactionAttempts).toBe(1);
});

for (const stream of [false, true]) test(`canonical pre-send context budget compacts once while retaining the active goal (stream=${stream})`, async () => {
  const goalText = "<codex_internal_context source=\"goal\">Goal status PURSUING; continue the full objective.</codex_internal_context>";
  const body = {
    model, stream,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: `thread_canonical_budget_${stream}`, turn_id: "turn_canonical_budget",
    }) },
    input: [{ type: "message", role: "user", id: "msg_canonical_budget_source",
      content: [{ type: "input_text", text: `Implement the active task. ${goalText}` }] }],
  };
  let attempts = 0;
  let compactions = 0;
  const factory = (): ProviderAdapter => ({
    name: "canonical-budget-auto-compact",
    async runTurn(parsed, _incoming, emit) {
      if (parsed._compactionRequest) {
        compactions++;
        emit({ type: "text_delta", text: "Compacted state; active goal remains PURSUING", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
        return;
      }
      attempts++;
      if (attempts === 1) {
        emit({ type: "error", message: "ChatGPT Web transport blocked: canonical context requires 117926 tokens, exceeding the measured account budget of 71808", status: 400,
          errorType: "invalid_request_error", code: "canonical_context_budget_exceeded", retryable: false });
        return;
      }
      expect(parsed.modelId).toBe("gpt-5.6-sol");
      const messages = parsed.context.messages.map(message => typeof message.content === "string"
        ? message.content : JSON.stringify(message.content));
      expect(messages.some(text => text.includes(goalText))).toBe(true);
      expect(messages.some(text => text.includes("active goal remains PURSUING"))).toBe(true);
      emit({ type: "text_delta", text: "Task resumed with GOAL PURSUING", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), defaultConfig("full"), factory);
  expect(response.status).toBe(200);
  const result = await response.text();
  expect(result).toContain("Task resumed with GOAL PURSUING");
  expect(attempts).toBe(2);
  expect(compactions).toBe(1);
});

test("an ambiguous browser context rejection never initiates automatic compaction", async () => {
  let calls = 0;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ model, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({thread_id: "thread_ambiguous_rejection", turn_id: "turn_ambiguous_rejection"}) },
      input: [{ type: "message", role: "user", id: "msg_ambiguous_rejection", content: [{ type: "input_text", text: "Keep task state." }] }],
    }),
  }), defaultConfig("full"), () => ({ name: "ambiguous-context-rejection", async runTurn(_parsed, _incoming, emit) {
    calls++;
    emit({ type: "error", status: 400, errorType: "invalid_request_error",
      code: "context_length_exceeded", retryable: false, message: "Context was rejected after an uncertain browser send" });
  } }));
  expect(calls).toBe(1);
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("failed");
});

test("canonical preflight overflow never compact-loops after its single retry", async () => {
  let normalAttempts = 0;
  let compactions = 0;
  const body = {
    model, stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_canonical_retry_limit", turn_id: "turn_canonical_retry_limit",
    }) },
    input: [{ type: "message", role: "user", id: "msg_canonical_retry_limit",
      content: [{ type: "input_text", text: "Continue the original task." }] }],
  };
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(body),
  }), defaultConfig("full"), () => ({ name: "canonical-overflow-single-retry", async runTurn(parsed, _incoming, emit) {
    if (parsed._compactionRequest) {
      compactions++;
      emit({ type: "text_delta", text: "Compacted source", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
      return;
    }
    normalAttempts++;
    emit({ type: "error", status: 400, errorType: "invalid_request_error",
      code: "canonical_context_budget_exceeded", retryable: false,
      message: "ChatGPT Web transport blocked: canonical context requires 117926 tokens, exceeding the measured account budget of 71808" });
  } }));
  const result = await response.json();
  expect(result.status).toBe("failed");
  expect(result.error.code).toBe("canonical_context_budget_exceeded");
  expect(result.error.message).toContain("after one automatic compaction retry");
  expect(result.error.message).toContain("117926 tokens");
  expect(result.error.message).toContain("71808");
  expect(normalAttempts).toBe(2);
  expect(compactions).toBe(1);
});

test("manual and automatic compaction both normalize to the same compaction request flag", async () => {
  const seen: Array<{ compaction: boolean; last: unknown }> = [];
  const factory = (): ProviderAdapter => ({
    name: "manual-auto-compaction-parity",
    async runTurn(parsed, _incoming, emit) {
      seen.push({
        compaction: parsed._compactionRequest === true,
        last: parsed.context.messages.at(-1)?.content,
      });
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const config = defaultConfig("full");

  const manual = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [{ type: "message", role: "user", id: "msg_manual_source", content: [{ type: "input_text", text: "manual source" }] }],
    }),
  }), config, factory);
  expect(manual.status).toBe(200);

  const metadata = {
    request_kind: "compaction",
    thread_id: "thread_auto_compaction_parity",
    turn_id: "turn_auto_compaction_parity",
    compaction: {
      trigger: "auto",
      reason: "context_limit",
      implementation: "responses",
      phase: "pre_turn",
      strategy: "memento",
    },
  };
  const automatic = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [{ type: "message", role: "user", id: "msg_auto_compaction_source",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_auto_compaction_parity" },
        content: [{ type: "input_text", text: "auto source" }] }],
    }),
  }), config, factory);
  expect(automatic.status).toBe(200);

  expect(seen).toHaveLength(2);
  expect(seen.every(entry => entry.compaction)).toBeTrue();
  expect(seen.every(entry => JSON.stringify(entry.last).includes("CONTEXT CHECKPOINT COMPACTION"))).toBeTrue();
});

function compactionAdapterFactory(
  seenProviders: CodexProviderConfig[] = [],
  expectedPreviousSummary?: string,
) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    seenProviders.push(structuredClone(provider));
    return {
      name: "test-web-compactor",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        expect(parsed.context.tools).toBeUndefined();
        expect(parsed.options.toolChoice).toBeUndefined();
        expect(parsed.options.parallelToolCalls).toBeUndefined();
        if (expectedPreviousSummary) {
          expect(parsed.context.messages).toContainEqual(expect.objectContaining({
            role: "user",
            content: expectedPreviousSummary,
          }));
        }
        expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
        emit({ type: "text_delta", text: summary, phase: "final_answer" });
        emit({
          type: "done",
          stopReason: "stop",
          endTurn: true,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, estimated: true },
        });
      },
    };
  };
}

test("zstd-compressed manual compaction reserializes internal JSON without stale encoding", async () => {
  const source = {
    model,
    input: [{ type: "message", role: "user", id: "msg_zstd_compact",
      content: [{ type: "input_text", text: "Preserve the full compaction source." }] }],
  };
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify(source)));
  const encoded = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(encoded).set(compressed);
  let adapterCalls = 0;
  const response = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd",
      "content-length": String(encoded.byteLength) },
    body: encoded,
  }), defaultConfig("full"), provider => {
    const actual = compactionAdapterFactory()(provider);
    return { ...actual, async runTurn(parsed, incoming, emit) {
      adapterCalls += 1;
      return actual.runTurn!(parsed, incoming, emit);
    } };
  });
  expect(response.status).toBe(200);
  const data = await response.json() as { output: unknown[] };
  expect(JSON.stringify(data.output)).toContain(summary);
  expect(adapterCalls).toBe(1);
});

test("compacts ChatGPT Web v1 through a dedicated read-only browser summarization turn", async () => {
  const providers: CodexProviderConfig[] = [];
  const previousSummary = `${SUMMARY_PREFIX}\nPrevious cumulative checkpoint`;
  const config = defaultConfig("full");
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "First answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: previousSummary }] },
        { type: "message", role: "user", id: "msg_v1_latest", content: [{ type: "input_text", text: "Latest request" }] },
      ],
    }),
  }), config, compactionAdapterFactory(providers, previousSummary));

  expect(response.status).toBe(200);
  expect(providers).toHaveLength(1);
  expect(providers[0]!.chatgptWeb?.localToolsEnabled).toBe(true);
  const body = await response.json() as { output: Array<{ role: string; content: Array<{ text: string }> }> };
  expect(body.output.map(item => item.content[0]!.text)).toEqual([
    "First request",
    "Latest request",
    `${SUMMARY_PREFIX}\n${summary}`,
  ]);
});

test("compacts legacy and named Pro tasks with Pro effort and preserves the selected family", async () => {
  const config = defaultConfig("full");
  config.extraHighAvailable = true;
  config.proAvailable = true;
  for (const [model, family] of [["chatgpt-web/pro", undefined], ["chatgpt-web/gpt-5.6-pro", "5.6"], ["chatgpt-web/gpt-6-pro", "6"]] as const) {
    const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ type: "message", role: "user", id: "msg_pro_source", content: [{ type: "input_text", text: "Inspect" }] }],
      }),
    }), config, () => ({
      name: "pro-compaction-effort-check",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        expect(parsed.options.reasoning).toBe("max");
        expect(parsed._chatgptModelFamily).toBe(family);
        emit({ type: "text_delta", text: summary, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }));

    expect(response.status).toBe(200);
  }
});

test("preserves canonical Codex turn metadata from the compact endpoint header", async () => {
  const turnMetadata = { thread_id: "thread_compact", turn_id: "turn_compact" };
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    },
    body: JSON.stringify({
      model,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnMetadata.turn_id },
      }],
    }),
  }), defaultConfig("full"), () => ({
    name: "metadata-check",
    async runTurn(parsed, _incoming, emit) {
      expect(extractChatGptTurnIdentity(parsed)).toMatchObject({
        threadId: turnMetadata.thread_id,
        turnId: turnMetadata.turn_id,
      });
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
});

test("compaction identity accepts a historical source message from the pre-compaction turn", async () => {
  const turnMetadata = { thread_id: "thread_compact", turn_id: "turn_compact" };
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    },
    body: JSON.stringify({
      model,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the existing task" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_before_compaction" },
      }],
    }),
  }), defaultConfig("full"), () => ({
    name: "compaction-identity-check",
    async runTurn(parsed, _incoming, emit) {
      expect(() => chatGptTurnExecutionKey(parsed)).not.toThrow();
      expect(() => chatGptCompactionSourceExecutionKey(parsed)).not.toThrow();
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
});

for (const format of ["v1", "v2"] as const) test(`${format} pre-turn compaction authorizes only its exact native continuation`, async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: `thread_preturn_${format}`, turn_id: `turn_preturn_${format}` };
  const source = {
    type: "message", role: "user", id: "msg_original", content: [{ type: "input_text", text: "Continue the original task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_before_preturn_compaction" },
  };
  const original = {
    model, stream: false, input: [source],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  const compact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify(original),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [source, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  const input = format === "v1" ? compacted.output : [source, ...compacted.output];
  const continuation = { ...original, input };
  let starts = 0;
  const factory = (): ProviderAdapter => ({
    name: "native-post-compaction-continuation",
    async runTurn(parsed, _incoming, emit) {
      starts += 1;
      expect(extractChatGptTurnIdentity(parsed).turnId).toBe(metadata.turn_id);
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
      emit({ type: "text_delta", text: "Continued after compaction", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const send = (body: unknown) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(body),
  }), config, factory);
  const resumed = await send(continuation);
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as { status: string }).status).toBe("completed");
  expect(starts).toBe(1);
  const toolRound = await send({ ...continuation, input: [...input,
    { type: "function_call", call_id: "call_native_round", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "call_native_round", output: "Native tool result" },
  ] });
  expect(toolRound.status).toBe(200);
  expect((await toolRound.json() as { status: string }).status).toBe("completed");
  // A checkpoint's text alone is not authority to start another task, another native turn,
  // a different model, or a rewritten source instruction.
  for (const changed of [
    { ...continuation, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, thread_id: "another_thread" }) } },
    { ...continuation, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, turn_id: "another_turn" }) } },
    { ...continuation, model: "chatgpt-web/medium" },
    { ...continuation, input: input.map(item => (item as { id?: string }).id === source.id
      ? { ...source, content: [{ type: "input_text", text: "Different task" }] } : item) },
    { ...continuation, input: [source, { type: "compaction", encrypted_content: encodeCompactionSummary("Unrecognized checkpoint") }] },
    { ...continuation, input: [...input, { type: "message", role: "user",
      content: [{ type: "input_text", text: "<turn_aborted>The user interrupted this turn.</turn_aborted>" }],
      internal_chat_message_metadata_passthrough: source.internal_chat_message_metadata_passthrough,
    }] },
  ]) {
    expect((await send(changed)).status).toBe(400);
  }
  expect(starts).toBe(2);
});

for (const format of ["v1", "v2"] as const) test(`${format} native continuation preserves a dropped delegation past an interrupted human turn`, async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: `thread_dropped_delegation_${format}`, turn_id: "turn_after_delegation" };
  const previous = { type: "message", role: "user", id: "msg_interrupted_human", content: [{ type: "input_text", text: "Earlier human task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_interrupted_human" } };
  const aborted = { type: "message", role: "user", id: "msg_human_abort",
    content: "<turn_aborted>The user interrupted this turn.</turn_aborted>",
    internal_chat_message_metadata_passthrough: previous.internal_chat_message_metadata_passthrough };
  const delegation = { type: "function_call_output", id: "fco_delegated_task", name: "send_message_to_thread",
    namespace: "codex_app", output: "<codex_delegation><source_thread_id>source_thread</source_thread_id><input>Finish the new delegated task.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: "turn_delegated_task" } };
  const original = { model, stream: false, input: [previous, aborted, delegation],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
  const compact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify(original),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [...original.input, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  const installed = format === "v1" ? compacted.output : [previous, aborted, ...compacted.output];
  let starts = 0;
  const send = (input: unknown[]) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input }),
  }), config, () => ({ name: "restored-delegated-task", async runTurn(parsed, _incoming, emit) {
    starts += 1;
    expect(extractChatGptTurnUserRevision(parsed)).toBe(delegation.output);
    emit({ type: "text_delta", text: "Delegated task continued", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  const continued = await send(installed);
  expect(continued.status).toBe(200);
  expect((await continued.json()).status).toBe("completed");
  // A long-running delegated task can compact again after its synthetic source was dropped.
  const recompact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify({ ...original, input: installed }),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [...installed, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(recompact.status).toBe(200);
  const recompacted = await recompact.json() as { output: unknown[] };
  const reinstalled = format === "v1" ? recompacted.output : [previous, aborted, ...recompacted.output];
  const continuedAgain = await send(reinstalled);
  expect(continuedAgain.status).toBe(200);
  expect((await continuedAgain.json()).status).toBe("completed");
  // Recovery of a different task never revives an explicitly interrupted delegation.
  expect((await send([...reinstalled, { ...aborted, id: "msg_delegation_abort",
    internal_chat_message_metadata_passthrough: delegation.internal_chat_message_metadata_passthrough }])).status).toBe(400);
  expect(starts).toBe(2);
});

for (const format of ["v1", "v2"] as const) test(`${format} goal compaction authorizes the human instruction past a standalone AGENTS preamble`, async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: `thread_goal_compaction_${format}`, turn_id: "turn_goal_continuation" };
  const source = { type: "message", role: "user", id: "msg_human",
    content: [{ type: "input_text", text: "Finish the requested work" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_human", content_item_kinds: ["user.text"] } };
  const goal = { type: "message", role: "user", id: "msg_goal_context",
    content: [{ type: "input_text", text: '<codex_internal_context source="goal">\nContinue the active goal.\n</codex_internal_context>' }],
    internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id, content_item_kinds: ["goal.internal_context"] } };
  // Instruction refreshes can be standalone user-role context, without an environment tag.
  // Native compaction drops these and rebuilds the preamble before the last real user.
  const instructions = { type: "message", role: "user", id: "msg_agents_refresh",
    content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Use the repository rules.</INSTRUCTIONS>" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_previous_goal", content_item_kinds: ["agents_md.instructions"] } };
  const original = { model, stream: false, input: [source, instructions, goal],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
  const compact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify(original),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [...original.input, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: Array<{ id?: string }> };
  // Codex 0.152.1 process_annotated_compacted_history drops internal model context.
  // The fixture preserves the wire behavior even if our v1 producer accidentally returns it.
  const retained = compacted.output.filter(item => item.id !== goal.id && item.id !== instructions.id);
  const installed = format === "v1" ? retained : [source, ...retained];
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: installed }),
  }), config, () => ({ name: "native-goal-continuation", async runTurn(parsed, _incoming, emit) {
    expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
    emit({ type: "text_delta", text: "Goal continued" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(response.status).toBe(200);
  expect((await response.json() as { status: string }).status).toBe("completed");
  expect(compacted.output).not.toContainEqual(expect.objectContaining({ id: goal.id }));
  expect(compacted.output).not.toContainEqual(expect.objectContaining({ id: instructions.id }));
});

test("v1 post-compaction continuation retains the producer's bounded source representation", async () => {
  const config = defaultConfig("full");
  const source = { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(80_100) }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_long_source" } };
  const original = { model, stream: false, input: [source], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_long_source", turn_id: "turn_after_long_source" }),
  } };
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", body: JSON.stringify(original),
  }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: compacted.output }),
  }), config, () => ({ name: "bounded-continuation", async runTurn(parsed, _incoming, emit) {
    expect(extractChatGptTurnUserRevision(parsed)).toEqual([{ type: "input_text", text: "x".repeat(80_000) }]);
    emit({ type: "text_delta", text: "Done", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(response.status).toBe(200);
});

for (const stream of [false, true]) test(`failed compaction cannot authorize a continuation (stream=${stream})`, async () => {
  const config = defaultConfig("full");
  const source = { type: "message", role: "user", content: [{ type: "input_text", text: "Original task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_failed_source" } };
  const original = { model, stream, input: [source], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread_failed_checkpoint_${stream}`, turn_id: "turn_failed_checkpoint" }),
  } };
  const failed = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: [source, { type: "compaction_trigger" }] }),
  }), config, () => ({ name: "failed-checkpoint", async runTurn(_parsed, _incoming, emit) {
    emit({ type: "text_delta", text: summary, phase: "final_answer" });
    emit({ type: "error", message: "Compaction failed before completion" });
  } }));
  // Consume the stream as native Codex does; only an actual completed checkpoint is evidence.
  expect(await failed.text()).toContain("Compaction failed before completion");
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, stream: false,
      input: [source, { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
    }),
  }), config, () => { throw new Error("Failed checkpoint must not authorize a new browser execution"); });
  expect(response.status).toBe(400);
});

test("returns exactly one native compaction item for a ChatGPT Web v2 request", async () => {
  const providers: CodexProviderConfig[] = [];
  const config = defaultConfig("full");
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools: [{ type: "function", name: "codex_exec", description: "Run", parameters: { type: "object" } }],
      input: [
        { type: "message", role: "user", id: "msg_v2_source", content: [{ type: "input_text", text: "Summarize the current work" }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, compactionAdapterFactory(providers));

  expect(response.status).toBe(200);
  expect(providers).toHaveLength(1);
  expect(providers[0]!.chatgptWeb?.localToolsEnabled).toBe(true);
  const body = await response.json() as {
    status: string;
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(body.status).toBe("completed");
  expect(body.output).toHaveLength(1);
  expect(body.output[0]!.type).toBe("compaction");
  expect(decodeCompactionSummary(body.output[0]!.encrypted_content ?? "")).toBe(summary);
});

test("v2 recompaction reads the previous checkpoint once and replaces it with one new compaction item", async () => {
  const config = defaultConfig("full");
  const firstResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        { type: "message", role: "user", id: "msg_first_recompact_source", content: [{ type: "input_text", text: "First request" }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, compactionAdapterFactory());
  expect(firstResponse.status).toBe(200);
  const firstBody = await firstResponse.json() as {
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(firstBody.output).toHaveLength(1);
  const previousCompaction = firstBody.output[0]!;

  const updatedSummary = "The previous checkpoint was consumed. Continue with the latest request only.";
  const secondResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        previousCompaction,
        { type: "message", role: "user", id: "msg_latest_recompact_source", content: [{ type: "input_text", text: "Latest request" }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, () => ({
    name: "v2-recompaction-check",
    async runTurn(parsed, _incoming, emit) {
      const previousSummaryText = `${SUMMARY_PREFIX}\n\n${summary}`;
      expect(parsed.context.messages.filter(message => (
        message.role === "user" && message.content === previousSummaryText
      ))).toHaveLength(1);
      expect(parsed.context.messages).toContainEqual(expect.objectContaining({
        role: "user",
        content: "Latest request",
      }));
      expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
      emit({ type: "text_delta", text: updatedSummary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(secondResponse.status).toBe(200);
  const secondBody = await secondResponse.json() as {
    status: string;
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(secondBody.status).toBe("completed");
  expect(secondBody.output).toHaveLength(1);
  expect(secondBody.output[0]!.type).toBe("compaction");
  expect(decodeCompactionSummary(secondBody.output[0]!.encrypted_content ?? ""))
    .toBe(updatedSummary);
});

test("streams one compaction item without leaking the summary as a normal assistant message", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, input: [
      { type: "message", role: "user", id: "msg_stream_source", content: [{ type: "input_text", text: "Summarize work" }] },
      { type: "compaction_trigger" },
    ] }),
  }), defaultConfig("full"), compactionAdapterFactory());

  expect(response.status).toBe(200);
  const sse = await response.text();
  expect(sse).toContain('"type":"compaction"');
  expect(sse).not.toContain("response.output_text.delta");
  expect(sse.match(/\"type\":\"compaction\"/g)).toHaveLength(2);
});

test("rejects an unknown routed compact model instead of treating it as ChatGPT Web", async () => {
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/not-enabled", input: [] }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("model is not enabled");
});

test("Luna accepts dedicated native compaction so Codex can reduce its own history", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  let adapterStarted = false;
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_luna_compact_v1", turn_id: "turn_luna_compact_v1", request_kind: "compaction",
      }) },
      input: [{ type: "message", role: "user", id: "msg_luna_compact_source",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_luna_compact_v1", content_item_kinds: ["user.text"] },
        content: [{ type: "input_text", text: "Keep the current task and its pending work." }] }],
    }),
  }), config, provider => {
    adapterStarted = true;
    return compactionAdapterFactory()(provider);
  });

  expect(response.status).toBe(200);
  expect(adapterStarted).toBeTrue();
  const body = await response.json() as { output: Array<{ type: string; role?: string; content?: Array<{ type: string; text?: string }> }> };
  expect(body.output.at(-1)).toMatchObject({
    type: "message", role: "user",
    content: [{ type: "input_text", text: SUMMARY_PREFIX + "\n" + summary }],
  });
});

test("Luna accepts remote-v2 compaction while retaining its per-turn rolling checkpoints", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  let adapterStarted = false;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_luna_compact_v2", turn_id: "turn_luna_compact_v2", request_kind: "turn",
      }) },
      input: [
        { type: "message", role: "user", id: "msg_luna_v2_compact_source",
          internal_chat_message_metadata_passthrough: { turn_id: "turn_luna_compact_v2", content_item_kinds: ["user.text"] },
          content: [{ type: "input_text", text: "Keep the current task and its pending work." }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, provider => {
    adapterStarted = true;
    return compactionAdapterFactory()(provider);
  });

  expect(response.status).toBe(200);
  expect(adapterStarted).toBeTrue();
  const body = await response.json() as { output: Array<{ type: string; encrypted_content?: string }> };
  expect(body.output).toHaveLength(1);
  expect(body.output[0]!.type).toBe("compaction");
  expect(decodeCompactionSummary(body.output[0]!.encrypted_content ?? "")).toBe(summary);
});

test("Luna Bigger Context accepts native v1 and v2 compaction", async () => {
  const config = { ...defaultConfig("browser-only"), solAvailable: false, experimentalBiggerContext: true };
  for (const v2 of [false, true]) {
    const input = [{ type: "message", role: "user", id: "msg_luna_big_source", content: [{ type: "input_text", text: "Keep the project requirements." }] }];
    const response = await (v2 ? responseRequest : compactRequest)(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", stream: false,
        input: v2 ? [...input, { type: "compaction_trigger" }] : input }),
    }), config, compactionAdapterFactory());
    expect(response.status).toBe(200);
    const body = await response.json();
    if (v2) {
      const checkpoint = body.output.find((item: { type: string }) => item.type === "compaction");
      expect(decodeCompactionSummary(checkpoint.encrypted_content)).toBe(summary);
    } else {
      expect(body.output.at(-1).content[0].text).toBe(`${SUMMARY_PREFIX}\n${summary}`);
    }
  }
});

test("rejects Pro-only routed models before opening a browser when the account has no Pro access", async () => {
  for (const [routedModel, label] of [
    ["chatgpt-web/extra-high", "Extra High"],
    ["chatgpt-web/pro", "Pro"],
  ] as const) {
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: routedModel, input: "test", stream: false }),
    }), defaultConfig("browser-only"));

    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain(`${label} is not available for this account`);
  }
});

test("preserves a structured browser preflight failure through the v1 compaction endpoint", async () => {
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: [{ type: "message", role: "user", id: "msg_browser_preflight_source", content: [{ type: "input_text", text: "Summarize the previous work" }] }] }),
  }), defaultConfig("browser-only"), () => ({
    name: "preflight-error",
    async runTurn(_parsed, _incoming, emit) {
      emit({
        type: "error",
        message: "This task exceeds the ChatGPT Web context window.",
        status: 400,
        errorType: "invalid_request_error",
        code: "context_length_exceeded",
        retryable: false,
      });
    },
  }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      message: "This task exceeds the ChatGPT Web context window.",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  });
});

test("refuses a ChatGPT Web continuation when local previous-response state is unavailable", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      previous_response_id: "resp_missing_after_restart",
      input: "continue",
      stream: false,
    }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(409);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("partial Codex context");
});

test('structured handoff cleanup is bounded even after backend compaction finishes', () => {
  const source=require('node:fs').readFileSync('src/adapters/chatgpt-web/index.ts','utf8');
  const cleanup=source.match(/\/\/ Cleanup must obey the same bounded compaction deadline\.[\s\S]{0,1200}?operationSignal,\s*\);/);
  expect(cleanup).toBeTruthy();
  expect(source).toContain('native_compaction_result_ready');
  expect(source).toContain('native_compaction_result_emitted');
});

test("automatic browser compaction preserves same-request responses_lite native and MCP tools", async () => {
  const native = { type: "function", name: "exec_command", description: "Run native command", parameters: { type: "object" } };
  const namespace = { type: "namespace", name: "mcp__sakura", tools: [
    { type: "function", name: "sakura_status", description: "Read-only status", parameters: { type: "object" } },
  ] };
  const input = [
    { type: "additional_tools", role: "user", tools: [native, namespace] },
    { type: "message", role: "user", id: "msg_auto_tools_source",
      content: [{ type: "input_text", text: "Read local state without mutating it." }] },
  ];
  let attempts = 0;
  let compactions = 0;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({
      model, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_auto_catalog_preserved", turn_id: "turn_auto_catalog_preserved",
      }) },
      input,
    }),
  }), defaultConfig("full"), () => ({ name: "verify-same-request-tools", async runTurn(parsed, _incoming, emit) {
    if (parsed._compactionRequest) {
      compactions++;
      emit({ type: "text_delta", text: "Concise handoff", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
      return;
    }
    attempts++;
    expect(parsed.context.tools?.map(tool => [tool.namespace, tool.name])).toEqual([
      [undefined, "exec_command"], ["mcp__sakura", "sakura_status"],
    ]);
    if (attempts === 1) {
      emit({ type: "error", status: 400, errorType: "invalid_request_error",
        code: "canonical_context_budget_exceeded", retryable: false,
        message: "Original canonical input exceeds browser token budget" });
      return;
    }
    const raw = parsed._rawBody as { input: Array<{ type: string; tools?: unknown[] }> };
    expect(raw.input.filter(item => item.type === "additional_tools")).toHaveLength(1);
    expect(raw.input[0]!.tools).toEqual([native, namespace]);
    emit({ type: "text_delta", text: "Native tools survived auto compaction", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(response.status).toBe(200);
  const outcome = await response.json();
  expect(outcome.status).toBe("completed");
  expect(attempts).toBe(2);
  expect(compactions).toBe(1);
});

test("automatic compact never invents native authority for tool-less outer requests", async () => {
  let attempts = 0;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ model, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_auto_catalog_absent", turn_id: "turn_auto_catalog_absent",
      }) },
      input: [{ type: "message", role: "user", id: "msg_toolless_source",
        content: [{ type: "input_text", text: "Summarize only." }] }],
    }),
  }), defaultConfig("full"), () => ({ name: "verify-no-privilege-invention", async runTurn(parsed, _incoming, emit) {
    if (parsed._compactionRequest) {
      emit({ type: "text_delta", text: "Short checkpoint", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
      return;
    }
    attempts++;
    expect(parsed.context.tools ?? []).toEqual([]);
    if (attempts === 1) {
      emit({ type: "error", status: 400, errorType: "invalid_request_error",
        code: "canonical_context_budget_exceeded", retryable: false, message: "Original prompt too long" });
      return;
    }
    emit({ type: "text_delta", text: "Tool-free retry", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect((await response.json()).status).toBe("completed");
  expect(attempts).toBe(2);
});

test("auto-compaction retains native discovered deferred tools from authenticated same-request tool_search_output", async () => {
  const directlyAdvertised = { type: "namespace", name: "functions", tools: [
    { type: "function", name: "exec_command", parameters: { type: "object" } },
    { type: "function", name: "shell_command", parameters: { type: "object" } },
  ] };
  const discovery = { type: "namespace", name: "mcp__Minecraft_Skript_MCP", tools: [
    ...Array.from({ length: 16 }, (_, index) => ({
      type: "function", name: `sakura_tool_${index}`, parameters: { type: "object" },
    })),
  ] };
  const search = { type: "tool_search_call", call_id: "call_discover_sakura", arguments: { query: "sakura" } };
  const result = { type: "tool_search_output", call_id: "call_discover_sakura", status: "completed", tools: [discovery] };
  const input = [
    { type: "additional_tools", role: "user", tools: [directlyAdvertised] },
    { type: "message", role: "user", id: "msg_deferred_tool_task",
      content: [{ type: "input_text", text: "Inspect the Sakura runtime." }] },
    search,
    result,
  ];
  let attempts = 0;
  let compactions = 0;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ model, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_deferred_autocompact", turn_id: "turn_deferred_autocompact",
      }) }, input }),
  }), defaultConfig("full"), () => ({
    name: "deferred-tools-auto-compact",
    async runTurn(parsed, _incoming, emit) {
      if (parsed._compactionRequest) {
        compactions++;
        emit({ type: "text_delta", text: "Sakura checkpoint", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
        return;
      }
      attempts++;
      expect(parsed.context.tools?.map(tool => tool.name)).toEqual([
        "exec_command", "shell_command", ...Array.from({ length: 16 }, (_, index) => `sakura_tool_${index}`),
      ]);
      if (attempts === 1) {
        emit({ type: "error", code: "canonical_context_budget_exceeded",
          status: 400, errorType: "invalid_request_error",
          retryable: false, message: "Measured pre-Send canonical budget exceeded" });
        return;
      }
      const retryInput = (parsed._rawBody as {input: unknown[]}).input;
      expect(retryInput).toContainEqual(search);
      expect(retryInput).toContainEqual(result);
      expect(retryInput[0]).toEqual(input[0]);
      emit({ type: "text_delta", text: "Deferred tool catalog preserved", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  const json = await response.json();
  expect(json.status).toBe("completed");
  expect(compactions).toBe(1);
  expect(attempts).toBe(2);
});

test("compaction retry never trusts browser-generated deferred-tool declarations", () => {
  const { restoreSameRequestAdditionalTools } = require("../src/responses/compaction-retry-tools");
  const original = [{ type: "additional_tools", tools: [
    { type: "function", name: "read_only", parameters: { type: "object" } },
  ] }];
  const malicious = [{ type: "tool_search_output", tools: [
    { type: "function", name: "invented_command", parameters: { type: "object" } },
  ] }];
  expect(() => restoreSameRequestAdditionalTools(original, malicious)).toThrow(
    "Compaction output cannot advertise native tools or tool-search receipts");
  const preserved = restoreSameRequestAdditionalTools(original, []);
  expect(preserved.restoredSearchSpecs).toBe(0);
  expect(preserved.restoredSpecs).toBe(1);
});
