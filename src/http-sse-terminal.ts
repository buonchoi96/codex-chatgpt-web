/** Bounded, content-free inspection of the server-side SSE lifecycle tee.
 * An observed terminal proves only that Bun's tee branch drained; it is NOT a
 * native Codex consumption acknowledgement or permission to replay a turn. */
export type HttpSseTerminalStatus = "completed" | "incomplete" | "failed";

export class HttpSseTerminalObserver {
  private tail = "";
  private terminal: HttpSseTerminalStatus | undefined;
  private done = false;

  observe(bytes: Uint8Array): void {
    const text = this.tail + new TextDecoder().decode(bytes);
    const terminal = /(?:^|\n)event: response\.(completed|incomplete|failed)\r?\n/.exec(text);
    if (terminal) this.terminal = terminal[1] as HttpSseTerminalStatus;
    if (/(?:^|\n)data: \[DONE\]\r?\n/.test(text)) this.done = true;
    this.tail = text.slice(-96);
  }

  snapshot(): { terminal: HttpSseTerminalStatus | null; done: boolean } {
    return { terminal: this.terminal ?? null, done: this.done };
  }
}
