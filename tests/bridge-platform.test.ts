import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* completedEvents(chunks = 1): AsyncGenerator<AdapterEvent> {
  for (let index = 0; index < chunks; index++) {
    yield { type: "text_delta", text: `chunk-${index}:` + "x".repeat(2_048) };
  }
  yield { type: "done", endTurn: true };
}

function responseStream(platform: NodeJS.Platform, chunks = 1): ReadableStream<Uint8Array> {
  return bridgeToResponsesSSE(
    completedEvents(chunks),
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { streamPlatform: platform },
  );
}

test("Responses SSE completes through the Windows push stream", async () => {
  const body = await new Response(responseStream("win32")).text();

  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("Darwin SSE remains decodable through Bun.serve under sustained chunking", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(responseStream("darwin", 64), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("chunk-63:");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  } finally {
    await server.stop(true);
  }
});

test("completed Windows Web response preserves final line and does not self-cancel",async()=>{
  let cancelled=0;
  const events:AsyncGenerator<AdapterEvent>=(async function*(){
    yield {type:"text_delta",text:"First line."};
    yield {type:"text_delta",text:" Final line."};
    yield {type:"done",stopReason:"stop",endTurn:true};
  })();
  const stream=bridgeToResponsesSSE(events,"chatgpt-web/test",
    undefined,undefined,undefined,()=>{cancelled++;},2000,{streamPlatform:"win32"});
  const body=await new Response(stream).text();
  expect(body).toContain("First line.");
  expect(body).toContain(" Final line.");
  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\\n\\n".replaceAll("\\n","\n"));
  expect(cancelled).toBe(0);
});

test("completed native pull SSE includes terminal and preserves the answer",async()=>{
  let cancelled=0;
  const events:AsyncGenerator<AdapterEvent>=(async function*(){
    yield {type:"text_delta",text:"Last instruction survived."};
    yield {type:"done",stopReason:"stop",endTurn:true};
  })();
  const stream=bridgeToResponsesSSE(events,"chatgpt-web/test",
    undefined,undefined,undefined,()=>{cancelled++;},2000,{streamPlatform:"linux"});
  const body=await new Response(stream).text();
  expect(body).toContain("Last instruction survived.");
  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\\n\\n".replaceAll("\\n","\n"));
  expect(cancelled).toBe(0);
});
