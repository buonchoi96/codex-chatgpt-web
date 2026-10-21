import {expect,test} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createChatGptMcpServer} from '../src/adapters/chatgpt-web/mcp-server';
import {TurnBroker, type BrokerToolResult} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const ns='mcp__computer_use_swift';
const names=['desktop_observe','game_observe','desktop_execute_and_observe','game_execute_and_observe'] as const;

async function fixture(run:(ctx:{call:(name:string,result:BrokerToolResult)=>Promise<{response:Awaited<ReturnType<Client['callTool']>>;dispatched:number}>})=>Promise<void>){
  // macOS Unix domain sockets have a short fixed sun_path; use a compact temp root.
  const socketRoot=process.platform==="win32"?tmpdir():"/tmp";
  const path=defaultBrokerEndpoint(join(socketRoot,`cgw-lg-${randomUUID()}`));
  const broker=TurnBroker.forSocket(path);
  const token=await broker.register({cwd:process.cwd(),roots:[process.cwd()],writableRoots:[],
    sandboxPolicy:{type:'readOnly',networkAccess:false},
    tools:names.map(name=>({name,namespace:ns,description:name,parameters:{type:'object'}}))},30000,'legacy-advisory');
  const [ct,st]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'legacy-observer-fixture',version:'1'});
  const server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,transport:st});
  await client.connect(ct);
  let dispatched=0;
  try {
    await run({call:async(name,result)=>{
      const pending=client.callTool({name:'codex_tool_call',arguments:{turn_token:token,wire_name:`${ns}__${name}`,arguments:{}}});
      const [request]=await broker.nextToolBatch(token);
      expect(request?.wireName).toBe(`${ns}__${name}`);
      dispatched++;
      broker.completeTool(token,request!.callId,result);
      return {response:await pending,dispatched};
    }});
  }finally{await client.close();await server.close();await broker.close();}
}

const screenshot={type:'image',mimeType:'image/png',data:'aW1hZ2UtYnl0ZXM='};
const swiftResult=(data:Record<string,unknown>):BrokerToolResult=>({
  content:[{type:'text',text:'original swift result'},screenshot],
  structuredContent:{ok:true,data,trace_id:'source-trace'},isError:false,_meta:{origin:'native'},
});

test('legacy Swift observation preserves source images and appends one truthful unverified-capability notice',async()=>{
  await fixture(async({call})=>{
    const source=swiftResult({frame_id:'frame-1'});
    const {response,dispatched}=await call('desktop_observe',source);
    const blocks=response.content as unknown as Array<unknown>;
    expect(dispatched).toBe(1);
    expect(blocks.slice(0,2)).toEqual(source.content);
    expect(blocks).toHaveLength(3);
    expect(response.structuredContent).toMatchObject({ok:true,data:{frame_id:'frame-1'},trace_id:'source-trace'});
    expect(response._meta).toEqual(source._meta as Record<string,unknown>);
    expect(response.isError).toBe(false);
    const notice=(response.structuredContent as Record<string,any>).observation_routing;
    expect(notice).toMatchObject({status:'LEGACY_COMPATIBILITY_ACTIVE',called_tool:'desktop.observe',
      replacement_available:false,action_execution:'none',image_delivery_status:'UNVERIFIED',mcp_image_items:1});
    expect(JSON.parse((blocks[2] as {text:string}).text)).toEqual({observation_routing:notice});
  });
});

test('terminal action is never recommended for replay and repeated notices are rate-limited',async()=>{
  await fixture(async({call})=>{
    const source=swiftResult({status:'completed',observation:{frame_id:'frame-1'}});
    const first=(await call('game_execute_and_observe',source)).response;
    expect((first.structuredContent as Record<string,any>).observation_routing).toMatchObject({
      action_execution:'completed',do_not_replay_action:true,replacement_available:false});
    const second=(await call('game_execute_and_observe',source)).response;
    expect(second.content).toEqual(source.content);
    expect(second.structuredContent).toEqual(source.structuredContent);
  });
});

test('uncertain action receipts never claim completion',async()=>{
  await fixture(async({call})=>{
    const response=(await call('desktop_execute_and_observe',swiftResult({status:'running'}))).response;
    expect((response.structuredContent as Record<string,any>).observation_routing).toMatchObject({
      action_execution:'unknown',do_not_replay_action:true,replacement_available:false});
  });
});

test('safety and native error receipts pass through untouched without observer rerouting',async()=>{
  await fixture(async({call})=>{
    const error:BrokerToolResult={content:[{type:'text',text:'blocked by safety review'}],
      structuredContent:{ok:false,error:{code:'safety_status_unknown_or_blocked'}},isError:true,
      _meta:{original:'receipt'}};
    const response=(await call('game_observe',error)).response;
    expect(response.isError).toBe(true);
    expect(response.content).toEqual(error.content);
    expect(response.structuredContent).toEqual(error.structuredContent);
    expect(response._meta).toEqual(error._meta as Record<string,unknown>);
  });
});


test('legacy Swift observation with no image remains explicitly unavailable',async()=>{
  await fixture(async({call})=>{
    const source:BrokerToolResult={
      content:[{type:'text',text:'metadata only'}],
      structuredContent:{ok:true,data:{frame_id:'frame-metadata-only'},trace_id:'metadata-only'},
    };
    const {response}=await call('game_observe',source);
    const routing=(response.structuredContent as Record<string,any>).observation_routing;
    expect(routing).toMatchObject({
      called_tool:'game.observe',image_delivery_status:'UNAVAILABLE',mcp_image_items:0,
      replacement_available:false,
    });
    expect((response.content as Array<{type:string}>).filter(v=>v.type==='image')).toHaveLength(0);
  });
});
