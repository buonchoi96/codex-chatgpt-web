import { createHash } from "node:crypto";
import type { BrokerToolResult } from "./turn-broker";

/** Metadata-only inventory; never log screenshots, base64, tool text or credentials. */
export interface NativeImageRelayDiagnostic {
  trace_id?: string;
  image_items: number;
  image_bytes: number;
  mime_types: string[];
  screenshot_expected: boolean;
  declared_mime?: string;
  declared_bytes?: number;
  sha256_match?: boolean;
  status: "delivered" | "missing" | "mismatch" | "skipped" | "unverified";
}

const MISSING_IMAGE_WARNING =
  "[Native image relay: screenshot metadata arrived without a multimodal image item. " +
  "The model has NOT observed this screenshot. Do not infer visual state from metadata " +
  "and do not replay already completed input actions to recover it.]";
const INVALID_IMAGE_WARNING =
  "[Native image relay: returned image content does not match its screenshot receipt. " +
  "Do not treat this image as a verified observation or repeat already completed inputs.]";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function metadata(result: BrokerToolResult): { envelope?: Record<string, unknown>; screenshot?: Record<string, unknown> } {
  let envelope: unknown = result.structuredContent;
  if (!object(envelope)) {
    for (const value of result.content) {
      if (!object(value) || value.type !== "text" || typeof value.text !== "string"
          || value.text.length > 65_536) continue;
      try { envelope = JSON.parse(value.text); break; } catch { /* not a JSON receipt */ }
    }
  }
  if (!object(envelope)) return {};
  const candidates: unknown[] = [envelope, envelope.data];
  if (object(envelope.data)) candidates.push(envelope.data.observation);
  if (object(envelope.observation)) candidates.push(envelope.observation);
  return {
    envelope,
    screenshot: candidates.find(x => object(x) &&
      ("screenshot_content_index" in x || "observation_skipped_unchanged" in x)) as Record<string, unknown> | undefined,
  };
}

/** Pure result inspection, callable at native-response, broker and MCP return boundaries. */
export function nativeImageRelayDiagnostic(result: BrokerToolResult): NativeImageRelayDiagnostic | undefined {
  const { envelope, screenshot } = metadata(result);
  const images = result.content.filter(x => object(x) && x.type === "image");
  if (!screenshot && images.length === 0) return undefined;
  const mimeTypes: string[] = [];
  let total = 0;
  const hashes: string[] = [];
  for (const image of images) {
    if (!object(image)) continue;
    const mime = image.mimeType === "image/png" || image.mimeType === "image/jpeg"
      ? image.mimeType : "other";
    mimeTypes.push(mime);
    if (typeof image.data !== "string" || image.data.length > 27_000_000 ||
        image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) {
      hashes.push("invalid");
      continue;
    }
    const data = Buffer.from(image.data, "base64");
    total += data.length;
    hashes.push(createHash("sha256").update(data).digest("hex"));
  }
  const expected = screenshot !== undefined &&
    Number.isSafeInteger(screenshot.screenshot_content_index) &&
    (screenshot.screenshot_content_index as number) > 0;
  const skipped = screenshot?.observation_skipped_unchanged === true;
  const sha = typeof screenshot?.screenshot_sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(screenshot.screenshot_sha256) ? screenshot.screenshot_sha256.toLowerCase() : undefined;
  const shaMatch = sha && images.length > 0 ? hashes.includes(sha) : undefined;
  const expectedMime = screenshot?.screenshot_mime_type;
  const mimeMismatch = images.length > 0 && typeof expectedMime === "string"
    && !mimeTypes.includes(expectedMime);
  const declaredBytes = screenshot?.screenshot_image_bytes;
  const bytesMismatch = images.length > 0 && Number.isSafeInteger(declaredBytes)
    && total !== declaredBytes;
  const status = skipped && !expected && images.length === 0 ? "skipped"
    : expected && images.length === 0 ? "missing"
    : images.length > 0 && (shaMatch === false || mimeMismatch || bytesMismatch || hashes.includes("invalid")) ? "mismatch"
    : images.length > 0 && expected ? "delivered" : "unverified";
  return {
    ...(typeof envelope?.trace_id === "string" && /^[0-9a-f-]{36}$/i.test(envelope.trace_id)
      ? { trace_id: envelope.trace_id } : {}),
    image_items: images.length,
    image_bytes: total,
    mime_types: mimeTypes,
    screenshot_expected: expected,
    ...(typeof expectedMime === "string" && ["image/png","image/jpeg"].includes(expectedMime) ? { declared_mime: expectedMime } : {}),
    ...(Number.isSafeInteger(screenshot?.screenshot_image_bytes) ? { declared_bytes: screenshot!.screenshot_image_bytes as number } : {}),
    ...(shaMatch !== undefined ? { sha256_match: shaMatch } : {}),
    status,
  };
}

/** Warn without changing whether an already executed action succeeded. Idempotent for replays. */
export function annotateNativeImageRelay(result: BrokerToolResult): BrokerToolResult {
  const diagnostic = nativeImageRelayDiagnostic(result);
  if (!diagnostic || (diagnostic.status !== "missing" && diagnostic.status !== "mismatch")) return result;
  const notice = diagnostic.status === "missing" ? MISSING_IMAGE_WARNING : INVALID_IMAGE_WARNING;
  if (result.content.some(item => object(item) && item.type === "text" && item.text === notice)) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: notice }],
    _meta: {
      ...(object(result._meta) ? result._meta : {}),
      nativeImageRelay: diagnostic,
    },
  };
}

export function logNativeImageRelay(stage: "codex_response" | "broker" | "mcp_outbound",
  result: BrokerToolResult, callId?: string): void {
  const diagnostic = nativeImageRelayDiagnostic(result);
  if (!diagnostic) return;
  console.info("[native-image-relay] " + JSON.stringify({
    stage,
    ...(callId ? { call: callId.slice(0, 17) } : {}),
    ...diagnostic,
  }));
}
