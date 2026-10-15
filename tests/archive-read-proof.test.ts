import {expect,test} from 'bun:test';
import {createArchiveReadProof} from '../src/adapters/chatgpt-web/archive-read-proof';
import {TurnBroker,RemoteTurnBroker,callTurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';
import type {ChatGptTurnEnvironment} from '../src/adapters/chatgpt-web/environment';

const environment:ChatGptTurnEnvironment={cwd:process.cwd(),roots:[process.cwd()],writableRoots:[],
  sandboxPolicy:{type:'readOnly',networkAccess:false},tools:[{name:'fixture_read',description:'Read an inert fixture',parameters:{}}]};

test('archive read proof is derived from context bytes absent from the inline capability contract',()=>{
  const proof=createArchiveReadProof('A'.repeat(256)+'middle'+'B'.repeat(256),12,2);
  expect(proof).toEqual({context_head_sha256:'e075f2f51cad23d0537186cfcd50f911ea954f9c2e32a437f45327f1b7899bbb',
    context_tail_sha256:'b0102e3e5f3ced3b4bd1e9d1a08ef35c5fce216b024beea399c4a51b95ece8e7',image_count:12,skill_count:2});
});

test('a cached DEV broker without archive-proof support receives only a compatibility read, never a transaction mutation',async()=>{
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(`${process.cwd()}/old-archive-protocol-${crypto.randomUUID()}`));
  const token=await broker.register(environment),methods:string[]=[];
  const internal=broker as unknown as {dispatch(request:{method:string}):Promise<unknown>};
  const dispatch=internal.dispatch;
  internal.dispatch=async request=>{
    methods.push(request.method);
    if(request.method==='owner_status')return {protocolVersion:5,acceptingExternalOwners:true};
    throw new Error('Legacy protocol rejected an unknown mutation');
  };
  try{
    await expect(new RemoteTurnBroker(broker.socketPath).requireArchiveRead(token,
      createArchiveReadProof('Historical fixture.',0,0))).rejects.toThrow('does not support context-archive-read-proof-v1');
    expect(methods).toEqual(['owner_status']);
    expect(broker.beginCompletionFence(token)).toBe(0);
  }finally{internal.dispatch=dispatch;await broker.close();}
});

test('archive read cancellation and capability retirement cannot leak a waiter or accept an old public receipt',async()=>{
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(`${process.cwd()}/archive-read-cancel-${crypto.randomUUID()}`));
  try{
    await broker.listen();
    const remote=new RemoteTurnBroker(broker.socketPath),token=await remote.register(environment);
    const proof=createArchiveReadProof('An independently owned fixture.',0,0);
    await remote.requireArchiveRead(token,proof);
    const abort=new AbortController(),waiting=remote.waitForArchiveRead(token,abort.signal);
    abort.abort();await expect(waiting).rejects.toMatchObject({name:'AbortError'});
    expect(()=>broker.rotateRecoveryCapability(token)).toThrow('unread historical archive');
    const retired=broker.waitForArchiveRead(token).catch(error=>error);await remote.revoke(token);
    expect(await retired).toBeInstanceOf(Error);
    await expect(callTurnBroker(broker.socketPath,{method:'archive_confirm',token,arguments:proof})).rejects.toThrow(/capability/);
  }finally{await broker.close();}
});

test('shutdown refuses an already accepted owner registration after its startup await',async()=>{
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(`${process.cwd()}/archive-close-register-${crypto.randomUUID()}`));
  await broker.listen();
  const internal=broker as unknown as {start():Promise<void>};
  const start=internal.start;
  let resume!:()=>void;
  const paused=new Promise<void>(resolve=>{resume=resolve;});
  internal.start=()=>paused;
  const registering=broker.register(environment,undefined,'close_register_fixture',true).catch(error=>error);
  try{
    await broker.close();resume();
    expect(await registering).toBeInstanceOf(Error);
    await expect(broker.register(environment)).rejects.toThrow(/closed|closing/);
  }finally{resume();internal.start=start;await broker.close();}
});

test('an unread archive cannot admit task work or final completion; its exact read proof releases one existing capability',async()=>{
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(`${process.cwd()}/archive-proof-${crypto.randomUUID()}`));
  try{
    const token=await broker.register(environment),proof=createArchiveReadProof('Fixture historical context.',0,0);
    await broker.requireArchiveRead(token,proof);
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    expect(broker.commitCompletionFence(token,0)).toBe(false);
    await expect(callTurnBroker(broker.socketPath,{method:'archive_confirm',token,
      arguments:{...proof,context_head_sha256:'0'.repeat(64)}})).rejects.toThrow(/proof/i);
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    const claimed=await callTurnBroker<{bindingId:string;activityId:string}>(broker.socketPath,{method:'claim',token});
    await expect(callTurnBroker(broker.socketPath,{method:'invoke',bindingId:claimed.bindingId,wireName:'fixture_read',arguments:{}})).rejects.toThrow(/archive/i);
    await callTurnBroker(broker.socketPath,{method:'activity_complete',token,activityId:claimed.activityId});
    const waiting=broker.waitForArchiveRead(token);
    expect(await callTurnBroker<{confirmed:true;duplicate:boolean}>(broker.socketPath,{method:'archive_confirm',token,arguments:proof})).toEqual({confirmed:true,duplicate:false});
    await waiting;
    expect(await callTurnBroker<{confirmed:true;duplicate:boolean}>(broker.socketPath,{method:'archive_confirm',token,arguments:proof})).toEqual({confirmed:true,duplicate:true});
    const accepted=await callTurnBroker<{bindingId:string;activityId:string}>(broker.socketPath,{method:'claim',token});
    const pending=callTurnBroker(broker.socketPath,{method:'invoke',bindingId:accepted.bindingId,wireName:'fixture_read',arguments:{}},null);
    const [request]=await broker.nextToolBatch(token);expect(request?.wireName).toBe('fixture_read');
    broker.completeTool(token,request!.callId,{content:[{type:'text',text:'fixture receipt'}]});
    expect(await pending).toEqual({content:[{type:'text',text:'fixture receipt'}]});
    await callTurnBroker(broker.socketPath,{method:'activity_complete',token,activityId:accepted.activityId});
    const revision=broker.beginCompletionFence(token)!;expect(broker.commitCompletionFence(token,revision)).toBe(true);
  }finally{await broker.close();}
});
