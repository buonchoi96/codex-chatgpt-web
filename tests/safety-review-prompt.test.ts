import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BlockedOperationLedger} from '../src/adapters/chatgpt-web/blocked-operation-ledger';
import {readBlockedOperationReview} from '../src/adapters/chatgpt-web/blocked-operation-review';
import {compileChatGptWebPrompt,CHATGPT_BIGGER_CONTEXT_PARTS} from '../src/adapters/chatgpt-web/prompt';
import {CHATGPT_WEB_MODEL_ID} from '../src/adapters/chatgpt-web/model';
import type {CodexParsedRequest} from '../src/types';
const capabilities={localToolsEnabled:true,solAvailable:true,extraHighAvailable:true,proAvailable:true};
const scope={cwd:'C:/fixture',roots:['C:/fixture']};
const token='turn_'+'a'.repeat(32);
function request():CodexParsedRequest{return {modelId:CHATGPT_WEB_MODEL_ID,stream:true,options:{reasoning:'high'},context:{messages:[{role:'user',content:'Continue the authorized task.',timestamp:1}]}};}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cgw-review-prompt-')),file=join(dir,'ledger.json'),ledger=new BlockedOperationLedger(file);return {file,ledger,close:()=>rmSync(dir,{recursive:true,force:true})};}
test.each(['cold','retained','compaction','manual'] as const)('current safety review is visible without becoming historical user context: %s',kind=>{
 const f=fixture();try{
  const record=f.ledger.recordSafetyRefusal({tool:'exec_command',arguments:{cmd:'PRIVATE_COMMAND'},owner:'PRIVATE_OWNER',targetScope:scope,affectedGoalRequirement:'SAFE-P0-02'});
  const parsed=request();if(kind==='compaction')parsed._compactionRequest=true;
  if(kind==='manual'){parsed.modelId='chatgpt-web-zero-risk';parsed.options={};}
  const original=JSON.stringify(parsed),review=readBlockedOperationReview(f.ledger,scope);
  const compiled=compileChatGptWebPrompt(parsed,capabilities,kind==='manual'?'request_'+'a'.repeat(32):token,
    {blockedOperationReview:review,...(kind==='retained'?{retainedHistoryProven:true}:{}),...(kind==='manual'?{manualControl:true}: {})} as any);
  expect(compiled.text).toContain('PENDING_SAFETY_REVIEW');expect(compiled.text).toContain(record.blocker_id);
  expect(compiled.text).toContain('local bookkeeping');expect(compiled.text).toContain('not permission');
  expect(compiled.text).toContain('"retry_allowed":false');
  expect(compiled.text).not.toContain('PRIVATE_COMMAND');expect(compiled.text).not.toContain('PRIVATE_OWNER');
  if(kind==='compaction')expect(compiled.text).toContain('Preserve unresolved blocker references in the checkpoint; do not call review or work tools');
  else expect(compiled.text).toContain('Only if the current connector advertises codex_safety_review');
  expect(JSON.stringify(parsed)).toBe(original);
  const context=compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  if(context){expect(context).not.toContain(record.blocker_id);expect(JSON.parse(context).messages.at(-1).content).toBe('Continue the authorized task.');}
 }finally{f.close();}
});
test('a failed ledger review remains visible and a clear ledger adds no task noise',()=>{
 const f=fixture();try{
  const parsed=request();const baseline=compileChatGptWebPrompt(parsed,capabilities,token);
  expect(compileChatGptWebPrompt(parsed,capabilities,token,{blockedOperationReview:readBlockedOperationReview(f.ledger,scope)} as any).text).toBe(baseline.text);
  writeFileSync(f.file,'PRIVATE_CORRUPT_LEDGER');
  const compiled=compileChatGptWebPrompt(parsed,capabilities,token,{blockedOperationReview:readBlockedOperationReview(f.ledger,scope)} as any);
  expect(compiled.text).toContain('"status":"unavailable"');expect(compiled.text).toContain('Do not treat an unavailable review as an empty ledger');
  expect(compiled.text).not.toContain('PRIVATE_CORRUPT_LEDGER');
 }finally{f.close();}
});
test('other-scope-only notice preserves pending counts without warning that this task is blocked',()=>{
 const f=fixture();try{
  const other=f.ledger.recordSafetyRefusal({tool:'exec_command',arguments:{cmd:'PRIVATE_OTHER_COMMAND'},owner:'other',targetScope:{cwd:'C:/PRIVATE_OTHER_ROOT',roots:['C:/PRIVATE_OTHER_ROOT']}});
  const compiled=compileChatGptWebPrompt(request(),capabilities,token,{blockedOperationReview:readBlockedOperationReview(f.ledger,scope)});
  expect(compiled.text).toContain('"status":"other_scope_pending"');
  expect(compiled.text).toContain('No unresolved operation is recorded for the current scope');
  expect(compiled.text).toContain('Do not present those counts as blockers for this task');
  expect(compiled.text).not.toContain('Keep PENDING_SAFETY_REVIEW');
  expect(compiled.text).not.toContain(other.blocker_id);expect(compiled.text).not.toContain('PRIVATE_OTHER_');
 }finally{f.close();}
});
test.each(['archive','multipart'] as const)('current review stays out of historical carriers: %s',kind=>{
 const f=fixture();try{
  const record=f.ledger.recordSafetyRefusal({tool:'exec_command',arguments:{},owner:'fixture',targetScope:scope});
  const parsed=request();parsed.context.systemPrompt=[...(parsed.context.systemPrompt??[]),...Array.from({length:6},(_,i)=>`record-${i}: `+'x'.repeat(90_000))];
  const compiled=compileChatGptWebPrompt(parsed,capabilities,token,{blockedOperationReview:readBlockedOperationReview(f.ledger,scope),contextArchive:kind==='archive',...(kind==='multipart'?{experimentalMultipartParts:CHATGPT_BIGGER_CONTEXT_PARTS}:{})} as any);
  expect(compiled.text).toContain(record.blocker_id);
  if(kind==='archive'){expect(compiled.contextArchive).toBeDefined();expect(compiled.contextArchive!.contextText).not.toContain(record.blocker_id);}
  else{expect(compiled.multipart).toBeDefined();for(const part of compiled.multipart!.parts)expect(part).not.toContain(record.blocker_id);}
 }finally{f.close();}
});
