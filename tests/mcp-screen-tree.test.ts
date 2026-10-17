import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createChatGptMcpServer} from '../src/adapters/chatgpt-web/mcp-server';
import type {NativeScreenProvider} from '../src/adapters/chatgpt-web/screen-observation';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';

const grantWire='mcp__fixture__swift_observer_reader_grant';
async function bounded<T>(p:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Screen tree fixture deadline')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}}
async function fixture(run:(f:{client:Client;token:string;lease:string;calls:Record<string,unknown>[];mutate:(value:Record<string,unknown>)=>void;authorize:()=>Promise<void>;revokeAfterDispatch:()=>void})=>Promise<void>){
 const parent=realpathSync(process.platform==='win32'?tmpdir():'/tmp'),root=mkdtempSync(join(parent,'cgw-tree-'));
 const broker=TurnBroker.forSocket(defaultBrokerEndpoint(root));
 const [ct,st]=InMemoryTransport.createLinkedPair(),client=new Client({name:'screen-tree-fixture',version:'1'});
 let server:Awaited<ReturnType<typeof createChatGptMcpServer>>|undefined;
 try{
  const region={x:10,y:20,width:200,height:100};
  const grant={observer_protocol:1,reader_lease:'reader_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),
   session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),owner_epoch:1,
   expires_in_ms:30000,region,observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
  const calls:Record<string,unknown>[]=[],changes:Record<string,unknown>={};let afterDispatch:(()=>void)|undefined;
  const provider:NativeScreenProvider={observe:async(g,args)=>{
   calls.push(structuredClone(args));afterDispatch?.();return {observer_protocol:1,operation_id:args.operation_id,session:g.session,hwnd:g.hwnd,pid:g.pid,
    owner_epoch:g.owner_epoch,region:g.region,status:'PARTIAL',image_encoded:false,image_delivery_status:'UNAVAILABLE',frame_id:7,target_generation:4,
    nodes:[{source:'uia',id:'root',parent_id:null,role:'Window',name:'Fixture',bounds:{x:10,y:20,width:200,height:100},pixel_correspondence:'unverified'},
     {source:'uia',id:'button',parent_id:'root',role:'Button',name:'Mở',patterns:['Invoke'],bounds:{x:10,y:20,width:100,height:20},pixel_correspondence:'unverified'},
     {source:'ocr',id:'text',role:'text',name:'Chào 世界',confidence:null,confidence_status:'unavailable',bounds:{x:20,y:50,width:100,height:20},frame_id:7,target_generation:4},
     {source:'cv',id:'cv',role:'visual_region',name:'',confidence:0.8,bounds:{x:120,y:50,width:40,height:30},frame_id:7,target_generation:4}],
    sources:{cv:{status:'completed',source_count:1,truncated:false},uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',sample_start_ms:501,sample_end_ms:509},
     ocr:{status:'completed',confidence_available:false,language:'vi-VN',frame_id:7,target_generation:4}},...changes};
  }};
  const token=await broker.register({cwd:root,roots:[root],writableRoots:[],sandboxPolicy:{type:'readOnly',networkAccess:false},
   tools:[{namespace:'mcp__fixture',name:'swift_observer_reader_grant',description:'Synthetic read-only grant fixture',parameters:{}}]},30000,'screen-tree');
  server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,transport:st,screenObserver:{provider,grantWireName:grantWire}});
  await bounded(client.connect(ct));
  const authorize=async()=>{
   const pending=client.callTool({name:'codex_tool_call',arguments:{turn_token:token,wire_name:grantWire,arguments:{}}});void pending.catch(()=>{});
   const [request]=await bounded(broker.nextToolBatch(token));expect(request?.wireName).toBe(grantWire);
   broker.completeTool(token,request!.callId,{content:[],structuredContent:{ok:true,data:grant}});
   expect((await bounded(pending)).isError).not.toBe(true);
  };
  await run({client,token,lease:grant.reader_lease,calls,mutate:value=>Object.assign(changes,value),authorize,revokeAfterDispatch:()=>{afterDispatch=()=>broker.revoke(token);}});
 }finally{
  const cleanup=await Promise.allSettled([client.close(),server?.close(),broker.close()]);
  const canonical=realpathSync(root);
  if(canonical!==resolve(root)||dirname(canonical)!==parent||!basename(canonical).startsWith('cgw-tree-'))throw Error('Refusing non-owned tree fixture cleanup');
  rmSync(canonical,{recursive:true,force:true});
  const failed=cleanup.find(x=>x.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 }
}
const call=(client:Client,token:string,lease:string,format?:string)=>bounded(client.callTool({name:'codex_screen_observe',
 arguments:{turn_token:token,reader_lease:lease,...(format?{tree_format:format}:{})}},undefined,{timeout:5000,maxTotalTimeout:5000}));

