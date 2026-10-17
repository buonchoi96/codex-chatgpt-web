import { expect, test } from 'bun:test';
import { RetainedConversationProofStore } from '../src/adapters/chatgpt-web/retained-followup-proof';
import type { CodexParsedRequest } from '../src/types';

function request(): CodexParsedRequest {
  return { modelId:'gpt-5.6-sol', stream:true, options:{reasoning:'high'},
    context:{systemPrompt:['Policy'], messages:[{role:'user',content:'Read A',timestamp:1}]} };
}
function followup(source: CodexParsedRequest): CodexParsedRequest {
  const next = structuredClone(source);
  next.context.messages.push({role:'assistant',content:[{type:'text',text:'A verified'}],timestamp:2},
    {role:'user',content:'Now B',timestamp:3}, {role:'user',content:'Then C',timestamp:4});
  return next;
}
test('retained delta requires canonical ancestry and preserves every ordered suffix revision', () => {
  const store = new RetainedConversationProofStore();
  const source = request(), next = followup(source);
  expect(store.check('owned',next).reason).toBe('proof_missing');
  store.commit('owned',source,'A verified');
  expect(store.check('owned',next).parsed?.context.messages).toEqual(next.context.messages.slice(2));
  next.context.messages[0]!.timestamp=99;
  expect(store.check('owned',next).reason).toBe('verified');
  next.context.messages[0]!.content='Changed ancestry';
  expect(store.check('owned',next).reason).toBe('ancestry_changed');
});
test('changed policy, answer, pending boundary, model and expiration all fail closed', () => {
  let now=1;
  const store=new RetainedConversationProofStore(()=>now), source=request();
  store.commit('owned',source,'A verified');
  const policy=followup(source); policy.context.systemPrompt=['Different'];
  expect(store.check('owned',policy).reason).toBe('policy_changed');
  const answer=followup(source); answer.context.messages[1]!.content=[{type:'text',text:'Foreign'}];
  expect(store.check('owned',answer).reason).toBe('answer_changed');
  const tools=followup(source); tools.context.messages[1]!.content=[{type:'toolCall',id:'pending',name:'exec',arguments:{}}];
  expect(store.check('owned',tools).reason).toBe('answer_boundary_changed');
  const foreign=followup(source); foreign.modelId='other';
  expect(store.check('owned',foreign).reason).toBe('policy_changed');
  expect(store.check('foreign-key',followup(source)).reason).toBe('proof_missing');
  now+=31*60000;
  expect(store.check('owned',followup(source)).reason).toBe('proof_expired');
});
test('matching answer cannot authorize skipping inserted uncommitted evidence', () => {
  const store=new RetainedConversationProofStore(), source=request();
  store.commit('owned',source,'A verified');
  const next=followup(source);
  next.context.messages.splice(1,0,{role:'user',content:'Uncommitted',timestamp:5});
  expect(store.check('owned',next).reason).toBe('answer_boundary_changed');
  store.invalidate('owned');
  expect(store.check('owned',followup(source)).reason).toBe('proof_missing');
});
