import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRequest} from '../src/responses/parser';
import {createChatGptWebAdapter} from '../src/adapters/chatgpt-web/index';
import {ChatGptBrowserWorker,type BrowserTurn} from '../src/adapters/chatgpt-web/browser-worker';
import {TurnBroker,callTurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {chatGptTurnSessions} from '../src/adapters/chatgpt-web/turn-execution';
import {defaultBrokerEndpoint} from '../src/config';
import {CHATGPT_WEB_BACKEND_MODEL} from '../src/chatgpt-web-models';
import type {AdapterEvent,CodexProviderConfig} from '../src/types';
import {chatGptBrowserTabClosedError} from '../src/adapters/chatgpt-web/adapter-error';

test('native steering returns the outstanding tool receipt once and continues the same adapter owner with a fresh capability',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cgw-steering-adapter-'));
  const socket=defaultBrokerEndpoint(root),broker=TurnBroker.forSocket(socket);
  const provider:CodexProviderConfig={adapter:'chatgpt-web',baseUrl:`fixture://${root}`,chatgptWeb:{
    browserHost:'launcher',browserHostDescriptorPath:join(root,'fixture-launcher.json'),brokerSocketPath:socket,
    localToolsEnabled:true,solAvailable:true,extraHighAvailable:false,proAvailable:false}};
  const body={model:CHATGPT_WEB_BACKEND_MODEL,stream:true,reasoning:{effort:'high'},
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'thread_fixture',turn_id:'turn_fixture'})},
    tools:[{type:'function',name:'fixture_effect',description:'Disposable fixture action',parameters:{type:'object',properties:{}}}],
    input:[{type:'message',role:'user',internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'},content:[{type:'input_text',text:`<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`}]},
      {type:'message',role:'user',id:'original',content:[{type:'input_text',text:'Original fixture instruction'}],
        internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}}]};
  const initial=parseRequest(body),worker=ChatGptBrowserWorker.forProvider(provider),originalRun=worker.run;
  let starts=0,effects=0,returnedReceipts=0;
  const promptTokens:string[]=[];
  // Only the external browser/model is substituted. Parser, runtime, native round journal,
  // gate, tool IPC, capability rotation and tool-result settlement all run their real code.
  worker.run=async(turn:BrowserTurn)=>{
    starts++;
    const prepared=await turn.prepare();
    const token=prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;promptTokens.push(token);
    await turn.onSendActivated?.();turn.onSubmitted?.();
    const claimed=await callTurnBroker<{bindingId:string;activityId:string}>(socket,{method:'claim',token});
    const invocation=callTurnBroker<{content:unknown[]}>(socket,{method:'invoke',bindingId:claimed.bindingId,wireName:'fixture_effect',arguments:{}});
    const progress=turn.externalProgress!;
    let snapshot=progress.snapshot();
    while(!snapshot.activeToolCalls)snapshot=await progress.waitForChange(snapshot.revision,turn.abortSignal);
    await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
    const receipt=await invocation;returnedReceipts++;
    expect(JSON.stringify(receipt)).toContain('Committed fixture receipt');
    await callTurnBroker(socket,{method:'activity_complete',token,activityId:claimed.activityId});
    let queued=turn.steering!.snapshot();
    while(!queued.pending)queued=await turn.steering!.waitForChange!(queued.revision,turn.abortSignal);
    const delta=await turn.prepareRecovery!({steering:true});
    expect(delta.text).toContain('Use the new fixture heading');
    expect(delta.text).not.toMatch(/Original fixture instruction|Committed fixture receipt/);
    expect(delta.contextArchive).toBeUndefined();expect(delta.multipart).toBeUndefined();
    expect(delta.transportDecision?.choice).toBe('RETAINED_DELTA');
    const current=delta.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;promptTokens.push(current);
    await expect(callTurnBroker(socket,{method:'claim',token})).rejects.toThrow(/finished/);
    const fresh=await callTurnBroker<{activityId:string}>(socket,{method:'claim',token:current});
    await callTurnBroker(socket,{method:'activity_complete',token:current,activityId:fresh.activityId});
    await turn.onSteeringSubmitted!(delta.steeringDeltaId!);
    const fence=await turn.completionFence!.begin();expect(fence).toBeDefined();
    expect(await turn.completionFence!.commit(fence!)).toBe(true);
    turn.onTextDelta('New fixture heading');return 'New fixture heading';
  };
  const adapter=createChatGptWebAdapter(provider,{broker});
  try {
    const first:AdapterEvent[]=[];
    await adapter.runTurn!(initial,{headers:new Headers()},event=>first.push(event));
    const tool=first.find((event):event is Extract<AdapterEvent,{type:'tool_call_start'}>=>event.type==='tool_call_start');
    expect(tool).toBeDefined();effects++;
    const incoming=parseRequest({...body,input:[...body.input,
      {type:'function_call_output',call_id:tool!.id,output:'Committed fixture receipt'},
      body.input[0],
      {...body.input[1],id:'steering',content:[{type:'input_text',text:'Use the new fixture heading'}]}]});
    const final:AdapterEvent[]=[];
    await adapter.runTurn!(incoming,{headers:new Headers()},event=>final.push(event));
    expect(starts).toBe(1);expect(effects).toBe(1);expect(returnedReceipts).toBe(1);
    expect(promptTokens).toHaveLength(2);expect(promptTokens[1]).not.toBe(promptTokens[0]);
    expect(final.filter(event=>event.type==='tool_call_start')).toHaveLength(0);
    expect(final.at(-1)).toMatchObject({type:'done',endTurn:true});
    const replay:AdapterEvent[]=[];
    await adapter.runTurn!(incoming,{headers:new Headers()},event=>replay.push(event));
    expect(starts).toBe(1);expect(returnedReceipts).toBe(1);expect(replay).toEqual(final);
  } finally {
    worker.run=originalRun;chatGptTurnSessions.clear();await broker.close();
    rmSync(root,{recursive:true,force:true});
  }
},10000);

