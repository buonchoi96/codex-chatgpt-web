import { expect, test } from "bun:test";
import { ChatGptAgentSessionGraph } from "../src/adapters/chatgpt-web/agent-session-graph";

test("agent session graph links references only when unambiguous", () => {
  const graph = new ChatGptAgentSessionGraph();
  graph.linkReference("root", "/root/worker");
  graph.link("root", "child");
  expect(graph.resolveReference("root", "/root/worker")).toBe("child");
  expect(graph.resolveReference("root", "worker")).toBe("child");
});

test("agent session graph retires a descendant tree without guessing ambiguous references", () => {
  const graph = new ChatGptAgentSessionGraph();
  graph.link("root", "child-a");
  graph.link("root", "child-b");
  graph.linkReference("root", "/root/worker");
  expect(graph.resolveReference("root", "/root/worker")).toBeUndefined();
  graph.link("child-a", "grandchild");
  expect(graph.descendants("child-a")).toEqual(["child-a", "grandchild"]);
  graph.forget(["child-a", "grandchild"]);
  expect(graph.descendants("root")).toEqual(["root", "child-b"]);
});
