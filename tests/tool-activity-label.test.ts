import { expect, test } from "bun:test";
import { swiftToolActivityTitle } from "../src/adapters/chatgpt-web/tool-activity-label";

test("Swift activity labels are extracted from direct and native wrapper calls", () => {
  const nested = { wireName: "codex_tool_call", arguments: {
    wire_name: "mcp__computer_use_swift__game.execute_and_observe",
    arguments: { session: "uuid", title: "Observe character movement after pressing W" },
  } };
  expect(swiftToolActivityTitle(nested)).toBe("Observe character movement after pressing W");
  expect(swiftToolActivityTitle({wireName:"mcp__computer_use_swift__desktop.observe",
    arguments:{title:"Close menu and view editor screen"}})).toBe("Close menu and view editor screen");
  expect(nested.arguments.arguments.title).toBe("Observe character movement after pressing W");
});

test("No title display from non-Swift, invalid, or unsafe-looking activity", () => {
  expect(swiftToolActivityTitle({wireName:"codex_exec",arguments:{title:"Run a secret"}})).toBeUndefined();
  expect(swiftToolActivityTitle({wireName:"codex_tool_call",arguments:{
    wire_name:"mcp__some_other_tool__observe",arguments:{title:"Other"}}})).toBeUndefined();
  expect(swiftToolActivityTitle({wireName:"mcp__computer_use_swift__game.observe",
    arguments:{title:"bad\nsecond line"}})).toBeUndefined();
  expect(swiftToolActivityTitle({wireName:"mcp__computer_use_swift__game.observe",
    arguments:{title:"x".repeat(121)}})).toBeUndefined();
  expect(swiftToolActivityTitle({wireName:"mcp__computer_use_swift__game.observe",
    arguments:{title:" "}})).toBeUndefined();
});
