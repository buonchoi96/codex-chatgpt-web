import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { DevSubmissionWireObserver } from "../scripts/dev-submission-wire-observer";

const prompt = "Owned inert draft café 日本語";
const draftId = "draft_user_123";
const foreignId = "history_user_123";
const rootFrame = "owned-frame";

class FixtureCDP extends EventEmitter {
  commands: Array<{ method: string; params?: object }> = [];
  handlers = new Map<string, (params?: any) => Promise<any>>();
  detached = false;
  async send(method: string, params?: object): Promise<any> {
    this.commands.push({ method, params });
    const custom = this.handlers.get(method);
    if (custom) return custom(params);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: rootFrame } } };
    if (method === "Network.streamResourceContent") return { bufferedData: "" };
    return {};
  }
  async detach() { this.detached = true; }
  page(): Page {
    return { url: () => "https://chatgpt.com/c/owned-fixture", context: () => ({
      newCDPSession: async () => this,
    }) } as unknown as Page;
  }
}

function body(text = prompt, messages: unknown[] = []) {
  return JSON.stringify({ action: "next", messages: [
    ...messages,
    { id: draftId, author: { role: "user" }, content: { parts: [text] } },
  ] });
}
function request(cdp: FixtureCDP, requestId = "request-1", postData?: string) {
  cdp.emit("Network.requestWillBeSent", { requestId, frameId: rootFrame, request: {
    method: "POST", url: "https://chatgpt.com/backend-api/f/conversation", ...(postData !== undefined ? { postData } : {}),
  } });
}
function response(cdp: FixtureCDP, requestId = "request-1", status = 200) {
  cdp.emit("Network.responseReceived", { requestId, response: { status } });
}
function data(cdp: FixtureCDP, text: string | Buffer, requestId = "request-1") {
  cdp.emit("Network.dataReceived", { requestId, data: Buffer.from(text).toString("base64") });
}
const tick = () => Bun.sleep(0);
const assistant = (parent = draftId) => ({
  message: { id: "assistant_reply_123", author: { role: "assistant" }, parent_id: parent },
});
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

async function attached() {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt, "Native2 DEV");
  await observer.attach(cdp.page());
  request(cdp, "request-1", body());
  response(cdp);
  await observer.flushSnapshot();
  return { cdp, observer };
}

test("error parents and foreign user IDs cannot confirm the exact owned draft", async () => {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
  await observer.attach(cdp.page());
  try {
    request(cdp, "request-1", body(prompt, [
      { id: foreignId, author: { role: "user" }, content: { parts: ["historical text"] } },
    ]));
    await tick();
    response(cdp);
    await tick();
    data(cdp, `data: ${JSON.stringify({ error: { code: "inert_error" }, parent_id: draftId })}\n\n`);
    data(cdp, `data: ${JSON.stringify({ message: { id: foreignId, author: { role: "user" } } })}\n\n`);
    data(cdp, `data: ${JSON.stringify({ message: { id: "assistant_reply_123", author: { role: "assistant" }, parent_id: foreignId } })}\n\n`);
    const [receipt] = observer.snapshot();
    expect(receipt?.server_parent_matches_user).toBe(false);
    expect(receipt?.server_echoed_user_id).toBe(false);
    expect(receipt?.user_message_ids).toEqual([draftId]);
  } finally { await observer.close(); }
});

test("HTTP 200 alone and quoted metadata are not server-user acceptance", async () => {
  const { cdp, observer } = await attached();
  try {
    expect(observer.snapshot()[0]).toMatchObject({ http_status: 200,
      server_echoed_user_id: false, server_parent_matches_user: false });
    data(cdp, sse({ parent_id: draftId, metadata: { message: assistant().message },
      text: JSON.stringify({ message: { id: draftId, author: { role: "user" } } }) }));
    data(cdp, sse({ code: "safety_status_unknown_or_blocked", ...assistant() }));
    data(cdp, "event: error\n" + sse(assistant()));
    expect(observer.snapshot()[0]).toMatchObject({
      server_echoed_user_id: false, server_parent_matches_user: false,
    });
    data(cdp, sse({ message: { id: draftId, author: { role: "user" } } }));
    data(cdp, sse({ ...assistant(), metadata: { quoted: "error_code: inert historical text" } }));
    expect(observer.snapshot()[0]).toMatchObject({
      server_echoed_user_id: true, server_parent_matches_user: true,
    });
    expect(cdp.commands.map(command => command.method)).toEqual([
      "Page.getFrameTree", "Network.enable", "Network.streamResourceContent",
    ]);
  } finally { await observer.close(); }
});

