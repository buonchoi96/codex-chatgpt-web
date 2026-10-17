import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetainedConversationProofStore } from '../src/adapters/chatgpt-web/retained-followup-proof';
import type { CodexParsedRequest } from '../src/types';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir,{recursive:true,force:true}); });
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'cw-retained-ledger-')); roots.push(dir);
  const file=join(dir,'proof.json'),key='a'.repeat(64);
  const source:CodexParsedRequest={modelId:'gpt-5.6-sol',stream:true,
    options:{reasoning:'high'}, context:{systemPrompt:['PRIVATE_SYSTEM_PROMPT'],
      messages:[{role:'user',content:'PRIVATE_SECRET_SOURCE_A',timestamp:1}]}};
  const next=structuredClone(source);
  next.context.messages.push({role:'assistant',content:[{type:'text',text:'Completed previous turn'}],timestamp:2},
    {role:'user',content:'Continue with next operation',timestamp:3});
  return {dir,file,key,source,next};
}
test('archive-style retained proof survives daemon restart without storing canonical content',()=>{
  const f=fixture();
  const first=new RetainedConversationProofStore(()=>100,()=>f.file);
  expect(first.commit(f.key,f.source,'Completed previous turn')).toBe(true);
  const raw=readFileSync(f.file,'utf8');
  expect(raw).not.toContain('PRIVATE_SYSTEM_PROMPT');
  expect(raw).not.toContain('PRIVATE_SECRET_SOURCE_A');
  expect(raw).not.toContain('Completed previous turn');
  expect(new RetainedConversationProofStore(()=>110,()=>f.file).check(f.key,f.next).parsed?.context.messages)
    .toEqual(f.next.context.messages.slice(2));
  // A goal may spend hours in a single browser turn before the next native Send.
  expect(new RetainedConversationProofStore(()=>2*60*60_000+100,()=>f.file).check(f.key,f.next).reason)
    .toBe('verified');
  f.next.context.messages[0]!.timestamp=999;
  expect(new RetainedConversationProofStore(()=>120,()=>f.file).check(f.key,f.next).reason).toBe('verified');
  f.next.context.messages[0]!.content='tampered';
  expect(new RetainedConversationProofStore(()=>130,()=>f.file).check(f.key,f.next).reason).toBe('ancestry_changed');
});
test('durable proof rejects mutated policy, changed answer, missing ownership and corrupt ledger',()=>{
  const f=fixture(),first=new RetainedConversationProofStore(()=>100,()=>f.file);
  first.commit(f.key,f.source,'Completed previous turn');
  const policy=structuredClone(f.next);policy.context.systemPrompt=['Another policy'];
  expect(new RetainedConversationProofStore(()=>110,()=>f.file).check(f.key,policy).reason).toBe('policy_changed');
  const toolCatalog=structuredClone(f.next);toolCatalog.context.tools=[];
  expect(new RetainedConversationProofStore(()=>110,()=>f.file).check(f.key,toolCatalog).reason).toBe('policy_changed');
  const answer=structuredClone(f.next);
  answer.context.messages[1]!.content=[{type:'text',text:'Other answer'}];
  expect(new RetainedConversationProofStore(()=>110,()=>f.file).check(f.key,answer).reason).toBe('answer_changed');
  expect(new RetainedConversationProofStore(()=>110,()=>f.file).check('b'.repeat(64),f.next).reason).toBe('proof_missing');
  const data=JSON.parse(readFileSync(f.file,'utf8')) as {proofs:Array<{prefixHash:string}>};
  data.proofs[0]!.prefixHash='0'.repeat(64);
  writeFileSync(f.file,JSON.stringify(data));
  expect(new RetainedConversationProofStore(()=>110,()=>f.file).check(f.key,f.next).reason).toBe('ledger_invalid');
});
test('expired durable proof cannot authorize a stale browser suffix',()=>{
  const f=fixture();
  new RetainedConversationProofStore(()=>100,()=>f.file).commit(f.key,f.source,'Completed previous turn');
  expect(new RetainedConversationProofStore(()=>25*60*60_000+101,()=>f.file).check(f.key,f.next).reason).toBe('proof_expired');
});
