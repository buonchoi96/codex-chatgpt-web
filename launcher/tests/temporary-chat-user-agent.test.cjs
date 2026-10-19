const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BrowserHost, androidTemporaryChatUserAgent, shouldUseAndroidTemporaryChatUserAgent,
  TEMPORARY_CHAT_URL, IDLE_BROWSER_URL,
} = require("../electron/browser-host.cjs");

const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7123.45 Safari/537.36";

test("issue #864 uses Android UA only for opted-in Windows Temporary Chats", () => {
  assert.equal(shouldUseAndroidTemporaryChatUserAgent(true, true, "win32"), true);
  for (const [temporary, enabled, platform] of [
    [false, true, "win32"], [true, false, "win32"],
    [true, true, "linux"], [true, true, "darwin"],
  ]) assert.equal(shouldUseAndroidTemporaryChatUserAgent(temporary, enabled, platform), false);
  assert.equal(androidTemporaryChatUserAgent(desktop),
    "Mozilla/5.0 (Linux; Android 13; SM-A235F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7123.45 Mobile Safari/537.36");
  assert.throws(() => androidTemporaryChatUserAgent("not Chromium"), /Cannot derive/);
});

test("issue #864 home verification restores its original desktop UA when returning to Saved Chats", async () => {
  const updates = [];
  let userAgent = desktop;
  let url = "about:blank";
  const contents = {
    getUserAgent: () => userAgent,
    setUserAgent: value => { updates.push(value); userAgent = value; },
    getURL: () => url,
    loadURL: async next => { url = next; },
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: contents },
    getTemporaryChatAndroidUserAgent: () => true,
    logger: { info() {} },
    waitForAuthenticated: async () => {},
    hardRefreshHome: async () => {},
    homeDesktopUserAgent: null,
  });
  await host.refreshChatGptHomeDocument(false);
  assert.equal(url, TEMPORARY_CHAT_URL);
  if (process.platform === "win32") {
    assert.match(userAgent, /Android 13; SM-A235F/);
    assert.equal(host.homeDesktopUserAgent, desktop);
  } else {
    assert.equal(userAgent, desktop);
  }
  await host.refreshChatGptHomeDocument(true);
  assert.equal(url, "https://chatgpt.com/");
  assert.equal(userAgent, desktop);
  assert.equal(host.homeDesktopUserAgent, null);
  assert.equal(updates.every(x => typeof x === "string"), true);
});

test("issue #864 first launcher reveal sets UA before loading fresh Temporary Chat", async () => {
  let currentUA = desktop;
  const operations = [];
  const contents = {
    getURL: () => IDLE_BROWSER_URL,
    getUserAgent: () => currentUA,
    setUserAgent: value => { currentUA = value; operations.push("setUA"); },
    loadURL: async value => { operations.push("load:" + value); },
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    show() { operations.push("show"); },
    selectedTurnTab: () => null,
    view: { webContents: contents },
    getTemporaryChatAndroidUserAgent: () => true,
    logger: { info() {} },
    homeDesktopUserAgent: null,
    probeAuthentication: async () => {},
    snapshot: () => ({ pageTitle: "ChatGPT", visible: true }),
  });
  // The activation rule is Windows-only. Linux CI must not spoof Android.
  await host.reveal(false);
  const load = operations.indexOf("load:" + TEMPORARY_CHAT_URL);
  assert.ok(load >= 0);
  if (process.platform === "win32") {
    assert.ok(operations.indexOf("setUA") >= 0);
    assert.ok(operations.indexOf("setUA") < load);
    assert.match(currentUA, /Android 13; SM-A235F/);
  } else {
    assert.equal(currentUA, desktop);
  }
});

test("retained Temporary Chat reuses the same view and records its actual UA", async () => {
  const events = [];
  const android = androidTemporaryChatUserAgent(desktop);
  const contents = {
    getUserAgent: () => process.platform === "win32" ? android : desktop,
    getURL: () => "https://chatgpt.com/c/retained-thread",
    executeJavaScript: async () => process.platform === "win32" ? android : desktop,
    isDestroyed: () => false,
    setBackgroundThrottling: () => {},
  };
  const tab = {
    id: "retained-tab", status: "ready", traceId: "completed-trace",
    conversationKey: "conversation-1", connectorIdentity: "native2-connector",
    connectorBound: true, interactionMode: "automatic", helperPid: 42,
    view: { webContents: contents }, surfaceId: "existing-surface",
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, userCancelledTurnOwners: new Map(),
    turnTabs: new Map([[tab.id, tab]]), selectedTabId: null,
    getUseSavedChats: () => false, getTemporaryChatAndroidUserAgent: () => true,
    logger: { info: (event, props) => events.push({ event, props }) },
    syncViewVisibility() {}, snapshot: () => ({}), writeDescriptor() {},
    publishState() {},
  });
  const outcome = await host.beginTurn(
    "continuation-trace", false, 99, "conversation-1", "native2-connector", true,
  );
  assert.equal(outcome.reused, true);
  assert.equal(outcome.tabId, "retained-tab");
  assert.equal(host.turnTabs.get("retained-tab").view.webContents, contents);
  const telemetry = events.find(entry => entry.event === "browser.retained_user_agent");
  assert.ok(telemetry);
  assert.equal(telemetry.props.hostUaClass,
    process.platform === "win32" ? "android-mobile" : "windows-desktop");
  assert.equal(telemetry.props.urlKind, "retained-thread");
  assert.equal(telemetry.props.navigatorUaClass,
    process.platform === "win32" ? "android-mobile" : "unobserved");
});

test("retained Temporary Chat rejects an explicitly reverted desktop UA on Windows", async () => {
  if (process.platform !== "win32") return;
  const contents = {
    getUserAgent: () => desktop, getURL: () => "https://chatgpt.com/c/retained-thread",
    executeJavaScript: async () => desktop,
  };
  const tab = {
    id: "retained-tab", status: "ready", traceId: "completed-trace",
    conversationKey: "conversation-1", connectorIdentity: "native2-connector",
    connectorBound: true, interactionMode: "automatic", helperPid: 42,
    view: { webContents: contents }, surfaceId: "existing-surface",
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, userCancelledTurnOwners: new Map(),
    turnTabs: new Map([[tab.id, tab]]),
    getUseSavedChats: () => false, getTemporaryChatAndroidUserAgent: () => true,
    logger: { info() {} },
  });
  await assert.rejects(
    host.beginTurn("continuation-trace", false, 99, "conversation-1", "native2-connector", true),
    error => error.code === "retained_conversation_ua_mismatch",
  );
  assert.equal(tab.status, "ready");
  assert.equal(tab.traceId, "completed-trace");
});
