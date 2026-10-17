import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {BlockedOperationLedger} from '../src/adapters/chatgpt-web/blocked-operation-ledger';
import {createChatGptMcpServer} from '../src/adapters/chatgpt-web/mcp-server';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';

async function fixture(safe=false){
 const dir=mkdtempSync(join(tmpdir(),'cgw-review-mcp-')),file=join(dir,'ledger.json');
 const ledger=new BlockedOperationLedger(file),scope={cwd:process.cwd(),roots:[process.cwd()]};
 const record=ledger.recordSafetyRefusal({tool:'exec_command',arguments:{cmd:'PRIVATE_INERT_COMMAND'},owner:'fixture-previous-binding',targetScope:scope,affectedGoalRequirement:'SAFE-P0-02'});
 const broker=TurnBroker.forSocket(defaultBrokerEndpoint(join(tmpdir(),`review-${crypto.randomUUID()}`)));
 const environment={...scope,writableRoots:[],sandboxPolicy:{type:'readOnly' as const,networkAccess:false},tools:[]};
 const token=safe?await broker.registerSafe(environment,'n'.repeat(43)):await broker.register(environment,30000);
 if(safe)broker.confirmSafeTurnSent(token,'n'.repeat(43)); // Simulated manual Send receipt, no browser action.
 const [ct,st]=InMemoryTransport.createLinkedPair();
 const server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,contract:safe?'safe':'native',transport:st,blockedOperationLedger:ledger});
 const client=new Client({name:'read-only-review-fixture',version:'1'});await client.connect(ct);
 return {ledger,file,record,broker,token,client,ref:safe?{request_id:token}:{turn_token:token},close:async()=>{await client.close();await server.close();await broker.close();rmSync(dir,{recursive:true,force:true});}};
}
async function reviewPage(f:Awaited<ReturnType<typeof fixture>>,args:Record<string,unknown>,reserved:boolean){
 return CallToolResultSchema.parse(await f.client.callTool(reserved
  ?{name:'codex_tool_call',arguments:{...f.ref,wire_name:'codex.control.safety_review',arguments:args}}
  :{name:'codex_safety_review',arguments:{...f.ref,...args}}));
}
test.each([false,true])('direct and reserved review share one scoped read without native execution; reserved=%s',async reserved=>{
 const f=await fixture();try{
  const inventory=await f.client.listTools(),tool=inventory.tools.find(tool=>tool.name==='codex_safety_review');
  expect(tool?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  expect(inventory.tools.find(tool=>tool.name==='codex_tool_call')?.description).toContain('codex.control.safety_review');
  const description=inventory.tools.find(tool=>tool.name==='codex_tool_call')?.description??'';
  expect(description.indexOf("Use only that request's issued control token")).toBeLessThan(description.indexOf('This connector also implements reserved codex.control.safety_review'));
  const before=readFileSync(f.file,'utf8');
  const response=CallToolResultSchema.parse(await f.client.callTool(reserved
   ?{name:'codex_tool_call',arguments:{...f.ref,wire_name:'codex.control.safety_review',arguments:{limit:1}}}
   :{name:'codex_safety_review',arguments:{...f.ref,limit:1}}));
  expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toMatchObject({status:'review_required',unresolved_count:1,retry_allowed:false,advisory_only:true,complete:true});
  expect((response.structuredContent as any).entries[0].blocker_id).toBe(f.record.blocker_id);
  expect(JSON.stringify(response)).not.toContain('PRIVATE_INERT_COMMAND');
  expect(readFileSync(f.file,'utf8')).toBe(before);
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
},10000);
test('retired binding and unknown arguments cannot read or resolve a ledger entry',async()=>{
 const f=await fixture();try{
  let reads=0;const original=f.ledger.unresolved.bind(f.ledger);f.ledger.unresolved=()=>{reads++;return original();};
  const invalid=CallToolResultSchema.parse(await f.client.callTool({name:'codex_safety_review',arguments:{...f.ref,resolution:'VERIFIED_COMPLETED'}}));
  expect(invalid.isError).toBe(true);expect(reads).toBe(0);
  await f.broker.revoke(f.token);
  const retired=CallToolResultSchema.parse(await f.client.callTool({name:'codex_safety_review',arguments:f.ref}));
  expect(retired.isError).toBe(true);expect(reads).toBe(0);
  expect(original()).toHaveLength(1);
 }finally{await f.close();}
},10000);
test('safe-contract review requires the existing manual start and settles its activity',async()=>{
 const f=await fixture(true);try{
  const early=CallToolResultSchema.parse(await f.client.callTool({name:'codex_safety_review',arguments:f.ref}));
  expect(early.isError).toBe(true);
  await f.client.callTool({name:'codex_turn_start',arguments:f.ref});
  const review=CallToolResultSchema.parse(await f.client.callTool({name:'codex_safety_review',arguments:f.ref}));
  expect(review.isError).not.toBe(true);expect(review.structuredContent).toMatchObject({unresolved_count:1,retry_allowed:false});
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
},10000);

test('actual MCP stdio restart resumes a scoped review page without execution or ledger mutation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cgw-review-stdio-')),home=join(dir,'isolated-home'),file=join(home,'runtime','blocked-operations.json');
 const ledger=new BlockedOperationLedger(file),scope={cwd:dir,roots:[dir]};
 const ids=Array.from({length:23},(_,i)=>ledger.recordSafetyRefusal({tool:'exec_command',arguments:{cmd:`PRIVATE_FIXTURE_${i}`},owner:'fixture',targetScope:scope,affectedGoalRequirement:'SAFE-P0-02'}).blocker_id);
 const before=readFileSync(file,'utf8'),broker=TurnBroker.forSocket(defaultBrokerEndpoint(join(dir,'broker')));
 const token=await broker.register({...scope,writableRoots:[],sandboxPolicy:{type:'readOnly',networkAccess:false},tools:[]},30000);
 let page:any;const reviewed:string[]=[];
 try{
  for(let iteration=0;iteration<2;iteration++){
   const transport=new StdioClientTransport({command:process.execPath,args:['src/cli.ts','mcp','--broker-socket',broker.socketPath],cwd:process.cwd(),env:{CODEX_CHATGPT_WEB_HOME:home},stderr:'pipe'});
   const client=new Client({name:'stdio-review-restart-fixture',version:'1'});
   try{
    await client.connect(transport);expect(transport.pid).toBeNumber();expect(transport.pid).not.toBe(process.pid);
    const response=CallToolResultSchema.parse(await client.callTool({name:'codex_safety_review',arguments:{turn_token:token,...(iteration?{offset:page.next_offset,snapshot_sha256:page.snapshot_sha256}:{})}}));
    expect(response.isError).not.toBe(true);page=response.structuredContent;
    expect(page.retry_allowed).toBe(false);expect(page.unresolved_count).toBe(23);
    reviewed.push(...page.entries.map((entry:any)=>entry.blocker_id));
    expect(broker.beginCompletionFence(token)).toBeNumber();
   }finally{await client.close();expect(transport.pid).toBeNull();}
  }
  expect(page.complete).toBe(true);expect(reviewed).toEqual(ids);expect(readFileSync(file,'utf8')).toBe(before);
 }finally{await broker.close();rmSync(dir,{recursive:true,force:true});}
},20000);

