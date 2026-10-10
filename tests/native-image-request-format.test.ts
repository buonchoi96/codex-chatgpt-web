import { expect, test } from "bun:test";
import { requestedNativeScreenshotFormat } from "../src/adapters/chatgpt-web/mcp-server";

test("capture intent keeps the exact requested PNG/JPEG encoding for relay diagnostics", () => {
  expect(requestedNativeScreenshotFormat("mcp__swift__game_observe", { session: "s", format: "jpeg", jpeg_quality: 80 })).toBe("jpeg");
  expect(requestedNativeScreenshotFormat("mcp__swift__desktop_observe", { session: "s", scale: 0.5 })).toBe("png");
  expect(requestedNativeScreenshotFormat("game.observe", { session: "s", format: "jpeg" })).toBe("jpeg");
  expect(requestedNativeScreenshotFormat("mcp__swift__game_execute_and_observe", { observation: { format: "jpeg", jpeg_quality: 80 } })).toBe("jpeg");
  expect(requestedNativeScreenshotFormat("mcp__swift__desktop_execute_and_observe", { observation: {} })).toBe("png");
  expect(requestedNativeScreenshotFormat("mcp__swift__game_execute_and_observe", { steps: [] })).toBeUndefined();
  expect(requestedNativeScreenshotFormat("mcp__swift__game_detach", { format: "jpeg" })).toBeUndefined();
  expect(requestedNativeScreenshotFormat("mcp__swift__game_observe", { format: "bmp" })).toBeUndefined();
});
