import { ChatGptWebAdapterError } from "./adapter-error";

/**
 * The final native result must never be marked complete while its tool
 * capability has an unresolved retirement. A bounded failure is preferable
 * to an indefinitely open Responses SSE stream, but no completed tool may be
 * replayed: the caller's existing failure journal remains authoritative.
 */
export async function awaitFinalBrokerRetirement(
  retire: () => Promise<void> | void,
  timeoutMs = 20_000,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid broker retirement deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(retire),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptWebAdapterError(
          "ChatGPT Web finished, but the final broker retirement was not acknowledged before its deadline. No Codex tool call was replayed.",
          { status: 409, errorType: "server_error", code: "final_broker_retirement_timeout", retryable: false },
        )), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