test.each([false,true])('another workspace is represented only by an aggregate count; reserved=%s',async reserved=>{
 const f=await fixture();try{
  const otherScope={cwd:'C:/PRIVATE_OTHER_WORKSPACE',roots:['C:/PRIVATE_OTHER_WORKSPACE']};
  const other=f.ledger.recordSafetyRefusal({tool:'exec_command',arguments:{cmd:'OTHER_PRIVATE_ARGUMENT_SENTINEL'},owner:'other-workspace-fixture',targetScope:otherScope,affectedGoalRequirement:'SAFE-P0-02'});
  const before=readFileSync(f.file,'utf8'),response=await reviewPage(f,{limit:50},reserved);
  const content=JSON.stringify(response);
  expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toMatchObject({status:'review_required',unresolved_count:1,other_scope_unresolved_count:1});
  expect((response.structuredContent as any).entries.map((entry:any)=>entry.blocker_id)).toEqual([f.record.blocker_id]);
  expect(content).not.toContain(other.blocker_id);
  expect(content).not.toContain('OTHER_PRIVATE_ARGUMENT_SENTINEL');
  expect(content).not.toContain('PRIVATE_OTHER_WORKSPACE');
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
  expect(readFileSync(f.file,'utf8')).toBe(before);
  f.ledger.resolve(f.record.blocker_id,'NO_LONGER_REQUIRED','Synthetic fixture owning-scope prerequisite removed; not a real approval');
  const afterFixtureResolution=readFileSync(f.file,'utf8'),otherOnly=await reviewPage(f,{},reserved);
  expect(otherOnly.isError).not.toBe(true);
  expect(otherOnly.structuredContent).toMatchObject({status:'other_scope_pending',unresolved_count:0,other_scope_unresolved_count:1,entries:[],complete:true,retry_allowed:false});
  expect(readFileSync(f.file,'utf8')).toBe(afterFixtureResolution);
 }finally{await f.close();}
},10000);

