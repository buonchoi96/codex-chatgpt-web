export type ChatGptToolFailureClassification =
  | "NO_FAILURE"
  | "SAFETY_STATUS_UNKNOWN_OR_BLOCKED"
  | "TOOL_NOT_AVAILABLE"
  | "MCP_IMAGE_RELAY_FAILED"
  | "NATIVE_CAPTURE_ERROR"
  | "TARGET_NOT_AUTHORIZED"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNKNOWN";

export interface ChatGptToolResultEvidence {
  isError?: boolean;
  content?: readonly unknown[];
  structuredContent?: unknown;
  error?: unknown;
}

export interface ChatGptToolFailureAssessment extends ChatGptToolResultEvidence {
  readonly classification: ChatGptToolFailureClassification;
  /** Advisory for technical explanation only; never authorizes a retry or route change. */
  readonly allowTechnicalFallback: boolean;
  readonly errorCode?: string;
}

const SAFETY_REFUSAL = "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request";
const EXACT_SAFETY_REFUSALS = new Set([SAFETY_REFUSAL, `${SAFETY_REFUSAL}.`]);

// These codes are interpreted only when carried by an actual error payload. Unknown codes fail closed.
const VERIFIED_ERROR_CODES: Readonly<Record<string, {
  classification: Exclude<ChatGptToolFailureClassification, "NO_FAILURE" | "SAFETY_STATUS_UNKNOWN_OR_BLOCKED" | "UNKNOWN">;
  allowTechnicalFallback: boolean;
}>> = Object.freeze({
  connector_not_found: { classification: "TOOL_NOT_AVAILABLE", allowTechnicalFallback: true },
  tool_not_found: { classification: "TOOL_NOT_AVAILABLE", allowTechnicalFallback: true },
  mcp_image_relay_failed: { classification: "MCP_IMAGE_RELAY_FAILED", allowTechnicalFallback: true },
  native_capture_error: { classification: "NATIVE_CAPTURE_ERROR", allowTechnicalFallback: true },
  target_not_authorized: { classification: "TARGET_NOT_AUTHORIZED", allowTechnicalFallback: false },
  codex_tool_timeout: { classification: "TIMEOUT", allowTechnicalFallback: false },
  manual_handoff_timeout: { classification: "TIMEOUT", allowTechnicalFallback: false },
  compaction_handoff_timeout: { classification: "TIMEOUT", allowTechnicalFallback: false },
  client_cancelled: { classification: "CANCELLED", allowTechnicalFallback: false },
  manual_turn_cancelled: { classification: "CANCELLED", allowTechnicalFallback: false },
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactErrorMessage(value: unknown): boolean {
  if (typeof value === "string") return EXACT_SAFETY_REFUSALS.has(value);
  const message = record(value)?.message;
  return typeof message === "string" && EXACT_SAFETY_REFUSALS.has(message);
}

function errorPayload(result: ChatGptToolResultEvidence): unknown {
  if (result.error !== undefined && result.error !== null) return result.error;
  const structured = record(result.structuredContent);
  return structured?.error;
}

function errorCode(payload: unknown): string | undefined {
  const candidate = record(payload)?.code;
  return typeof candidate === "string" ? candidate : undefined;
}

function refusalInErrorResult(result: ChatGptToolResultEvidence, payload: unknown): boolean {
  if (exactErrorMessage(payload)) return true;
  if (result.isError !== true || !Array.isArray(result.content)) return false;
  return result.content.some(block => record(block)?.type === "text"
    && typeof record(block)?.text === "string"
    && EXACT_SAFETY_REFUSALS.has(record(block)!.text as string));
}

/**
 * Classify only the MCP result's error bit or explicit error payload. Content is returned by
 * reference and is never searched for codes or prose, except for the exact standalone safety
 * refusal on a result explicitly marked isError. No action, retry, routing, or fallback occurs here.
 */
export function classifyChatGptToolFailure(
  result: ChatGptToolResultEvidence,
): ChatGptToolFailureAssessment {
  const payload = errorPayload(result);
  const hasActualError = result.isError === true || payload !== undefined;
  const code = errorCode(payload);
  let classification: ChatGptToolFailureClassification = "NO_FAILURE";
  let allowTechnicalFallback = false;

  if (hasActualError) {
    if (code === 'safety_status_unknown_or_blocked' || code === 'SAFETY_STATUS_UNKNOWN_OR_BLOCKED'
      || refusalInErrorResult(result, payload)) {
      classification = "SAFETY_STATUS_UNKNOWN_OR_BLOCKED";
    } else if (code && VERIFIED_ERROR_CODES[code]) {
      ({ classification, allowTechnicalFallback } = VERIFIED_ERROR_CODES[code]!);
    } else {
      classification = "UNKNOWN";
    }
  }

  return {
    classification,
    allowTechnicalFallback,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(code !== undefined ? { errorCode: code } : {}),
  };
}
