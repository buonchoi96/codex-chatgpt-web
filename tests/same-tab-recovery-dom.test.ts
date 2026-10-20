import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { SameTabRecovery, type RecoveryObservation } from "../src/adapters/chatgpt-web/same-tab-recovery";
import { chatGptStopButton, throwIfChatGptTerminalErrorAlert, chatGptInterruptedNetworkVisible, chatGptMessageDeliveryTimeoutVisible } from "../src/adapters/chatgpt-web/browser-worker";
import {ChatGptRecoveryWatchdog} from '../src/adapters/chatgpt-web/recovery-watchdog';

const fixture = readFileSync(new URL("./fixtures/same-tab-recovery.html", import.meta.url), "utf8");
const domTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);

domTest("recovery watchdog recognizes current delivery and connection banners without matching quoted messages", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    await page.getByTestId("regenerate-thread-error-button").evaluate(node => node.remove());
    const cases = [
      { text: "Interrupted network. Waiting for final answer ...", kind: "interrupted", threshold: 180_000 },
      { text: "Connection interrupted. Waiting for final answer …", kind: "interrupted", threshold: 180_000 },
      { text: "Message delivery timed out. Please try again.", kind: "red", threshold: 60_000 },
      { text: "Message delivery failed. Please try again.", kind: "red", threshold: 60_000 },
    ] as const;
    for (const { text, kind, threshold } of cases) {
      await page.evaluate(value => {
        const banner = document.createElement("div");
        banner.id = "recovery-banner";
        banner.setAttribute("role", value.startsWith("Message") ? "alert" : "status");
        banner.textContent = value;
        document.querySelector("main")!.append(banner);
      }, text);
      expect(await chatGptMessageDeliveryTimeoutVisible(page)).toBe(kind === "red");
      expect(await chatGptInterruptedNetworkVisible(page)).toBe(kind === "interrupted");
      const watchdog = new ChatGptRecoveryWatchdog();
      const state = { errorKind: kind, visibleText: "Unchanged answer", traceBlocks: [],
        nativeToolCallsInFlight: false, approvalPending: false };
      expect(watchdog.update(state, 0).expired).toBe(false);
      expect(watchdog.update(state, threshold - 1).expired).toBe(false);
      await page.locator("#recovery-banner").evaluate(node => node.remove());
      expect(await chatGptMessageDeliveryTimeoutVisible(page)).toBe(false);
      expect(await chatGptInterruptedNetworkVisible(page)).toBe(false);
      expect(watchdog.update({ ...state, errorKind: null }, threshold).expired).toBe(false);
      expect(watchdog.update(state, threshold + 1).expired).toBe(false);
    }
    await page.getByTestId("assistant-turn").evaluate((node, messages) => {
      node.append(...messages.map(text => {
        const quote = document.createElement("p");
        quote.textContent = `The prompt quoted: ${text}`;
        return quote;
      }));
    }, cases.map(item => item.text));
    const userTurn = await page.locator("main").evaluate((main, messages) => {
      const user = document.createElement("section");
      user.dataset.testid = "user-turn";
      user.textContent = messages.join(" | ");
      main.append(user);
      return user.dataset.testid;
    }, cases.map(item => item.text));
    expect(userTurn).toBe("user-turn");
    expect(await chatGptMessageDeliveryTimeoutVisible(page)).toBe(false);
    expect(await chatGptInterruptedNetworkVisible(page)).toBe(false);
    // A marked status wrapper is not itself an error when only nested quoted
    // content contains the matching text.
    await page.evaluate(() => {
      const main = document.querySelector("main")!;
      for (const [role, text, quoteTag] of [
        ["status", "Connection interrupted. Waiting for final answer ...", "code"],
        ["alert", "Message delivery failed. Please try again.", "blockquote"],
      ]) {
        const wrapper = document.createElement("div");
        wrapper.setAttribute("role", role);
        wrapper.dataset.recoveryQuotedWrapper = "true";
        const quoted = document.createElement(quoteTag);
        quoted.textContent = text;
        wrapper.append(quoted);
        main.append(wrapper);
      }
    });
    expect(await chatGptMessageDeliveryTimeoutVisible(page)).toBe(false);
    expect(await chatGptInterruptedNetworkVisible(page)).toBe(false);
    await page.evaluate(() => {
      const wrappers = document.querySelectorAll('[data-recovery-quoted-wrapper="true"]');
      wrappers[0]!.append(document.createTextNode("Connection interrupted. Waiting for final answer ..."));
      wrappers[1]!.append(document.createTextNode("Message delivery failed. Please try again."));
    });
    expect(await chatGptMessageDeliveryTimeoutVisible(page)).toBe(true);
    expect(await chatGptInterruptedNetworkVisible(page)).toBe(true);
    expect(await page.evaluate(() => (window as any).fixture)).toEqual({ sends: 0, stops: 0 });
    await page.close();
  } finally {
    await browser.close();
  }
}, 20_000);

