import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, isWindowsPipeEndpoint } from "../src/config";

test.skipIf(process.platform === "win32")("closing a rejected broker leaves the live socket reachable", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-owner-"));
  const endpoint = join(root, "broker.sock");
  const server = createServer(socket => {
    socket.once("data", bytes => {
      const request = JSON.parse(bytes.toString().trim());
      socket.end(JSON.stringify({ id: request.id, result: { ready: true } }) + "\n");
    });
  });
  const contender = TurnBroker.forSocket(endpoint);
  try {
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    chmodSync(endpoint, 0o600);
    await expect(contender.listen()).rejects.toThrow("already owned by another process");
    await contender.close();
    await contender.close();
    expect(existsSync(endpoint)).toBeTrue();
    expect(await callTurnBroker<{ ready: boolean }>(endpoint, { method: "owner_status" })).toEqual({ ready: true });
  } finally {
    await contender.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("a broker whose endpoint was busy at startup recovers once it is released", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retry-"));
  const endpoint = join(root, "broker.sock");
  const previousOwner = createServer(socket => socket.destroy());
  const broker = TurnBroker.forSocket(endpoint);
  try {
    await new Promise<void>(resolve => previousOwner.listen(endpoint, resolve));
    chmodSync(endpoint, 0o600);
    // The daemon only logs this startup failure and keeps serving; later turns must not inherit it.
    await expect(broker.listen()).rejects.toThrow("already owned by another process");
    await new Promise<void>(resolve => previousOwner.close(() => resolve()));
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    await expect(callTurnBroker<{ bindingId: string }>(endpoint, { method: "claim", token }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    if (previousOwner.listening) await new Promise<void>(resolve => previousOwner.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit browser-turn cancellation aborts and removes every registered session", async () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const replayable = sessions.getOrCreate("turn-a", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));
  await replayable.browserOutcome;
  sessions.getOrCreate("turn-b", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  expect(sessions.activeCount()).toBe(1);
  expect(sessions.clear()).toBe(2);
  expect(cancelled).toBe(2);
  expect(sessions.activeCount()).toBe(0);
});

test("targeted tab cancellation settles one trace and keeps a terminal replay tombstone", async () => {
  const sessions = new ChatGptTurnSessions();
  let rejectTarget!: (error: Error) => void;
  let targetCancelled = 0;
  let otherCancelled = 0;
  const target = sessions.getOrCreate("target", () => ({
    mode: "read-only",
    browser: new Promise<string>((_resolve, reject) => { rejectTarget = reject; }),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {
      targetCancelled += 1;
      rejectTarget(new Error("browser tab closed by user"));
    },
  }), "trace_target");
  sessions.getOrCreate("other", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { otherCancelled += 1; },
  }), "trace_other");

  expect(await sessions.cancelTrace("trace_target")).toBe(1);
  expect(targetCancelled).toBe(1);
  expect(otherCancelled).toBe(0);
  expect(target.settledOutcome()).toMatchObject({ type: "error" });
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("target", () => {
    throw new Error("a cancelled continuation must not open a new browser tab");
  }, "trace_target")).toBe(target);
  expect(await sessions.cancelTrace("trace_target")).toBe(0);
  sessions.clear();
});

test("native interruption retires only the exact browser turn identity", async () => {
  const sessions = new ChatGptTurnSessions();
  const cancelled: string[] = [];
  const runtime = (name: string) => {
    let rejectBrowser!: (error: Error) => void;
    const browser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
    return {
      mode: "read-only" as const,
      browser,
      physicalSettlement: browser.then(() => undefined, () => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: (reason?: Error) => {
        cancelled.push(name);
        rejectBrowser(reason ?? new Error("cancelled"));
      },
    };
  };
  sessions.getOrCreate(
    "target",
    () => runtime("target"),
    "trace_target",
    "owner_target",
    "turn_shared",
    "thread_target",
  );
  sessions.getOrCreate(
    "other-thread",
    () => runtime("other-thread"),
    "trace_other",
    "owner_other",
    "turn_shared",
    "thread_other",
  );

  const cancellation = sessions.cancelNativeTurn(
    "thread_target",
    "turn_shared",
    new DOMException("Codex turn interrupted", "AbortError"),
  );
  expect(cancellation.cancelled).toBe(1);
  await cancellation.settlement;
  expect(cancelled).toEqual(["target"]);
  expect(sessions.find("target")).toBeUndefined();
  expect(sessions.find("other-thread")?.nativeThreadId).toBe("thread_other");
  expect(sessions.activeCount()).toBe(1);
  sessions.clear();
});

test("session cache expiry never cancels a still-active long browser turn", async () => {
  const sessions = new ChatGptTurnSessions(1);
  let cancelled = 0;
  const active = sessions.getOrCreate("long-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  await Bun.sleep(5);
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("long-turn", () => {
    throw new Error("active session must be reused");
  })).toBe(active);
  expect(cancelled).toBe(0);
  sessions.clear();
});

test("five active turns coexist and a sixth fails closed", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  });

  const active = Array.from({ length: 5 }, (_unused, index) => (
    sessions.getOrCreate(`turn-${index + 1}`, runtime)
  ));
  expect(sessions.activeCount()).toBe(5);
  expect(cancelled).toBe(0);
  expect(() => sessions.getOrCreate("turn-6", runtime)).toThrow("at most 5 simultaneous browser turns");

  expect(sessions.getOrCreate("turn-3", () => {
    throw new Error("an in-flight turn must be reused");
  })).toBe(active[2]);
  expect(cancelled).toBe(0);
  sessions.clear();
  expect(cancelled).toBe(5);
});

test("settled replay sessions expire from their last use instead of their creation time", async () => {
  const sessions = new ChatGptTurnSessions(50);
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("done"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    };
  };
  const first = sessions.getOrCreate("replay", start);
  await first.browserOutcome;
  await Bun.sleep(10);
  expect(sessions.getOrCreate("replay", start)).toBe(first);
  await Bun.sleep(70);
  expect(sessions.getOrCreate("replay", start)).not.toBe(first);
  expect(starts).toBe(2);
  sessions.clear();
});

