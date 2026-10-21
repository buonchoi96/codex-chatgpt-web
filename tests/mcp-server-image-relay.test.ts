import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultBrokerEndpoint } from "../src/config";
import { createChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const root = process.cwd();
const token = "turn_mcp_server_image_relay_1234567890";
// The PNG is the ComputerUseSwift fixed probe sample; the JPEG is its decoded 1x1 GDI+ encoding.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==";
const imageBlocks = [
  { type: "text", text: "frame metadata" },
  { type: "image", data: png, mimeType: "image/png" },
  { type: "image", data: jpeg, mimeType: "image/jpeg" },
];

test.skipIf(process.platform !== "win32")("fixed probe PNG/JPEG fixtures decode to complete images", () => {
  for (const [mimeType, base64] of [["image/png", png], ["image/jpeg", jpeg]]) {
    const script = `Add-Type -AssemblyName System.Drawing;$bytes=[Convert]::FromBase64String('${base64}');$stream=[IO.MemoryStream]::new($bytes);try{$image=[System.Drawing.Image]::FromStream($stream);if($image.Width -ne 1 -or $image.Height -ne 1){exit 2};'decoded'}finally{if($image){$image.Dispose()};$stream.Dispose()}`;
    const decoded = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(decoded.status, `${mimeType} decoder failed: ${decoded.stderr}`).toBe(0);
    expect(decoded.stdout.trim()).toBe("decoded");
  }
});

const environment = (nested = false): ChatGptTurnEnvironment => ({
  cwd: root,
  roots: [root],
  writableRoots: [],
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  tools: nested
    ? [{ name: "exec", description: "Run nested tools", parameters: {}, freeform: true }]
    : [{ name: "desktop_observe", namespace: "mcp__computer_use_swift", description: "Observe", parameters: {} }],
});

async function connectedRelay(nested = false) {
  const socketPath = defaultBrokerEndpoint(join(process.platform === "win32" ? tmpdir() : "/tmp", `cgw-ir-${process.pid}-${Date.now()}-${nested ? "n" : "d"}`), process.platform);
  const broker = TurnBroker.forSocket(socketPath);
  const requestToken = await broker.register(environment(nested), 30_000);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createChatGptMcpServer({ brokerSocketPath: socketPath, transport: serverTransport });
  const client = new Client({ name: "mcp-image-relay-test", version: "1" });
  await client.connect(clientTransport);
  return { broker, requestToken, client, server };
}

test("direct codex_tool_call returns broker image blocks and MCP result metadata unchanged", async () => {
  const relay = await connectedRelay();
  try {
    const pending = relay.client.callTool({
      name: "codex_tool_call",
      arguments: { turn_token: relay.requestToken, wire_name: "mcp__computer_use_swift__desktop_observe", arguments: {} },
    });
    const [request] = await relay.broker.nextToolBatch(relay.requestToken);
    expect(request?.wireName).toBe("mcp__computer_use_swift__desktop_observe");
    const result = {
      content: imageBlocks,
      structuredContent: { screenshot_content_index: 1, frame_id: "fixture-frame" },
      isError: false,
      _meta: { trace_id: "fixture-trace" },
    };
    relay.broker.completeTool(relay.requestToken, request!.callId, result);
    const received = await pending;
    expect(received.content).toEqual(imageBlocks);
    expect(received.isError).toBe(false);
    expect(received.structuredContent).toEqual(result.structuredContent);
    expect(received._meta).toEqual(result._meta);
    const content = received.content as Array<Record<string, unknown>>;
    expect(content.filter(item => item.type === "image").map(item => [item.mimeType, item.data]))
      .toEqual([["image/png", png], ["image/jpeg", jpeg]]);
  } finally {
    await relay.client.close();
    await relay.server.close();
    await relay.broker.close();
  }
});

test("direct codex_tool_call retains 3.56MB image block without flattening media into text", async () => {
  const relay = await connectedRelay();
  try {
    // Structural relay test: deterministic bytes, not a pixel recognition oracle.
    const encoded = Buffer.alloc(3_563_717, 0x5a).toString("base64");
    const pending = relay.client.callTool({
      name: "codex_tool_call",
      arguments: { turn_token: relay.requestToken, wire_name: "mcp__computer_use_swift__desktop_observe", arguments: {} },
    });
    const [request] = await relay.broker.nextToolBatch(relay.requestToken);
    const receipt = { ok: true, data: { screenshot_image_bytes: 3_563_717, screenshot_content_index: 1 } };
    relay.broker.completeTool(relay.requestToken, request!.callId, {
      content: [{type:"text",text:"capture receipt"},
        {type:"image",data:encoded,mimeType:"image/png"}],
      structuredContent:receipt,
    });
    const received = await pending;
    expect(received.isError).not.toBe(true);
    expect(received.structuredContent).toEqual(receipt);
    const imageParts = (received.content as Array<Record<string,unknown>>).filter(item=>item.type==="image");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]!.mimeType).toBe("image/png");
    expect(imageParts[0]!.data).toBe(encoded);
    expect((received.content as Array<{type:string;text?:string}>)
      .filter(item=>item.type==="text").map(item=>item.text??"").join("\n")).not.toContain(encoded);
  } finally {
    await relay.client.close();
    await relay.server.close();
    await relay.broker.close();
  }
});

