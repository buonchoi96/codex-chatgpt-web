import {expect,test} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createChatGptMcpServer} from '../src/adapters/chatgpt-web/mcp-server';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';
import {ScreenObservationRegistry,NativeScreenObservationError,type NativeScreenProvider,type ScreenReaderGrant} from '../src/adapters/chatgpt-web/screen-observation';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'a'.repeat(64),session:randomUUID(),hwnd:'101',pid:202,
  consumer_owner:randomUUID(),capability_epoch:randomUUID(),owner_epoch:3,expires_in_ms:30000,
  region:{x:0,y:0,width:100,height:80},observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
const wire='mcp__swift__swift_observer_reader_grant';
const accepted={content:[{type:'text',text:'reader grant'}],structuredContent:{ok:true,data:grant}};
function observation(operation_id:string):Record<string,unknown>{return {observer_protocol:1,operation_id,session:grant.session,
  hwnd:grant.hwnd,pid:grant.pid,owner_epoch:grant.owner_epoch,region:grant.region,status:'PARTIAL',image_encoded:false,
  image_delivery_status:'UNAVAILABLE',frame_id:1,target_generation:1,
  nodes:[{source:'cv',name:'',frame_id:1,target_generation:1,bounds:{x:10,y:10,width:20,height:20}}]};}