test("turn broker creates its private runtime directory on a cold start", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    if (process.platform === "win32") {
      expect(isWindowsPipeEndpoint(socketPath)).toBe(true);
    } else {
      expect(existsSync(socketPath)).toBe(true);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker rejects a Unix socket path that leaves no room for sun_path's NUL terminator", async () => {
  if (process.platform === "win32") return;
  const socketPath = `/tmp/${"x".repeat(99)}`;
  expect(Buffer.byteLength(socketPath)).toBe(104);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await expect(broker.listen()).rejects.toThrow("103-byte limit");
  } finally {
    await broker.close();
  }
});

test("turn broker tokens do not expire while their browser turn is still alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-unbounded-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    await Bun.sleep(5);
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker revokes only channels owned by the closed browser trace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-targeted-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const target = await broker.register(environment, 60_000, "trace_target");
    const other = await broker.register(environment, 60_000, "trace_other");
    expect(broker.revokeTrace("trace_target")).toBe(1);
    await expect(callTurnBroker(socketPath, { method: "claim", token: target }))
      .rejects.toThrow("already finished");
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token: other }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker account-safety cancellation aborts the matching DEV response and revokes only its trace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-bs-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const environment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [],
  };
  const targetTrace = "a1b2c3d4e5f6";
  const targetController = new AbortController();
  const otherController = new AbortController();
  try {
    const targetToken = await broker.register(environment, undefined, targetTrace, true);
    await broker.register(environment, undefined, "f6e5d4c3b2a1", true);
    broker.registerTraceAbortController(targetTrace, targetController);
    broker.registerTraceAbortController("f6e5d4c3b2a1", otherController);

    await expect(callTurnBroker<{
      cancelled_responses: number;
      revoked_turns: number;
    }>(socketPath, {
      method: "cancel_trace",
      traceId: targetTrace,
      reason: "account_security",
    })).resolves.toEqual({ cancelled_responses: 1, revoked_turns: 1 });

    expect(targetController.signal.aborted).toBe(true);
    expect(otherController.signal.aborted).toBe(false);
    expect(broker.externalOwnerActiveCount()).toBe(1);
    await expect(callTurnBroker(socketPath, { method: "claim", token: targetToken }))
      .rejects.toThrow(/already finished|invalid or expired/);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function unansweredBrokerEndpoint(name: string, onConnection: (socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), name));
  const socketPath = defaultBrokerEndpoint(root);
  if (!isWindowsPipeEndpoint(socketPath)) mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer(onConnection);
  return {
    socketPath,
    listen: () => new Promise<void>(ready => server.listen(socketPath, ready)),
    close: async () => {
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an unbounded broker call fails when the broker closes without answering", async () => {
  const broker = unansweredBrokerEndpoint("cgw-broker-closed-", socket => socket.on("data", () => socket.end()));
  await broker.listen();
  try {
    await expect(callTurnBroker(broker.socketPath, { method: "claim", token: "turn_closed" }, null))
      .rejects.toThrow("closed the connection");
  } finally {
    await broker.close();
  }
}, 10_000);

