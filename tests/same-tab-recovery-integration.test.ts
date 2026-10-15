import { expect, test } from "bun:test";
import {
  classifySameTabRecoveryTrigger,
  createSameTabRecoveryDelta,
  createSameTabRecoveryFallback,
  runSameTabRecoverySafely,
} from "../src/adapters/chatgpt-web/same-tab-recovery-policy";
import {validateContextArchive} from '../src/adapters/chatgpt-web/context-archive';
import {compileChatGptWebPrompt} from '../src/adapters/chatgpt-web/prompt';
import {ChatGptWebAdapterError} from '../src/adapters/chatgpt-web/adapter-error';

test('steering and watchdog reconciliation faults cannot authorize an outer retry or fresh conversation',async()=>{
  for(const fault of [new Error('Owned observation unavailable'),new ChatGptWebAdapterError('Recovery Send acknowledgement unavailable',
    {status:503,errorType:'server_error',code:'message_delivery_stalled',retryable:true})]) {
    const error=await runSameTabRecoverySafely(async()=>{throw fault;}).catch(error=>error);
    expect(error).toMatchObject({code:'same_tab_recovery_blocked',retryable:false});
    expect(classifySameTabRecoveryTrigger(error,false,false).eligible).toBe(false);
  }
  const refusal=new ChatGptWebAdapterError('Authentication challenge',{status:401,errorType:'server_error',code:'chatgpt_session_expired',retryable:false});
  await expect(runSameTabRecoverySafely(async()=>{throw refusal;})).rejects.toBe(refusal);
  const abort=new AbortController();abort.abort();let invoked=false;
  await expect(runSameTabRecoverySafely(async()=>{invoked=true;},abort.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(invoked).toBe(false);
});

test("only retryable upstream response errors and verified delivery stalls qualify", () => {
  expect(classifySameTabRecoveryTrigger({ code: "upstream_server_error", retryable: true }, false, false))
    .toMatchObject({ eligible: true, trigger: "upstream_error" });
  expect(classifySameTabRecoveryTrigger({ code: "message_delivery_stalled", retryable: true }, false, false))
    .toMatchObject({ eligible: true, trigger: "verified_stall" });
  for (const error of [
    { code: "chatgpt_security_check", retryable: false },
    { code: "chatgpt_session_expired", retryable: false },
    { code: "chatgpt_rate_limited", retryable: true },
    { code: "client_cancelled", retryable: false },
    { code: "upstream_server_error", retryable: false },
  ]) {
    expect(classifySameTabRecoveryTrigger(error, false, false).eligible).toBe(false);
  }
});

test("explicit user abort and tool-capable turns fail closed with a diagnostic reason", () => {
  expect(classifySameTabRecoveryTrigger({ code: "upstream_server_error", retryable: true }, true, false))
    .toMatchObject({ eligible: false, reason: "user_cancelled" });
  expect(classifySameTabRecoveryTrigger({ code: "upstream_server_error", retryable: true }, false, true))
    .toMatchObject({ eligible: false, reason: "tool_capable_fresh_capability_required" });
  expect(classifySameTabRecoveryTrigger({ code: "upstream_server_error", retryable: true }, false, true, true))
    .toMatchObject({ eligible: true });
});

test("recovery submits one short continuation delta without historical context", () => {
  const delta = createSameTabRecoveryDelta();
  expect(delta.length).toBeLessThan(240);
  expect(delta).toMatch(/continue/i);
  expect(delta).not.toMatch(/archive|tool|token|capabilit/i);
});

test('eligible cold recovery preserves the canonical context and committed prefix in a validated ZIP',()=>{
  const cold=createSameTabRecoveryFallback({text:'Canonical task and historical receipts',images:[]},'Committed paragraph');
  const archive=cold.contextArchive!;
  const files=validateContextArchive(Buffer.from(archive.base64,'base64'),archive.sha256);
  expect(new TextDecoder().decode(files['context.txt'])).toContain('Canonical task and historical receipts');
  expect(archive.contextText).toContain('Committed paragraph');
  expect(cold.text).not.toContain('historical receipts');
  expect(()=>createSameTabRecoveryFallback({text:`turn_${'a'.repeat(32)}`,images:[]},'')).toThrow(/capabilit/i);
});

test('tool-capable cold recovery archives canonical history while the retired capability contract stays outside ZIP',()=>{
  const retired=`turn_${'d'.repeat(32)}`;
  const source=compileChatGptWebPrompt({modelId:'gpt-5.6-sol',stream:true,options:{reasoning:'high'},
    context:{systemPrompt:['Canonical policy'],messages:[{role:'user',content:'Latest steering',timestamp:1}]}},
    {localToolsEnabled:true,solAvailable:true,extraHighAvailable:false,proAvailable:false},retired);
  expect(source.text).toContain(retired);
  const fallback=createSameTabRecoveryFallback(source,'Committed result');
  expect(fallback.contextArchive!.contextText).toContain('Canonical policy');
  expect(fallback.contextArchive!.contextText).toContain('Latest steering');
  expect(fallback.contextArchive!.contextText).not.toContain(retired);
});
