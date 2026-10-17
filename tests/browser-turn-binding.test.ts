import { expect, test } from "bun:test";
import { chromium, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { readFileSync } from "node:fs";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("CodeMirror language invalidates the response cache and incomplete code is not delivered", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-codemirror-reply-2026-10-11.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```python\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => editor.setAttribute("data-language", "text"));
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```text\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => {
      const gap = document.createElement("div");
      gap.style.height = "200px";
      editor.appendChild(gap);
    });
    await expect(observe()).rejects.toThrow("one complete set of code lines");
  } finally { await browser.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("paragraph identity survives file preview movement in both response layouts", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const root of ['class="markdown"', 'data-markdown-text-style="assistant-message"']) {
      const page = await browser.newPage();
      await page.setContent(`<section id="turn"><div data-content-search-unit-key="answer">
        <h4 data-conversation-role="assistant"></h4><div id="answer" ${root}>
        <p>Report saved:</p><p id="file">report.md</p><p id="tail">Done.</p>
      </div></div><button aria-label="Copy"></button></section>`);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const cache = {};
      const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
      const before = await observe();
      const buffer = new ChatGptMarkdownBuffer(undefined, 0);
      expect(buffer.observe(before.markdownSegments, 0)).toBe("Report saved:\n\nreport.md");
      await page.locator("#file").evaluate(file => { file.parentElement!.parentElement!.appendChild(file); });
      const moved = await observe();
      expect(moved.markdownSegments.at(-1).key).toBe(before.markdownSegments.at(-1).key);
      expect(buffer.observe(moved.markdownSegments, 1)).toBe("");
      await page.locator("#answer").evaluate(answer => { answer.innerHTML = answer.innerHTML; });
      buffer.observe((await observe()).markdownSegments, 2);
      expect(buffer.finish().markdown).toBe("Report saved:\n\nreport.md\n\nDone.");
      await page.locator("#tail").evaluate(tail => { tail.textContent = "A changed answer."; });
      buffer.observe((await observe()).markdownSegments, 3);
      expect(() => buffer.finish()).toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content invalidate the response cache", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const turn = page.locator("#turn");
    const observe = () => worker.responseDomSnapshot(turn, cache);
    const first = await observe();
    expect(first.traceBlocks.filter((block: any) => block.kind === "status")).toHaveLength(10);
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
    const summary = page.locator('[data-markdown-text-style="assistant-message"]')
      .filter({ has: page.getByText("status 1", { exact: true }) });
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "primary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("commentary");
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "tertiary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("status");
    await summary.evaluate(node => { node.parentElement!.hidden = true; });
    const collapsed = await observe();
    expect(collapsed.traceBlocks.some((block: any) => block.kind === "status" || block.kind === "commentary")).toBeFalse();
    expect(collapsed.visibleText).toBe("answer 1");
    await summary.evaluate(node => { node.parentElement!.hidden = false; });
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("preserves the accepted user identity across Activity's temporary fallback group", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt.\n\nReturn its contents.";
    // Captured on the installed launcher: the user group appears at Send, disappears
    // during Activity, then returns with the same ID and a rich-text user bubble.
    const user = '<div data-user-message-bubble><div data-search-result-target><p><span data-prompt-link-href="app://test">Codex Native</span> Read first.txt.<br>Return its contents.</p></div></div>';
    const answer = '<div data-content-search-unit-key="fallback-turn-0:2:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>FIRST fixture-marker</p></div></div><div class="turn-action-controls"><button>Copy</button></div>';
    for (const scenario of ["same-user", "different-user", "competing-turn", "old-group-remains", "unfinished", "streaming"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "different-user" ? "unrelated" : "submitted";
      const renderedUser = scenario === "different-user"
        ? `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${prompt}</div></div>`
        : user;
      const response = scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>'
        : scenario === "streaming" ? answer.replace('<div class="turn-action-controls"><button>Copy</button></div>', "") : answer;
      let replacement = `<div data-turn-key="${key}">${renderedUser}${response}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (["same-user", "unfinished", "streaming"].includes(scenario)) {
        expect((await result).identity).toBe("group:assistant:submitted");
      } else {
        await expect(result).rejects.toThrow("another user turn");
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("recovery force-reconciles a retained binding only to the accepted user's unfinished assistant group", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt and return its contents.";
    const user = `<div data-user-message-bubble><div data-search-result-target>${prompt}</div></div>`;
    const assistant = '<span hidden data-chatgpt-agent-turn-start></span>';
    const outcomes: string[] = [];

    for (const scenario of ["accepted-user", "changed-user", "competing-user", "old-group-remains"] as const) {
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((root, html) => { root.innerHTML = html; },
        `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");

      await page.locator("main").evaluate((root, html) => { root.innerHTML = html; },
        '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>');
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");

      const replacementKey = scenario === "changed-user" ? "changed" : "submitted";
      let replacement = `<div data-turn-key="${replacementKey}">${scenario === "changed-user"
        ? `<div data-user-message-bubble><div data-search-result-target>Different prompt.</div></div>`
        : user}${assistant}</div>`;
      if (scenario === "competing-user") {
        replacement += '<div data-turn-key="competing"><div data-user-message-bubble><div data-search-result-target>Another prompt.</div></div></div>';
      }
      if (scenario === "old-group-remains") {
        replacement += '<div data-turn-key="fallback-turn-0"></div>';
      }
      // A retained shell can keep the old locator at count 1 after its bound identity
      // has disappeared from the fresh assistant-response identities. It cannot prove ownership.
      await page.locator("main").evaluate((root, html) => {
        root.innerHTML = `<div id="retained-shell" data-turn-id="fallback-turn-0"></div>${html}`;
      }, replacement);
      const retainedBinding = { ...binding, locator: page.locator("#retained-shell") };
      expect(await retainedBinding.locator.count()).toBe(1);
      const current = await worker.submissionDomState(page);
      expect(current.responseIdentities).not.toContain(binding.identity);

      const reconcile = () => worker.reconcileAssistantTurnBinding(
        page, baseline, retainedBinding, undefined, true,
      );
      try {
        const rebound = await reconcile();
        outcomes.push(`${scenario}:${rebound.identity}`);
      } catch (error) { outcomes.push(`${scenario}:rejected:${(error as Error).message}`); }
      if (scenario === "accepted-user") {
        expect(await page.locator('[data-turn-key="submitted"] [data-chatgpt-agent-turn-start]').count()).toBe(1);
      }
      await page.close();
    }
    expect(outcomes).toEqual([
      "accepted-user:group:assistant:submitted",
      "changed-user:rejected:ChatGPT opened another user turn while the bound assistant response was detached",
      "competing-user:rejected:ChatGPT opened another user turn while the bound assistant response was detached",
      "old-group-remains:rejected:ChatGPT opened another user turn while the bound assistant response was detached",
    ]);
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("generation-only Send acknowledgement requires the exact submitted user text before recovery pairing",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try{
    const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
    for(const message of ['Original fixture prompt','A different task']){
      const page=await browser.newPage();await page.setContent('<main></main>');
      const baseline=await worker.captureSubmissionBaseline(page,'Original fixture prompt');
      await page.locator('main').evaluate((root,text)=>{root.innerHTML='<div data-turn-key="submitted"><div data-user-message-bubble><div data-search-result-target></div></div><span hidden data-chatgpt-agent-turn-start></span></div>';root.querySelector('[data-search-result-target]')!.textContent=text;},message);
      const binding=await worker.waitForNewAssistantTurn(page,baseline,Date.now()+2000);
      expect(baseline.acceptedUserIdentity).toBeUndefined();
      if(message==='Original fixture prompt'){
        const ready=await worker.prepareSteeringRecoveryBinding(page,baseline,binding);
        expect(ready.pending).toBe(false);expect(baseline.acceptedUserIdentity).toBe('group:user:submitted');
      }else await expect(worker.prepareSteeringRecoveryBinding(page,baseline,binding)).rejects.toThrow();
      await page.close();
    }
  }finally{await browser.close();}
},12000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("steering recovery retains a response already paired with the acknowledged user after Stop removes its role", async () => {
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try {
    const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
    const page=await browser.newPage();await page.setContent('<main></main>');
    const baseline=await worker.captureSubmissionBaseline(page,'Fixture prompt');
    await page.locator('main').evaluate(root=>{root.innerHTML='<div data-turn-key="submitted"><div data-user-message-bubble><div data-search-result-target>Fixture prompt</div></div><span hidden data-chatgpt-agent-turn-start></span></div>';});
    expect(await worker.currentSubmissionEvidence(page,baseline)).toBe('user_turn');
    const binding=await worker.waitForNewAssistantTurn(page,baseline,Date.now()+2000);
    const ready=await worker.prepareSteeringRecoveryBinding(page,baseline,binding);
    expect(ready.pending).toBe(false);
    await page.locator('[data-chatgpt-agent-turn-start]').evaluate(node=>node.remove());
    expect(await ready.binding.locator.count()).toBe(1);
  }finally{await browser.close();}
},10000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("steering preflight waits through both accepted-user and assistant-role remount gaps", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const page = await browser.newPage();
    const prompt = "Read first.txt and return its contents.";
    const history = '<div data-turn-key="history"><div data-user-message-bubble>Earlier.</div><h4 data-conversation-role="assistant"></h4></div>';
    const user = `<div data-user-message-bubble><div data-search-result-target>${prompt}</div></div>`;
    await page.setContent(`<main>${history}<button id="stop">Stop</button><button id="send">Send</button></main><script>window.actions={stop:0,send:0};document.querySelector('#stop').onclick=()=>window.actions.stop++;document.querySelector('#send').onclick=()=>window.actions.send++;</script>`);
    const baseline = await worker.captureSubmissionBaseline(page, prompt);
    await page.locator("main").evaluate((root, html) => { root.insertAdjacentHTML("beforeend", html); }, `<div data-turn-key="submitted">${user}</div>`);
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    await page.locator("[data-turn-key='submitted']").evaluate(group => group.remove());
    await page.locator("main").evaluate(root => root.insertAdjacentHTML("beforeend", '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'));
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    expect(binding.identity).toBe("group:assistant:fallback-turn-0");

    let prepared = await worker.prepareSteeringRecoveryBinding(page, baseline, binding);
    expect(prepared).toEqual({ pending: true, binding });

    // The exact accepted user group returns first, without any assistant role mounted.
    await page.locator("[data-turn-key='fallback-turn-0']").evaluate(group => group.remove());
    await page.locator("main").evaluate((root, html) => { root.insertAdjacentHTML("beforeend", html); }, `<div data-turn-key="submitted">${user}</div>`);
    prepared = await worker.prepareSteeringRecoveryBinding(page, baseline, binding);
    expect(prepared).toEqual({ pending: true, binding });
    expect(await page.evaluate(() => (window as any).actions)).toEqual({ stop: 0, send: 0 });

    // Only after the accepted group registers an assistant role can strict rebind return it.
    await page.locator('[data-turn-key="submitted"]').evaluate(group => {
      const assistant = document.createElement("span");
      assistant.hidden = true;
      assistant.setAttribute("data-chatgpt-agent-turn-start", "");
      group.append(assistant);
    });
    prepared = await worker.prepareSteeringRecoveryBinding(page, baseline, binding);
    expect(prepared.pending).toBe(false);
    expect(prepared.binding.identity).toBe("group:assistant:submitted");
    await page.locator('[data-turn-key="submitted"] [data-chatgpt-agent-turn-start]').evaluate(marker => marker.remove());
    expect(await prepared.binding.locator.count()).toBe(1);
    expect(await page.evaluate(() => (window as any).actions)).toEqual({ stop: 0, send: 0 });
    await page.close();
  } finally { await browser.close(); }
}, 25_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("steering preflight rejects changed users, competing turns, lost history, and retained fallback groups", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt and return its contents.";
    const history = '<div data-turn-key="history"><div data-user-message-bubble>Earlier.</div><h4 data-conversation-role="assistant"></h4></div>';
    const user = `<div data-user-message-bubble><div data-search-result-target>${prompt}</div></div>`;
    const assistant = '<span hidden data-chatgpt-agent-turn-start></span>';

    for (const scenario of ["changed-user", "competing-turn", "history-loss", "history-reordered", "old-group-remains"] as const) {
      const page = await browser.newPage();
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((root, html) => { root.insertAdjacentHTML("beforeend", html); }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("[data-turn-key='submitted']").evaluate(group => group.remove());
      await page.locator("main").evaluate((root, html) => root.insertAdjacentHTML("beforeend", html), `<div data-turn-key="fallback-turn-0">${assistant}</div>`);
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);

      let current: string;
      if (scenario === "changed-user") {
        current = `${history}<div data-turn-key="changed"><div data-user-message-bubble><div data-search-result-target>Different prompt.</div></div>${assistant}</div>`;
      } else if (scenario === "competing-turn") {
        current = `${history}<div data-turn-key="fallback-turn-0">${assistant}</div><div data-turn-key="competing"><div data-user-message-bubble><div data-search-result-target>Another prompt.</div></div></div>`;
      } else if (scenario === "history-loss") {
        current = `<div data-turn-key="fallback-turn-0">${assistant}</div>`;
      } else if (scenario === "history-reordered") {
        current = `<div data-turn-key="submitted">${user}${assistant}</div>${history}`;
      } else {
        current = `${history}<div data-turn-key="submitted">${user}${assistant}</div><div data-turn-key="fallback-turn-0">${assistant}</div>`;
      }
      await page.locator("main").evaluate((root, html) => { root.innerHTML = html; }, current);
      await expect(worker.prepareSteeringRecoveryBinding(page, baseline, binding)).rejects.toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

// Execute the real observation/rebinding code against the reported renderer transition.
// No account, network requests, or model submissions are used.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an exchange rekeys only with the exact submitted prompt and no competing turn", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      captureSubmissionBaseline(page: Page, submittedText?: string): Promise<unknown>;
      waitForNewAssistantTurn(page: Page, baseline: unknown, deadline: number): Promise<Binding>;
      reconcileAssistantTurnBinding(page: Page, baseline: unknown, binding: Binding): Promise<Binding>;
    };
    type Binding = { identity: string; locator: Locator; acceptedTurnIdentities: string[] };
    const prompt = "Explain one thing.\nKeep  two spaces.";
    const group = (key: string, text?: string, complete = false) => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div><span aria-hidden="true">\u200b</span><button>Show more</button></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>Answer.</p></div></div>
      ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;
    for (const scenario of ["matching", "history", "foreign", "prefix-only", "changed-spaces", "changed-edges", "two-turns", "old-group-remains", "unfinished", "no-prompt", "same-key"] as const) {
      const page = await browser.newPage();
      const history = scenario === "history" ? group("earlier", prompt, true) : "";
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, scenario === "no-prompt" ? undefined : prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, history + group("optimistic"));
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      const text = scenario === "foreign" ? "Different task."
        : scenario === "prefix-only" ? prompt + " Another request."
        : scenario === "changed-spaces" ? prompt.replace("  ", " ")
        : scenario === "changed-edges" ? " " + prompt : prompt;
      let html = history + group(scenario === "same-key" ? "optimistic" : "persisted", text, scenario !== "unfinished");
      if (scenario === "two-turns") html += group("foreign", prompt, true);
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"><div data-user-message-bubble>Earlier</div></div>';
      await page.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "matching" || scenario === "history" || scenario === "same-key" || scenario === "unfinished") {
        const rebound = await result;
        expect(rebound.identity).toBe(`group:assistant:${scenario === "same-key" ? "optimistic" : "persisted"}`);
        expect(await rebound.locator.count()).toBe(1);
      } else {
        await expect(result).rejects.toThrow();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("collapsed plugin messages rebind only after their complete text is verified", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { appName: "Clew review" };
    const prompt = "Verify the entire message.\n\n" + "alpha  beta\n".repeat(1_000) + "END_MARKER";
    // Structure captured in the DEV launcher on 2026-10-15. The user content is
    // removed from the DOM when collapsed; the plugin and blank-line spans are real.
    const render = (value: string) => '<div data-markdown-text-tone="user-message" class="rich-text-user-turn">'
      + value.split("\n\n").map((paragraph, i) => (i ? '<span data-markdown-copy="blank-lines">\n</span>' : "")
        + '<p>' + (i ? "" : '<a href="/plugins/fixture"><span data-prompt-link-href="app://fixture">Clew review</span></a>  ')
        + paragraph.split("\n").map(line => `<span>${line}</span>`).join("<br>") + '</p>').join("") + '</div>';
    for (const scenario of ["complete", "different-tail", "changed-spaces", "wrong-plugin", "still-truncated", "competing-turn"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator('main').evaluate(e => { e.innerHTML = '<div data-turn-key="optimistic"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      const collapsed = render(prompt.slice(0, 10_000));
      await page.locator('main').evaluate((e, html) => { e.innerHTML = html; }, `<div data-turn-key="persisted">
        <div data-user-message-bubble><div data-search-result-target>${collapsed}</div>
        <button type="button" aria-expanded="false" data-thread-find-skip="true" data-markdown-copy="exclude">Показать ещё</button></div>
        <div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">Complete answer</div></div>`);
      let expanded = render(scenario === "different-tail" ? prompt.replace("END_MARKER", "OTHER_TASK")
        : scenario === "changed-spaces" ? prompt.replace("alpha  beta", "alpha beta")
        : scenario === "still-truncated" ? prompt.slice(0, 10_000) : prompt);
      if (scenario === "wrong-plugin") expanded = expanded.replace("Clew review", "Other plugin");
      await page.locator('button').evaluate((button, { html, competing }) => {
        button.addEventListener('click', () => {
          button.setAttribute('aria-expanded', 'true');
          button.parentElement!.querySelector('[data-search-result-target]')!.innerHTML = html;
          if (competing) document.querySelector('main')!.insertAdjacentHTML('beforeend', '<div data-turn-key="other"><div data-user-message-bubble>Another task</div></div>');
        });
      }, { html: expanded, competing: scenario === "competing-turn" });
      const result = await worker.reconcileAssistantTurnBinding(page, baseline, binding)
        .then((value: unknown) => ({ value }), (error: Error) => ({ error }));
      if (scenario === "complete") expect(result.value).toMatchObject({ identity: "group:assistant:persisted" });
      else expect(result.error).toBeInstanceOf(Error);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("plain user code blocks preserve the full submitted code and whitespace", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = 'Literal header\n\n```json\n{"value":"a  b"}\n```\n\n\tEnd.';
    // Captured plain user-message renderer: only fenced code becomes an HTML block.
    await page.setContent('<div id="group"><div data-user-message-bubble><div data-search-result-target>'
      + 'Literal header\n\n<pre data-markdown-copy="code-block"><code data-markdown-copy-content="true" data-language="json">{"value":"a  b"}</code></pre>\n\n\tEnd.</div></div></div>');
    expect(await worker.userMessageMatchesSubmission(page.locator('#group'), prompt)).toBeTrue();
    expect(await worker.userMessageMatchesSubmission(page.locator('#group'), prompt.replace('a  b', 'a b'))).toBeFalse();
  } finally { await browser.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("rich-text rebind requires the exact prepared turn token after expansion", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const token = "turn_0123456789abcdef0123456789abcdef";
    const foreign = "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prompt = 'Task JSON with links.\nPass turn_token ' + token;
    for (const scenario of ["matching", "foreign", "missing", "duplicate", "token-prefix", "competing-turn"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt, [], token);
      await page.locator('main').evaluate(e => { e.innerHTML = '<div data-turn-key="pending"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      await page.locator('main').evaluate(e => { e.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble>'
        + '<div data-search-result-target><a data-search-result-target href="https://example.com">Altered JSON/link label</a></div>'
        + '<button type="button" aria-expanded="false" data-thread-find-skip="true" data-markdown-copy="exclude">Afficher plus</button></div>'
        + '<span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const displayed = scenario === "foreign" ? foreign : scenario === "missing" ? ""
        : scenario === "duplicate" ? `${token} ${token}` : scenario === "token-prefix" ? `${token}extra` : token;
      await page.locator('button').evaluate((button, { displayed, competing }) => {
        button.addEventListener('click', () => {
          button.setAttribute('aria-expanded', 'true');
          button.parentElement!.querySelector('[data-search-result-target]')!.append(' Pass turn_token ' + displayed);
          if (competing) document.querySelector('main')!.insertAdjacentHTML('beforeend', '<div data-turn-key="other"><div data-user-message-bubble>Other task</div></div>');
        });
      }, { displayed, competing: scenario === "competing-turn" });
      const result = await worker.reconcileAssistantTurnBinding(page, baseline, binding)
        .then((value: unknown) => ({ value }), (error: Error) => ({ error }));
      if (scenario === "matching") expect(result.value).toMatchObject({ identity: "group:assistant:persisted" });
      else expect(result.error).toBeInstanceOf(Error);
      const invalid = await worker.captureSubmissionBaseline(page, "No broker token here", [], token)
        .then(() => undefined, (error: Error) => error);
      expect(invalid).toBeInstanceOf(Error);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("binds captured Activity before an answer exists and recognizes uploaded native-button tiles", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/backend-api/files/process_upload_stream"
    ? new Response(JSON.stringify({ event: "file.processing.completed", file_id: "fixture-file" }) + "\n", { headers: { "content-type": "application/x-ndjson" } })
    : new Response("<main></main>", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main>');
    const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
    const html = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8");
    await page.locator("main").evaluate((node, content) => { node.innerHTML = content; }, html);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
    expect(binding.identity).toBe("group:assistant:activity");
    expect((await worker.responseDomSnapshot(binding.locator)).traceBlocks.some((block: { kind: string }) => block.kind === "commentary")).toBeTrue();
    for (const tile of ['button', 'div role="button"']) {
      await page.setContent(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px">Prompt</div>
        <input type="file" multiple><${tile} class="composer-attachment-surface" aria-label="codex-input-image-1.png">File</${tile.split(' ')[0]}>
        <button type="submit">Send</button></form>`);
      await page.locator('input[type="file"]').evaluate(input => {
        input.addEventListener("change", () => void fetch("/backend-api/files/process_upload_stream", {
          method: "POST", body: JSON.stringify({ file_name: "codex-input-image-1.png", file_id: "fixture-file" }),
        }));
      });
      await worker.attachFiles(page, { images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
      expect(await page.locator('input[type="file"]').evaluate(input => (input as HTMLInputElement).files?.[0]?.name)).toBe("codex-input-image-1.png");
    }
  } finally { await browser.close(); server.stop(true); }
}, 15_000);
