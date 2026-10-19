import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";
import { deflateSync } from "node:zlib";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const turnToken = "turn_mcp_image_pipeline_1234567890";

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, name, data, checksum]);
}

function screenshotPng2x2(): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([
    0, 0xff, 0, 0, 0xff, 0, 0, 0, 0xff, 0xff,
    0, 0, 0xff, 0, 0xff, 0xff, 0xff, 0xff,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function requestFromMcpImage(mimeType: string, base64: string) {
  const callId = "call_computer_use_observe";
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    input: [
      {
        type: "function_call",
        call_id: callId,
        name: "mcp__computer_use_swift__desktop_observe",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: [
          { type: "input_text", text: "Screenshot captured by desktop.observe." },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${base64}`,
            detail: "high",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Read the visible verification code." }],
      },
    ],
    reasoning: { effort: "high" },
  });
}

for (const [mimeType, base64, extension] of [
  ["image/png", screenshotPng2x2(), "png"],
  ["image/jpeg", "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==", "jpg"],
]) {
  test(`MCP ${mimeType} screenshot remains a direct GPT image attachment`, () => {
    const parsed = requestFromMcpImage(mimeType, base64);
    const toolResult = parsed.context.messages.find(message => message.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role !== "toolResult") throw new Error("MCP function output was not parsed as a tool result");
    expect(Array.isArray(toolResult.content)).toBe(true);
    if (!Array.isArray(toolResult.content)) throw new Error("MCP image was flattened into text");
    expect(toolResult.content).toContainEqual({
      type: "image",
      imageUrl: `data:${mimeType};base64,${base64}`,
      detail: "high",
    });

    const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken);
    expect(compiled.images).toHaveLength(1);
    expect(compiled.text).toContain('"type":"image_attachment"');
    expect(compiled.text).not.toContain(base64);
    const [attachment] = chatGptPromptFilePayloads(compiled);
    expect(attachment?.name).toBe(`codex-input-image-1.${extension}`);
    expect(attachment?.mimeType).toBe(mimeType);
    expect(attachment?.buffer.toString("base64")).toBe(base64);
  });
}
