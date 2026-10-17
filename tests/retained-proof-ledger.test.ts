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
test('late final receipts cannot roll durable retained ancestry backwards',()=>{
  const f=fixture();
  const store=new RetainedConversationProofStore(()=>100,()=>f.file);
  expect(store.commit(f.key,f.source,'Completed previous turn')).toBe(true);
  // The next browser turn saw the previous verified answer and all new input.
  expect(store.commit(f.key,f.next,'Completed next turn')).toBe(true);
  const after=structuredClone(f.next);
  after.context.messages.push(
    {role:'assistant',content:[{type:'text',text:'Completed next turn'}],timestamp:4},
    {role:'user',content:'Continue with a third operation',timestamp:5},
  );
  const reopened=()=>new RetainedConversationProofStore(()=>110,()=>f.file);
  expect(reopened().check(f.key,after).reason).toBe('verified');
  // An observer from the first response completes later, after daemon restart.
  expect(reopened().commit(f.key,f.source,'Completed previous turn')).toBe(false);
  expect(reopened().check(f.key,after).reason).toBe('verified');
  // Same canonical round and a different answer must not overwrite a winner.
  expect(reopened().commit(f.key,f.next,'Conflicting late answer')).toBe(false);
  expect(reopened().commit(f.key,f.next,'Completed next turn')).toBe(true);
  const diverted=structuredClone(after);
  diverted.context.messages[0]!.content='Different canonical ancestry';
  expect(reopened().commit(f.key,diverted,'Foreign answer')).toBe(false);
  expect(reopened().check(f.key,after).reason).toBe('verified');
  // The next genuine follow-up can still advance the ledger monotonically.
  expect(reopened().commit(f.key,after,'Completed third turn')).toBe(true);
});
test('a fresh accepted canonical answer repairs a corrupt proof file',()=>{
  const f=fixture();
  const store=new RetainedConversationProofStore(()=>100,()=>f.file);
  expect(store.commit(f.key,f.source,'Completed previous turn')).toBe(true);
  writeFileSync(f.file,'corrupt prior process write');
  expect(store.check(f.key,f.next).reason).toBe('ledger_invalid');
  // The accepted Web send is the new authority; the invalid ledger is not.
  expect(store.commit(f.key,f.source,'Completed previous turn')).toBe(true);
  expect(new RetainedConversationProofStore(()=>110,()=>f.file).check(f.key,f.next).reason).toBe('verified');
});
test('expired durable proof cannot authorize a stale browser suffix',()=>{
  const f=fixture();
  new RetainedConversationProofStore(()=>100,()=>f.file).commit(f.key,f.source,'Completed previous turn');
  expect(new RetainedConversationProofStore(()=>25*60*60_000+101,()=>f.file).check(f.key,f.next).reason).toBe('proof_expired');
});
