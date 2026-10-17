import {expect,test} from 'bun:test';
import {LiveSteering} from '../src/adapters/chatgpt-web/live-steering';
import {parseRequest} from '../src/responses/parser';
import {ChatGptTurnSessions,ChatGptTraceFeed,ChatGptTextFeed,chatGptInstructionLineage} from '../src/adapters/chatgpt-web/turn-execution';
import {ChatGptExternalTurnProgress} from '../src/adapters/chatgpt-web/turn-progress';

const raw=(items:unknown[])=>({model:'chatgpt-web/gpt-6-sol',stream:true,instructions:'Stable policy',
  client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'thread_fixture',turn_id:'turn_fixture'})},input:items});
const user=(id:string,text:string)=>({type:'message',role:'user',id,content:[{type:'input_text',text}],
  internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}});
test('canonical live steering preserves a tool receipt while preparing only new ordered user deltas',()=>{
  const first=user('original','Original task'),second=user('steer1','Change the heading'),third=user('steer2','Add a test');
  const initial=parseRequest(raw([first]));
  const next=parseRequest(raw([first,{type:'function_call_output',call_id:'old_call',output:'Committed tool receipt'},second]));
  const queue=new LiveSteering(initial,'owned_conversation');
  expect(queue.admit(next)).toBe(true);
  queue.activateDelivery();
  expect(()=>queue.prepare(false)).toThrow(/held/);
  const prepared=queue.prepare(true)!;
  expect(JSON.stringify(prepared.parsed.context.messages)).toContain('Change the heading');
  expect(JSON.stringify(prepared.parsed.context.messages)).not.toMatch(/Original task|Committed tool receipt/);
  const later=parseRequest(raw([first,{type:'function_call_output',call_id:'old_call',output:'Committed tool receipt'},second,third]));
  expect(queue.admit(later)).toBe(true);
  expect(()=>queue.prepare(true)).toThrow(/held/);
  queue.acknowledge(prepared.deltaId);queue.acknowledge(prepared.deltaId);
  queue.activateDelivery();
  const reserved=queue.prepare(true)!;
  expect(JSON.stringify(reserved.parsed.context.messages)).toContain('Add a test');
  expect(JSON.stringify(reserved.parsed.context.messages)).not.toContain('Change the heading');
  queue.acknowledge(reserved.deltaId);expect(queue.snapshot().pending).toBe(false);
});
test('live steering rejects rewritten canonical ancestry or policy and cancellation forbids mutation',()=>{
  const first=user('original','Original task'),next=user('steer','New instruction');
  const queue=new LiveSteering(parseRequest(raw([first])),'owned_conversation');
  expect(queue.admit(parseRequest(raw([user('original','Changed ancestry'),next])))).toBe(false);
  expect(queue.admit(parseRequest({...raw([first,next]),instructions:'Changed policy'}))).toBe(false);
  expect(queue.admit(parseRequest(raw([first,next])))).toBe(true);
  queue.cancel();expect(queue.snapshot().pending).toBe(false);
  expect(()=>queue.prepare(true)).toThrow(/cancelled|held/);
});

test('a steered native execution shares the original live tool journal and cancellation occurs once',async()=>{
  const first=user('original','Original task'),next=user('steer','New instruction');
  const initial=parseRequest(raw([first]));
  const incoming=parseRequest(raw([first,{type:'function_call_output',call_id:'old_call',output:'Actual receipt'},next]));
  const queue=new LiveSteering(initial,'owned_conversation'),sessions=new ChatGptTurnSessions();
  let cancels=0,starts=0;
  const session=sessions.getOrCreate('old',()=>({mode:'tools',token:Promise.resolve('fixture_owner'),externalProgress:new ChatGptExternalTurnProgress(),
    browser:new Promise<string>(()=>{}),physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),
    enqueueSteering:input=>queue.admit(input),cancel:()=>{cancels++;}}),'trace','owner','native_old','thread',chatGptInstructionLineage(initial).current);
  session.setOutstanding([{callId:'old_call',wireName:'fixture',freeform:false,arguments:{}}]);
  const oldObserver=session.observerSignal('old');
  const steered=await sessions.getOrCreateAfterOwnerRetirement('new','owner',()=>{starts++;throw new Error('Must retain the owned runtime');},
    'newtrace',undefined,'native_new','thread',chatGptInstructionLineage(incoming),incoming);
  expect(steered).toBe(session);expect(starts).toBe(0);expect(cancels).toBe(0);expect(sessions.activeCount()).toBe(1);
  expect(oldObserver.aborted).toBe(true);expect(steered.observerSignal('new').aborted).toBe(false);
  expect(steered.outstanding()).toHaveLength(1);steered.markResultDelivered('old_call');
  expect(session.outstanding()).toHaveLength(0);expect(()=>session.markResultDelivered('old_call')).toThrow();
  sessions.clear();expect(cancels).toBe(1);
});