test("only exact known connector prefixes match; unknown suffixes expose a masked diagnostic shape", async () => {
  for (const prefix of ["@Native2 DEV ", "@Native2 DEV\n", "@Other connector "]) {
    const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt, "Native2 DEV");
    await observer.attach(cdp.page());
    try {
      request(cdp, "request-1", body(prefix + prompt));
      await observer.flushSnapshot();
      expect(observer.snapshot()).toHaveLength(prefix.startsWith("@Native2 DEV") ? 1 : 0);
      expect(observer.diagnostics().known_connector_prefix).toBe(prefix.startsWith("@Native2 DEV"));
    } finally { await observer.close(); }
  }
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt, "Native2 DEV");
  await observer.attach(cdp.page());
  try {
    const basePrefix = "@[connector:公開-01234567]";
    const prefix = basePrefix + "z".repeat(104 - basePrefix.length);
    const postData = JSON.stringify({ messages: JSON.parse(body(prefix + prompt)).messages,
      turn_attribution: { secret_fixture_value: "must-not-leak" } });
    request(cdp, "request-1", postData);
    response(cdp);
    await observer.flushSnapshot();
    expect(observer.snapshot()).toEqual([]);
    expect(observer.diagnostics()).toMatchObject({
      draft_suffix_match: true, draft_prefix_char_count: 104,
      known_connector_prefix: false, draft_prefix_shape_truncated: false,
      draft_prefix_shape: prefix.replace(/[^\p{P}\p{Z}\s]/gu, "x"),
    });
    const report = JSON.stringify({ receipts: observer.snapshot(), diagnostic: observer.diagnostics() });
    for (const secret of [prefix, prompt, "must-not-leak"]) expect(report).not.toContain(secret);
    expect(observer.diagnostics().body_keys).toContain("turn_attribution");
    expect(cdp.commands.some(command => command.method === "Network.streamResourceContent")).toBe(false);
  } finally { await observer.close(); }
});

test("body readiness and activation queue preserve buffered-first UTF-8 stream order", async () => {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
  const post = Promise.withResolvers<{ postData: string }>();
  const activation = Promise.withResolvers<{ bufferedData: string }>();
  cdp.handlers.set("Network.getRequestPostData", () => post.promise);
  cdp.handlers.set("Network.streamResourceContent", () => activation.promise);
  await observer.attach(cdp.page());
  try {
    request(cdp);
    response(cdp);
    const bytes = Buffer.from("\ufeff" + sse({ ...assistant(), metadata: { quoted: "日本語 café" } }));
    const split = bytes.indexOf(Buffer.from("日")) + 1;
    data(cdp, bytes.subarray(1, split));
    data(cdp, bytes.subarray(split));
    post.resolve({ postData: body() });
    await tick();
    expect(cdp.commands.some(command => command.method === "Network.streamResourceContent")).toBe(true);
    activation.resolve({ bufferedData: bytes.subarray(0, 1).toString("base64") });
    const [receipt] = await observer.flushSnapshot();
    expect(receipt).toMatchObject({ server_parent_matches_user: true, stream_available: true });
    expect(receipt?.user_message_ids).toEqual([draftId]);
  } finally { await observer.close(); }
});

test("one pending request cannot block a different ready request and flush stays bounded", async () => {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
  const stalled = Promise.withResolvers<{ postData: string }>();
  cdp.handlers.set("Network.getRequestPostData", () => stalled.promise);
  cdp.handlers.set("Network.streamResourceContent", async () => ({ bufferedData: Buffer.from(sse(assistant())).toString("base64") }));
  await observer.attach(cdp.page());
  try {
    request(cdp, "stalled");
    response(cdp, "stalled");
    request(cdp, "ready", body());
    response(cdp, "ready");
    const start = Date.now();
    const receipts = await observer.flushSnapshot(15);
    expect(Date.now() - start).toBeLessThan(500);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.server_parent_matches_user).toBe(true);
    expect(observer.diagnostics().flush_timed_out).toBe(true);
  } finally { await observer.close(); stalled.resolve({ postData: body() }); }
});

