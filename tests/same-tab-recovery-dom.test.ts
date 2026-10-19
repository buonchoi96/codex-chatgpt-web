import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { SameTabRecovery, type RecoveryObservation } from "../src/adapters/chatgpt-web/same-tab-recovery";
import { chatGptStopButton, throwIfChatGptTerminalErrorAlert, chatGptInterruptedNetworkVisible } from "../src/adapters/chatgpt-web/browser-worker";
import {ChatGptRecoveryWatchdog} from '../src/adapters/chatgpt-web/recovery-watchdog';

const fixture = readFileSync(new URL("./fixtures/same-tab-recovery.html", import.meta.url), "utf8");
const domTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);

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