test("direct codex_tool_call preserves actual error status, refusal content and structured error code", async () => {
  const relay = await connectedRelay();
  try {
    const pending = relay.client.callTool({
      name: "codex_tool_call",
      arguments: { turn_token: relay.requestToken, wire_name: "mcp__computer_use_swift__desktop_observe", arguments: {} },
    });
    const [request] = await relay.broker.nextToolBatch(relay.requestToken);
    const refusal = "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request";
    const result = {
      content: [{ type: "text", text: refusal }],
      structuredContent: { error: { code: "target_not_authorized" } },
      isError: true,
      _meta: { trace_id: "refusal-trace" },
    };
    relay.broker.completeTool(relay.requestToken, request!.callId, result);
    const received = await pending;
    expect(received.isError).toBe(true);
    expect(received.content).toEqual(result.content);
    expect(received.structuredContent).toEqual(result.structuredContent);
    expect(received._meta).toEqual(result._meta);
  } finally {
    await relay.client.close();
    await relay.server.close();
    await relay.broker.close();
  }
});

test.each([false,true])("nested exec gateway preserves image blocks and actual error status %s without base64 in text", async (isError) => {
  const relay = await connectedRelay(true);
  try {
    const pending = relay.client.callTool({
      name: "codex_tool_call",
      arguments: {
        turn_token: relay.requestToken,
        wire_name: "mcp__computer_use_swift__desktop_observe",
        arguments: {},
      },
    });
    const [request] = await relay.broker.nextToolBatch(relay.requestToken);
    expect(request).toMatchObject({ wireName: "exec", freeform: true });

    const emitted: Array<Record<string, unknown>> = [];
    const asyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
    const execute = new asyncFunction("tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", request!.input!);
    await execute(
      { mcp__computer_use_swift__desktop_observe: async () => ({ content: imageBlocks, isError, structuredContent: { frame_id: "fixture-frame" },_meta:{trace_id:'nested-trace'} }) },
      [{ name: "mcp__computer_use_swift__desktop_observe", description: "Observe" }],
      (text: unknown) => emitted.push({ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }),
      (image: unknown) => emitted.push(image as Record<string, unknown>),
      () => {},
      () => {},
    );
    expect(emitted.slice(0,imageBlocks.length)).toEqual(imageBlocks);
    expect(emitted.filter(item => item.type === "image").map(item => [item.mimeType, item.data]))
      .toEqual([["image/png", png], ["image/jpeg", jpeg]]);
    expect(emitted.filter(item => item.type === "text").map(item => item.text).join("\n"))
      .not.toMatch(/iVBOR|\/9j\//);

    relay.broker.completeTool(relay.requestToken, request!.callId, { content: emitted });
    const received = await pending;
    expect(received.content).toEqual(imageBlocks);
    expect(received.isError).toBe(isError);
    expect(received.structuredContent).toEqual({frame_id:'fixture-frame'});
    expect(received._meta).toEqual({trace_id:'nested-trace'});
    const content = received.content as Array<Record<string, unknown>>;
    expect(content.filter(item => item.type === "image").map(item => [item.mimeType, item.data]))
      .toEqual([["image/png", png], ["image/jpeg", jpeg]]);
  } finally {
    await relay.client.close();
    await relay.server.close();
    await relay.broker.close();
  }
});

test.each([false,true])('nested gateway forwards connector content_items and original error status %s without flattening image bytes into text', async (isError) => {
  const relay = await connectedRelay(true);
  try {
    const pending = relay.client.callTool({name:'codex_tool_call',arguments:{
      turn_token:relay.requestToken,wire_name:'mcp__computer_use_swift__desktop_observe',arguments:{},
    }});
    const [request] = await relay.broker.nextToolBatch(relay.requestToken);
    expect(request).toMatchObject({wireName:'exec',freeform:true});
    const emitted:Array<Record<string,unknown>>=[];
    const asyncFunction=Object.getPrototypeOf(async()=>{}).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>;
    const execute=new asyncFunction('tools','ALL_TOOLS','text','image','audio','generatedImage',request!.input!);
    await execute({mcp__computer_use_swift__desktop_observe:async()=>({
      content:'Tool returned multimodal content.',content_items:imageBlocks,isError,
      structuredContent:{frame_id:'connector-multimodal'},_meta:{trace_id:'connector-test'},
    })},[{name:'mcp__computer_use_swift__desktop_observe',description:'Observe'}],
    (value:unknown)=>emitted.push({type:'text',text:typeof value==='string'?value:JSON.stringify(value)}),
    (value:unknown)=>emitted.push(value as Record<string,unknown>),()=>{},()=>{});
    expect(emitted.slice(0,imageBlocks.length)).toEqual(imageBlocks);
    expect(emitted.filter(item=>item.type==='text').map(item=>item.text).join('\n')).not.toMatch(/iVBOR|\/9j\//);
    relay.broker.completeTool(relay.requestToken,request!.callId,{content:emitted});
    const received=await pending;
    expect(received.content).toEqual(imageBlocks);
    expect(received.isError).toBe(isError);
    expect(received.structuredContent).toEqual({frame_id:'connector-multimodal'});
    expect(received._meta).toEqual({trace_id:'connector-test'});
  } finally {
    await relay.client.close();await relay.server.close();await relay.broker.close();
  }
});

test('codex_view_image nested gateway forwards native connector image content_items within one MCP result',async()=>{
  const relay=await connectedRelay(true);
  try {
    const pending=relay.client.callTool({name:'codex_view_image',arguments:{turn_token:relay.requestToken,
      path:'C:\\isolated-fixtures\\unread.png',detail:'original'}});
    const [request]=await relay.broker.nextToolBatch(relay.requestToken);
    expect(request).toMatchObject({wireName:'exec',freeform:true});
    const emitted:Array<Record<string,unknown>>=[];
    const asyncFunction=Object.getPrototypeOf(async()=>{}).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>;
    const execute=new asyncFunction('tools','ALL_TOOLS','text','image','audio','generatedImage',request!.input!);
    await execute({view_image:async()=>({content:'Tool returned multimodal content.',
      content_items:[{type:'image',mimeType:'image/png',data:png}],isError:false})},
      [{name:'view_image',description:'Mocked native image read'}],
      (value:unknown)=>emitted.push({type:'text',text:typeof value==='string'?value:JSON.stringify(value)}),
      (value:unknown)=>emitted.push(value as Record<string,unknown>),()=>{},()=>{});
    expect(emitted.some(item=>item.type==='image')).toBe(true);
    expect(JSON.stringify(emitted.filter(item=>item.type==='text'))).not.toContain(png);
    relay.broker.completeTool(relay.requestToken,request!.callId,{content:emitted});
    const received=await pending;
    expect(received.content).toEqual([{type:'image',mimeType:'image/png',data:png}]);
    expect(received.isError).toBe(false);
  } finally {
    await relay.client.close();await relay.server.close();await relay.broker.close();
  }
});
