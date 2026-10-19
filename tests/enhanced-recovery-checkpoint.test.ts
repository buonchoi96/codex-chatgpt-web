import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexMessage, CodexParsedRequest } from "../src/types";
import {
  EnhancedRecoveryCheckpointStore,
} from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parsed(messages: CodexMessage[], overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    options: { reasoning: "high" },
    context: { messages },
    _chatgptModelFamily: "5.6",
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread-recovery",
          turn_id: "turn-current",
        }),
      },
    },
    ...overrides,
  } as CodexParsedRequest;
}

function completeHistory(task = "Preserve exact probe ASTRAL-KITE-381"): CodexMessage[] {
  return [
    { role: "developer", content: "Keep exact validation probes.", timestamp: 1 },
    { role: "user", content: task, timestamp: 2 },
    {
      role: "assistant",
      timestamp: 3,
      content: [{ type: "toolCall", id: "call-1", name: "inspect", arguments: { path: "repo" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "inspect",
      content: "verified result 167284",
      isError: false,
      timestamp: 4,
    },
  ];
}

test("durable recovery checkpoint applies only to its exact canonical prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const source = parsed(completeHistory());
  const store = new EnhancedRecoveryCheckpointStore(path);

  expect(store.shouldCheckpoint(source, 1)).toBe(true);
  store.commit(source, [
    "Objective: continue the exact task.",
    "Evidence: ASTRAL-KITE-381 and 167284 were verified.",
    "Pending: finish remaining validation.",
  ].join("\n"));

  const applied = new EnhancedRecoveryCheckpointStore(path).apply(source);
  expect(applied.applied).toBe(true);
  expect(applied.parsed.context.messages.some(message => (
    message.role === "assistant"
    && message.content.some(part => part.type === "text"
      && part.text.includes("[Enhanced passive recovery checkpoint]")
      && part.text.includes("ASTRAL-KITE-381")
      && part.text.includes("167284"))
  ))).toBe(true);
  expect(applied.parsed.context.messages.some(message => message.role === "toolResult")).toBe(false);
  expect(applied.parsed.context.messages.some(message => (
    message.role === "user" && typeof message.content === "string"
    && message.content.includes("ASTRAL-KITE-381")
  ))).toBe(true);

  const tampered = parsed(completeHistory("Changed canonical user instruction"));
  const rejected = new EnhancedRecoveryCheckpointStore(path).apply(tampered);
  expect(rejected.applied).toBe(false);
  expect(rejected.reason).toContain("prefix mismatch");

  const wrongModel = parsed(completeHistory(), { modelId: "gpt-6-sol" });
  const modelRejected = new EnhancedRecoveryCheckpointStore(path).apply(wrongModel);
  expect(modelRejected.applied).toBe(false);
  expect(modelRejected.reason).toContain("model identity mismatch");
});

test("large canonical history cannot be downgraded from ZIP transport by passive recovery checkpointing", () => {
  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-archive-"));
  roots.push(root);
  const store = new EnhancedRecoveryCheckpointStore(join(root, "checkpoints.json"));
  const source = parsed([
    { role: "developer", content: "Keep the complete canonical evidence.", timestamp: 1 },
    { role: "user", content: "Continue the current long-running task.", timestamp: 2 },
    {
      role: "assistant",
      timestamp: 3,
      content: [{ type: "toolCall", id: "call-large", name: "inspect", arguments: { path: "repo" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-large",
      toolName: "inspect",
      content: "x".repeat(900_000),
      isError: false,
      timestamp: 4,
    },
  ]);
  store.commit(source, "Objective: continue.\nState: verified large evidence.\nPending: continue.");
  const checkpointed = store.apply(source);
  expect(checkpointed.applied).toBeTrue();

  const capabilities = {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
  };
  const turnToken = "turn_12345678901234567890123456789012";
  // The Web account cannot cold-transport this full canonical tool transcript.
  // A checksum-bound checkpoint is the only permitted reduced bootstrap.
  expect(() => compileChatGptWebPrompt(source, capabilities, turnToken))
    .toThrow(/canonical context requires/);
  const reduced = compileChatGptWebPrompt(checkpointed.parsed, capabilities, turnToken);
  expect(reduced.transportDecision?.choice).not.toBe("BLOCK");

  const adapterSource = require("node:fs").readFileSync("src/adapters/chatgpt-web/index.ts", "utf8");
  expect(adapterSource).toContain("enhancedRecoveryCheckpointStore.apply(parsed)");
  expect(adapterSource).toContain("prepare: () => prepareWith(checkpointInput.parsed)");
  expect(adapterSource).toContain("enhancedRecoveryCheckpointStore.checkpointAdmission(");

});

test("recovery checkpoint is never created across an incomplete tool boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-"));
  roots.push(root);
  const store = new EnhancedRecoveryCheckpointStore(join(root, "checkpoints.json"));
  const incomplete = parsed([
    { role: "user", content: "Do the task.", timestamp: 1 },
    {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call-pending", name: "mutate", arguments: {} }],
    },
  ]);
  expect(store.shouldCheckpoint(incomplete, 1)).toBe(false);
  expect(() => store.commit(incomplete, "This must not persist."))
    .toThrow("complete canonical tool-result boundary");
});

test("recovery and compaction one-shot control tokens cannot be cross-used", async () => {
  const transactions = new CompactionTransactionStore();
  const committed: string[] = [];
  const recovery = transactions.begin("trace_recovery", 30_000, summary => committed.push(summary));

  expect(() => transactions.submit(
    recovery.token,
    recovery.handoffId,
    "checkpoint",
    "compaction",
  )).toThrow("does not match");
  expect(committed).toEqual([]);

  transactions.submit(recovery.token, recovery.handoffId, " checkpoint ", "recovery");
  expect(committed).toEqual(["checkpoint"]);
  await expect(transactions.wait(recovery.token)).resolves.toBe("checkpoint");

  const compaction = transactions.begin("trace_compaction", 30_000);
  expect(() => transactions.submit(
    compaction.token,
    compaction.handoffId,
    "summary",
    "recovery",
  )).toThrow("does not match");
  transactions.abort(compaction.token);
});


test("passive recovery checkpoint remains asynchronous after tool-result delivery", () => {
  const source = require("node:fs").readFileSync("src/adapters/chatgpt-web/index.ts", "utf8");
  expect(source).toContain("void structuredBroker.waitForCompactionHandoff(ticket.token).then(");
  expect(source).toContain("enhancedRecoveryCheckpointStore.checkpointAdmission(");
  expect(source).toContain("enhancedRecoveryCheckpointStore.commit(parsed, summary)");
  expect(source).toContain("passiveRecoveryCheckpointInstruction(checkpoint)");
  expect(source).not.toContain("await structuredBroker.waitForCompactionHandoff(ticket.token)");
});

test("subagent Sol follow-up preparation requests passive checkpoint before 71K Web limit",()=>{
  const root=mkdtempSync(join(tmpdir(),"checkpoint-subagent-"));
  roots.push(root);
  const store=new EnhancedRecoveryCheckpointStore(join(root,"recovery.json"));
  const all=completeHistory();
  all[3]!.content = Array.from({length:21_000},(_,n)=>"p"+n.toString(36).padStart(6,"0")).join(" ");
  const source=parsed(all,{modelId:"gpt-6-sol",_chatgptModelFamily:"6"});
  const admission=store.checkpointAdmission(source);
  expect(admission.due).toBe(true);
  expect(admission.reason).toBe("ready");
  expect(admission.prefixLength).toBe(0);
  expect(admission.canonicalTokens).toBeGreaterThan(0);
  store.commit(source,"Persisted verification of completed tool call; continue pending follow-up.");
  const withFollowup=parsed([...all,{role:"user",content:"New subagent follow-up",timestamp:5}],
    {modelId:"gpt-6-sol",_chatgptModelFamily:"6"});
  const recovered=store.apply(withFollowup);
  expect(recovered.applied).toBe(true);
  expect(recovered.parsed.context.messages.find(x=>x.role==="user"&&x.content==="New subagent follow-up")).toBeDefined();
  expect(recovered.parsed.context.messages.some(x=>x.role==="toolResult")).toBe(false);
});

test("unmatched in-flight tool calls never become an authenticated recovery boundary",()=>{
  const root=mkdtempSync(join(tmpdir(),"checkpoint-unmatched-"));
  roots.push(root);
  const store=new EnhancedRecoveryCheckpointStore(join(root,"recovery.json"));
  const source=parsed([{role:"user",content:"Task",timestamp:1},
    {role:"assistant",timestamp:2,content:[{type:"toolCall",id:"call_1",name:"exec",arguments:{}}]},
    {role:"toolResult",toolCallId:"foreign",toolName:"exec",content:"large".repeat(20000),isError:false,timestamp:3}]);
  const admission=store.checkpointAdmission(source);
  expect(admission.due).toBe(false);
  expect(admission.reason).toBe("no_complete_tool_boundary");
});

test("out-of-order passive recovery handoffs preserve the most advanced checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-order-"));
  roots.push(root);
  const path = join(root, "recovery.json");
  const shorter = parsed(completeHistory());
  const longer = parsed([...completeHistory(),
    {role:"assistant",timestamp:5,content:[{type:"toolCall",id:"call-2",name:"inspect",arguments:{path:"more"}}]},
    {role:"toolResult",toolCallId:"call-2",toolName:"inspect",content:"evidence two",isError:false,timestamp:6},
    {role:"user",content:"Continue goal",timestamp:7},
  ]);
  const store = new EnhancedRecoveryCheckpointStore(path);
  // Later boundary resolves first, earlier handoff settles late.
  store.commit(longer, "Later evidence from call-2 has been inspected.");
  store.commit(shorter, "Earlier evidence from call-1 was inspected.");
  const followup = parsed([...longer.context.messages, {role:"user",content:"Next turn",timestamp:8}]);
  const applied = new EnhancedRecoveryCheckpointStore(path).apply(followup);
  expect(applied.applied).toBe(true);
  const rendered = JSON.stringify(applied.parsed.context.messages);
  expect(rendered).toContain("Later evidence from call-2");
  expect(rendered).not.toContain("Earlier evidence from call-1");
  expect(rendered).toContain("Next turn");
  expect(store.checkpointAdmission(followup).prefixLength).toBe(6);
});