test('a full alias journal refuses steering before changing the canonical queue',async()=>{
  const initial=parseRequest(raw([user('original','Original task')]));
  const incoming=parseRequest(raw([user('original','Original task'),user('new','Next instruction')]));
  const queue=new LiveSteering(initial,'owned_conversation'),sessions=new ChatGptTurnSessions(1800000,1);
  sessions.getOrCreate('old',()=>({mode:'read-only',browser:new Promise<string>(()=>{}),physicalSettlement:Promise.resolve(),
    trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),enqueueSteering:input=>queue.admit(input),cancel:()=>{}}),
    'trace','owner','native_old','thread',chatGptInstructionLineage(initial).current);
  await expect(sessions.getOrCreateAfterOwnerRetirement('new','owner',()=>{throw new Error('Unexpected replacement');},
    'trace',undefined,'native_new','thread',chatGptInstructionLineage(incoming),incoming)).rejects.toThrow(/journal is full/);
  expect(queue.hasQueued()).toBe(false);expect(queue.snapshot()).toEqual({revision:0,pending:false});
  sessions.clear();
});

test('one explicit trace cancellation cancels a shared steered browser once across execution aliases',async()=>{
  const initial=parseRequest(raw([user('original','Original task')]));
  const incoming=parseRequest(raw([user('original','Original task'),user('new','Next instruction')]));
  const queue=new LiveSteering(initial,'owned_conversation'),sessions=new ChatGptTurnSessions();let cancellations=0;
  sessions.getOrCreate('old',()=>({mode:'read-only',browser:new Promise<string>(()=>{}),physicalSettlement:Promise.resolve(),
    trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),enqueueSteering:input=>queue.admit(input),cancel:()=>{cancellations++;}}),
    'trace','owner','native_old','thread',chatGptInstructionLineage(initial).current);
  await sessions.getOrCreateAfterOwnerRetirement('new','owner',()=>{throw new Error('Unexpected replacement');},
    'trace',undefined,'native_new','thread',chatGptInstructionLineage(incoming),incoming);
  const cancelled=sessions.beginCancelTrace('trace',new Error('Explicit user Stop'));
  expect(cancelled.cancelled).toBe(1);expect(cancellations).toBe(1);await cancelled.settlement;
  sessions.clear();
});

test('concurrent steering reserves alias capacity before admission and rejects the extra revision without queue mutation',async()=>{
  const first=user('original','Original task'),second=user('second','Second instruction'),third=user('third','Third instruction');
  const initial=parseRequest(raw([first])),next=parseRequest(raw([first,second])),later=parseRequest(raw([first,second,third]));
  const queue=new LiveSteering(initial,'owned_conversation'),sessions=new ChatGptTurnSessions(1800000,2);
  let release!:()=>void,settle!:()=>void,admissions=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  sessions.getOrCreate('old',()=>({mode:'read-only',browser:new Promise<string>(()=>{}),
    physicalSettlement:new Promise<void>(resolve=>{settle=resolve;}),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),
    enqueueSteering:async input=>{admissions++;await gate;return queue.admit(input);},cancel:()=>{settle();}}),
    'trace','owner','native_old','thread',chatGptInstructionLineage(initial).current);
  const admit=(key:string,input:ReturnType<typeof parseRequest>)=>sessions.getOrCreateAfterOwnerRetirement(key,'owner',
    ()=>{throw new Error('Unexpected replacement');},'trace',undefined,'native_new','thread',chatGptInstructionLineage(input),input);
  const admitted=admit('new',next),extra=admit('later',later).then(()=>undefined,error=>error);
  await Bun.sleep(0);release();await admitted;
  expect(await extra).toBeInstanceOf(Error);expect(admissions).toBe(1);
  queue.activateDelivery();const delta=queue.prepare(true)!;
  expect(JSON.stringify(delta.parsed.context.messages)).toContain('Second instruction');
  expect(JSON.stringify(delta.parsed.context.messages)).not.toContain('Third instruction');
  sessions.clear();
});

test('a cancelled attachment observer cannot admit steering after the original capability arrives',async()=>{
  const initial=parseRequest(raw([user('original','Original task')]));
  const next=parseRequest(raw([user('original','Original task'),user('new','Next instruction')]));
  const queue=new LiveSteering(initial,'owned_conversation'),sessions=new ChatGptTurnSessions();
  let release!:()=>void,settle!:()=>void,gates=0,cancellations=0;
  const attachment=new Promise<void>(resolve=>{release=resolve;}),abort=new AbortController();
  const session=sessions.getOrCreate('old',()=>({mode:'read-only',browser:new Promise<string>(()=>{}),
    physicalSettlement:new Promise<void>(resolve=>{settle=resolve;}),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),
    enqueueSteering:async(input,signal)=>{await attachment;return queue.admitAfterGate(input,()=>{gates++;return true;},signal);},
    cancel:()=>{cancellations++;settle();}}),'trace','owner','native_old','thread',chatGptInstructionLineage(initial).current);
  const request=sessions.getOrCreateAfterOwnerRetirement('new','owner',()=>{throw new Error('Unexpected replacement');},
    'trace',abort.signal,'native_new','thread',chatGptInstructionLineage(next),next).then(()=>undefined,error=>error);
  abort.abort();
  const early=await Promise.race([request,Bun.sleep(50).then(()=>new Error('Cancellation remained blocked on attachment'))]);
  release();await request;await Bun.sleep(0);
  expect(early).toMatchObject({name:'AbortError'});expect(gates).toBe(0);expect(queue.hasQueued()).toBe(false);
  expect(sessions.find('new')).toBeUndefined();expect(sessions.find('old')).toBe(session);expect(cancellations).toBe(0);
  sessions.clear();
});