domTest("headless DOM confirms Stop, unique composer, stable history and exactly one short Send", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    await expect(throwIfChatGptTerminalErrorAlert(page)).rejects.toMatchObject({ code: "upstream_server_error" });
    const observe = async (): Promise<RecoveryObservation> => {
      const before = await page.locator("main").getAttribute("data-revision");
      const stop = chatGptStopButton(page);
      const composerCount = await page.locator("[contenteditable=true]").count();
      const composerReady = composerCount === 1 && await page.locator("[contenteditable=true]").isVisible();
      const after = await page.locator("main").getAttribute("data-revision");
      return {
        owned: await page.locator('[data-surface-id="owned-fixture"]').count() === 1,
        revision: Number(after), activeTools: 0, approvalPending: false, safetyBlocked: false,
        sendAcknowledged: true, generationActive: await stop.isVisible().catch(() => false),
        composerReady, historyStable: before === after, verifiedStall: true,
        completed: await page.getByTestId("completion-action").isVisible().catch(() => false),
      };
    };
    const recovery = new SameTabRecovery();
    const result = await recovery.recover({
      observe,
      stop: async () => { await chatGptStopButton(page).click(); },
      submit: async () => {
        await page.locator("[contenteditable=true]").fill("Continue briefly.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        return "accepted";
      },
    });
    expect(result).toBe("resumed");
    expect(await page.evaluate(() => (window as any).fixture)).toEqual({ sends: 1, stops: 1 });
    expect(await page.getByTestId("assistant-turn").innerText()).toContain("Recovered answer is complete.");
  } finally {
    await browser.close();
  }
}, 20_000);

domTest('real owned DOM waits the red/soft watchdog boundary, then Stop and one delta with no tab or ZIP creation',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try {
    for(const [kind,threshold] of [['red',60000],['interrupted',180000]] as const){
      const page=await browser.newPage();await page.setContent(fixture);
      if(kind==='interrupted')await page.evaluate(()=>{
        document.querySelector('[data-testid="regenerate-thread-error-button"]')?.remove();
        const status=document.createElement('div');status.setAttribute('role','status');
        status.textContent='Interrupted network. Waiting for final answer ...';document.querySelector('main')!.append(status);
      });
      if(kind==='red')await expect(throwIfChatGptTerminalErrorAlert(page)).rejects.toMatchObject({code:'upstream_server_error'});
      else expect(await chatGptInterruptedNetworkVisible(page)).toBe(true);
      const watchdog=new ChatGptRecoveryWatchdog();
      const state={errorKind:kind,visibleText:await page.getByTestId('assistant-turn').innerText(),traceBlocks:[],nativeToolCallsInFlight:false,approvalPending:false};
      expect(watchdog.update(state,0).expired).toBe(false);
      expect(watchdog.update(state,threshold-1).expired).toBe(false);
      expect(await page.evaluate(()=>(window as any).fixture)).toEqual({sends:0,stops:0});
      const expired=watchdog.update(state,threshold).expired;expect(expired).toBe(true);
      const pages=browser.contexts().flatMap(context=>context.pages()).length;
      const result=await new SameTabRecovery().recover({
        observe:async()=>({owned:true,revision:1,activeTools:0,approvalPending:false,safetyBlocked:false,
          sendAcknowledged:true,generationActive:await chatGptStopButton(page).isVisible(),
          composerReady:await page.locator('[contenteditable=true]').count()===1,historyStable:true,verifiedStall:expired}),
        stop:async()=>{await chatGptStopButton(page).click();},
        submit:async()=>{await page.locator('[contenteditable=true]').fill('Continue the unfinished task.');
          await page.getByRole('button',{name:'Send',exact:true}).click();return 'accepted';},
      });
      expect(result).toBe('resumed');expect(await page.evaluate(()=>(window as any).fixture)).toEqual({sends:1,stops:1});
      expect(browser.contexts().flatMap(context=>context.pages()).length).toBe(pages);
      expect(await page.locator('input[type=file]').count()).toBe(0);
      await page.close();
    }
  } finally {await browser.close();}
},20000);

