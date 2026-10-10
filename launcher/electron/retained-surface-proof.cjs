const { createHash } = require("node:crypto");

// Browser content never crosses this boundary: hash the owned transcript inside its renderer.
// UI labels/picker controls are separately reconciled by the worker before every Send.
const TRANSCRIPT_PROBE = `(async () => {
  const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-user-message-bubble], [data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]';
  const selector = '[data-turn-key], [data-turn-id], [data-turn-id-container], ' + messageSelector;
  const role = element => element.getAttribute('data-message-author-role')
    ?? (element.matches('[data-user-message-bubble]') ? 'user' : 'assistant');
  const identity = element => element.getAttribute('data-message-id') ?? element.getAttribute('data-turn-id')
    ?? element.closest('[data-turn-id-container]')?.getAttribute('data-turn-id-container')
    ?? element.closest('[data-turn-key]')?.getAttribute('data-turn-key');
  const record = element => [role(element), identity(element), element.textContent];
  const key = '__codexBridgeRetainedTranscriptV2';
  if (!globalThis[key]) {
    const tracker = { revision: 0, seen: new Map() };
    const relevant = node => node && (node.nodeType === 1
      ? node.matches(selector) || node.closest(selector) || node.querySelector(selector)
      : node.parentElement?.closest(selector));
    tracker.update = records => {
      for (const mutation of records) {
        if (mutation.type !== 'childList') {
          if (relevant(mutation.target)) tracker.revision++;
          continue;
        }
        // Identical messages can be virtualized/remounted. An unseen or changed logical
        // message leaves permanent evidence even if it disappears before the next probe.
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (!relevant(node)) continue;
          const messages = node.nodeType === 1
            ? [...(node.matches(messageSelector) ? [node] : []), ...(node.querySelectorAll?.(messageSelector) ?? [])]
            : [];
          if (!messages.length) { tracker.revision++; continue; }
          for (const message of messages) {
            const value = record(message), id = JSON.stringify(value.slice(0, 2));
            if (!value[1] || tracker.seen.get(id) !== JSON.stringify(value)) tracker.revision++;
          }
        }
      }
    };
    tracker.observer = new MutationObserver(tracker.update);
    tracker.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['data-turn-key', 'data-turn-id', 'data-turn-id-container', 'data-message-author-role', 'data-message-id'] });
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
  const last = messages.at(-1);
  if (!composer || running || !last || role(last) !== 'assistant') return null;
  const draft = composer.cloneNode(true);
  draft.querySelectorAll('[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"], [data-inline-selection-pill-cursor-target]').forEach(element => element.remove());
  if ((draft.textContent ?? '').trim()) return null;
  const records = messages.map(record);
  const transcript = JSON.stringify(records);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transcript));
  tracker.update(tracker.observer.takeRecords());
  if (revision !== tracker.revision) return null;
  tracker.seen = new Map(records.filter(value => value[1]).map(value => [JSON.stringify(value.slice(0, 2)), JSON.stringify(value)]));
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