test("bounded broker calls preserve server-owned closure before advancing the lifecycle", async () => {
  let peer!: Socket;
  let finishFrame!: () => void;
  const frameWritten = new Promise<void>(resolve => { finishFrame = resolve; });
  const broker = unansweredBrokerEndpoint("cgw-broker-frame-", socket => {
    peer = socket;
    socket.once("data", chunk => {
      const request = JSON.parse(chunk.toString().trim());
      const frame = JSON.stringify({ id: request.id, result: { ready: true } }) + "\n";
      socket.write(frame.slice(0, -1));
      setImmediate(() => { socket.write(frame.slice(-1), finishFrame); });
    });
  });
  await broker.listen();
  try {
    let settled = false;
    const call = callTurnBroker(broker.socketPath, { method: "owner_status" }).then(result => {
      settled = true;
      return result;
    });
    await frameWritten;
    await Bun.sleep(25);
    expect(settled).toBeFalse();
    peer.destroy();
    await Bun.sleep(0);
    await expect(call).resolves.toEqual({ ready: true });
  } finally {
    peer?.destroy();
    await broker.close();
  }
});

test("broker frame settlement still rejects errors, wrong identities and incomplete replies", async () => {
  for (const [reply, expected] of [
    [(id: string) => JSON.stringify({ id, error: "claim rejected" }) + "\n", "claim rejected"],
    [() => '{"id":"another","result":true}\n', "response id mismatch"],
    [() => 'null\n', "invalid response frame"],
    [(id: string) => JSON.stringify({ id, result: true, error: "contradiction" }) + "\n", "invalid response frame"],
    [(id: string) => JSON.stringify({ id }), "closed the connection"],
    [() => '{broken}\n', "invalid JSON"],
  ] as const) {
    const broker = unansweredBrokerEndpoint("cgw-broker-reject-", socket => {
      socket.once("data", chunk => socket.end(reply(JSON.parse(chunk.toString().trim()).id)));
    });
    await broker.listen();
    try {
      await expect(callTurnBroker(broker.socketPath, { method: "owner_status" })).rejects.toThrow(expected);
    } finally { await broker.close(); }
  }
});