test("SSE multiline, comments and CRLF parsing work; DONE stops later frames", async () => {
  const { cdp, observer } = await attached();
  try {
    const payload = JSON.stringify(assistant()), split = payload.indexOf(',"author"');
    data(cdp, ": heartbeat\r\n" + `data: ${payload.slice(0, split)}\r\ndata: ${payload.slice(split)}\r\n\r\n`);
    expect(observer.snapshot()[0]?.server_parent_matches_user).toBe(true);
    data(cdp, "data: [DONE]\n\n");
    data(cdp, sse({ message: { id: draftId, author: { role: "user" } } }));
    expect(observer.snapshot()[0]?.server_echoed_user_id).toBe(false);
  } finally { await observer.close(); }
});

test("loadingFinished flushes a complete final SSE frame without a trailing newline", async () => {
  const { cdp, observer } = await attached();
  try {
    data(cdp, "data: " + JSON.stringify(assistant()));
    expect(observer.snapshot()[0]?.server_parent_matches_user).toBe(false);
    cdp.emit("Network.loadingFinished", { requestId: "request-1" });
    expect((await observer.flushSnapshot())[0]?.server_parent_matches_user).toBe(true);
  } finally { await observer.close(); }
});

test("loadingFailed cannot turn an unterminated pending frame into acceptance", async () => {
  const { cdp, observer } = await attached();
  try {
    data(cdp, "data: " + JSON.stringify(assistant()));
    cdp.emit("Network.loadingFailed", { requestId: "request-1", canceled: true });
    expect((await observer.flushSnapshot())[0]?.server_parent_matches_user).toBe(false);
  } finally { await observer.close(); }
});

test("terminal response-body fallback is read-only and an error status cannot confirm a draft", async () => {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
  cdp.handlers.set("Network.streamResourceContent", async () => { throw new Error("fixture host does not stream"); });
  cdp.handlers.set("Network.getResponseBody", async () => ({ body: "data: " + JSON.stringify(assistant()), base64Encoded: false }));
  await observer.attach(cdp.page());
  try {
    request(cdp, "request-1", body()); response(cdp);
    cdp.emit("Network.loadingFinished", { requestId: "request-1" });
    expect((await observer.flushSnapshot())[0]).toMatchObject({
      server_parent_matches_user: true, stream_available: false,
    });
    request(cdp, "bad-status", body()); response(cdp, "bad-status", 403);
    data(cdp, sse(assistant()), "bad-status");
    expect((await observer.flushSnapshot())[1]).toMatchObject({
      http_status: 403, server_parent_matches_user: false, server_echoed_user_id: false,
    });
    expect(cdp.commands.every(command => [
      "Page.getFrameTree", "Network.enable", "Network.getRequestPostData",
      "Network.streamResourceContent", "Network.getResponseBody",
    ].includes(command.method))).toBe(true);
  } finally { await observer.close(); }
});

test("capture caps reject oversized encoded and cumulative decoded data without retaining acceptance", async () => {
  for (const oversizedEncoded of [true, false]) {
    const { cdp, observer } = await attached();
    try {
      data(cdp, sse(assistant()));
      expect(observer.snapshot()[0]?.server_parent_matches_user).toBe(true);
      if (oversizedEncoded) {
        cdp.emit("Network.dataReceived", { requestId: "request-1", data: "A".repeat(Math.ceil(4 * 1024 * 1024 / 3) * 4 + 4) });
      } else {
        const chunk = Buffer.alloc(2 * 1024 * 1024, 32).toString("base64");
        cdp.emit("Network.dataReceived", { requestId: "request-1", data: chunk });
        cdp.emit("Network.dataReceived", { requestId: "request-1", data: chunk });
      }
      expect(observer.diagnostics().capture_limit_reached).toBe(true);
      expect(observer.snapshot()[0]?.server_parent_matches_user).toBe(false);
    } finally { await observer.close(); }
  }
});

