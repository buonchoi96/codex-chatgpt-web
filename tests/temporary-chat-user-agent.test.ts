import { expect, test } from "bun:test";
import { androidTemporaryChatUserAgentForVersion, resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";

test("issue #864 Android User-Agent uses the actual managed Chromium version", () => {
  expect(androidTemporaryChatUserAgentForVersion("142.0.7123.45")).toBe(
    "Mozilla/5.0 (Linux; Android 13; SM-A235F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7123.45 Mobile Safari/537.36",
  );
  for (const invalid of ["", "142", "Chrome/142.0.0.0", "142.0.0.0 Windows", "142.0.0.0\\nHeader: injected"]) {
    expect(() => androidTemporaryChatUserAgentForVersion(invalid)).toThrow();
  }
});

test("issue #864 UA workaround is explicit opt-in and preserves Saved Chat selection", () => {
  const provider = (chatgptWeb: Record<string, unknown>) => ({
    adapter: "chatgpt-web", baseUrl: "browser://issue864", chatgptWeb,
  }) as Parameters<typeof resolveBrowserConfig>[0];
  expect(resolveBrowserConfig(provider({ useSavedChats: false })).temporaryChatAndroidUserAgent).toBe(false);
  const temporary = resolveBrowserConfig(provider({ useSavedChats: false, temporaryChatAndroidUserAgent: true }));
  expect(temporary.useSavedChats).toBe(false);
  expect(temporary.temporaryChatAndroidUserAgent).toBe(true);
  const saved = resolveBrowserConfig(provider({ useSavedChats: true, temporaryChatAndroidUserAgent: true }));
  expect(saved.useSavedChats).toBe(true);
  expect(saved.temporaryChatAndroidUserAgent).toBe(true);
  expect(() => resolveBrowserConfig(provider({ temporaryChatAndroidUserAgent: "true" }))).toThrow("must be a boolean");
});

// The existing connector-preflight tests remain authoritative: Android UA alone
// must never count as evidence that Personalized or Codex Native2 is selectable.