test("an unbounded broker call outlives the bounded default timeout", async () => {
  const accepted: Socket[] = [];
  const broker = unansweredBrokerEndpoint("cgw-broker-slow-", socket => { accepted.push(socket); });
  await broker.listen();
  try {
    const call = callTurnBroker(broker.socketPath, { method: "claim", token: "turn_unbounded" }, null);
    const outcome = await Promise.race([
      call.then(() => "settled", () => "settled"),
      Bun.sleep(5_300).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");
  } finally {
    for (const socket of accepted) socket.destroy();
    await broker.close();
  }
}, 15_000);

test("turn broker names the finished turn that owns a replayed handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 60_000, "turn-alpha");
    await expect(callTurnBroker(socketPath, { method: "claim", token: ` ${token}` }))
      .rejects.toThrow("turn token is invalid, expired, or revoked");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    broker.revoke(token);

    const rejection = async (request: Parameters<typeof callTurnBroker>[1]): Promise<string> => {
      try {
        await callTurnBroker(socketPath, request);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("turn broker accepted a handle it should have rejected");
    };

    const replayedBinding = await rejection({
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    });
    expect(replayedBinding).toContain("turn-alpha");
    expect(replayedBinding).toContain("has already finished");
    expect(replayedBinding).not.toContain("codex_bind_turn");

    const replayedToken = await rejection({ method: "claim", token });
    expect(replayedToken).toContain("turn-alpha");
    expect(replayedToken).toContain("can no longer run");
    expect(replayedToken).not.toContain("current task context");

    const unknownBinding = await rejection({
      method: "invoke",
      bindingId: "binding_never-issued",
      wireName: "exec_command",
    });
    expect(unknownBinding).toBe("internal Codex turn binding is invalid or expired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch guard rejects an MCP call before it is queued or delivered", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-bg-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const guardedTraceIds: string[] = [];
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, undefined, "guarded-trace");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    broker.setDispatchGuard(traceId => {
      guardedTraceIds.push(traceId);
      throw new Error("chatgpt_account_safety_stop");
    });

    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: "call_guarded_mcp_123456789",
      wireName: "exec_command",
      arguments: { cmd: "must not be queued" },
    }, null)).rejects.toThrow("chatgpt_account_safety_stop");
    expect(guardedTraceIds).toEqual(["guarded-trace"]);

    const abort = new AbortController();
    const nextBatch = broker.nextToolBatch(token, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(nextBatch).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("an undelivered timed-out invocation can be abandoned without retiring its turn binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-abandon-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const token = await broker.register(environment, undefined, "queued-timeout");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const callId = "call_queued_timeout_123456789";
    const pending = callTurnBroker<{ content: unknown[] }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId,
      wireName: "exec_command",
      arguments: { cmd: "echo never-delivered" },
    }, null);
    // Attach the rejection handler before cancel_invoke rejects the broker-side promise so Bun
    // never observes a transient unhandled rejection.
    const pendingOutcome = pending.then(
      () => ({ type: "value" as const }),
      error => ({ type: "error" as const, message: error instanceof Error ? error.message : String(error) }),
    );

    await Bun.sleep(25);
    expect(await callTurnBroker<{
      cancelled: boolean;
      delivered: boolean;
      pending: boolean;
      completed: boolean;
    }>(socketPath, {
      method: "cancel_invoke",
      bindingId: claimed.bindingId,
      callId,
    })).toEqual({ cancelled: true, delivered: false, pending: false, completed: false });
    expect(await pendingOutcome).toEqual({
      type: "error",
      message: "Codex Native invocation was abandoned before delivery",
    });

    const resolved = await callTurnBroker<{ environment: { cwd: string } }>(socketPath, {
      method: "resolve",
      bindingId: claimed.bindingId,
    });
    expect(resolved.environment.cwd).toBe(root);
    const replay = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    expect(replay.bindingId).toBe(claimed.bindingId);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a delivered invocation detaches at transport timeout and its result remains consumable", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-delivered-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, undefined, "delivered-timeout");
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(
      socketPath,
      { method: "claim", token },
    );
    const callId = "call_delivered_timeout_1234567";
    const pending = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId,
      wireName: "exec_command",
      arguments: { cmd: "echo delivered" },
    }, null);

    const batch = await broker.nextToolBatch(token);
    expect(batch.map(item => item.callId)).toEqual([callId]);
    expect(await callTurnBroker<{
      cancelled: boolean;
      delivered: boolean;
      pending: boolean;
      completed: boolean;
    }>(socketPath, {
      method: "cancel_invoke",
      bindingId: claimed.bindingId,
      callId,
    })).toEqual({ cancelled: false, delivered: true, pending: true, completed: false });

    type InvocationStatus = {
      state: string;
      delivered?: boolean;
      detached?: boolean;
      toolResult?: unknown;
    };
    expect(await callTurnBroker<InvocationStatus>(socketPath, {
      method: "invoke_status",
      bindingId: claimed.bindingId,
      callId,
    })).toEqual({ state: "running", delivered: true, detached: true });

    broker.completeTool(token, callId, { content: [{ type: "text", text: "ok" }] });
    expect(await pending).toEqual({ content: [{ type: "text", text: "ok" }] });

    // A completed detached result is still unfinished turn work until ChatGPT consumes it.
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    expect(await callTurnBroker<InvocationStatus>(socketPath, {
      method: "invoke_status",
      bindingId: claimed.bindingId,
      callId,
    })).toEqual({
      state: "completed",
      toolResult: { content: [{ type: "text", text: "ok" }] },
    });
    // The synthetic low-level claim used by this test is still active. Real MCP requests settle it
    // in withClaimedTurn.finally before the browser completion fence can commit.
    expect(await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token,
      activityId: claimed.activityId,
    })).toEqual({ completed: true });
    expect(broker.beginCompletionFence(token)).toEqual(expect.any(Number));

    // Retrieval is one-shot; a repeated poll cannot replay a tool result into model context.
    expect(await callTurnBroker<InvocationStatus>(socketPath, {
      method: "invoke_status",
      bindingId: claimed.bindingId,
      callId,
    })).toEqual({ state: "completed_elsewhere" });

    // The binding itself remains valid after the long tool finishes.
    expect(await callTurnBroker<{ environment: { cwd: string } }>(socketPath, {
      method: "resolve",
      bindingId: claimed.bindingId,
    })).toMatchObject({ environment: { cwd: root } });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("a later work-tool boundary drains an unpolled detached result before dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgd-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, undefined, "detached-drain");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });

    const originalCallId = "call_detached_original_12345678";
    const original = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: originalCallId,
      wireName: "mcp__research__corpus_search",
      arguments: { query: "large corpus" },
    }, null);
    expect((await broker.nextToolBatch(token)).map(item => item.callId)).toEqual([originalCallId]);
    expect(await callTurnBroker(socketPath, {
      method: "cancel_invoke",
      bindingId: claimed.bindingId,
      callId: originalCallId,
    })).toMatchObject({ delivered: true, pending: true, completed: false });

    broker.completeTool(token, originalCallId, {
      content: [{ type: "text", text: "AUTHORITATIVE_RESEARCH_RESULT" }],
      structuredContent: { rows: 1280 },
    });
    await original;

    const nextCallId = "call_detached_followup_12345678";
    const replay = await callTurnBroker<{
      content: Array<{ type?: string; text?: string }>;
      structuredContent?: {
        code?: string;
        original_call_id?: string;
        requested_tool?: string;
        requested_tool_executed?: boolean;
      };
    }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: nextCallId,
      wireName: "tool_search",
      arguments: { query: "next operation" },
    }, null);

    expect(replay.structuredContent).toMatchObject({
      code: "codex_detached_tool_result_replayed",
      original_call_id: originalCallId,
      requested_tool: "tool_search",
      requested_tool_executed: false,
    });
    expect(replay.content.map(item => item?.text ?? "").join("\n")).toContain("AUTHORITATIVE_RESEARCH_RESULT");
    expect(replay.content.map(item => item?.text ?? "").join("\n")).toContain(originalCallId);

    const noDispatch = new AbortController();
    const batch = broker.nextToolBatch(token, noDispatch.signal);
    setTimeout(() => noDispatch.abort(), 20);
    await expect(batch).rejects.toMatchObject({ name: "AbortError" });

    expect(await callTurnBroker<{ state: string }>(socketPath, {
      method: "invoke_status",
      bindingId: claimed.bindingId,
      callId: originalCallId,
    })).toEqual({ state: "completed_elsewhere" });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active compaction carries completed detached results instead of aborting the source turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgc-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, undefined, "detached-compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });

    const originalCallId = "call_detached_compact_123456789";
    const original = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: originalCallId,
      wireName: "mcp__research__corpus_status",
      arguments: {},
    }, null);
    expect((await broker.nextToolBatch(token)).map(item => item.callId)).toEqual([originalCallId]);
    expect(await callTurnBroker(socketPath, {
      method: "cancel_invoke",
      bindingId: claimed.bindingId,
      callId: originalCallId,
    })).toMatchObject({ delivered: true, pending: true, completed: false });

    broker.completeTool(token, originalCallId, {
      content: [{ type: "text", text: "DETACHED_RESULT_MUST_SURVIVE_COMPACTION" }],
      structuredContent: { status: "complete" },
    });
    await original;

    expect(() => broker.requestCompaction(token, {
      content: [{ type: "text", text: "ACTIVE_COMPACTION_CONTROL" }],
      structuredContent: { code: "active_compaction" },
    })).not.toThrow();

    const compactResult = await callTurnBroker<{
      content: Array<{ type?: string; text?: string }>;
      structuredContent?: {
        code?: string;
        detached_results?: Array<{ call_id?: string }>;
      };
    }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: "call_post_compaction_123456789",
      wireName: "tool_search",
      arguments: { query: "should be intercepted" },
    }, null);

    const text = compactResult.content.map(item => item?.text ?? "").join("\n");
    expect(text).toContain("ACTIVE_COMPACTION_CONTROL");
    expect(text).toContain("DETACHED_RESULT_MUST_SURVIVE_COMPACTION");
    expect(text).toContain(originalCallId);
    expect(compactResult.structuredContent).toMatchObject({
      code: "codex_compaction_carries_detached_results",
      detached_results: [{ call_id: originalCallId }],
    });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
    expect(await callTurnBroker<{ state: string }>(socketPath, {
      method: "invoke_status",
      bindingId: claimed.bindingId,
      callId: originalCallId,
    })).toEqual({ state: "completed_elsewhere" });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("Computer Use telemetry measures result-to-next-tool decision latency without payload logging", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-cu-latency-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const originalInfo = console.info;
  const logs: string[] = [];
  console.info = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, undefined, "cu-latency");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });

    const firstCallId = "call_computer_use_latency_1234";
    const first = callTurnBroker<{ content: unknown[] }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: firstCallId,
      wireName: "mcp__node_repl__js",
      arguments: { code: "SECRET_SCREEN_PAYLOAD_SHOULD_NOT_BE_LOGGED" },
    }, null);
    const firstBatch = await broker.nextToolBatch(token);
    expect(firstBatch.map(item => item.callId)).toEqual([firstCallId]);
    broker.completeTool(token, firstCallId, {
      content: [{ type: "text", text: "SECRET_UI_RESULT_SHOULD_NOT_BE_LOGGED" }],
    });
    await first;

    const secondCallId = "call_computer_use_next_123456";
    const second = callTurnBroker<{ content: unknown[] }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: secondCallId,
      wireName: "mcp__node_repl__js",
      arguments: { code: "next()" },
    }, null);
    const secondBatch = await broker.nextToolBatch(token);
    expect(secondBatch.map(item => item.callId)).toEqual([secondCallId]);
    broker.completeTool(token, secondCallId, { content: [{ type: "text", text: "ok" }] });
    await second;

    const joined = logs.join("\n");
    expect(joined).toContain("[computer-use]");
    expect(joined).toContain("toolComplete tool=mcp__node_repl__js");
    expect(joined).toContain("decisionLatencyMs=");
    expect(joined).not.toContain("SECRET_SCREEN_PAYLOAD_SHOULD_NOT_BE_LOGGED");
    expect(joined).not.toContain("SECRET_UI_RESULT_SHOULD_NOT_BE_LOGGED");
  } finally {
    console.info = originalInfo;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("parallel native invocations are delivered as one broker tool batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-parallel-batch-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, undefined, "parallel-batch");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });

    const firstId = "call_parallel_first_123456789";
    const secondId = "call_parallel_second_12345678";
    const first = callTurnBroker<{ content: unknown[] }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: firstId,
      wireName: "exec_command",
      arguments: { cmd: "git status --short" },
    }, null);
    const second = callTurnBroker<{ content: unknown[] }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId: secondId,
      wireName: "exec_command",
      arguments: { cmd: "git rev-parse HEAD" },
    }, null);

    const batch = await broker.nextToolBatch(token);
    expect(batch.map(item => item.callId).sort()).toEqual([firstId, secondId].sort());
    expect(batch).toHaveLength(2);

    broker.completeTool(token, firstId, { content: [{ type: "text", text: "first" }] });
    broker.completeTool(token, secondId, { content: [{ type: "text", text: "second" }] });
    expect(await first).toEqual({ content: [{ type: "text", text: "first" }] });
    expect(await second).toEqual({ content: [{ type: "text", text: "second" }] });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
