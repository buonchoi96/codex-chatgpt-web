/**
 * Opt-in REA/Ghidra MCP stdio proxy. A slow tool executes in the persistent
 * downstream process while short start/poll requests fit the Native2 deadline.
 * stdout is MCP wire data only; diagnostics must use stderr.
 */
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema,ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {REA_ASYNC_ALLOWED_TOOLS,REA_ASYNC_MAX_POLL_CHARS,ReaAsyncJobs} from "./rea-async-jobs";

const REA_TIMEOUT_MS=30*60_000;
const command=process.platform==="win32"?"cmd.exe":"npx";
const args=process.platform==="win32"
 ?["/d","/c","npx","-y","rea-agents@6.5.0","mcp"]
 :["-y","rea-agents@6.5.0","mcp"];

function record(v:unknown):Record<string,unknown>|undefined{
 return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
}
function ok(v:Record<string,unknown>){
 return {content:[{type:"text" as const,text:JSON.stringify(v)}]};
}
function err(v:unknown){
 return {content:[{type:"text" as const,text:String(v instanceof Error?v.message:v).slice(0,4096)}],isError:true};
}

/** Native Codex remains the approval/transport authority. Never synthesize a
 * REA tool from an old turn; discover it from this backend on startup. */
export async function runReaAsyncProxy():Promise<void>{
 const downstream=new Client({name:"rea-async-transport",version:"1.0.0"},{capabilities:{}});
 await downstream.connect(new StdioClientTransport({command,args,stderr:"inherit"}));
 const advertised=await downstream.listTools();
 const names=new Set(advertised.tools.map(tool=>tool.name));
 if(names.has("rea_async_start")||names.has("rea_async_poll"))throw Error("Reserved REA async tool names are already present");
 const jobs=new ReaAsyncJobs(names,async(name,args)=>
  downstream.callTool({name,arguments:args},undefined,{timeout:REA_TIMEOUT_MS}));
 const server=new Server({name:"rea-async-proxy",version:"1.0.0"},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  ...advertised.tools.map(tool=>({...tool,
   description:(tool.description??"")+"\n\nFor REA procedure_info and binary_overview that may exceed 60s, use rea_async_start and rea_async_poll. Direct calls remain bound by the native 90s transport deadline."})),
  {name:"rea_async_start",
   description:"Start one advertised read-only REA procedure_info/binary_overview invocation without waiting for analysis. Returns opaque job_id immediately; poll separately. No implicit retry.",
   inputSchema:{type:"object" as const,properties:{
    tool:{type:"string",enum:[...REA_ASYNC_ALLOWED_TOOLS]},
    arguments:{type:"object",additionalProperties:true}
   },required:["tool","arguments"],additionalProperties:false}},
  {name:"rea_async_poll",
   description:"Read one REA job status/result chunk without dispatching REA again. Use next_offset until null. Unknown never proves the job stopped.",
   inputSchema:{type:"object" as const,properties:{
    job_id:{type:"string"},offset:{type:"integer",minimum:0,default:0},
    max_chars:{type:"integer",minimum:1,maximum:REA_ASYNC_MAX_POLL_CHARS,default:8000}
   },required:["job_id"],additionalProperties:false},
   annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true}}
 ]}));
 server.setRequestHandler(CallToolRequestSchema,async(request)=>{
  const name=request.params.name,input=record(request.params.arguments)??{};
  try{
   if(name==="rea_async_start"){
    const validatedArgs=record(input.arguments);
    if(typeof input.tool!=="string"||!validatedArgs)return err("rea_async_start needs a tool name and original argument object");
    return ok(jobs.start(input.tool,validatedArgs));
   }
   if(name==="rea_async_poll"){
    if(typeof input.job_id!=="string")return err("rea_async_poll needs job_id");
    return ok(jobs.poll(input.job_id,
     input.offset===undefined?0:Number(input.offset),
     input.max_chars===undefined?8000:Number(input.max_chars)));
   }
   if(!names.has(name))return err("Unadvertised REA tool");
   if(jobs.active())return err("REA_ASYNC_BUSY: An active or uncertain REA operation must be reconciled before another call");
   return await downstream.callTool({name,arguments:input},undefined,{timeout:REA_TIMEOUT_MS});
  }catch(e){return err(e);}
 });
 await server.connect(new StdioServerTransport());
 console.error("[rea-async-proxy] Connected to persistent rea-agents@6.5.0 MCP backend");
}
if(import.meta.main)runReaAsyncProxy().catch(e=>{
 console.error("[rea-async-proxy] fatal: "+String(e instanceof Error?e.message:e));
 process.exitCode=1;
});
