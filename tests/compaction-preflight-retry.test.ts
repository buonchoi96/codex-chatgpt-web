import { expect, test } from "bun:test";
import { exceedsChatGptCompactionPreflightBudget } from "../src/adapters/chatgpt-web/prompt";

const measured = {
  canonicalTokens: 109_936,
  accountCanonicalTokenLimit: 71_808,
  messageTokens: 109_936,
  messageTokenLimit: 81_807,
  composerChars: 64,
  composerCharLimit: 100_000,
};

test("retry compaction cannot treat a byte-small prompt as transportable when canonical tokens exceed the account budget", () => {
  expect(exceedsChatGptCompactionPreflightBudget("small request", measured, false)).toBe(true);
  expect(exceedsChatGptCompactionPreflightBudget("small request", measured, true)).toBe(true);
});

test("inline compaction enforces its per-message token ceiling independently of canonical fit", () => {
  const tokenOnly = { ...measured, canonicalTokens: 50_000, messageTokens: 82_000 };
  expect(exceedsChatGptCompactionPreflightBudget("small request", tokenOnly, false)).toBe(true);
  // Verified multipart can stage records across several messages when canonical fits.
  expect(exceedsChatGptCompactionPreflightBudget("small request", tokenOnly, true)).toBe(false);
});

test("multipart is exempt from legacy inline byte and composer limits, not canonical budget", () => {
  const fits = { ...measured, canonicalTokens: 50_000, messageTokens: 50_000, composerChars: 120_000 };
  expect(exceedsChatGptCompactionPreflightBudget("x".repeat(120_000), fits, false)).toBe(true);
  expect(exceedsChatGptCompactionPreflightBudget("x".repeat(120_000), fits, true)).toBe(false);
});

test("preflight fails closed if verified transport measurements are missing", () => {
  expect(exceedsChatGptCompactionPreflightBudget("small", undefined, false)).toBe(true);
  expect(exceedsChatGptCompactionPreflightBudget("small", undefined, true)).toBe(true);
});
