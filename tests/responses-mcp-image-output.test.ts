import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8r+DAwMDAxMDAwMDAAAARXQFjhE1l/AAAAABJRU5ErkJggg==";
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFoooryz9hP//Z";

function withNativeOutput(output: unknown, custom = false) {
  const callId = "call_swift_mcp_image";
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: [
      custom
        ? { type: "custom_tool_call", call_id: callId, name: "exec", input: "" }
        : { type: "function_call", call_id: callId, name: "codex_tool_call", arguments: "{}" },
      custom
        ? { type: "custom_tool_call_output", call_id: callId, output }
        : { type: "function_call_output", call_id: callId, output },
    ],
  });
}

test("preserves MCP PNG/JPEG image blocks from native tool outputs through ChatGPT attachments", () => {
  for (const [mimeType, data, custom] of [
    ["image/png", png, false],
    ["image/jpeg", jpeg, true],
  ] as const) {
    const parsed = withNativeOutput([
      { type: "text", text: '{"screenshot_content_index":1,"screenshot_mime_type":"' + mimeType + '"}' },
      { type: "image", mimeType, data },
    ], custom);
    const result = parsed.context.messages.find(message => message.role === "toolResult");
    expect(result?.content).toEqual([
      { type: "text", text: '{"screenshot_content_index":1,"screenshot_mime_type":"' + mimeType + '"}' },
      { type: "image", imageUrl: `data:${mimeType};base64,${data}` },
    ]);
    const compiled = compileChatGptWebPrompt(parsed, capabilities, "turn_mcp_image_test");
    expect(compiled.images).toHaveLength(1);
    expect(compiled.images[0]?.imageUrl).toBe(`data:${mimeType};base64,${data}`);
    expect(compiled.text).toContain("image_attachment");
    expect(compiled.text).not.toContain(data);
  }
});

test("preserves canonical Codex input_image output blocks and encrypted markers", () => {
  const url = `data:image/png;base64,${png}`;
  const parsed = withNativeOutput([
    { type: "input_text", text: "native result" },
    { type: "input_image", image_url: url, detail: "original" },
    { type: "encrypted_content", encrypted_content: "opaque" },
  ]);
  const result = parsed.context.messages.find(message => message.role === "toolResult");
  expect(result?.content).toEqual([
    { type: "text", text: "native result" },
    { type: "image", imageUrl: url, detail: "high" },
    { type: "text", text: "[encrypted content omitted]" },
  ]);
});

test("rejects unsupported, malformed and oversized MCP image blocks without base64 text leakage", () => {
  const attempts = [
    { type: "image", mimeType: "image/svg+xml", data: png },
    { type: "image", mimeType: "image/png", data: "not-valid-base64" },
    { type: "image", mimeType: "image/jpeg", data: png },
    { type: "image", mimeType: "image/png", data: "A".repeat(26_666_672) },
  ];
  for (const block of attempts) {
    const parsed = withNativeOutput([{ type: "text", text: "visible" }, block]);
    const result = parsed.context.messages.find(message => message.role === "toolResult");
    expect(result?.content).toBe("visible[MCP image omitted: invalid or unsupported image payload]");
    const compiled = compileChatGptWebPrompt(parsed, capabilities, "turn_mcp_image_test");
    expect(compiled.images).toHaveLength(0);
    expect(compiled.text).not.toContain(block.data.slice(0, 80));
  }
});

test("never constructs image attachments from screenshot metadata without a real image block", () => {
  const metadata = '{"screenshot_content_index":1,"screenshot_image_bytes":1783758,"screenshot_mime_type":"image/png"}';
  const parsed = withNativeOutput([{ type: "text", text: metadata }]);
  const result = parsed.context.messages.find(message => message.role === "toolResult");
  expect(result?.content).toBe(metadata);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, "turn_mcp_image_test");
  expect(compiled.images).toHaveLength(0);
});
