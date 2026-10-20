import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import { HttpSseTerminalObserver } from "../src/http-sse-terminal";
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

test("final_answer output and completed plus DONE are delivered in one terminal chunk on Windows", async () => {
  let cancelled = 0;
  const finalLine = "Final subagent response was accepted.";
  async function* completed(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: finalLine.slice(0, 12), phase: "final_answer" };
    yield { type: "text_delta", text: finalLine.slice(12), phase: "final_answer" };
    yield { type: "done", stopReason: "stop", endTurn: true };
  }
  const stream = bridgeToResponsesSSE(completed(), "chatgpt-web/test",
    undefined, undefined, undefined, () => { cancelled++; }, 2000, { streamPlatform: "win32" });
  const reader = stream.getReader();
  const chunks: string[] = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(new TextDecoder().decode(item.value));
  }
  const body = chunks.join("");
  const output = body.split("\n").find(line => line.startsWith("data: ")
    && line.includes('"type":"response.output_item.done"')
    && line.includes('"phase":"final_answer"'));
  expect(output).toBeDefined();
  expect(JSON.parse(output!.slice(6)).item.content[0].text).toBe(finalLine);
  expect(body.match(/event: response.completed/g)).toHaveLength(1);
  expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
  expect(chunks.at(-1)).toContain("event: response.completed");
  expect(chunks.at(-1)).toContain("data: [DONE]\n\n");
  expect(cancelled).toBe(0);
});

test("terminal diagnostic callback failure cannot swallow a final answer", async () => {
  async function* completed(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "Final message.", phase: "final_answer" };
    yield { type: "done", stopReason: "stop", endTurn: true };
  }
  const body = await new Response(bridgeToResponsesSSE(completed(), "chatgpt-web/test",
    undefined, undefined, undefined, undefined, 2000, {
      streamPlatform: "win32",
      onTerminal: () => { throw new Error("diagnostic callback failure"); },
    })).text();
  expect(body).toContain("Final message.");
  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});


test("large terminal frame is fragmented on Windows but its exact final answer and DONE reach the lifecycle tee", async () => {
  const finalAnswer = "Start\\n" + "🌟".repeat(85_000) + "\\nEND FINAL LINE";
  let canceled = 0;
  async function* completed(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: finalAnswer, phase: "final_answer" };
    yield { type: "done", stopReason: "stop", endTurn: true };
  }
  const original = bridgeToResponsesSSE(completed(), "chatgpt-web/test",
    undefined, undefined, undefined, () => { canceled++; }, 2_000,
    { streamPlatform: "win32" });
  const [httpBody, observerBody] = original.tee();
  const observer = new HttpSseTerminalObserver();
  const observedChunks: Uint8Array[] = [];
  const observerPromise = (async () => {
    const reader = observerBody.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      observedChunks.push(next.value);
      observer.observe(next.value);
    }
  })();
  const httpBytes = await new Response(httpBody).arrayBuffer();
  await observerPromise;
  const httpText = new TextDecoder().decode(httpBytes);
  const observedText = new TextDecoder().decode(
    Buffer.concat(observedChunks.map(chunk => Buffer.from(chunk))),
  );
  expect(httpText).toBe(observedText);
  expect(observedText).toContain("END FINAL LINE");
  expect(observedText).toEndWith("data: [DONE]\\n\\n".replaceAll("\\n", "\n"));
  expect(observer.snapshot()).toEqual({ terminal: "completed", done: true });
  const completedAt = observedChunks.findIndex(chunk =>
    new TextDecoder().decode(chunk).includes("event: response.completed"));
  expect(completedAt).toBeGreaterThanOrEqual(0);
  expect(observedChunks.length - completedAt).toBeGreaterThan(2);
  for (const chunk of observedChunks.slice(completedAt)) {
    expect(chunk.byteLength).toBeLessThanOrEqual(32 * 1024);
  }
  // The final byte chunk carries the DONE marker rather than splitting it
  // across two tear-down-sensitive native HTTP writes.
  expect(new TextDecoder().decode(observedChunks.at(-1))).toEndWith("data: [DONE]\\n\\n".replaceAll("\\n", "\n"));
  expect(canceled).toBe(0);
});

test("large Windows SSE terminal passes through Bun.serve without losing DONE", async () => {
  const text = "Large final" + "🏁".repeat(82_000) + "\\nFinal sentence survived.";
  async function* completed(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text, phase: "final_answer" };
    yield { type: "done", stopReason: "stop", endTurn: true };
  }
  const server = Bun.serve({
    port: 0,
    fetch() {
      const body = bridgeToResponsesSSE(completed(), "chatgpt-web/test",
        undefined, undefined, undefined, undefined, 2_000, { streamPlatform: "win32" });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Final sentence survived.");
    expect(body).toContain("event: response.completed");
    expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(body).toEndWith("data: [DONE]\\n\\n".replaceAll("\\n", "\n"));
  } finally {
    await server.stop(true);
  }
});