test('UIA stage timing must be measured within observation and absent when provider was not attempted',async()=>{
  const base={cv:{status:'completed',source_count:1,truncated:false},
    ocr:{status:'UNAVAILABLE',confidence_available:false}};
  const actual={status:'ok',partial:false,temporal_relation:'after_final_frame',
    pixel_correspondence:'unverified',sample_start_ms:2,sample_end_ms:5};
  const fixtures=[
    {uia:actual,valid:true},
    {uia:{...actual,sample_end_ms:1},valid:false},
    {uia:{...actual,sample_end_ms:11},valid:false},
    {uia:{...actual,sample_start_ms:12},valid:false},
    {uia:{...actual,status:'not_attempted'},valid:false},
    {uia:{...actual,status:'not_attempted',sample_start_ms:undefined,sample_end_ms:undefined},valid:true},
    {uia:{...actual,sample_end_ms:undefined},valid:false},
  ];
  for(const [index,fixture] of fixtures.entries()){
    const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>({
      ...observation(args.operation_id),sources:{...base,uia:fixture.uia},total_ms:10})});
    const binding='uia-timing-'+index;
    registry.remember(binding,'owner',accepted);
    const observed=registry.observe(binding,'owner',{reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{});
    if(fixture.valid)expect((await observed).total_ms).toBe(10);
    else await expect(observed).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
  }
});
test('strict native observation permits grounded per-frame CPU timings and rejects invalid timing values',async()=>{
  const compute={mode:'AUTO',worker_threads:1,control_threads:1,concurrency_limit:1,active:0,queued:0,
    governor_reason:'conservative_bootstrap',cv_tasks_completed:2,cv_peak_parallel:1,cv_task_wall_ms_sum:1.8,
    analysis_join_ms:2.1,analysis_timings_complete:true,additional_task_ms:0.7,
    available_logical_processors:null,allocation_status:'uncertain',
    allocation_reasons:['job_ancestor_limits_unverified'],foreground_reserved:0,bootstrap_workers:1,
    uia_provider_ownership:'isolated_private_helper',ocr_provider_ownership:'isolated_private_helper',
    ocr_engine_internal_parallelism:'not_measured'};
  let invalid=false;let invalidOverlap=false;
  const registry=new ScreenObservationRegistry({observe:async(_lease,args)=>({
    ...observation(args.operation_id),compute:{...compute,cv_task_wall_ms_sum:invalid?-1:1.8,
      cv_peak_parallel:invalidOverlap?2:1}})});
  registry.remember('cpu-binding','cpu-owner',accepted);
  const request={reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64};
  const measured=await registry.observe('cpu-binding','cpu-owner',request,async()=>{});
  expect(measured.compute).toMatchObject({cv_tasks_completed:2,cv_peak_parallel:1,cv_task_wall_ms_sum:1.8,
    analysis_join_ms:2.1,analysis_timings_complete:true,additional_task_ms:0.7,
    allocation_status:'uncertain',worker_threads:1});
  invalid=true;
  await expect(registry.observe('cpu-binding','cpu-owner',request,async()=>{})).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
  invalid=false;invalidOverlap=true;
  await expect(registry.observe('cpu-binding','cpu-owner',request,async()=>{})).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
});
test('reader registry requires a current native receipt and exact broker binding',async()=>{
  let calls=0;const provider:NativeScreenProvider={observe:async(_grant,args)=>{++calls;return observation(args.operation_id);}};
  const registry=new ScreenObservationRegistry(provider);const args={reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64};
  await expect(registry.observe('binding-a','owner-a',args,async()=>{})).rejects.toThrow('NOT_AUTHORIZED');
  registry.remember('binding-a','owner-a',accepted);
  await expect(registry.observe('binding-b','owner-a',args,async()=>{})).rejects.toThrow('NOT_AUTHORIZED');
  await expect(registry.observe('binding-a','owner-b',args,async()=>{})).rejects.toThrow('NOT_AUTHORIZED');
  expect(calls).toBe(0);
  const result=await registry.observe('binding-a','owner-a',args,async()=>{});expect(result.image_delivery_status).toBe('UNAVAILABLE');expect(calls).toBe(1);
});
test('retirement during native work prevents publication and never falls back',async()=>{
  let validations=0,calls=0;
  const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>{++calls;return observation(args.operation_id);}});
  registry.remember('binding-a','owner-a',accepted);
  await expect(registry.observe('binding-a','owner-a',{reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{
    if(++validations===2)throw new Error('retired current turn');
  })).rejects.toThrow('retired current turn');expect(calls).toBe(1);
});
test('native mismatched target, stale CV and claimed images are rejected',async()=>{
  for(const change of [{pid:999},{image_delivery_status:'MODEL_PROVEN'},
    {nodes:[{source:'cv',name:'',frame_id:0,target_generation:1,bounds:{x:10,y:10,width:20,height:20}}]},
    {nodes:[{source:'uia',pixel_correspondence:'same_frame',bounds:{x:10,y:10,width:20,height:20}}]}]) {
    const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>({...observation(args.operation_id),...change})});
    registry.remember('binding-a','owner-a',accepted);
    await expect(registry.observe('binding-a','owner-a',{reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{})).rejects.toThrow('PROTOCOL');
  }
});
test('expired and failed reader grants cannot authorize native capture',async()=>{
  let now=1000,calls=0;const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>{++calls;return observation(args.operation_id);}},()=>now);
  registry.remember('binding-a','owner-a',{...accepted,isError:true});
  await expect(registry.observe('binding-a','owner-a',{reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{})).rejects.toThrow('NOT_AUTHORIZED');
  registry.remember('binding-a','owner-a',accepted);now+=30001;
  await expect(registry.observe('binding-a','owner-a',{reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{})).rejects.toThrow('NOT_AUTHORIZED');expect(calls).toBe(0);
});
test('an older owner epoch cannot overwrite a newer native reader grant for the same session',async()=>{
  let calls=0;
  const registry=new ScreenObservationRegistry({observe:async(g,args)=>{
    calls++;return {...observation(args.operation_id),owner_epoch:g.owner_epoch};
  }});
  const newer={...grant,reader_lease:'reader_'+'b'.repeat(64),owner_epoch:grant.owner_epoch+1};
  registry.remember('binding-a','owner-a',{content:[],structuredContent:{ok:true,data:newer}});
  expect(()=>registry.remember('binding-a','owner-a',accepted)).toThrow('SCREEN_READER_STALE_GRANT');
  await expect(registry.observe('binding-a','owner-a',{
    reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{}))
    .rejects.toThrow('NOT_AUTHORIZED');
  await registry.observe('binding-a','owner-a',{
    reader_lease:newer.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{});
  expect(calls).toBe(1);
  // Native epoch numbering is scoped to its attached session. A new native
  // session may legitimately start from a smaller epoch.
  const reattached={...grant,session:randomUUID(),reader_lease:'reader_'+'c'.repeat(64),owner_epoch:1};
  expect(()=>registry.remember('binding-a','owner-a',
    {content:[],structuredContent:{ok:true,data:reattached}})).not.toThrow();
  await expect(registry.observe('binding-a','owner-a',{
    reader_lease:newer.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{}))
    .rejects.toThrow('NOT_AUTHORIZED');
});
test('retirement or expiry during asynchronous native binding validation prevents provider dispatch',async()=>{
  for (const kind of ['rotated','expired'] as const) {
    let now=1000, calls=0, dispatched=0;
    const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>{
      ++calls;return observation(args.operation_id);
    }},()=>now);
    registry.remember('binding-a','owner-a',accepted);
    const current={reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64};
    let releaseValidation=()=>{},notifyEntered=()=>{};
    const validationEntered=new Promise<void>(resolve=>{notifyEntered=resolve;});
    const validationReleased=new Promise<void>(resolve=>{releaseValidation=resolve;});
    const pending=registry.observe('binding-a','owner-a',current,async()=>{
      notifyEntered();await validationReleased;
    },undefined,()=>{dispatched++;});
    await validationEntered;
    if(kind==='rotated') {
      registry.remember('binding-a','owner-a',{content:[],structuredContent:{ok:true,
        data:{...grant,reader_lease:'reader_'+'b'.repeat(64),owner_epoch:grant.owner_epoch+1}}});
    } else now+=grant.expires_in_ms;
    releaseValidation();
    await expect(pending)
      .rejects.toThrow('SCREEN_READER_STALE');
    expect(calls).toBe(0);
    expect(dispatched).toBe(0);
  }
});
test('image payloads and undeclared node/capture fields are rejected before publication',async()=>{
  for(const mutate of [
    (value:Record<string,unknown>)=>({...value,image_payload:'SENSITIVE'}),
    (value:Record<string,unknown>)=>({...value,nodes:[{...(value.nodes as Array<object>)[0],secret_value:'SENSITIVE'}]}),
    (value:Record<string,unknown>)=>({...value,capture:{...(value.capture as object),png_base64:'SENSITIVE'}}),
  ]) {
    const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>mutate(observation(args.operation_id))});
    registry.remember('binding-a','owner-a',accepted);
    await expect(registry.observe('binding-a','owner-a',{reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64},async()=>{})).rejects.toThrow();
  }
});
test('semantic readiness must reference the final frame and preserve the requested ROI',async()=>{
  const readiness={mode:'ui_ready' as const,region:{x:10,y:10,width:40,height:20},contains:'HUD'};
  for(const [sameFrame,query] of [[false,'HUD'],[true,'HUD'],[true,'OTHER']] as const){
    let forwarded:unknown;
    const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>{
      forwarded=(args as Record<string,unknown>).readiness;
      return {...observation(args.operation_id),status:'READY',readiness:{status:'READY',semantic_ready:true,final_frames:1,
        mode:'ui_ready',pixel_stable:false,capture_attempts:1,accepted_samples:1,rejected_samples:0,
        semantic_frame_id:sameFrame?1:2,semantic_generation:1,predicate:'ocr_text_contains',
        predicate_sha256:createHash('sha256').update(query,'utf8').digest('hex'),region:readiness.region,wait_ms:20},
        sources:{cv:{status:'completed',source_count:1,truncated:false},
          uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
            sample_start_ms:1,sample_end_ms:2},
          ocr:{status:'completed',confidence_available:false,frame_id:1,target_generation:1}}};
    }});
    registry.remember('binding-a','owner-a',accepted);
    const observed=registry.observe('binding-a','owner-a',{reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64,readiness},async()=>{});
    if(sameFrame&&query==='HUD'){expect((await observed).status).toBe('READY');expect(forwarded).toEqual(readiness);}
    else await expect(observed).rejects.toThrow('PROTOCOL');
  }
});