test('an explicit tab-close abort still cancels the physical owner instead of using the steering observer handoff',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cgw-steering-cancel-kind-'));
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const provider:CodexProviderConfig={adapter:'chatgpt-web',baseUrl:`fixture://${root}`,chatgptWeb:{
    browserHost:'launcher',browserHostDescriptorPath:join(root,'fixture-launcher.json'),brokerSocketPath:broker.socketPath,
    localToolsEnabled:false,solAvailable:true,extraHighAvailable:false,proAvailable:false}};
  const request=parseRequest({model:CHATGPT_WEB_BACKEND_MODEL,stream:true,reasoning:{effort:'high'},
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'thread_fixture',turn_id:'turn_fixture'})},
    input:[{type:'message',role:'user',id:'original',content:[{type:'input_text',text:'Original fixture instruction'}],
      internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}}]});
  const worker=ChatGptBrowserWorker.forProvider(provider),originalRun=worker.run,abort=new AbortController();
  let started!:()=>void,cancellations=0;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  worker.run=async turn=>{
    await turn.prepare();turn.onSubmitted?.();started();
    return await new Promise<string>((_,reject)=>turn.abortSignal!.addEventListener('abort',()=>{
      cancellations++;reject(turn.abortSignal!.reason);
    },{once:true}));
  };
  const events:AdapterEvent[]=[];
  const running=createChatGptWebAdapter(provider,{broker}).runTurn!(request,{headers:new Headers(),abortSignal:abort.signal},event=>events.push(event));
  try {
    await ready;abort.abort(chatGptBrowserTabClosedError());await running;
    expect(cancellations).toBe(1);
    expect(events.at(-1)).toMatchObject({type:'error',code:'client_cancelled',retryable:false});
  } finally {worker.run=originalRun;chatGptTurnSessions.clear();await broker.close();rmSync(root,{recursive:true,force:true});}
},10000);

test('steering during attachment waits for the original capability and Send acknowledgement without replacing the browser owner',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cgw-steering-attach-'));
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const provider:CodexProviderConfig={adapter:'chatgpt-web',baseUrl:`fixture://${root}`,chatgptWeb:{
    browserHost:'launcher',browserHostDescriptorPath:join(root,'fixture-launcher.json'),brokerSocketPath:broker.socketPath,
    localToolsEnabled:true,solAvailable:true,extraHighAvailable:false,proAvailable:false}};
  const input=[{type:'message',role:'user',content:[{type:'input_text',text:`<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`}],internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}},
    {type:'message',role:'user',id:'original',content:[{type:'input_text',text:'Original fixture instruction'}],
      internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}}];
  const body={model:CHATGPT_WEB_BACKEND_MODEL,stream:true,reasoning:{effort:'high'},
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'thread_fixture',turn_id:'turn_fixture'})},input};
  const initial=parseRequest(body),next=parseRequest({...body,input:[...input,input[0],
    {...input[1],id:'steering',content:[{type:'input_text',text:'Follow-up during attachment'}]}]});
  const worker=ChatGptBrowserWorker.forProvider(provider),originalRun=worker.run;
  let releaseAttach!:()=>void,started!:()=>void,starts=0,cancellations=0;
  const attachment=new Promise<void>(resolve=>{releaseAttach=resolve;});
  const browserStarted=new Promise<void>(resolve=>{started=resolve;});
  worker.run=async turn=>{
    if(++starts>1)throw new Error('Attachment steering replaced the original browser owner');
    started();
    await Promise.race([attachment,new Promise<never>((_,reject)=>turn.abortSignal!.addEventListener('abort',()=>{
      cancellations++;reject(new DOMException('fixture owner cancelled','AbortError'));
    },{once:true}))]);
    await turn.prepare();
    await turn.onSendActivated?.();
    let progress=turn.steering!.snapshot();
    while(!progress.pending)progress=await turn.steering!.waitForChange!(progress.revision,turn.abortSignal);
    await expect(turn.prepareRecovery!({steering:true})).rejects.toThrow(/held/);
    turn.onSubmitted?.();
    const delta=await turn.prepareRecovery!({steering:true});
    expect(delta.text).toContain('Follow-up during attachment');
    expect(delta.text).not.toContain('Original fixture instruction');
    expect(delta.contextArchive).toBeUndefined();
    await turn.onSteeringSubmitted!(delta.steeringDeltaId!);
    turn.onTextDelta('Steered after attachment');return 'Steered after attachment';
  };
  const adapter=createChatGptWebAdapter(provider,{broker});
  let oldRequest:Promise<unknown>|undefined,newRequest:Promise<unknown>|undefined;
  try {
    const oldEvents:AdapterEvent[]=[];
    oldRequest=adapter.runTurn!(initial,{headers:new Headers()},event=>oldEvents.push(event)).catch(error=>error);
    await browserStarted;
    const final:AdapterEvent[]=[];
    newRequest=adapter.runTurn!(next,{headers:new Headers()},event=>final.push(event));
    await Bun.sleep(0);releaseAttach();await newRequest;await oldRequest;
    expect(starts).toBe(1);expect(cancellations).toBe(0);
    expect(oldEvents.at(-1)).toMatchObject({type:'error',code:'client_cancelled',retryable:false});
    expect(final.at(-1)).toMatchObject({type:'done',endTurn:true});
  } finally {
    releaseAttach();worker.run=originalRun;chatGptTurnSessions.clear();
    await Promise.allSettled([oldRequest,newRequest]);await broker.close();rmSync(root,{recursive:true,force:true});
  }
},10000);