domTest('visible semantic progress and an active native command suppress Stop and Send on the owned DOM', async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(fixture);
    await expect(throwIfChatGptTerminalErrorAlert(page)).rejects.toMatchObject({code:'upstream_server_error'});
    const watchdog=new ChatGptRecoveryWatchdog();
    const readAnswer=()=>page.getByTestId('assistant-turn').innerText();
    const initial={errorKind:'red' as const,visibleText:await readAnswer(),traceBlocks:[],
      nativeToolCallsInFlight:false,approvalPending:false};
    expect(watchdog.update(initial,0).expired).toBe(false);
    expect(watchdog.update(initial,59_998).expired).toBe(false);
    // The error banner remains; real answer content changes just before its deadline.
    await page.getByTestId('assistant-turn').evaluate(node=>{
      node.querySelector('.markdown')!.textContent+=' A new meaningful answer token arrived.';
    });
    const progressed={...initial,visibleText:await readAnswer()};
    expect(progressed.visibleText).not.toBe(initial.visibleText);
    expect(watchdog.update(progressed,59_999).expired).toBe(false);
    expect(watchdog.update(progressed,119_997).expired).toBe(false);
    // A native tool remains in flight across the refreshed deadline.
    const busy={...progressed,nativeToolCallsInFlight:true};
    expect(watchdog.update(busy,119_998).expired).toBe(false);
    expect(watchdog.update(busy,240_000).expired).toBe(false);
    expect(watchdog.update(progressed,240_001).expired).toBe(false);
    const result=await new SameTabRecovery().recover({
      observe:async()=>({owned:true,revision:1,activeTools:0,approvalPending:false,safetyBlocked:false,
        sendAcknowledged:true,generationActive:await chatGptStopButton(page).isVisible(),
        composerReady:await page.locator('[contenteditable=true]').count()===1,
        historyStable:true,verifiedStall:watchdog.update(progressed,240_002).expired}),
      stop:async()=>{throw new Error('must not Stop while useful work is still within the watchdog');},
      submit:async()=>{throw new Error('must not Send after meaningful activity');},
    });
    expect(result).toBe('waiting');
    expect(await page.evaluate(()=>(window as any).fixture)).toEqual({sends:0,stops:0});
    await page.close();
  } finally {await browser.close();}
},20000);

domTest("headless DOM reconciles a committed answer without Stop or Send", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    await page.getByTestId("stop-button").evaluate(element => element.remove());
    await page.getByTestId("regenerate-thread-error-button").evaluate(element => element.remove());
    await page.locator("main").evaluate(root => {
      const complete = document.createElement("button");
      complete.dataset.testid = "completion-action";
      complete.textContent = "Good response";
      root.append(complete);
    });
    const result = await new SameTabRecovery().recover({
      observe: async () => ({
        owned: true, revision: 1, activeTools: 0, approvalPending: false, safetyBlocked: false,
        sendAcknowledged: true, generationActive: false, composerReady: true,
        historyStable: true, verifiedStall: true,
        completed: await page.getByTestId("completion-action").isVisible(),
      }),
      stop: async () => { throw new Error("must not Stop a committed answer"); },
      submit: async () => { throw new Error("must not Send after reconciliation"); },
    });
    expect(result).toBe("completed");
    expect(await page.evaluate(() => (window as any).fixture.sends)).toBe(0);
  } finally {
    await browser.close();
  }
}, 20_000);