test('omitted format preserves legacy observer payload and native arguments',async()=>{
 await fixture(async f=>{await f.authorize();const r=await call(f.client,f.token,f.lease);
  expect(r.isError).not.toBe(true);expect(r.structuredContent).toHaveProperty('nodes');
  expect(r.structuredContent).not.toHaveProperty('tree');expect(f.calls).toHaveLength(1);expect(f.calls[0]).not.toHaveProperty('tree_format');
 });
});
test('MCP both format exposes a bounded source-aware tree after an authenticated grant',async()=>{
 await fixture(async f=>{await f.authorize();const listed=await bounded(f.client.listTools());
  expect(listed.tools.find(t=>t.name==='codex_screen_observe')?.inputSchema.properties).toHaveProperty('tree_format');
  const r=await call(f.client,f.token,f.lease,'both');expect(r.isError).not.toBe(true);
  const body=r.structuredContent as Record<string,any>;expect(body.tree).toBeDefined();
  expect(body.tree.frame_id).toBe(7);expect(body.tree.target_generation).toBe(4);expect(body.tree.coordinate_space).toBe('authorized_viewport');
  expect(body.tree.nodes).toHaveLength(4);expect(body.tree.compact).toContain('Chào 世界');
  for(const n of body.tree.nodes)expect(body.tree.compact).toContain(n.ephemeral_id);
  expect(Buffer.byteLength(JSON.stringify(body.tree),'utf8')).toBeLessThanOrEqual(16384);
  expect(body.image_delivery_status).toBe('UNAVAILABLE');expect(body.image_encoded).toBe(false);
  expect(body.status).toBe('PARTIAL');expect(JSON.stringify(body.tree)).toContain('after_final_frame');expect(JSON.stringify(body.tree)).toContain('unverified');
  expect(f.calls).toHaveLength(1);expect(f.calls[0]).not.toHaveProperty('tree_format');
 });
});
for(const format of ['json','compact'] as const){test('MCP '+format+' format retains only its requested representation',async()=>{
 await fixture(async f=>{await f.authorize();const r=await call(f.client,f.token,f.lease,format);expect(r.isError).not.toBe(true);
  const tree=(r.structuredContent as Record<string,any>).tree;expect(tree).toBeDefined();
  if(format==='json'){expect(tree.nodes).toHaveLength(4);expect(tree).not.toHaveProperty('compact');}
  else{expect(tree.compact).toContain('Chào 世界');expect(tree).not.toHaveProperty('nodes');}
  expect(f.calls).toHaveLength(1);
 });
});}
test('a revoked turn cannot publish formatted output after provider dispatch',async()=>{
 await fixture(async f=>{await f.authorize();f.revokeAfterDispatch();const r=await call(f.client,f.token,f.lease,'both');
  expect(r.isError).toBe(true);expect(r.structuredContent).not.toHaveProperty('tree');expect(f.calls).toHaveLength(1);
 });
});
test('MCP projection does not reveal a redacted UIA parent ID through its child',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({nodes:[
  {source:'uia',id:'sensitive-parent-provider',parent_id:null,role:'Pane',name:'[REDACTED]',redacted:true,bounds:{x:10,y:20,width:200,height:100},pixel_correspondence:'unverified'},
  {source:'uia',id:'visible-child',parent_id:'sensitive-parent-provider',role:'Button',name:'Next',bounds:{x:20,y:30,width:20,height:10},pixel_correspondence:'unverified'},
 ]});const r=await call(f.client,f.token,f.lease,'both');expect(r.isError).not.toBe(true);
  const body=r.structuredContent as Record<string,any>;
  expect(body.tree.nodes).toHaveLength(2);expect(body.tree.nodes[1].parent.status).toBe('linked');
  expect(JSON.stringify(body.tree)).not.toContain('sensitive-parent-provider');
  // This option projects the already validated native receipt; legacy nodes are retained.
  expect(body.nodes[1].parent_id).toBe('sensitive-parent-provider');
 });
});
test('source partial/truncation remains explicit when the projection itself fits',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({
  nodes:[{source:'cv',id:'partial-cv',role:'visual_region',name:'',bounds:{x:10,y:20,width:20,height:10},frame_id:7,target_generation:4}],sources:{
  cv:{status:'completed',source_count:40,truncated:true},
  uia:{status:'timeout',partial:true,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',sample_start_ms:1,sample_end_ms:3},
  ocr:{status:'UNAVAILABLE',reason:'fixture_unavailable',confidence_available:false},
 }});const r=await call(f.client,f.token,f.lease,'both');expect(r.isError).not.toBe(true);
  const body=r.structuredContent as Record<string,any>;expect(body.status).toBe('PARTIAL');
  expect(body.tree.truncated).toBe(false);expect(body.tree.absence_is_proven).toBe(false);
  expect(body.tree.sources.cv.truncated).toBe(true);expect(body.tree.sources.uia.partial).toBe(true);
  expect(body.tree.sources.ocr.status).toBe('UNAVAILABLE');
 });
});
test('invalid tree format is rejected before provider dispatch',async()=>{
 await fixture(async f=>{await f.authorize();const r=await call(f.client,f.token,f.lease,'xml');
  expect(r.isError).toBe(true);expect(f.calls).toHaveLength(0);
 });
});
test('formatting does not authorize a guessed lease',async()=>{
 await fixture(async f=>{const r=await call(f.client,f.token,'reader_'+'0'.repeat(64),'both');
  expect(r.isError).toBe(true);expect(JSON.stringify(r.content)).toContain('SCREEN_READER_NOT_AUTHORIZED');expect(f.calls).toHaveLength(0);
 });
});
for(const [label,node] of [
 ['outside viewport',{source:'cv',name:'',bounds:{x:0,y:0,width:1,height:1},frame_id:7,target_generation:4}],
 ['wrong frame',{source:'ocr',name:'stale',confidence:null,confidence_status:'unavailable',bounds:{x:10,y:20,width:1,height:1},frame_id:6,target_generation:4}],
] as const){test('tree cannot publish native nodes '+label,async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({nodes:[node]});const r=await call(f.client,f.token,f.lease,'both');
  expect(r.isError).toBe(true);expect(JSON.stringify(r.content)).toContain('SCREEN_OBSERVATION_PROTOCOL');
  expect(r.structuredContent).not.toHaveProperty('tree');expect(f.calls).toHaveLength(1);
 });
});}