test("divergent /goal histories on one thread retain separate authenticated prefixes", () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-branches-"));
  roots.push(root);
  const path = join(root, "recovery.json");
  const branchA = parsed(completeHistory("Branch A exact instruction"));
  const branchB = parsed(completeHistory("Branch B exact instruction"));
  const store = new EnhancedRecoveryCheckpointStore(path);
  store.commit(branchA, "Observed only branch A");
  store.commit(branchB, "Observed only branch B");
  const loaded = new EnhancedRecoveryCheckpointStore(path);
  const selectedA = loaded.apply(parsed([...branchA.context.messages,
    {role:"user",content:"Continue A",timestamp:5}]));
  const selectedB = loaded.apply(parsed([...branchB.context.messages,
    {role:"user",content:"Continue B",timestamp:5}]));
  expect(selectedA.applied).toBe(true);
  expect(selectedB.applied).toBe(true);
  expect(JSON.stringify(selectedA.parsed.context.messages)).toContain("Observed only branch A");
  expect(JSON.stringify(selectedB.parsed.context.messages)).toContain("Observed only branch B");
  expect(JSON.stringify(selectedA.parsed.context.messages)).not.toContain("Observed only branch B");
  const changed = parsed(completeHistory("Foreign branch instruction"));
  expect(loaded.apply(changed).reason).toContain("parsed_prefix_changed");
});

test("a wrong-model recovery checkpoint remains unavailable after adding multiple candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-identity-"));
  roots.push(root);
  const path = join(root, "recovery.json");
  const store = new EnhancedRecoveryCheckpointStore(path);
  store.commit(parsed(completeHistory()), "Verified only for model 5.6.");
  store.commit(parsed(completeHistory("Other branch")), "Other canonical branch.");
  expect(new EnhancedRecoveryCheckpointStore(path).apply(
    parsed(completeHistory(), {modelId:"gpt-6-sol",_chatgptModelFamily:"6"}),
  ).reason).toContain("model identity mismatch");
});
