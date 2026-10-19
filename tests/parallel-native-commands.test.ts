import {test,expect} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {createChatGptMcpServer} from '../src/adapters/chatgpt-web/mcp-server';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import type {BrokerToolRequest} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const execTool={name:'exec_command',description:'Native command',parameters:{type:'object',properties:{
 cmd:{type:'string'},workdir:{type:'string'},yield_time_ms:{type:'integer'},max_output_tokens:{type:'integer'},tty:{type:'boolean'},
}}};
async function connected(tools:any[]=[execTool]){
 const broker=TurnBroker.forSocket(defaultBrokerEndpoint(join(process.platform === 'win32' ? tmpdir() : '/tmp', `cgw-p-${crypto.randomUUID()}`),process.platform));
 const token=await broker.register({cwd:process.cwd(),roots:[process.cwd()],writableRoots:[],sandboxPolicy:{type:'readOnly',networkAccess:false},
  tools},30000);
 const [ct,st]=InMemoryTransport.createLinkedPair();
 const server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,transport:st});
 const client=new Client({name:'parallel-fixture',version:'1'});await client.connect(ct);
 expect((await client.listTools()).tools.some(tool=>tool.name==='codex_parallel_exec')).toBe(true);
 return {broker,token,client,close:async()=>{await client.close();await server.close();await broker.close();}};
}
const commands=(count:number)=>Array.from({length:count},(_,i)=>({cmd:`Get-Content -LiteralPath 'fixture-${i}.txt' -Raw`,yield_time_ms:250}));
async function collectRequests(f:Awaited<ReturnType<typeof connected>>,count:number){
 const distinct=new Map<string,BrokerToolRequest>();
 while(distinct.size<count){
  for(const request of await f.broker.nextToolBatch(f.token))distinct.set(request.callId,request);
  // owner_next legitimately replays delivered uncompleted requests. Give the other
  // accepted pipe peers time to queue; count unique native call identities only.
  if(distinct.size<count)await new Promise(resolve=>setTimeout(resolve,5));
 }
 return [...distinct.values()];
}
const call=(f:Awaited<ReturnType<typeof connected>>,reserved:boolean,items:Record<string,unknown>[]=commands(8))=>f.client.callTool(reserved
 ?{name:'codex_tool_call',arguments:{turn_token:f.token,wire_name:'codex.control.parallel_exec',arguments:{commands:items}}}
 :{name:'codex_parallel_exec',arguments:{turn_token:f.token,commands:items}}).then(value=>CallToolResultSchema.parse(value));

const nativeRegistry=[{name:'exec_command',description:'Native command\n```ts\ndeclare const tools: { exec_command(args: { cmd: string; workdir?: string; yield_time_ms?: number; max_output_tokens?: number; tty?: boolean; }): Promise<unknown>; };\n```'}];
async function executeGateway(request:BrokerToolRequest,registry=nativeRegistry,tool:((args:any)=>Promise<any>)=async args=>({output:args.cmd,exit_code:0})){
 const content:any[]=[];
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 try{
  await new AsyncFunction('ALL_TOOLS','tools','text','image','audio',request.input!)(registry,{exec_command:tool},
   (v:unknown)=>content.push({type:'text',text:typeof v==='string'?v:JSON.stringify(v)}),
   (v:unknown)=>content.push(v),(v:unknown)=>content.push(v));
  return {content};
 }catch(error){return {content:[{type:'text',text:String(error)}],isError:true};}
}