test('UTF-8 predicate over the native byte budget cannot record dispatch or invoke the provider',async()=>{
  let providerCalls=0,dispatchReceipts=0;
  const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>{
    providerCalls++;return observation(args.operation_id);
  }});
  registry.remember('binding-a','owner-a',accepted);
  const request={reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64,
    readiness:{mode:'ui_ready' as const,region:{x:10,y:10,width:40,height:20},contains:'界'.repeat(43)}};
  await expect(registry.observe('binding-a','owner-a',request,async()=>{},undefined,()=>{dispatchReceipts++;}))
    .rejects.toThrow('128-byte UTF-8');
  expect(providerCalls).toBe(0);
  expect(dispatchReceipts).toBe(0);
});

test('readiness ROI outside the granted viewport or covering the entire frame is rejected before native dispatch',async()=>{
  let calls=0,dispatchReceipts=0;
  const registry=new ScreenObservationRegistry({observe:async(_grant,args)=>{
    calls++;return {...observation(args.operation_id),
      ...(args.readiness?{readiness:{status:'PARTIAL',semantic_ready:false,final_frames:1,
        mode:'ui_ready',region:args.readiness.region,
        predicate_sha256:createHash('sha256').update(args.readiness.contains,'utf8').digest('hex')}}:{})};
  }});
  registry.remember('roi-binding','roi-owner',accepted);
  const options={reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:64};
  for(const region of [
    {x:90,y:30,width:20,height:10},
    {x:0,y:0,width:100,height:80},
  ]) {
    await expect(registry.observe('roi-binding','roi-owner',{...options,
      readiness:{mode:'ui_ready',region,contains:'HUD'}},async()=>{},undefined,()=>{dispatchReceipts++;}))
      .rejects.toThrow('SCREEN_READER_READINESS_ROI_INVALID');
  }
  expect(calls).toBe(0);
  expect(dispatchReceipts).toBe(0);
  const valid=await registry.observe('roi-binding','roi-owner',{...options,
    readiness:{mode:'ui_ready',region:{x:10,y:10,width:20,height:15},contains:'HUD'}},async()=>{},
    undefined,()=>{dispatchReceipts++;});
  expect(valid.status).toBe('PARTIAL');
  expect(calls).toBe(1);
  expect(dispatchReceipts).toBe(1);
});

