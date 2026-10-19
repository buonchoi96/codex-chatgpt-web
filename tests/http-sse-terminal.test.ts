import { expect, test } from "bun:test";
import { HttpSseTerminalObserver } from "../src/http-sse-terminal";

test("bounded HTTP tee inspector finds a split completed plus DONE tail", () => {
  const observer = new HttpSseTerminalObserver();
  const payload = new TextEncoder().encode(
    'event: response.output_item.done\ndata: {"type":"message"}\n\n'
    + 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
    + 'data: [DONE]\n\n',
  );
  for (let i = 0; i < payload.length; i += 7) observer.observe(payload.slice(i, i + 7));
  expect(observer.snapshot()).toEqual({ terminal: "completed", done: true });
});

test("HTTP tee inspection distinguishes incomplete and absent terminal, without inventing an ACK", () => {
  const partial = new HttpSseTerminalObserver();
  partial.observe(new TextEncoder().encode("event: response.incomplete\n"));
  expect(partial.snapshot()).toEqual({ terminal: "incomplete", done: false });
  const silent = new HttpSseTerminalObserver();
  silent.observe(new TextEncoder().encode("event: response.output_text.delta\n"));
  expect(silent.snapshot()).toEqual({ terminal: null, done: false });
});