test.each([false,true])('nested gateway discovers native schema then dispatches eight separately; reserved=%s',async reserved=>{
 const f=await connected([{name:'exec',description:'Native gateway',parameters:{},freeform:true}]);
 try{
  const pending=call(f,reserved);
  const discovery=await f.broker.nextToolBatch(f.token,AbortSignal.timeout(1000)).catch(()=>[]);
  expect(discovery).toHaveLength(1);
  expect(discovery[0]!.wireName).toBe('exec');
  await f.broker.completeTool(f.token,discovery[0]!.callId,await executeGateway(discovery[0]!));
  const requests=await Promise.race([collectRequests(f,8),pending.then(result=>{throw Error('Batch completed before child dispatch: '+JSON.stringify(result));})]);
  expect(new Set(requests.map(r=>r.callId)).size).toBe(8);
  let invocations=0;
  for(const request of requests){
   expect(request.wireName).toBe('exec');
   await f.broker.completeTool(f.token,request.callId,await executeGateway(request,nativeRegistry,async args=>{
    invocations++;expect(args.yield_time_ms).toBe(250);return {output:args.cmd,exit_code:0};
   }));
  }
  expect(invocations).toBe(8);
  expect((await pending).isError).toBe(false);
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
});

test.each(['missing','duplicate','wrong-type','required-option','unsupported-option'] as const)('nested schema %s rejects the entire batch before child dispatch',async change=>{
 const f=await connected([{name:'exec',description:'Native gateway',parameters:{},freeform:true}]);
 try{
  const items:Record<string,unknown>[]=commands(2);
  if(change==='unsupported-option')items[1]!.tty=false;
  let registry=structuredClone(nativeRegistry);
  if(change==='missing')registry=[];
  if(change==='duplicate')registry.push(registry[0]!);
  if(change==='wrong-type')registry[0]!.description=registry[0]!.description.replace('yield_time_ms?: number','yield_time_ms?: string');
  if(change==='required-option')registry[0]!.description=registry[0]!.description.replace('workdir?: string','workdir: string');
  if(change==='unsupported-option')registry[0]!.description=registry[0]!.description.replace('tty?: boolean;','');
  const pending=call(f,false,items);
  const discovery=await f.broker.nextToolBatch(f.token,AbortSignal.timeout(1000));
  expect(discovery).toHaveLength(1);
  await f.broker.completeTool(f.token,discovery[0]!.callId,await executeGateway(discovery[0]!,registry));
  const result=await pending;expect(result.isError).toBe(true);
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
});

test.each([false,true])('eight separate broker invocations overlap before any completion; reserved=%s',async reserved=>{
 const f=await connected();try{
  const pending=call(f,reserved);const requests=await collectRequests(f,8);
  expect(requests).toHaveLength(8);expect(new Set(requests.map(r=>r.callId)).size).toBe(8);
  expect(f.broker.beginCompletionFence(f.token)).toBeUndefined();
  const ordered=[...requests].sort((a,b)=>commands(8).findIndex(c=>c.cmd===a.arguments?.cmd)-commands(8).findIndex(c=>c.cmd===b.arguments?.cmd));
  for(const [i,r] of ordered.entries()){
   expect(r.wireName).toBe('exec_command');expect(r.arguments).toEqual(commands(8)[i]);
   expect(r.arguments).not.toHaveProperty('sandbox_permissions');
  }
  for(const [i,r] of [...ordered.entries()].reverse())await f.broker.completeTool(f.token,r.callId,{
   isError:i===3,content:[{type:'text',text:`receipt-${i}`}],structuredContent:{session_id:100+i},_meta:{index:i}});
  const result=await pending,receipt=result.structuredContent as any;
  expect(result.isError).toBe(true);expect(receipt).toMatchObject({parallel:true,command_count:8,succeeded:7,failed:1});
  expect(receipt.commands.map((r:any)=>r.index)).toEqual([0,1,2,3,4,5,6,7]);
  for(const [i,r] of receipt.commands.entries())expect(r.result).toEqual({isError:i===3,content:[{type:'text',text:`receipt-${i}`}],structuredContent:{session_id:100+i},_meta:{index:i}});
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
});

test('overlapping native parallel batches attribute later batch sessions to their own lease',async()=>{
 const f=await connected();try{
  const first=call(f,false,commands(2));
  const laterCommands=[{cmd:'Get-Content -LiteralPath later-a.txt -Raw'},{cmd:'Get-Content -LiteralPath later-b.txt -Raw'}];
  const second=call(f,true,laterCommands);
  // Both batches must reach the broker before its first owner delivery, which
  // otherwise replays an uncompleted earlier batch ahead of newly queued calls.
  await new Promise(resolve=>setTimeout(resolve,100));
  const requests=await f.broker.nextToolBatch(f.token);
  expect(requests).toHaveLength(4);
  const firstRequests=requests.filter(request=>(request.arguments?.cmd as string).includes('fixture-'));
  const secondRequests=requests.filter(request=>(request.arguments?.cmd as string).includes('later-'));
  expect(firstRequests).toHaveLength(2);expect(secondRequests).toHaveLength(2);
  for(const [index,request] of secondRequests.entries())await f.broker.completeTool(f.token,request.callId,{
   content:[{type:'text',text:'later'}],structuredContent:{session_id:700+index}});
  const secondResult=await second;
  expect(secondResult.isError).toBe(false);
  expect((secondResult.structuredContent as any).commands.every((child:any)=>child.status==='succeeded')).toBe(true);
  for(const [index,request] of firstRequests.entries())await f.broker.completeTool(f.token,request.callId,{
   content:[{type:'text',text:'earlier'}],structuredContent:{session_id:800+index}});
  expect((await first).isError).toBe(false);
  // All four running native sessions must still count against the same owner.
  expect((await call(f,true,commands(5))).isError).toBe(true);
 }finally{await f.close();}
});

test.each([false,true])('parallel command options keep their native names and values; reserved=%s',async reserved=>{
 const f=await connected();try{
  const items=commands(2).map((command,index)=>({...command,workdir:`/workspace/${index}`,max_output_tokens:1200+index,tty:false}));
  const pending=call(f,reserved,items),requests=await collectRequests(f,2);
  for(const [index,request] of requests.entries()){
   expect(request.wireName).toBe('exec_command');expect(request.arguments).toEqual(items[index]);
   expect(request.arguments).not.toHaveProperty('timeout_ms');
  }
  for(const request of requests)await f.broker.completeTool(f.token,request.callId,{content:[{type:'text',text:'done'}]});
  expect((await pending).isError).toBe(false);
 }finally{await f.close();}
});

test('shell-only interface preserves supported fields and rejects yield time when only hard timeout is advertised',async()=>{
 const shell={name:'shell_command',description:'Legacy native shell',parameters:{type:'object',properties:{
  command:{type:'string'},workdir:{type:'string'},max_output_tokens:{type:'integer'},tty:{type:'boolean'},timeout_ms:{type:'integer'},
 }}};
 const f=await connected([shell]);try{
  const items=commands(2).map((command,index)=>({cmd:command.cmd,workdir:`/workspace/${index}`,max_output_tokens:800+index,tty:false}));
  const pending=call(f,true,items),requests=await collectRequests(f,2);
  for(const [index,request] of requests.entries()){
   expect(request.wireName).toBe('shell_command');
   expect(request.arguments).toEqual({command:items[index]!.cmd,workdir:items[index]!.workdir,max_output_tokens:items[index]!.max_output_tokens,tty:false});
  }
  for(const request of requests)await f.broker.completeTool(f.token,request.callId,{content:[{type:'text',text:'done'}]});
  expect((await pending).isError).toBe(false);

  const unsupported=await call(f,true,commands(2));expect(unsupported.isError).toBe(true);
  expect(unsupported.content.map((item:any)=>item.text).join('\n')).toContain('not equivalent to yield_time_ms');
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
});

test('unsupported fields reject before dispatch and native exec remains preferred over legacy shell',async()=>{
 const incomplete={name:'exec_command',description:'Limited command',parameters:{type:'object',properties:{cmd:{type:'string'},yield_time_ms:{type:'integer'}}}};
 const f=await connected([incomplete]);try{
  const result=await call(f,false,commands(2).map(command=>({...command,max_output_tokens:2000})));
  expect(result.isError).toBe(true);expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
 const both=await connected([execTool,{...execTool,name:'shell_command',parameters:{type:'object',properties:{command:{type:'string'}}}}]);try{
  const pending=call(both,false,commands(2)),requests=await collectRequests(both,2);
  for(const request of requests){expect(request.wireName).toBe('exec_command');await both.broker.completeTool(both.token,request.callId,{content:[{type:'text',text:'done'}]});}
  expect((await pending).isError).toBe(false);
 }finally{await both.close();}
 const duplicate=await connected([execTool,execTool]);try{
  const result=await call(duplicate,false,commands(2));expect(result.isError).toBe(true);
  expect(duplicate.broker.beginCompletionFence(duplicate.token)).toBeNumber();
 }finally{await duplicate.close();}
});

test('invalid sizing, escalation, mutable/compound/interactive commands reject before child dispatch',async()=>{
 const f=await connected();try{
  for(const reserved of [false,true])for(const items of [commands(1),commands(9),
   [{...commands(2)[0]!,sandbox_permissions:'require_escalated'},commands(2)[1]!],
   [{cmd:'Remove-Item fixture.txt'},commands(2)[1]!],
   [{cmd:'Get-Content a.txt; Get-Content b.txt'},commands(2)[1]!],
   [{cmd:'rg --pre evil pattern .'},commands(2)[1]!],
   [{...commands(2)[0]!,tty:true},commands(2)[1]!]]){
   const result=await call(f,reserved,items);expect(result.isError).toBe(true);
   expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
  }
 }finally{await f.close();}
});

test('one owner cannot exceed eight active commands across concurrent batches',async()=>{
 const f=await connected();try{
  const first=call(f,false),requests=await collectRequests(f,8);
  const second=await call(f,true,commands(2));expect(second.isError).toBe(true);
  expect(f.broker.beginCompletionFence(f.token)).toBeUndefined();
  for(const r of requests)await f.broker.completeTool(f.token,r.callId,{content:[{type:'text',text:'done'}],isError:false});
  expect((await first).isError).toBe(false);
  const third=call(f,true,commands(2)),next=await collectRequests(f,2);
  for(const r of next)await f.broker.completeTool(f.token,r.callId,{content:[{type:'text',text:'done'}]});
  expect((await third).isError).toBe(false);
 }finally{await f.close();}
});

test('aggregate keeps image items out of serialized text while preserving child metadata',async()=>{
 const f=await connected();try{
  const pending=call(f,false,commands(2)),requests=await collectRequests(f,2);
  const image={type:'image' as const,mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='};
  await f.broker.completeTool(f.token,requests[0]!.callId,{content:[{type:'text',text:'frame'},image],isError:false,_meta:{trace_id:'child-0'}});
  await f.broker.completeTool(f.token,requests[1]!.callId,{content:[{type:'text',text:'done'}],isError:false});
  const result=await pending;expect(result.content.filter(r=>r.type==='image')).toEqual([image]);
  expect(result.content.filter(r=>r.type==='text').map(r=>(r as any).text).join('\n')).not.toContain(image.data);
  expect((result.structuredContent as any).commands[0].result._meta).toEqual({trace_id:'child-0'});
  expect(JSON.stringify(result.structuredContent)).not.toContain(image.data);
 }finally{await f.close();}
});

test('mutable ordinary commands cannot overlap active parallel reads',async()=>{
 const f=await connected();try{
  const pending=call(f,false,commands(2)),requests=await collectRequests(f,2);
  const write=await f.client.callTool({name:'codex_exec',arguments:{turn_token:f.token,cmd:"Set-Content -LiteralPath fixture-0.txt -Value changed"}},CallToolResultSchema,{signal:AbortSignal.timeout(1000)});
  expect(write.isError).toBe(true);
  for(const r of requests)await f.broker.completeTool(f.token,r.callId,{content:[{type:'text',text:'done'}],isError:false});
  expect((await pending).isError).toBe(false);
 }finally{await f.close();}
});

test('live native session receipts retain capacity until a terminal poll receipt',async()=>{
 const f=await connected();try{
  const pending=call(f,false),requests=await collectRequests(f,8);
  for(const [i,r] of requests.entries())await f.broker.completeTool(f.token,r.callId,{content:[{type:'text',text:'still running'}],isError:false,structuredContent:{session_id:900+i}});
  expect((await pending).isError).toBe(false);
  const blocked=await call(f,true,commands(2));expect(blocked.isError).toBe(true);
 }finally{await f.close();}
});

test('generic native command calls share the batch capacity without retiring its active children',async()=>{
 const f=await connected();try{
  const pending=call(f,false),requests=await collectRequests(f,8);
  const overflow=f.client.callTool({name:'codex_tool_call',arguments:{turn_token:f.token,wire_name:'exec_command',arguments:{cmd:'Get-Content -LiteralPath a.txt'}}},CallToolResultSchema,{signal:AbortSignal.timeout(1000)});
  // A rejected ninth call is an admission result, not evidence that the eight calls stopped.
  const observed=await overflow;expect(observed.isError).toBe(true);
  for(const r of requests)await f.broker.completeTool(f.token,r.callId,{content:[{type:'text',text:'done'}],isError:false});
  expect((await pending).isError).toBe(false);
 }finally{await f.close();}
});

test('parallel task commands are rejected during the control-only compaction phase',async()=>{
 const f=await connected();try{
  f.broker.requestCompaction(f.token,{content:[{type:'text',text:'compaction control receipt'}],isError:false});
  for(const reserved of [false,true]){
   const result=await call(f,reserved,commands(2));expect(result.isError).toBe(true);
   expect(f.broker.compactionDeliveryCount(f.token)).toBe(0);
  }
 }finally{await f.close();}
});
