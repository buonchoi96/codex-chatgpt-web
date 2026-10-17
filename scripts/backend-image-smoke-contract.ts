export const BACKEND_IMAGE_SMOKE_MODELS = [
  { id: "chatgpt-web/gpt-6-sol", label: "GPT-6 Sol", effort: "high" },
  { id: "chatgpt-web/gpt-6-sol-instant", label: "GPT-6 Sol Instant", effort: "low" },
  { id: "chatgpt-web/gpt-5.6-sol", label: "GPT-5.6 Sol", effort: "high" },
  { id: "chatgpt-web/gpt-5.6-sol-instant", label: "GPT-5.6 Sol Instant", effort: "low" },
] as const;

export type BackendImageSmokeModel = typeof BACKEND_IMAGE_SMOKE_MODELS[number];
export type BackendImageSmokeTool =
  | "mcp__computer_use_swift__desktop_observe"
  | "mcp__computer_use_swift__desktop_execute_and_observe";

export interface BackendImageSmokeObservation {
  tool: BackendImageSmokeTool;
  data: string;
  mimeType: "image/png" | "image/jpeg";
  expectedMarkers: string[];
  mcpElapsedMs?: number;
}

export interface BackendImageSmokeAssessment {
  pass: boolean;
  errors: string[];
}

export function resolveBackendImageSmokeModel(modelId: unknown = "chatgpt-web/gpt-6-sol"): BackendImageSmokeModel {
  const model = BACKEND_IMAGE_SMOKE_MODELS.find(candidate => candidate.id === modelId);
  if (!model) throw new Error(`Unsupported image smoke model: ${String(modelId)}`);
  return model;
}

export function buildImageSelfAssessmentPrompt(observations: readonly BackendImageSmokeObservation[]): string {
  const toolList = observations.map(observation => observation.tool).join(", ");
  return [
    "Can you read the images directly from the preceding MCP results? Inspect the attached images visually; do not infer image contents from this request.",
    `The image results are in this order and come from these tools: ${toolList}.`,
    "Read every numeric verification code visible in the main document area of each image, in visual order. Ignore window decorations and menus.",
    'Return exactly one JSON object, no Markdown: {"readable":true,"observations":[{"tool":"<exact MCP tool name>","markers":["<visible code>"]}]}.',
    "Include one observations entry per image in the same order. If you cannot inspect an image directly, set readable to false. Do not use a shell, PowerShell, or another tool to inspect the images.",
  ].join("\n");
}

export function buildImageSmokeToolHistory(
  observations: readonly BackendImageSmokeObservation[],
  callIdForIndex: (index: number) => string = index => `call_mcp_image_${index + 1}`,
): unknown[] {
  return observations.flatMap((observation, index) => {
    const callId = callIdForIndex(index);
    const toolLabel = observation.tool === "mcp__computer_use_swift__desktop_observe"
      ? "desktop.observe"
      : "desktop.execute_and_observe";
    return [
      { type: "function_call", call_id: callId, name: observation.tool, arguments: "{}" },
      {
        type: "function_call_output",
        call_id: callId,
        output: [
          { type: "input_text", text: `ComputerUseSwift-MCP ${toolLabel} result; the screenshot is attached as native image content.` },
          { type: "input_image", image_url: `data:${observation.mimeType};base64,${observation.data}`, detail: "high" },
        ],
      },
    ];
  });
}

export function evaluateImageSelfAssessment(
  answer: string,
  expected: readonly BackendImageSmokeObservation[],
): BackendImageSmokeAssessment {
  const errors: string[] = [];
  let value: unknown;
  const trimmed = answer.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    value = JSON.parse(unfenced);
  } catch {
    try {
      const markdownUnescaped = unfenced.replaceAll("\\_", "_").replaceAll("\\[", "[").replaceAll("\\]", "]");
      value = JSON.parse(markdownUnescaped);
    } catch {
      return { pass: false, errors: ["answer_not_json"] };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { pass: false, errors: ["answer_not_object"] };
  }
  const record = value as { readable?: unknown; observations?: unknown };
  if (record.readable !== true) errors.push("model_reported_unreadable");
  if (!Array.isArray(record.observations)) {
    errors.push("observations_missing");
    return { pass: false, errors };
  }
  if (record.observations.length !== expected.length) errors.push("observation_count_mismatch");
  for (let index = 0; index < expected.length; index += 1) {
    const actual = record.observations[index];
    const wanted = expected[index]!;
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      errors.push(`observation_${index + 1}_invalid`);
      continue;
    }
    const entry = actual as { tool?: unknown; markers?: unknown };
    if (entry.tool !== wanted.tool) errors.push(`observation_${index + 1}_tool_mismatch`);
    if (!Array.isArray(entry.markers)
      || entry.markers.length !== wanted.expectedMarkers.length
      || entry.markers.some((marker, markerIndex) => marker !== wanted.expectedMarkers[markerIndex])) {
      errors.push(`observation_${index + 1}_markers_mismatch`);
    }
  }
  return { pass: errors.length === 0, errors };
}
