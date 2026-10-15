import { expect, test } from "bun:test";
import {
  assertFixedProbeInline, assertProbeHttp, assertProbeResponseError, assertSingleBrowserOwner,
  boundedFixtureAnswer, FIXED_PNG_SHA256, fixedProbeHistory, MAX_FIXTURE_ANSWER_CHARS, orderedMcpContent,
} from "../scripts/smoke-dev-fixed-probe";

test("probe continuation retains every Responses item and both source and canonical turn provenance", () => {
  const output = [
    { type: "reasoning", id: "reasoning_fixture", summary: [{ type: "summary_text", text: "Inert reasoning summary." }],
      internal_chat_message_metadata_passthrough: { turn_id: "source-turn", source_label: "fixture" } },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Fixture call next." }] },
    { type: "function_call", name: "probe", call_id: "call_fixture", arguments: "{}" },
  ];
  const before = structuredClone(output);
  expect(fixedProbeHistory(output, "canonical-turn")).toEqual([
    { ...output[0], internal_chat_message_metadata_passthrough: { turn_id: "canonical-turn", source_label: "fixture", source_turn_id: "source-turn" } },
    { ...output[1], internal_chat_message_metadata_passthrough: { turn_id: "canonical-turn" } },
    { ...output[2], internal_chat_message_metadata_passthrough: { turn_id: "canonical-turn" } },
  ]);
  expect(output).toEqual(before);
});

test("probe rejects non-INLINE, archive and multipart before send", () => {
  expect(() => assertFixedProbeInline({ transportDecision: { choice: "ZIP_SINGLE_MESSAGE" } })).toThrow("beforeSend");
  expect(() => assertFixedProbeInline({ contextArchive: { sha256: "fixture" } })).toThrow("beforeSend");
  expect(() => assertFixedProbeInline({ multipart: { parts: ["fixture"] } })).toThrow("beforeSend");
  expect(() => assertFixedProbeInline({ transportDecision: { choice: "INLINE" } })).not.toThrow();
});

test("probe permits one browser owner and rejects a second", () => {
  expect(() => assertSingleBrowserOwner(1)).not.toThrow();
  expect(() => assertSingleBrowserOwner(2)).toThrow("second browser owner");
});

test("each Responses round checks HTTP status and structured API errors", () => {
  expect(() => assertProbeHttp({ ok: false, status: 429 }, "initial")).toThrow("initial Responses HTTP 429");
  expect(() => assertProbeHttp({ ok: true, status: 200 }, "final")).not.toThrow();
  expect(() => assertProbeResponseError({ error: { code: "fixture_error" } }, "final")).toThrow("final Responses error (fixture_error)");
  expect(() => assertProbeResponseError({ output: [] }, "initial")).not.toThrow();
});

test("MCP text and image blocks keep their original interleaved order", () => {
  expect(orderedMcpContent([
    { type: "text", text: "before" },
    { type: "image", mimeType: "image/png", data: "UE5H" },
    { type: "text", text: "after" },
  ])).toEqual([
    { type: "input_text", text: "before" },
    { type: "input_image", image_url: "data:image/png;base64,UE5H", detail: "high" },
    { type: "input_text", text: "after" },
  ]);
});

test("pinned fixture digest and final model answer capture are explicit and bounded", () => {
  expect(FIXED_PNG_SHA256).toBe("3e047a27b2fc3e60a6dc329985cb8ce77b7254cdcd41c77039e4f3c5d9acc9c4");
  expect(boundedFixtureAnswer("x".repeat(MAX_FIXTURE_ANSWER_CHARS + 100))).toHaveLength(MAX_FIXTURE_ANSWER_CHARS);
});