async function connection(enabled=true,override?:NativeScreenProvider,nested=false){
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(join(process.platform === 'win32' ? tmpdir() : '/tmp', `cgw-so-${randomUUID()}`),process.platform));
  const token=await broker.register({cwd:process.cwd(),roots:[process.cwd()],writableRoots:[],sandboxPolicy:{type:'readOnly',networkAccess:false},
    tools:nested?[{name:'exec',description:'Native gateway',freeform:true,parameters:{}}]:[{namespace:'mcp__swift',name:'swift_observer_reader_grant',description:'Native authorized reader grant',parameters:{type:'object',properties:{},additionalProperties:false}}]},30000);
  let calls=0;const provider={observe:async(_grant:ScreenReaderGrant,args:{operation_id:string})=>{++calls;return observation(args.operation_id);}};
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,transport:serverTransport,
    ...(enabled?{screenObserver:{provider:override??provider,grantWireName:wire}}:{})});
  const client=new Client({name:'screen-observer-test',version:'1'});await client.connect(clientTransport);
  return {broker,token,server,client,calls:()=>calls};
}
test('MCP observer is opt-in and ungranted input cannot create authority',async()=>{
  for(const enabled of [false,true]){const c=await connection(enabled);try{
    expect((await c.client.listTools()).tools.some(tool=>tool.name==='codex_screen_observe')).toBe(enabled);
    if(enabled){const denied=await c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
      expect(denied.isError).toBe(true);expect(c.calls()).toBe(0);}
  }finally{await c.client.close();await c.server.close();await c.broker.close();}}
});
async function completeGateway(c:Awaited<ReturnType<typeof connection>>,listed=true) {
  const [request]=await c.broker.nextToolBatch(c.token);
  expect(request?.wireName).toBe('exec');
  const emitted:Array<{type:'text';text:string}>=[];
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor as new(...args:string[]) => (...args:unknown[])=>Promise<void>;
  await new AsyncFunction('tools','ALL_TOOLS','text','image','audio','generatedImage',request!.input!)(
    {[wire]:async()=>accepted},listed?[{name:wire,description:'Native authorized reader grant'}]:[],
    (value:unknown)=>emitted.push({type:'text',text:typeof value==='string'?value:JSON.stringify(value)}),
    ()=>{throw new Error('Unexpected image');},()=>{},()=>{});
  c.broker.completeTool(c.token,request!.callId,{content:emitted});
}
test('nested native grant authorizes one observation only while its actual registry still exposes the tool',async()=>{
  const c=await connection(true,undefined,true);try{
    const pending=c.client.callTool({name:'codex_tool_call',arguments:{turn_token:c.token,wire_name:wire,arguments:{}}});
    await completeGateway(c);expect((await pending).isError).not.toBe(true);
    const observed=c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    await completeGateway(c);
    const receipt=await observed;expect(receipt.isError,JSON.stringify(receipt.content)).not.toBe(true);expect(c.calls()).toBe(1);
    const unavailable=c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    await completeGateway(c,false);expect((await unavailable).isError).toBe(true);expect(c.calls()).toBe(1);
  }finally{await c.client.close();await c.server.close();await c.broker.close();}
});
test('raw exec cannot promote a grant-shaped receipt into reader authority',async()=>{
  const c=await connection(true,undefined,true);try{
    const pending=c.client.callTool({name:'codex_tool_call',arguments:{turn_token:c.token,wire_name:'exec',input:'text("diagnostic only");'}});
    const [request]=await c.broker.nextToolBatch(c.token);expect(request?.wireName).toBe('exec');
    c.broker.completeTool(c.token,request!.callId,accepted);await pending;
    const observed=c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    await completeGateway(c);expect((await observed).isError).toBe(true);expect(c.calls()).toBe(0);
  }finally{await c.client.close();await c.server.close();await c.broker.close();}
});
test('one observer MCP call consumes a trusted same-turn grant and returns tree-only',async()=>{
  const c=await connection();try{
    const pending=c.client.callTool({name:'codex_tool_call',arguments:{turn_token:c.token,wire_name:wire,arguments:{}}});
    const [request]=await c.broker.nextToolBatch(c.token);expect(request?.wireName).toBe(wire);
    c.broker.completeTool(c.token,request!.callId,accepted);await pending;
    const observed=await c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    expect(observed.isError,JSON.stringify(observed.content)).not.toBe(true);expect(observed.content).toHaveLength(1);
    expect((observed.content as Array<{type:string}>)[0]!.type).toBe('text');
    const data=observed.structuredContent as Record<string,unknown>;
    expect(data.status).toBe('PARTIAL');expect(data.image_delivery_status).toBe('UNAVAILABLE');expect(c.calls()).toBe(1);
  }finally{await c.client.close();await c.server.close();await c.broker.close();}
});
async function authorize(c:Awaited<ReturnType<typeof connection>>) {
  const pending=c.client.callTool({name:'codex_tool_call',arguments:{turn_token:c.token,wire_name:wire,arguments:{}}});
  const [request]=await c.broker.nextToolBatch(c.token);c.broker.completeTool(c.token,request!.callId,accepted);await pending;
}
test('native policy denial is returned once and retires later tool authority',async()=>{
  let dispatched=0;const c=await connection(true,{observe:async()=>{++dispatched;throw new NativeScreenObservationError('POLICY_DENIED');}});
  try {
    await authorize(c);
    const failed=await c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    expect(failed.isError).toBe(true);expect((failed.structuredContent as {error:{code:string}}).error.code).toBe('POLICY_DENIED');
    const later=await c.client.callTool({name:'codex_tool_call',arguments:{turn_token:c.token,wire_name:wire,arguments:{}}});
    expect(later.isError).toBe(true);expect(dispatched).toBe(1);
  }finally{await c.client.close();await c.server.close();await c.broker.close();}
});
test('a provider-supplied stale-frame error must not masquerade as a locally rejected older frame',async()=>{
  let dispatched=0;
  const c=await connection(true,{observe:async()=>{
    ++dispatched;
    throw new NativeScreenObservationError('SCREEN_READER_STALE_FRAME');
  }});
  try {
    await authorize(c);
    const failed=await c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    expect(failed.isError).toBe(true);
    expect((failed.structuredContent as {error:{code:string}}).error.code).toBe('SCREEN_READER_STALE_FRAME');
    const later=await c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    expect(later.isError).toBe(true);
    expect(dispatched).toBe(1);
  }finally{await c.client.close();await c.server.close();await c.broker.close();}
});
test('retired broker binding suppresses an otherwise valid late native observer result',async()=>{
  let complete!:(value:Record<string,unknown>)=>void,started!:(value:string)=>void;
  const running=new Promise<string>(resolve=>{started=resolve;});
  const c=await connection(true,{observe:async(_grant,args)=>{started(args.operation_id);return new Promise(resolve=>{complete=resolve;});}});
  try {
    await authorize(c);
    const pending=c.client.callTool({name:'codex_screen_observe',arguments:{turn_token:c.token,reader_lease:grant.reader_lease}});
    const operation=await running;c.broker.revoke(c.token);complete(observation(operation));
    const rejected=await pending;expect(rejected.isError).toBe(true);
    expect((rejected.structuredContent as Record<string,unknown>|undefined)?.status).not.toBe('PARTIAL');
  }finally{await c.client.close();await c.server.close();await c.broker.close();}
});
