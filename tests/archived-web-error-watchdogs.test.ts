import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import {
  CHATGPT_HARD_NETWORK_ERROR_PATTERN,
  CHATGPT_INTERRUPTED_NETWORK_PATTERN,
  CHATGPT_MESSAGE_DELIVERY_TIMEOUT_PATTERN,
  chatGptHardNetworkErrorVisible,
  chatGptInterruptedNetworkVisible,
  chatGptMessageDeliveryTimeoutVisible,
  chatGptPageRetryErrorVisible,
} from "../src/adapters/chatgpt-web/browser-worker";

type BannerKind = "status" | "alert" | "plain" | "transcript";
function bannerPage(text: string, kind: BannerKind, retry = false): Page {
  return {
    locator(selector: string) {
      const isPlainExact = selector.startsWith('text="')
        && selector.slice(6, -1) === text;
      // Plain fallback is intentionally only tested as the banner displayed
      // outside an owned response. The caller still requires active turn ownership.
      let matches = isPlainExact && kind === "plain"
        || selector.startsWith('[role="status"],') && (kind === "status" || kind === "alert")
        || selector.startsWith('[role="alert"],') && kind === "alert"
        || selector === '[role="alert"]' && kind === "alert";
      const locator = {
        filter(condition: { hasText?: RegExp; visible?: boolean }) {
          if (condition.hasText && !condition.hasText.test(text)) matches = false;
          return locator;
        },
        last() { return locator; },
        count: async () => matches ? 1 : 0,
        isVisible: async () => matches,
        getByRole(role: string, options: { name: string }) {
          matches = matches && role === "button" && options.name === "Retry" && retry;
          return locator;
        },
      };
      return locator;
    },
  } as unknown as Page;
}

test("archived connection-interrupted variants use the existing soft watchdog", async () => {
  for (const label of [
    "Connecting interrupted. Waiting for complete answer",
    "Connection interrupted. Waiting for final answer.",
    "Connectiong interrupted. Waiting for final answer ...",
    "Network interrupted. Waiting for final answer",
    "Interrupted network. Waiting for the final answer.",
    "Interrupted network. Waiting for final answer…",
  ]) {
    expect(CHATGPT_INTERRUPTED_NETWORK_PATTERN.test(label)).toBe(true);
    expect(await chatGptInterruptedNetworkVisible(bannerPage(label, "status"))).toBe(true);
    expect(await chatGptHardNetworkErrorVisible(bannerPage(label, "status"))).toBe(false);
    expect(await chatGptInterruptedNetworkVisible(bannerPage(label, "transcript"))).toBe(false);
  }
  expect(CHATGPT_INTERRUPTED_NETWORK_PATTERN.test(
    "Connection interrupted. Waiting for final answer soon (quoted)")).toBe(false);
});

test("both message-delivery red banners arm the existing short watchdog", async () => {
  for (const label of [
    "Message delivery timed out. Please try again.",
    "Message delivery failed. Please try again.",
  ]) {
    expect(CHATGPT_MESSAGE_DELIVERY_TIMEOUT_PATTERN.test(label)).toBe(true);
    expect(await chatGptMessageDeliveryTimeoutVisible(bannerPage(label, "alert"))).toBe(true);
    expect(await chatGptMessageDeliveryTimeoutVisible(bannerPage(label, "plain"))).toBe(true);
  }
});

test("hard red network errors and scoped red Retry are observed but never clicked", async () => {
  for (const label of [
    "Network error",
    "A network error occurred. Please check your connection and try again.",
  ]) {
    expect(CHATGPT_HARD_NETWORK_ERROR_PATTERN.test(label)).toBe(true);
    expect(await chatGptHardNetworkErrorVisible(bannerPage(label, "alert"))).toBe(true);
    expect(await chatGptHardNetworkErrorVisible(bannerPage(label, "transcript"))).toBe(false);
    expect(await chatGptInterruptedNetworkVisible(bannerPage(label, "alert"))).toBe(false);
  }
  expect(await chatGptPageRetryErrorVisible(bannerPage("Failure", "alert", true))).toBe(true);
  expect(await chatGptPageRetryErrorVisible(bannerPage("Failure", "alert", false))).toBe(false);
  expect(await chatGptPageRetryErrorVisible(bannerPage("Failure", "transcript", true))).toBe(false);
});

test("recovery watchdog includes restored archive labels in the original and fresh Stop observations", () => {
  const source = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  expect(source.match(/await chatGptHardNetworkErrorVisible\(page\)/g)?.length).toBe(2);
  expect(source.match(/await chatGptPageRetryErrorVisible\(page\)/g)?.length).toBe(2);
  expect(source.match(/await chatGptInterruptedNetworkVisible\(page\)/g)?.length).toBe(2);
  expect(source).toContain("const verifiedStall = freshRecoveryStall(");
  expect(source).toContain("recoverSameTab(stallError)");
  // No automatic click of a Retry action is authorized by the banner alone.
  expect(source).not.toContain("chatGptNetworkErrorRetryButton(page)");
});
