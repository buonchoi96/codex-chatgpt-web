import { expect, test } from 'bun:test';
import { chatGptSubmittedInputProjection } from '../src/adapters/chatgpt-web/submitted-input-projection';
const { createWindow } = require('@mixmark-io/domino');

test('canonical editor text preserves explicit line breaks within one paragraph', () => {
  const window = createWindow('<div id="editor"><p>one<br><br>three</p></div>');
  const editor = window.document.getElementById('editor')! as unknown as HTMLElement;
  expect(chatGptSubmittedInputProjection(editor, { kind: 'composer', captureDraft: false }).canonical).toBe('one\n\nthree');
});

test.each([false, true])('draft and user projections preserve paragraphs, blank lines, Unicode and literal source: modern %s', modern => {
  const window = createWindow('<div id="editor"><p></p><p>Second  line 日本語</p><p><br></p><p>Last line.</p></div><section id="group"><div data-user-message-bubble><div data-search-result-target><p></p><p><br></p><p>Last line.</p></div></div></section>');
  const editor = window.document.getElementById('editor')! as unknown as HTMLElement;
  const group = window.document.getElementById('group')! as unknown as HTMLElement;
  const prefix = modern
    ? '<span app-mention-path="app://fixture" app-mention-display-name="Native2" contenteditable="false">Native2<svg><title>icon</title></svg></span>'
    : '<span data-id="plugin:fixture" data-keyword="Native2" contenteditable="false">Native2<svg><title>icon</title></svg></span>';
  editor.querySelector('p')!.innerHTML = prefix + '<span data-inline-selection-pill-cursor-target>\u200b</span> ';
  editor.querySelector('p')!.appendChild(window.document.createTextNode('Literal <script>keep text</script> & `code`.'));
  group.querySelector('p')!.innerHTML = '<span data-prompt-link-href="app://fixture">Native2</span> ';
  group.querySelector('p')!.appendChild(window.document.createTextNode('Literal <script>keep text</script> & `code`.'));
  group.querySelector('p')!.appendChild(window.document.createElement('br'));
  group.querySelector('p')!.appendChild(window.document.createTextNode('Second  line 日本語'));
  const beforeEditor = editor.innerHTML, beforeUser = group.innerHTML;
  const draft = chatGptSubmittedInputProjection(editor, { kind: 'composer', captureDraft: true });
  const user = chatGptSubmittedInputProjection(group, { kind: 'user', captureDraft: true });
  expect(draft.canonical).toBe('Literal <script>keep text</script> & `code`.\nSecond  line 日本語\n\nLast line.');
  expect(draft.draftText).toBe('Native2 ' + draft.canonical);
  expect(user.draftText).toBe(draft.draftText);
  expect(user.connectorPaths).toEqual(draft.connectorPaths);
  expect(editor.innerHTML).toBe(beforeEditor);
  expect(group.innerHTML).toBe(beforeUser);
  expect(editor.querySelectorAll('script').length).toBe(0);
});

test.each([
  '<div data-user-message-bubble><div data-search-result-target>one</div></div><div data-user-message-bubble><div data-search-result-target>two</div></div>',
  '<div data-user-message-bubble><div data-search-result-target>one</div><div data-search-result-target>two</div></div>',
  '<div data-user-message-bubble></div>',
])('ambiguous user text is never sampled as a complete submission: %s', html => {
  const window = createWindow('<section id="group">' + html + '</section>');
  const projection = chatGptSubmittedInputProjection(window.document.getElementById('group')! as unknown as HTMLElement, { kind: 'user', captureDraft: true });
  expect(projection.valid).toBe(false);
  expect(projection.canonical).toBe('');
  expect(projection.draftText).toBeUndefined();
  expect(projection.connectorPaths).toEqual([]);
});

test('semantic submission proof preserves exact spaces and does not trigger rendered layout', () => {
  const window = createWindow('<div id="editor"><p>  Keep  exact spaces. </p><p>Next.</p></div>');
  const editor = window.document.getElementById('editor')! as unknown as HTMLElement;
  Object.defineProperty(editor, 'innerText', { get() { throw new Error('Layout must not supply message identity'); } });
  const projection = chatGptSubmittedInputProjection(editor, { kind: 'composer', captureDraft: true });
  expect(projection.draftText).toBe('  Keep  exact spaces. \nNext.');
});
