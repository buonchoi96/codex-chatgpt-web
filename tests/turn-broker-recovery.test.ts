import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TurnBroker,RemoteTurnBroker,callTurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';
import {LiveSteering} from '../src/adapters/chatgpt-web/live-steering';
import {parseRequest} from '../src/responses/parser';

test('compaction refuses steering before admitting a revision and leaves canonical handoff intact',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cgw-steer-compaction-'));
  const endpoint=defaultBrokerEndpoint(root),broker=TurnBroker.forSocket(endpoint),remote=new RemoteTurnBroker(endpoint);
  const body={model:'chatgpt-web/gpt-6-sol',instructions:'Stable policy',
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'thread_fixture',turn_id:'turn_fixture'})},
    input:[{type:'message',role:'user',id:'original',content:[{type:'input_text',text:'Original task'}],
      internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}}]};
  const next=parseRequest({...body,input:[...body.input,{...body.input[0],id:'steering',
    content:[{type:'input_text',text:'Instruction arriving during compaction'}]}]});
  const queue=new LiveSteering(parseRequest(body),'owned_conversation');
  try {
    const token=await broker.register({cwd:root,roots:[root],writableRoots:[root],
      sandboxPolicy:{type:'readOnly',networkAccess:false},tools:[]},60000,'compaction_steering_fixture');
    broker.requestCompaction(token,{content:[]});
    for(let attempt=0;attempt<2;attempt++) {
      expect(await queue.admitAfterGate(next,()=>remote.pauseForSteering(token))).toBe(false);
      expect(queue.hasQueued()).toBe(false);
      expect(queue.snapshot()).toEqual({revision:0,pending:false});
    }
    const newToken=await broker.register({cwd:root,roots:[root],writableRoots:[root],
      sandboxPolicy:{type:'readOnly',networkAccess:false},tools:[]},60000,'post_compaction_steering');
    expect(await queue.admitAfterGate(next,()=>remote.pauseForSteering(newToken))).toBe(true);
    queue.activateDelivery();
    const delta=queue.prepare(true)!;
    expect(JSON.stringify(delta.parsed.context.messages)).toContain('Instruction arriving during compaction');
    expect(JSON.stringify(delta.parsed.context.messages)).not.toContain('Original task');
    queue.acknowledge(delta.deltaId);expect(queue.hasQueued()).toBe(false);
  } finally {await broker.close();rmSync(root,{recursive:true,force:true});}
});

test('recovery rotates only a settled capability, rejects old public handles and preserves owner waiters',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cgw-rotate-'));
  const endpoint=defaultBrokerEndpoint(root), broker=TurnBroker.forSocket(endpoint);
  const environment={cwd:root,roots:[root],writableRoots:[root],sandboxPolicy:{type:'readOnly' as const,networkAccess:false},tools:[]};
  try {
    const old=await broker.register(environment,60000,'recovery_fixture');
    const claim=await callTurnBroker<{bindingId:string;activityId:string}>(endpoint,{method:'claim',token:old});
    expect(()=>broker.rotateRecoveryCapability(old)).toThrow(/settled/);
    await callTurnBroker(endpoint,{method:'activity_complete',token:old,activityId:claim.activityId});
    await new RemoteTurnBroker(endpoint).pauseForSteering(old);
    await expect(callTurnBroker(endpoint,{method:'claim',token:old})).rejects.toThrow(/queued/);
    await expect(callTurnBroker(endpoint,{method:'invoke',bindingId:claim.bindingId,wireName:'fixture',arguments:{}})).rejects.toThrow(/queued/);
    const pending=broker.nextToolBatch(old);
    const next=await new RemoteTurnBroker(endpoint).rotateRecoveryCapability(old);
    expect(next).not.toBe(old);
    await expect(callTurnBroker(endpoint,{method:'claim',token:old})).rejects.toThrow(/finished/);
    await expect(callTurnBroker(endpoint,{method:'resolve',bindingId:claim.bindingId})).rejects.toThrow(/finished|revoked/);
    const current=await callTurnBroker<{bindingId:string;activityId:string}>(endpoint,{method:'claim',token:next});
    const invoke=callTurnBroker(endpoint,{method:'invoke',bindingId:current.bindingId,wireName:'fixture',arguments:{}});
    const batch=await pending;
    expect(batch).toHaveLength(1);
    broker.completeTool(old,batch[0]!.callId,{content:[]});
    await invoke;
    await callTurnBroker(endpoint,{method:'activity_complete',token:next,activityId:current.activityId});
    const fence=broker.beginCompletionFence(old)!;
    expect(broker.commitCompletionFence(old,fence)).toBe(true);
    expect(()=>broker.rotateRecoveryCapability(old)).toThrow(/terminal/);
    broker.revoke(old);
    await expect(callTurnBroker(endpoint,{method:'claim',token:next})).rejects.toThrow(/finished/);
  } finally {await broker.close();rmSync(root,{recursive:true,force:true});}
});
