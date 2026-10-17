import { expect, test } from "bun:test";
import { ChatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";

test("launcher cancel-all terminalizes the same native /goal execution without blocking a new turn", async () => {
  const sessions = new ChatGptTurnSessions();
  let starts = 0;
  const runtime = () => {
    starts += 1;
    let abort!: (reason: Error) => void;
    const browser = new Promise<string>((_resolve, reject) => { abort = reject; });
    return {
      mode: "read-only" as const,
      browser,
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: (reason?: Error) => abort(reason ?? new Error("cancelled")),
    };
  };
  const old = sessions.getOrCreate("old-native-execution", runtime, "same-trace", "goal-owner");
  const reason = new Error("Active turn cancelled by launcher");
  expect(sessions.cancelAllForLauncher(reason)).toBe(1);
  expect(sessions.cancelAllForLauncher(reason)).toBe(0);
  expect(await old.browserOutcome).toMatchObject({ type: "error" });
  expect(() => sessions.getOrCreate("old-native-execution", runtime)).toThrow("Active turn cancelled by launcher");
  await expect(sessions.getOrCreateAfterOwnerRetirement(
    "old-native-execution", "goal-owner", runtime,
  )).rejects.toThrow("Active turn cancelled by launcher");
  expect(starts).toBe(1);
  // A new native task, not a replay of the cancelled request, can proceed.
  sessions.getOrCreate("new-native-execution", runtime, "new-trace", "goal-owner");
  expect(starts).toBe(2);
  sessions.clear();
});
