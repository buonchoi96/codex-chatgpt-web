import { expect, test } from "bun:test";
import {
  BACKEND_IMAGE_SMOKE_MODELS,
  buildImageSelfAssessmentPrompt,
  buildImageSmokeToolHistory,
  evaluateImageSelfAssessment,
  resolveBackendImageSmokeModel,
  type BackendImageSmokeObservation,
} from "../scripts/backend-image-smoke-contract";

const observations: BackendImageSmokeObservation[] = [
  {
    tool: "mcp__computer_use_swift__desktop_observe",
    data: "AQIDBA==",
    mimeType: "image/png",
    expectedMarkers: ["2468"],
  },
  {
    tool: "mcp__computer_use_swift__desktop_execute_and_observe",
    data: "BQYHCA==",
    mimeType: "image/jpeg",
    expectedMarkers: ["2468", "1357"],
  },
];

test("image self-assessment attaches each MCP screenshot under its originating tool call", () => {
  const history = buildImageSmokeToolHistory(observations, index => `call_${index + 1}`);

  expect(history).toHaveLength(4);
  expect(history[0]).toEqual({ type: "function_call", call_id: "call_1", name: observations[0]!.tool, arguments: "{}" });
  expect(history[1]).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: [
      { type: "input_text", text: "ComputerUseSwift-MCP desktop.observe result; the screenshot is attached as native image content." },
      { type: "input_image", image_url: "data:image/png;base64,AQIDBA==", detail: "high" },
    ],
  });
  expect(history[2]).toEqual({ type: "function_call", call_id: "call_2", name: observations[1]!.tool, arguments: "{}" });
  expect(history[3]).toEqual({
    type: "function_call_output",
    call_id: "call_2",
    output: [
      { type: "input_text", text: "ComputerUseSwift-MCP desktop.execute_and_observe result; the screenshot is attached as native image content." },
      { type: "input_image", image_url: "data:image/jpeg;base64,BQYHCA==", detail: "high" },
    ],
  });
});

test("self-assessment prompt asks for direct visual evidence without revealing expected markers", () => {
  const prompt = buildImageSelfAssessmentPrompt(observations);

  expect(prompt).toContain("read the images directly");
  expect(prompt).toContain(observations[0]!.tool);
  expect(prompt).toContain(observations[1]!.tool);
  expect(prompt).not.toContain("2468");
  expect(prompt).not.toContain("1357");
});

test("assessment passes only when the model self-reports readability and exact markers in tool order", () => {
  const answer = JSON.stringify({
    readable: true,
    observations: [
      { tool: observations[0]!.tool, markers: ["2468"] },
      { tool: observations[1]!.tool, markers: ["2468", "1357"] },
    ],
  });

  expect(evaluateImageSelfAssessment(answer, observations)).toEqual({ pass: true, errors: [] });
  expect(evaluateImageSelfAssessment(answer.replace("1357", "9999"), observations).pass).toBe(false);
  expect(evaluateImageSelfAssessment(answer.replace('"readable":true', '"readable":false'), observations).pass).toBe(false);
  expect(evaluateImageSelfAssessment("I can see the image", observations).pass).toBe(false);
});

test("assessment accepts Markdown-escaped JSON returned by the Web renderer", () => {
  const answer = '{"readable":true,"observations":\\[{"tool":"mcp\\_\\_computer\\_use\\_swift\\_\\_desktop\\_observe","markers":\\["2468"\\]},{"tool":"mcp\\_\\_computer\\_use\\_swift\\_\\_desktop\\_execute\\_and\\_observe","markers":\\["2468","1357"\\]}\\]}';

  expect(evaluateImageSelfAssessment(answer, observations)).toEqual({ pass: true, errors: [] });
});

test("image smoke exposes only the four Sol routes enabled for this account tier", () => {
  expect(BACKEND_IMAGE_SMOKE_MODELS.map(model => model.id)).toEqual([
    "chatgpt-web/gpt-6-sol",
    "chatgpt-web/gpt-6-sol-instant",
    "chatgpt-web/gpt-5.6-sol",
    "chatgpt-web/gpt-5.6-sol-instant",
  ]);
  expect(resolveBackendImageSmokeModel("chatgpt-web/gpt-6-sol").effort).toBe("high");
  expect(resolveBackendImageSmokeModel("chatgpt-web/gpt-6-sol-instant").effort).toBe("low");
  expect(() => resolveBackendImageSmokeModel("chatgpt-web/gpt-5.5-sol")).toThrow("Unsupported image smoke model");
});
