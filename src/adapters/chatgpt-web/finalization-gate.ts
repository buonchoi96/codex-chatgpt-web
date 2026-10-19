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

import type { AdapterEvent } from "../../types";

/**
 * The browser's completed answer and the native Responses event journal are
 * separate durability boundaries. A drained ChatGptTextFeed is not proof that
 * its final suffix entered the event journal. Do not send response.completed
 * until the full, ordered final answer has been journaled.
 *
 * Divergence is a terminal integrity error: a mismatching prefix cannot be
 * repaired by duplicating or rewriting earlier stream content.
 */
export function pendingJournaledFinalAnswerSuffix(
  events: readonly AdapterEvent[],
  completedAnswer: string,
): string {
  const recorded = events.flatMap(event => event.type === "text_delta"
    && event.phase === "final_answer" ? [event.text] : []).join("");
  if (!completedAnswer.startsWith(recorded)) {
    throw new ChatGptWebAdapterError(
      "ChatGPT final-answer event journal diverged from the completed browser answer",
      { status: 502, errorType: "server_error", code: "browser_stream_inconsistent", retryable: false },
    );
  }
  return completedAnswer.slice(recorded.length);
}
