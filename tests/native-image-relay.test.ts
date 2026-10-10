import { expect, test } from "bun:test";
import {
  annotateNativeImageRelay,
  nativeImageRelayDiagnostic,
} from "../src/adapters/chatgpt-web/native-image-relay";
import type { BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const metadata = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  trace_id: "1ce024fa-37b1-4479-981a-40e1bf58dd75",
  data: {
    observation: {
      screenshot_content_index: 1,
      screenshot_mime_type: "image/png",
      screenshot_image_bytes: Buffer.from(png, "base64").length,
      ...overrides,
    },
  },
});
function receipt(overrides: Record<string, unknown> = {}): BrokerToolResult {
  const value = metadata(overrides);
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

test("native image relay matches an intact MCP image content item without changing it", async () => {
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(Buffer.from(png, "base64")).digest("hex");
  const value = receipt({ screenshot_sha256: sha });
  value.content.push({ type: "image", mimeType: "image/png", data: png });
  expect(nativeImageRelayDiagnostic(value)).toMatchObject({
    status: "delivered", screenshot_expected: true, image_items: 1, sha256_match: true,
  });
  expect(annotateNativeImageRelay(value)).toBe(value);
});

test("metadata-only screenshot must warn without retrying a successful computer action", () => {
  const value = receipt();
  const diagnostic = nativeImageRelayDiagnostic(value);
  expect(diagnostic).toMatchObject({ status: "missing", image_items: 0, screenshot_expected: true });
  const annotated = annotateNativeImageRelay(value);
  expect(annotated.isError).not.toBe(true);
  expect(annotated.content).toHaveLength(2);
  expect((annotated.content[1] as { text: string }).text).toContain("has NOT observed");
  expect(annotateNativeImageRelay(annotated).content).toHaveLength(2);
  expect(JSON.stringify(annotated)).not.toContain(png);
});

test("corrupted image checksum is explicit and does not leak its bytes into warning", () => {
  const value = receipt({ screenshot_sha256: "a".repeat(64) });
  value.content.push({ type: "image", mimeType: "image/png", data: png });
  expect(nativeImageRelayDiagnostic(value)).toMatchObject({ status: "mismatch", sha256_match: false });
  const warned = annotateNativeImageRelay(value);
  expect((warned.content.at(-1) as { text: string }).text).toContain("does not match");
  expect((warned.content.at(-1) as { text: string }).text).not.toContain(png);
});

test("intentional unchanged-frame suppression is not reported as image loss", () => {
  const value = receipt({ observation_skipped_unchanged: true, screenshot_content_index: undefined });
  expect(nativeImageRelayDiagnostic(value)?.status).toBe("skipped");
  expect(annotateNativeImageRelay(value)).toBe(value);
});

test("mismatched declared screenshot bytes are reported without logging screenshot payload", () => {
  const value = receipt({ screenshot_image_bytes: 999_999 });
  value.content.push({ type: "image", mimeType: "image/png", data: png });
  const diagnostic = nativeImageRelayDiagnostic(value);
  expect(diagnostic?.status).toBe("mismatch");
  expect(diagnostic?.image_bytes).toBe(Buffer.from(png, "base64").length);
  expect(JSON.stringify(diagnostic)).not.toContain(png);
});

test("unrelated text-only tool results are unchanged", () => {
  const value: BrokerToolResult = { content: [{ type: "text", text: "git status clean" }] };
  expect(nativeImageRelayDiagnostic(value)).toBeUndefined();
  expect(annotateNativeImageRelay(value)).toBe(value);
});

test("JPEG requested while native declares PNG is a distinct safe diagnostic", () => {
  const value = { ...receipt(), _meta: { nativeImageRequestedFormat: "jpeg" } };
  expect(nativeImageRelayDiagnostic(value)).toMatchObject({
    status: "missing",
    image_items: 0,
    requested_format: "jpeg",
    requested_format_match: false,
    declared_mime: "image/png",
  });
  const annotated = annotateNativeImageRelay(value);
  const notice = (annotated.content.at(-1) as { text: string }).text;
  expect(notice).toContain("requested jpeg, received image/png");
  expect(notice).toContain("has NOT observed");
  expect(annotateNativeImageRelay(annotated).content).toHaveLength(2);
  expect(annotated.isError).not.toBe(true);

  const image = { type: "image", mimeType: "image/png", data: png };
  const withImage = { ...value, content: [...value.content, image] };
  expect(nativeImageRelayDiagnostic(withImage)).toMatchObject({
    status: "mismatch",
    image_items: 1,
    requested_format_match: false,
  });
  expect(withImage.content).toHaveLength(2);
});

test("matching JPEG hint is optional and cannot manufacture image contents", () => {
  const value = { ...receipt({ screenshot_mime_type: "image/jpeg" }), _meta: { nativeImageRequestedFormat: "jpeg" } };
  expect(nativeImageRelayDiagnostic(value)).toMatchObject({
    status: "missing", image_items: 0, requested_format_match: true,
  });
  expect(annotateNativeImageRelay(value).content).toHaveLength(2);
});
