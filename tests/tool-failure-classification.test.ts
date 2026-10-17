import { expect, test } from "bun:test";
import { classifyChatGptToolFailure } from "../src/adapters/chatgpt-web/tool-failure-classification";

const refusal = "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request";

test("classifies an actual safety refusal and preserves the original MCP result", () => {
  const content = [{ type: "text", text: refusal }];
  const structuredContent = { refusal_id: "safety-1" };
  const result = classifyChatGptToolFailure({
    isError: true,
    content,
    structuredContent,
  });

  expect(result).toMatchObject({
    classification: "SAFETY_STATUS_UNKNOWN_OR_BLOCKED",
    allowTechnicalFallback: false,
    isError: true,
    content,
    structuredContent,
  });
  expect(result.content).toBe(content);
  expect(result.structuredContent).toBe(structuredContent);
});

test("classifies a thrown exact platform refusal only when it is an actual error", () => {
  const error = new Error(refusal);
  expect(classifyChatGptToolFailure({ isError: true, error })).toMatchObject({
    classification: "SAFETY_STATUS_UNKNOWN_OR_BLOCKED", allowTechnicalFallback: false,
  });
  expect(classifyChatGptToolFailure({ isError: true, error: new Error(`Previously: ${refusal}`) }))
    .toMatchObject({ classification: "UNKNOWN", allowTechnicalFallback: false });
});

test("classifies the real platform refusal with a trailing period, without trusting quoted prose", () => {
  const exactWithPeriod = `${refusal}.`;
  expect(classifyChatGptToolFailure({ isError: true, error: new Error(exactWithPeriod) }))
    .toMatchObject({ classification: "SAFETY_STATUS_UNKNOWN_OR_BLOCKED", allowTechnicalFallback: false });
  expect(classifyChatGptToolFailure({ isError: true, content: [{ type: "text", text: exactWithPeriod }] }))
    .toMatchObject({ classification: "SAFETY_STATUS_UNKNOWN_OR_BLOCKED", allowTechnicalFallback: false });
  expect(classifyChatGptToolFailure({ isError: true, content: [{ type: "text", text: `Historical error: ${exactWithPeriod}` }] }))
    .toMatchObject({ classification: "UNKNOWN", allowTechnicalFallback: false });
});

test("does not classify quoted refusal text or code-like user content as a tool failure", () => {
  const content = [{ type: "text", text: `Historical note: ${refusal}; code=connector_not_found` }];
  expect(classifyChatGptToolFailure({ isError: false, content })).toMatchObject({
    classification: "NO_FAILURE",
    allowTechnicalFallback: false,
    isError: false,
    content,
  });
  expect(classifyChatGptToolFailure({ content })).toMatchObject({
    classification: "NO_FAILURE",
    allowTechnicalFallback: false,
    content,
  });
});

test.each([
  ["connector_not_found", "TOOL_NOT_AVAILABLE", true],
  ["mcp_image_relay_failed", "MCP_IMAGE_RELAY_FAILED", true],
  ["native_capture_error", "NATIVE_CAPTURE_ERROR", true],
  ["target_not_authorized", "TARGET_NOT_AUTHORIZED", false],
  ["codex_tool_timeout", "TIMEOUT", false],
  ["client_cancelled", "CANCELLED", false],
  ["unrecognized_vendor_code", "UNKNOWN", false],
] as const)("maps only explicit error payload code %s", (code, classification, fallback) => {
  const error = { code, message: "failure details" };
  const content = [{ type: "text", text: "failure details" }];
  const result = classifyChatGptToolFailure({ isError: true, content, error });
  expect(result).toMatchObject({ classification, allowTechnicalFallback: fallback, isError: true, content, errorCode: code });
  expect(result.content).toBe(content);
});

test("reads verified codes from structured error payloads, never from error prose", () => {
  const structuredContent = { error: { code: "target_not_authorized", message: "authorization denied" } };
  expect(classifyChatGptToolFailure({ isError: true, structuredContent })).toMatchObject({
    classification: "TARGET_NOT_AUTHORIZED",
    allowTechnicalFallback: false,
    errorCode: "target_not_authorized",
    structuredContent,
  });
  expect(classifyChatGptToolFailure({
    isError: true,
    content: [{ type: "text", text: "connector_not_found" }],
  })).toMatchObject({ classification: "UNKNOWN", allowTechnicalFallback: false });
});

test("requires an actual error result or payload before examining a refusal message", () => {
  expect(classifyChatGptToolFailure({ content: [{ type: "text", text: refusal }] }).classification)
    .toBe("NO_FAILURE");
  expect(classifyChatGptToolFailure({
    isError: true,
    content: [{ type: "text", text: `The task quoted: ${refusal}` }],
  }).classification).toBe("UNKNOWN");
});

test.each(['safety_status_unknown_or_blocked','SAFETY_STATUS_UNKNOWN_OR_BLOCKED'])(
 'an explicit safety error code %s stops technical fallback independently of localized prose',code=>{
  expect(classifyChatGptToolFailure({isError:true,structuredContent:{error:{code,message:'Localized safety rejection'}}}))
   .toMatchObject({classification:'SAFETY_STATUS_UNKNOWN_OR_BLOCKED',allowTechnicalFallback:false,errorCode:code});
 });