test.each([false,true])('a changed page snapshot fails empty, settles activity, and a fresh review reaches all pending entries; reserved=%s',async reserved=>{
 const f=await fixture();try{
  const ids=[f.record.blocker_id];
  for(let index=1;index<23;index++)ids.push(f.ledger.recordSafetyRefusal({
   tool:'exec_command',arguments:{cmd:`PAGE_FIXTURE_${index}`},owner:'page-fixture',targetScope:{cwd:process.cwd(),roots:[process.cwd()]},affectedGoalRequirement:'SAFE-P0-02',
  }).blocker_id);
  const first=await reviewPage(f,{limit:1},reserved);
  expect(first.isError).not.toBe(true);
  const firstPage=first.structuredContent as any;
  expect(firstPage.entries).toHaveLength(1);
  const added=f.ledger.recordSafetyRefusal({tool:'exec_command',arguments:{cmd:'PAGE_FIXTURE_ADDED'},owner:'page-fixture',targetScope:{cwd:process.cwd(),roots:[process.cwd()]},affectedGoalRequirement:'SAFE-P0-02'});
  ids.push(added.blocker_id);
  const stale=await reviewPage(f,{offset:1,limit:1,snapshot_sha256:firstPage.snapshot_sha256},reserved);
  expect(stale.isError).toBe(true);
  expect(stale.structuredContent).toMatchObject({status:'snapshot_changed',unresolved_count:24,entries:[]});
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();

  const fresh=await reviewPage(f,{limit:50},reserved);
  expect(fresh.isError).not.toBe(true);
  expect((fresh.structuredContent as any).entries.map((entry:any)=>entry.blocker_id)).toEqual(ids);
  expect((fresh.structuredContent as any).complete).toBe(true);
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
},10000);

test.each([false,true])('a corrupt ledger returns unavailable without clear status, counts, or raw corruption text; reserved=%s',async reserved=>{
 const f=await fixture();try{
  const raw='CORRUPT_LEDGER_PRIVATE_SENTINEL { definitely not json';
  writeFileSync(f.file,raw);
  const response=await reviewPage(f,{},reserved);
  const review=response.structuredContent as any;
  expect(response.isError).toBe(true);
  expect(review.status).toBe('unavailable');
  expect(review.status).not.toBe('clear');
  expect(review.unresolved_count).toBeUndefined();
  expect(review.entries).toEqual([]);
  expect(JSON.stringify(response)).not.toContain(raw);
  expect(JSON.stringify(response)).not.toContain('CORRUPT_LEDGER_PRIVATE_SENTINEL');
  expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
 }finally{await f.close();}
},10000);