test("queued chunks, candidates, diagnostic arrays and duplicate receipts remain bounded", async () => {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
  const activation = Promise.withResolvers<{ bufferedData: string }>();
  cdp.handlers.set("Network.streamResourceContent", () => activation.promise);
  await observer.attach(cdp.page());
  try {
    for (let index = 0; index < 20; index++) request(cdp, `request-${index}`, body());
    await observer.flushSnapshot();
    expect(observer.snapshot()).toHaveLength(8);
    expect(observer.diagnostics()).toMatchObject({ candidate_limit_reached: true, ambiguous_submission: true });
    expect(observer.diagnostics().user_counts.length).toBeLessThanOrEqual(10);
    expect(observer.diagnostics().text_lengths.length).toBeLessThanOrEqual(10);
    response(cdp, "request-0");
    for (let index = 0; index < 257; index++) data(cdp, " ", "request-0");
    activation.resolve({ bufferedData: "" });
    await observer.flushSnapshot();
    expect(observer.diagnostics().capture_limit_reached).toBe(true);
    const copied = observer.snapshot();
    copied[0]!.user_message_ids.push("foreign_mutation");
    expect(observer.snapshot()[0]!.user_message_ids).toEqual([draftId]);
  } finally { await observer.close(); }
});

test("close invalidates pending body and stream callbacks and removes every listener", async () => {
  for (const phase of ["body", "stream"] as const) {
    const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
    const deferred = Promise.withResolvers<any>();
    cdp.handlers.set(phase === "body" ? "Network.getRequestPostData" : "Network.streamResourceContent", () => deferred.promise);
    await observer.attach(cdp.page());
    request(cdp, "request-1", phase === "body" ? undefined : body());
    response(cdp);
    await observer.flushSnapshot(5);
    const before = { receipts: observer.snapshot(), diagnostic: observer.diagnostics() };
    await observer.close();
    expect(cdp.detached).toBe(true);
    expect(cdp.eventNames()).toEqual([]);
    deferred.resolve(phase === "body" ? { postData: body() } : { bufferedData: Buffer.from(sse(assistant())).toString("base64") });
    data(cdp, sse(assistant()));
    await tick();
    expect({ receipts: observer.snapshot(), diagnostic: observer.diagnostics() }).toEqual(before);
    expect(await observer.flushSnapshot()).toEqual(before.receipts);
    expect(cdp.commands.some(command => /Fetch|cancel|abort/i.test(command.method))).toBe(false);
  }
});

test("foreign frames, invalid draft identity and multiple exact users are never bound", async () => {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
  await observer.attach(cdp.page());
  try {
    cdp.emit("Network.requestWillBeSent", { requestId: "foreign", frameId: "foreign-frame",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/conversation", postData: body() } });
    request(cdp, "invalid-id", JSON.stringify({ messages: [
      { id: "bad", author: { role: "user" }, content: { parts: [prompt] } },
    ] }));
    request(cdp, "duplicate-users", body(prompt, [
      { id: foreignId, author: { role: "user" }, content: { parts: [prompt] } },
    ]));
    await observer.flushSnapshot();
    expect(observer.snapshot()).toEqual([]);
    expect(observer.diagnostics()).toMatchObject({
      conversation_posts: 3, main_frame_posts: 2, ambiguous_submission: true,
    });
  } finally { await observer.close(); }
});

test("UTF-8 body size is capped before JSON parsing even when its character count fits", async () => {
  const cdp = new FixtureCDP(), observer = new DevSubmissionWireObserver(prompt);
  await observer.attach(cdp.page());
  try {
    request(cdp, "large-body", body("é".repeat(3 * 1024 * 1024)));
    await observer.flushSnapshot();
    expect(observer.snapshot()).toEqual([]);
    expect(observer.diagnostics().capture_limit_reached).toBe(true);
    expect(observer.diagnostics().body_keys).toEqual([]);
  } finally { await observer.close(); }
});

test("candidate overflow prevents an earlier receipt from appearing as unique acceptance", async () => {
  const { cdp, observer } = await attached();
  try {
    data(cdp, sse(assistant()));
    expect(observer.snapshot()[0]?.server_parent_matches_user).toBe(true);
    for (let index = 0; index < 9; index++) request(cdp, `foreign-${index}`, body("not the owned draft"));
    await observer.flushSnapshot();
    data(cdp, sse(assistant()));
    expect(observer.snapshot()).toHaveLength(1);
    expect(observer.snapshot()[0]?.server_parent_matches_user).toBe(false);
    expect(observer.diagnostics()).toMatchObject({ ambiguous_submission: true, candidate_limit_reached: true });
  } finally { await observer.close(); }
});
