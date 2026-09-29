const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { cancelDevChatTurn } = require("../electron/dev-chat-turn-control.cjs");

test("DEV browser cancellation sends an exact-trace account-safety request and validates its receipt", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-web-gpt-test-${process.pid}-${randomUUID()}`
    : path.join(root, "broker.sock");
  let received;
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      received = JSON.parse(buffer.slice(0, newline));
      socket.end(`${JSON.stringify({
        id: received.id,
        result: { cancelled_responses: 1, revoked_turns: 2 },
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));

  const result = await cancelDevChatTurn(socketPath, "trace_123456", "account_security");
  assert.deepEqual(result, { cancelled_responses: 1, revoked_turns: 2 });
  assert.match(received.id, /^request_[a-f0-9]{32}$/);
  assert.equal(received.method, "cancel_trace");
  assert.equal(received.traceId, "trace_123456");
  assert.equal(received.reason, "account_security");
});

test("DEV browser cancellation rejects unsafe or malformed requests before opening a socket", async () => {
  await assert.rejects(cancelDevChatTurn(undefined, "trace_123456", "account_security"), /endpoint is unavailable/);
  await assert.rejects(cancelDevChatTurn("unused", "bad", "account_security"), /trace id is invalid/);
  await assert.rejects(cancelDevChatTurn("unused", "trace_123456", "user_close"), /reason is invalid/);
});
