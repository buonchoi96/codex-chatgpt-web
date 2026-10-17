export interface ChatGptSubmittedInputProjection {
  valid: boolean;
  bubbleCount: number;
  contentCount: number;
  canonical: string;
  draftText?: string;
  connectorPaths: string[];
}

/** Serialized into the page by Playwright: keep all runtime dependencies local.
 * Read semantic text without CSS layout, whitespace folding, or live DOM mutation. */
export function chatGptSubmittedInputProjection(element: HTMLElement,
  options: { kind: 'composer' | 'user'; captureDraft: boolean }): ChatGptSubmittedInputProjection {
  let content = element;
  let bubbleCount = 0, contentCount = 1;
  if (options.kind === 'user') {
    const bubbles = element.querySelectorAll('[data-user-message-bubble]');
    const contents = bubbles.length === 1 ? bubbles[0]!.querySelectorAll<HTMLElement>('[data-search-result-target]') : [];
    bubbleCount = bubbles.length; contentCount = contents.length;
    if (contentCount !== 1) return { valid: false, bubbleCount, contentCount, canonical: '', connectorPaths: [] };
    content = contents[0]!;
  }
  const nodes = content.querySelectorAll(options.kind === 'composer'
    ? '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]'
    : '[data-prompt-link-href^="app://"], [app-mention-path^="app://"]');
  const connectorPaths = [...nodes].map(node => node.getAttribute('data-prompt-link-href')
    ?? node.getAttribute('app-mention-path') ?? `app://${node.getAttribute('data-id')!.slice('plugin:'.length)}`);
  const semanticText = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeName === 'BR') return '\n';
    let text = '', previousBlock = false, hasPrevious = false;
    for (const child of node.childNodes) {
      const block = /^(P|DIV|PRE|LI|BLOCKQUOTE)$/.test(child.nodeName);
      const emptyParagraph = block && child.childNodes.length === 1 && child.firstChild?.nodeName === 'BR';
      if (hasPrevious && (block || previousBlock)) text += '\n';
      text += emptyParagraph ? '' : semanticText(child);
      previousBlock = block; hasPrevious = true;
    }
    return text;
  };
  let draftText: string | undefined;
  if (options.kind === 'user' || options.captureDraft) {
    const semantic = content.cloneNode(true) as HTMLElement;
    semantic.querySelectorAll('svg, style, script, [data-inline-selection-pill-cursor-target]').forEach(node => node.remove());
    if (options.kind === 'composer') {
      // A selected chip may contain editor-only cursor characters. Its declared
      // display name is the verified UI label, not task text. Keep user text intact.
      semantic.querySelectorAll('[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]').forEach(node => {
        node.textContent = node.getAttribute('app-mention-display-name') ?? node.getAttribute('data-keyword');
      });
    }
    draftText = semanticText(semantic);
  }
  let canonical = '';
  if (options.kind === 'composer') {
    const clone = content.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('svg, style, script, [data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]').forEach(node => node.remove());
    canonical = semanticText(clone).trimStart();
  }
  return { valid: true, bubbleCount, contentCount, canonical, draftText, connectorPaths };
}
