const { createHash } = require("node:crypto");

// Browser content never crosses this boundary: hash the owned transcript inside its renderer.
// UI labels/picker controls are separately reconciled by the worker before every Send.
const TRANSCRIPT_PROBE = `(async () => {
  const selector = '[data-turn-key], [data-message-author-role="user"], [data-message-author-role="assistant"]';
  const key = '__codexBridgeRetainedTranscriptV1';
  if (!globalThis[key]) {
    const tracker = { revision: 0 };
    const relevant = node => node && (node.nodeType === 1
      ? node.matches(selector) || node.closest(selector) || node.querySelector(selector)
      : node.parentElement?.closest(selector));
    tracker.update = records => {
      if (records.some(record => record.type === 'attributes' || relevant(record.target)
        || [...record.addedNodes, ...record.removedNodes].some(relevant))) tracker.revision++;
    };
    tracker.observer = new MutationObserver(tracker.update);
    tracker.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['data-turn-key', 'data-message-author-role', 'data-message-id'] });
    globalThis[key] = tracker;
  }
  const tracker = globalThis[key];
  tracker.update(tracker.observer.takeRecords());
  const revision = tracker.revision;
  const visible = element => element && element.getClientRects().length > 0;
  const composer = [...document.querySelectorAll('#prompt-textarea, [contenteditable="true"][role="textbox"]')].find(visible);
  const running = [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label="Stop generating"]')].some(visible);
  const groups = [...document.querySelectorAll('[data-turn-key]')];
  const messages = groups.length ? groups.flatMap(group => [
    ...group.querySelectorAll('[data-user-message-bubble]'),
    ...group.querySelectorAll('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]')
  ]) : [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
  const role = element => element.getAttribute('data-message-author-role')
    ?? (element.matches('[data-user-message-bubble]') ? 'user' : 'assistant');
  const last = messages.at(-1);
  if (!composer || running || !last || role(last) !== 'assistant') return null;
  const draft = composer.cloneNode(true);
  draft.querySelectorAll('[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"], [data-inline-selection-pill-cursor-target]').forEach(element => element.remove());
  if ((draft.textContent ?? '').trim()) return null;
  const transcript = JSON.stringify(messages.map(element => [role(element),
    element.getAttribute('data-message-id') ?? element.closest('[data-turn-key]')?.getAttribute('data-turn-key'), element.textContent]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transcript));
  tracker.update(tracker.observer.takeRecords());
  if (revision !== tracker.revision) return null;
  return { url: location.href, document: performance.timeOrigin, count: messages.length, revision,
    hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
})()`;

async function captureRetainedSurfaceProof(tab) {
  const contents = tab.view.webContents;
  if (contents.isDestroyed() || tab.authenticationRequired) return undefined;
  let timer;
  try {
    // Bounded proof capture fails closed; disconnects never turn absence into authorization.
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 5_000); timer.unref?.(); });
    const probe = await Promise.race([contents.executeJavaScript(TRANSCRIPT_PROBE), timeout]);
    if (!probe || !/^https:\/\/chatgpt\.com\//.test(probe.url) || !/^[a-f0-9]{64}$/.test(probe.hash)
      || !Number.isFinite(probe.document) || !Number.isSafeInteger(probe.count) || probe.count < 2) return undefined;
    const cookies = await Promise.race([contents.session.cookies.get({ domain: "chatgpt.com" }), timeout]);
    if (!cookies) return undefined;
    const auth = cookies.filter(cookie => cookie.httpOnly && /session|auth/i.test(cookie.name))
      .map(cookie => [cookie.domain, cookie.path, cookie.name, cookie.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (!auth.length) return undefined;
    return { ...probe, session: createHash('sha256').update(JSON.stringify(auth)).digest('hex'),
      navigation: tab.navigationGeneration ?? 0 };
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

function retainedSurfaceProofMatches(expected, actual) {
  return Boolean(expected && actual && expected.url === actual.url && expected.document === actual.document
    && expected.navigation === actual.navigation && expected.revision === actual.revision && expected.count === actual.count
    && expected.hash === actual.hash && expected.session === actual.session);
}
module.exports = { captureRetainedSurfaceProof, retainedSurfaceProofMatches, TRANSCRIPT_PROBE };
