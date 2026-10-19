const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BrowserHost, androidTemporaryChatUserAgent, shouldUseAndroidTemporaryChatUserAgent,
  TEMPORARY_CHAT_URL,
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
  const host = {
    view: { webContents: contents },
    getTemporaryChatAndroidUserAgent: () => true,
    logger: { info() {} },
    waitForAuthenticated: async () => {},
    hardRefreshHome: async () => {},
    homeDesktopUserAgent: null,
  };
  await BrowserHost.prototype.refreshChatGptHomeDocument.call(host, false);
  assert.equal(url, TEMPORARY_CHAT_URL);
  if (process.platform === "win32") {
    assert.match(userAgent, /Android 13; SM-A235F/);
    assert.equal(host.homeDesktopUserAgent, desktop);
  } else {
    assert.equal(userAgent, desktop);
  }
  await BrowserHost.prototype.refreshChatGptHomeDocument.call(host, true);
  assert.equal(url, "https://chatgpt.com/");
  assert.equal(userAgent, desktop);
  assert.equal(host.homeDesktopUserAgent, null);
  assert.equal(updates.every(x => typeof x === "string"), true);
});
