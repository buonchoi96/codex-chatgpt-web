import {expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createChatGptMcpServer} from "../src/adapters/chatgpt-web/mcp-server";
import {TurnBroker} from "../src/adapters/chatgpt-web/turn-broker";
import {defaultBrokerEndpoint} from "../src/config";

async function bounded<T>(p:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  return await Promise.race([p,new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(Error("Async MCP E2E fixture exceeded 5-second deadline")),5000);
  })]);
 }finally{if(timer)clearTimeout(timer);}
}
async function fixture(run:(f:{
 client:Client;token:string;otherToken:string;broker:TurnBroker
})=>Promise<void>){
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,"cgw-async-e2e-"));
 const broker=TurnBroker.forSocket(defaultBrokerEndpoint(root));
 const [ct,st]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:"async-test",version:"1.0.0"},{capabilities:{}});
 let server:Awaited<ReturnType<typeof createChatGptMcpServer>>|undefined;
 try{
  const env={cwd:root,roots:[root],writableRoots:[root],
   sandboxPolicy:{type:"dangerFullAccess" as const},
   tools:[{namespace:"mcp__rea",name:"procedure_info",description:"Fake REA procedure",
    parameters:{type:"object",properties:{address:{type:"string"}}}},
    {namespace:"mcp__rea",name:"binary_overview",description:"Fake REA overview",
    parameters:{type:"object",properties:{}}}]};
  const token=await broker.register(env,undefined,"async_main_agent");
  const otherToken=await broker.register(env,undefined,"async_subagent");
  server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,transport:st});
  await bounded(client.connect(ct));
  await run({client,token,otherToken,broker});
 }finally{
  await Promise.allSettled([client.close(),server?.close(),broker.close()]);
  const canonical=realpathSync(root);
  if(canonical!==resolve(root)||dirname(canonical)!==parent||!basename(canonical).startsWith("cgw-async-e2e-"))
   throw Error("Unsafe test fixture cleanup");
  rmSync(canonical,{recursive:true,force:true});
 }
}
function call(client:Client,turn_token:string,wire_name:string,args:Record<string,unknown>={}){
 return bounded(client.callTool({name:"codex_tool_call",arguments:{
  turn_token,wire_name,arguments:args,
 }},undefined,{timeout:5000,maxTotalTimeout:5000}));
}
function body(response:unknown):Record<string,any>{
 const v=(response as {structuredContent?:unknown})?.structuredContent;
 if(!v||typeof v!=="object"||Array.isArray(v))throw Error("Structured MCP result missing");
 return v as Record<string,any>;
}
test("E2E persistent Native2 broker dispatches one REA call and polls it through old codex_tool_call contract",async()=>{
 await fixture(async({client,token,otherToken,broker})=>{
  const listed=await bounded(client.listTools());
  expect(listed.tools.some(item=>item.name==="codex_tool_poll")).toBe(true);
  expect(listed.tools.some(item=>item.name==="codex_tool_start")).toBe(true);
  const started=await call(client,token,"codex.control.async_start",{
   wire_name:"mcp__rea__procedure_info",arguments:{address:"0x1000"},
  });
  const ticket=body(started);
  expect(ticket.status).toBe("pending");
  expect(ticket.poll_with).toBe("codex.control.async_poll");
  const [request]=await bounded(broker.nextToolBatch(token));
  expect(request).toMatchObject({wireName:"mcp__rea__procedure_info",arguments:{address:"0x1000"}});
  const waiting=body(await call(client,token,"codex.control.async_poll",{job_id:ticket.job_id}));
  expect(waiting.status).toBe("running");
  const foreign=await call(client,otherToken,"codex.control.async_poll",{job_id:ticket.job_id});
  expect(foreign.isError).toBe(true);
  broker.completeTool(token,request!.callId,{
   content:[{type:"text",text:"REA work completed"}],
   structuredContent:{address:"0x1000",bytes:[1,2,3]},
  });
  let complete:Record<string,any>|undefined;
  for(let attempt=0;attempt<60;attempt++){
   const response=body(await call(client,token,"codex.control.async_poll",{job_id:ticket.job_id}));
   if(response.status==="completed"){complete=response;break;}
   await Bun.sleep(10);
  }
  expect(complete?.status).toBe("completed");
  const original=JSON.parse(complete!.chunk);
  expect(original.structuredContent).toEqual({address:"0x1000",bytes:[1,2,3]});
  expect(original.content[0].text).toBe("REA work completed");
  expect(complete!.next_offset).toBeNull();
  // The result came from this ONE dispatched native call; polling is read-only.
  expect(complete!.job_id).toBe(ticket.job_id);
 });
});

