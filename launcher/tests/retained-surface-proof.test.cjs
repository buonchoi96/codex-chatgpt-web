const { test } = require("node:test");
const assert = require("node:assert/strict");
const { captureRetainedSurfaceProof, retainedSurfaceProofMatches } = require("../electron/retained-surface-proof.cjs");
const { TRANSCRIPT_PROBE } = require("../electron/retained-surface-proof.cjs");
const vm = require("node:vm");
function fixture() {
  let probe = { url: "https://chatgpt.com/c/A", document: 123, count: 2, revision: 0, hash: 'a'.repeat(64) };
  const cookie = { name: "__Secure-authjs.session-token", domain: ".chatgpt.com", path: "/", value: "private", httpOnly: true };
  const tab = { navigationGeneration: 0, view: { webContents: { isDestroyed: () => false,
    executeJavaScript: async () => probe, session: { cookies: { get: async () => [cookie] } } } } };
  return { tab, cookie, setProbe: value => probe = value };
}
test("healthy physical proof contains hashes and never session credentials", async () => {
  const { tab } = fixture();
  const first = await captureRetainedSurfaceProof(tab);
  assert.ok(retainedSurfaceProofMatches(first, await captureRetainedSurfaceProof(tab)));
  assert.equal(JSON.stringify(first).includes("private"), false);
});

test("a foreign turn virtualized away cannot restore a previously valid transcript proof", async () => {
  let callback;
  const message = role => ({ nodeType: 1, textContent: role + ' text', getAttribute: name => name === 'data-message-author-role' ? role : null,
    matches: () => true, closest: () => null, querySelector: () => null });
  const messages = [message('user'), message('assistant')];
  const composer = { getClientRects: () => [1], cloneNode: () => ({ textContent: '', querySelectorAll: () => [] }) };
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, TextEncoder, location: { href: 'https://chatgpt.com/c/A' },
    performance: { timeOrigin: 123 }, document: { documentElement: {}, querySelectorAll: selector => selector.startsWith('#prompt') ? [composer]
      : selector.startsWith('[data-message-author-role') ? messages : [] },
    MutationObserver: class { constructor(fn) { callback = fn; } observe() {} takeRecords() { return []; } } });
  const first = await vm.runInContext(TRANSCRIPT_PROBE, context);
  // A manual user message appears and is subsequently virtualized; current text is unchanged.
  callback([{ type: 'childList', target: {}, addedNodes: [message('user')], removedNodes: [] }]);
  const second = await vm.runInContext(TRANSCRIPT_PROBE, context);
  assert.equal(first.hash, second.hash);
  assert.equal(second.revision, first.revision + 1);
  assert.equal(retainedSurfaceProofMatches(first, second), false);
});
test("manual messages, different navigation/document, and account transition invalidate proof", async () => {
  for (const field of ['url', 'document', 'count', 'hash']) {
    const { tab, setProbe } = fixture(), first = await captureRetainedSurfaceProof(tab);
    setProbe({ ...first, [field]: field === 'url' ? 'https://chatgpt.com/c/B' : field === 'hash' ? 'b'.repeat(64) : 999 });
    assert.equal(retainedSurfaceProofMatches(first, await captureRetainedSurfaceProof(tab)), false);
  }
  const { tab, cookie } = fixture(), first = await captureRetainedSurfaceProof(tab);
  cookie.value = "other-account";
  assert.equal(retainedSurfaceProofMatches(first, await captureRetainedSurfaceProof(tab)), false);
  tab.navigationGeneration++;
  assert.equal(retainedSurfaceProofMatches(first, await captureRetainedSurfaceProof(tab)), false);
});
test("unprovable terminal state, disconnected renderer and authentication transition fail closed", async () => {
  const { tab, setProbe } = fixture();
  setProbe(null); assert.equal(await captureRetainedSurfaceProof(tab), undefined);
  tab.view.webContents.executeJavaScript = async () => { throw new Error('CDP disconnect'); };
  assert.equal(await captureRetainedSurfaceProof(tab), undefined);
  tab.authenticationRequired = true;
  assert.equal(await captureRetainedSurfaceProof(tab), undefined);
});