test("E2E normal codex_tool_call preserves fast native MCP result directly",async()=>{
 await fixture(async({client,token,broker})=>{
  const pending=call(client,token,"mcp__rea__binary_overview",{});
  const [invocation]=await bounded(broker.nextToolBatch(token));
  expect(invocation!.wireName).toBe("mcp__rea__binary_overview");
  broker.completeTool(token,invocation!.callId,{
   content:[{type:"text",text:"overview ready"}],
   structuredContent:{ok:true},
  });
  const response=await pending;
  expect(body(response).ok).toBe(true);
  expect(response.isError).not.toBe(true);
 });
});


test("slow multimodal MCP result survives async poll as an image block, not JSON chunks",async()=>{
 await fixture(async({client,token,otherToken,broker})=>{
  // Deterministic large payload exercises the exact-size class of real game
  // screenshots. This test proves relay bytes and type, NOT image semantics.
  const pixels=Buffer.alloc(3_656_150,0x5a);
  const image=pixels.toString("base64");
  let dispatches=0;
  const started=await call(client,token,"codex.control.async_start",{
   wire_name:"mcp__rea__binary_overview",arguments:{},
  });
  const ticket=body(started);
  expect(ticket.status).toBe("pending");
  const [request]=await bounded(broker.nextToolBatch(token));
  expect(request).toMatchObject({wireName:"mcp__rea__binary_overview"});
  dispatches++;

  const unauthorized=await call(client,otherToken,"codex.control.async_poll",{job_id:ticket.job_id});
  expect(unauthorized.isError).toBe(true);
  broker.completeTool(token,request!.callId,{
   content:[{type:"text",text:"capture receipt"},
     {type:"image",data:image,mimeType:"image/png"}],
   structuredContent:{ok:true,frame_id:1,screenshot_image_bytes:pixels.length},
   isError:false,_meta:{trace_id:"async-image-fixture"},
  });
  let completed:Awaited<ReturnType<typeof call>>|undefined;
  for(let attempt=0;attempt<40;attempt++){
   const observed=await call(client,token,"codex.control.async_poll",{job_id:ticket.job_id});
   if(observed.content?.some(part=>part.type==="image")){completed=observed;break;}
   await Bun.sleep(10);
  }
  expect(completed).toBeDefined();
  expect(completed!.isError).toBe(false);
  expect((completed!.content as any[]).filter(p=>p.type==="image"))
   .toEqual([{type:"image",data:image,mimeType:"image/png"}]);
  expect(completed!.structuredContent).toEqual({ok:true,frame_id:1,screenshot_image_bytes:pixels.length});
  expect(completed!._meta).toEqual({trace_id:"async-image-fixture"});
  expect((completed!.content as any[]).filter(p=>p.type==="text").map(p=>p.text).join("\n"))
   .not.toContain(image);
  const direct=await bounded(client.callTool({name:"codex_tool_poll",arguments:{
   turn_token:token,job_id:ticket.job_id,offset:0,
  }},undefined,{timeout:5000,maxTotalTimeout:5000}));
  expect((direct.content as any[]).filter(p=>p.type==="image")).toHaveLength(1);
  expect((direct.content as any[])[1].data).toBe(image);
  expect(dispatches).toBe(1);
 });
});

test("completed async tool error with image retains isError and metadata",async()=>{
 await fixture(async({client,token,broker})=>{
  const started=await call(client,token,"codex.control.async_start",{
   wire_name:"mcp__rea__binary_overview",arguments:{},
  });
  const ticket=body(started);
  const [request]=await bounded(broker.nextToolBatch(token));
  broker.completeTool(token,request!.callId,{
   content:[{type:"image",data:"aGVsbG8=",mimeType:"image/png"}],
   isError:true,structuredContent:{error:{code:"fixture_error"}},
  });
  let final:Awaited<ReturnType<typeof call>>|undefined;
  for(let attempt=0;attempt<40;attempt++){
   const response=await call(client,token,"codex.control.async_poll",{job_id:ticket.job_id});
   if(response.isError===true&&response.content?.some(p=>p.type==="image")){final=response;break;}
   await Bun.sleep(10);
  }
  expect(final?.isError).toBe(true);
  expect(final?.structuredContent).toEqual({error:{code:"fixture_error"}});
  expect((final?.content as any[])?.[0].type).toBe("image");
 });
});
