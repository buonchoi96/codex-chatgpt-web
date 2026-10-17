// Real Swift stdio client -> current adapter/broker -> Native2 DEV -> actual Web model.
// Fixed samples are plumbing evidence; this is not randomized or production-client proof.
import {randomBytes,createHash} from 'node:crypto';
import {writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import type {ChildProcess} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadConfig,DEV_CHATGPT_CONNECTOR_NAME} from '../src/config';
import {activateDevProfileEnvironment,resolveDevProfilePaths} from '../src/dev-chat/profile';
import {DEV_CONFIG_PURPOSE,DEV_LAUNCHER_PROFILE} from '../src/dev-chat/constants';
import {createLauncherDevAdapter} from '../src/dev-chat/driver';
import {startDevChatTransport,type DevChatTransport} from '../src/dev-chat/transport';
import {inspectLauncherBrowserHost,releaseLauncherRetainedConversation} from '../src/launcher-browser-host';
import {responseRequest} from '../src/server';
import {ChatGptBrowserWorker,closeChatGptBrowserWorkers,type BrowserTurn} from '../src/adapters/chatgpt-web/browser-worker';

export const FIXED_PNG_SHA256='3e047a27b2fc3e60a6dc329985cb8ce77b7254cdcd41c77039e4f3c5d9acc9c4';
export const MAX_FIXTURE_ANSWER_CHARS=512;

type OutputItem=Record<string,unknown> & {type?:unknown};
export function fixedProbeHistory(output:unknown[],turnId:string):unknown[]{
 return output.filter((item):item is OutputItem=>!!item&&typeof item==='object'&&!Array.isArray(item)).map(item=>{
  const existing=item.internal_chat_message_metadata_passthrough;
  const provenance=existing&&typeof existing==='object'&&!Array.isArray(existing)?existing as Record<string,unknown>:{};
  return {...item,internal_chat_message_metadata_passthrough:{...provenance,
   ...(provenance.turn_id!==undefined?{source_turn_id:provenance.turn_id}:{}),turn_id:turnId}};
 });
}
export function assertFixedProbeInline(prepared:{transportDecision?:{choice?:unknown}|null;contextArchive?:unknown;multipart?:unknown}):void{
 const choice=prepared.transportDecision?.choice??(prepared.contextArchive?'ZIP_SINGLE_MESSAGE':prepared.multipart?'VERIFIED_MULTIPART':'INLINE');
 if(choice!=='INLINE'||prepared.contextArchive||prepared.multipart)throw new Error(`Fixed probe rejected beforeSend: transport must be INLINE (received ${String(choice)})`);
}
export function assertProbeHttp(response:Pick<Response,'ok'|'status'>,round:'initial'|'final'):void{
 if(!response.ok)throw new Error(`${round} Responses HTTP ${response.status}`);
}
export function assertProbeResponseError(value:Record<string,unknown>,round:'initial'|'final'):void{
 if(value.error&&typeof value.error==='object'){
  const code=(value.error as {code?:unknown}).code;
  throw new Error(`${round} Responses error${code?` (${String(code)})`:''}`);
 }
}
export function assertSingleBrowserOwner(ownerCount:number):void{
 if(ownerCount>1)throw new Error('Fixed probe rejected beforeSend: a second browser owner is forbidden');
 if(ownerCount!==1)throw new Error('Fixed probe rejected beforeSend: exactly one browser owner is required');
}
export function orderedMcpContent(content:unknown[]):Array<Record<string,unknown>>{
 return content.flatMap((block:any):Array<Record<string,unknown>>=>{
  if(block?.type==='text'&&typeof block.text==='string')return [{type:'input_text',text:block.text}];
  if(block?.type==='image'&&typeof block.data==='string'&&typeof block.mimeType==='string')
   return [{type:'input_image',image_url:`data:${block.mimeType};base64,${block.data}`,detail:'high'}];
  return [];
 });
}
export function boundedFixtureAnswer(text:string):string{return text.slice(0,MAX_FIXTURE_ANSWER_CHARS);}

async function runFixedProbe(){
 if(process.argv[2]!=='--run')throw new Error('Explicit --run required for the owned DEV fixed-probe model test');
 const paths=resolveDevProfilePaths();activateDevProfileEnvironment(paths);const config=loadConfig();
 if(config.purpose!==DEV_CONFIG_PURPOSE||config.mode!=='full'||config.appName!==DEV_CHATGPT_CONNECTOR_NAME
  ||config.browserHost!=='launcher'||!config.browserHostDescriptorPath||config.browserInteractionMode==='manual')throw new Error('Isolated DEV automatic Full profile required');
 await inspectLauncherBrowserHost(config.browserHostDescriptorPath,{expectedProfile:DEV_LAUNCHER_PROFILE});
 const swiftRoot=resolve('F:/Source Projects/ComputerUseSwift-MCP'),entry=join(swiftRoot,'dist/src/index.js');
 if(!existsSync(entry))throw new Error('The existing Swift checkout must be built first');
 const wireName='mcp__computer_use_swift__swift_image_relay_probe',marker=`PROBE-${randomBytes(4).toString('hex')}`;
 const report:Record<string,any>={kind:'real-Swift-stdio-Native2-Web-fixed-probe',started_at:new Date().toISOString(),
  outer_client:'MCP SDK fixture actor',codex_desktop_client:'NOT_RUN',model:'NOT_RUN',unpredictable_pixel_proof:false,
  status:'INCOMPLETE',production_changes:false,rounds:{initial:{http:'NOT_RUN',response_error:'NOT_RUN'},final:{http:'NOT_RUN',response_error:'NOT_RUN'}},
  preflight:{browser_owner:'NOT_RUN',transport:'NOT_RUN',model:'NOT_RUN'}};
 const client=new Client({name:'owned-fixed-probe-actor',version:'1'}),abort=new AbortController();
 const timeout=setTimeout(()=>abort.abort(new Error('Fixed-probe model test exceeded six minutes')),360000);
 let transport:DevChatTransport|undefined,request:Promise<Response>|undefined,sendCount=0,browserCount=0,toolCalls=0;
 let stdio:StdioClientTransport|undefined,stdioProcess:ChildProcess|undefined,stdioExitCode:number|null=null,stdioClosed=false;
 const ownedKeys=new Set<string>(),originalRun=ChatGptBrowserWorker.prototype.run;
 try{
  stdio=new StdioClientTransport({command:process.env.CODEX_WEB_GPT_NODE??'E:/nodejs/node.exe',args:[entry],cwd:swiftRoot,
   env:{...process.env,COMPUTER_USE_SWIFT_AUTOSTART:'0',COMPUTER_USE_SWIFT_PIPE:'\\\\.\\pipe\\unused_web_probe_'+process.pid,SWIFT_IMAGE_RELAY_PROBE:'1'}});
  await client.connect(stdio);stdioProcess=(stdio as any)._process as ChildProcess|undefined;
  if(!stdioProcess?.pid)throw new Error('Swift stdio child PID was not observable after spawn');
  stdioProcess.once('close',(code:number|null)=>{stdioExitCode=code;stdioClosed=true;});
  report.stdio_process={pid:stdioProcess.pid,exited:false,exit_code:null};
  if(!(await client.listTools()).tools.some(tool=>tool.name==='swift.image_relay_probe'))throw new Error('Owner-opted fixed probe is unavailable');
  transport=await startDevChatTransport(config,paths.runtimePath);
  const runtime=createLauncherDevAdapter(transport.config,paths.runtimePath,{broker:transport.broker});
  ChatGptBrowserWorker.prototype.run=function(turn:BrowserTurn){
   browserCount++;report.preflight.browser_owner=browserCount===1?'ONE':'REJECTED_SECOND';assertSingleBrowserOwner(browserCount);
   if(turn.conversationKey)ownedKeys.add(turn.conversationKey);
   const originalPrepare=turn.prepare;
   const guardedTurn:BrowserTurn={...turn,prepare:async()=>{
    const prepared=await originalPrepare();
    try{assertFixedProbeInline(prepared);report.preflight.transport='INLINE';return prepared;}
    catch(error){prepared.release();report.preflight.transport='REJECTED';throw error;}
   },onSubmitted:async()=>{sendCount++;await turn.onSubmitted?.();}};
   return originalRun.call(this,guardedTurn);
  };
  const threadId=`fixed_probe_${crypto.randomUUID()}`,turnId=`fixed_probe_turn_${crypto.randomUUID()}`;
  const body:Record<string,unknown>={model:'chatgpt-web/gpt-6-sol',stream:false,store:false,prompt_cache_key:threadId,
   reasoning:{effort:'high',summary:'auto'},client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:threadId,turn_id:turnId,
    request_kind:'turn',sandbox:'none',workspaces:{[process.cwd()]:{}}})},
   instructions:'This is an authorized, read-only fixed image-relay fixture. Its actual Swift MCP server returns bundled images; no desktop or input action is requested. Use only the single advertised fixture tool once, then inspect the returned image directly. Do not use code execution, web search, file reads, clipboard, screenshots, or another image-reading tool.',
   tools:[{type:'function',name:wireName,description:'Call the actual local Swift fixed image probe. Readonly 96x96 bundled PNG; no target capture/input. The MCP owner has explicitly enabled this fixture.',
    parameters:{type:'object',properties:{format:{type:'string',enum:['png']}},required:['format'],additionalProperties:false}}],
   input:[{type:'message',role:'user',id:`msg_probe_environment_${turnId}`,internal_chat_message_metadata_passthrough:{turn_id:turnId},
    content:[{type:'input_text',text:`<environment_context>\n  <cwd>${process.cwd()}</cwd>\n  <filesystem><workspace_roots><root>${process.cwd()}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`}]},
    {type:'message',role:'user',id:`msg_probe_instruction_${turnId}`,internal_chat_message_metadata_passthrough:{turn_id:turnId},
     content:[{type:'input_text',text:`Call ${wireName} exactly once with format png. Return JSON with marker "${marker}" and colors: an array of the dominant color names in top-left, top-right, bottom-left, bottom-right order, based only on the returned pixels.`}]}]};
  const call=async(round:'initial'|'final')=>{
   report.preflight.model='RUNNING';request=responseRequest(new Request('http://codex-web-gpt.dev/v1/responses',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body),signal:abort.signal}),transport!.config,runtime.adapterFactory,{rememberState:false});
   const response=await request;report.rounds[round].http=response.status;
   const value=await response.json() as Record<string,unknown>;
   report.rounds[round].response_error=value.error&&typeof value.error==='object'?'PRESENT':'NONE';
   assertProbeHttp(response,round);assertProbeResponseError(value,round);return value;
  };
  const first=await call('initial');
  const calls=(Array.isArray(first.output)?first.output:[]).filter((item:any)=>item.type==='function_call') as Array<{name:string;call_id:string;arguments:string}>;
  if(calls.length!==1||calls[0]!.name!==wireName)throw new Error('The actual Web model did not issue the one permitted probe call');
  const args=JSON.parse(calls[0]!.arguments);if(args.format!=='png'||Object.keys(args).length!==1)throw new Error('Unexpected fixture arguments');
  const toolStarted=Date.now();toolCalls++;
  const result=CallToolResultSchema.parse(await client.callTool({name:'swift.image_relay_probe',arguments:args}));
  if(result.isError)throw new Error('The actual Swift probe failed; no substitute capture is permitted');
  const images=result.content.filter(item=>item.type==='image');if(images.length!==1||images[0]!.mimeType!=='image/png')throw new Error('Actual stdio response omitted its PNG image');
  const imageBytes=Buffer.from(images[0]!.data,'base64'),imageHash=createHash('sha256').update(imageBytes).digest('hex');
  report.image_items_received=images.length;report.image_bytes=imageBytes.length;report.image_sha256=imageHash;report.expected_image_sha256=FIXED_PNG_SHA256;
  report.actual_pinned_png_hash_verified=imageHash===FIXED_PNG_SHA256;report.mcp_client_ms=Date.now()-toolStarted;
  if(imageHash!==FIXED_PNG_SHA256)throw new Error('Actual Swift stdio PNG did not match the pinned fixture SHA-256');
  const envelope={isError:result.isError??false,structuredContent:result.structuredContent,_meta:result._meta};
  (body.input as unknown[]).push(...fixedProbeHistory(Array.isArray(first.output)?first.output:[],turnId),{type:'function_call_output',call_id:calls[0]!.call_id,
   output:[{type:'input_text',text:JSON.stringify(envelope)},...orderedMcpContent(result.content)]});
  report.forwarded_content_types=result.content.map((item:any)=>item.type);
  const forwarded=Date.now(),final=await call('final');report.forward_to_model_final_ms=Date.now()-forwarded;
  if(final.status!=='completed'||final.end_turn!==true)throw new Error('The same tool response did not complete the model turn');
  const text=(Array.isArray(final.output)?final.output:[]).flatMap((item:any)=>item.type==='message'&&item.phase!=='commentary'
   ?(item.content??[]).filter((part:any)=>part.type==='output_text').map((part:any)=>part.text):[]).join('').trim();
  report.fixture_answer=boundedFixtureAnswer(text);
  const answer=JSON.parse(text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  report.reported_colors=Array.isArray(answer.colors)?answer.colors.slice(0,8):[];
  if(answer.marker!==marker||JSON.stringify(answer.colors?.map((value:string)=>value.toLowerCase()))!==JSON.stringify(['red','green','blue','yellow']))
   throw new Error('Fixed sample model report did not match this task and sample');
  if(sendCount!==1||browserCount!==1||toolCalls!==1)throw new Error('Tool continuation issued another user Send, browser owner, or image call');
  report.model='COMPLETED';report.status='PASS';
 }catch(error){report.status='FAIL';report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
 finally{
  clearTimeout(timeout);abort.abort();ChatGptBrowserWorker.prototype.run=originalRun;
  const errors:string[]=[];await closeChatGptBrowserWorkers().catch(error=>errors.push(String(error)));
  await client.close().catch(error=>errors.push(String(error)));
  if(stdioProcess&&!stdioClosed)await new Promise<void>(resolveExit=>{
   const timer=setTimeout(resolveExit,2500);timer.unref();stdioProcess!.once('close',(code:number|null)=>{stdioExitCode=code;stdioClosed=true;clearTimeout(timer);resolveExit();});
  });
  report.stdio_process={pid:stdioProcess?.pid??null,exited:stdioClosed,exit_code:stdioExitCode};
  if(!stdioClosed){errors.push('Test-owned Swift stdio process exit was not observed');process.exitCode=1;}
  let released=0;for(const key of ownedKeys)await releaseLauncherRetainedConversation(config.browserHostDescriptorPath!,key).then(count=>{released+=count;},error=>errors.push(String(error)));
  await transport?.close().catch(error=>errors.push(String(error)));
  report.accepted_sends=sendCount;report.browser_owners=browserCount;report.actual_swift_calls=toolCalls;report.cleanup={released,errors};
  if(errors.length){report.status='FAIL';process.exitCode=1;}report.finished_at=new Date().toISOString();
  const artifact=`output/dev-fixed-probe-${Date.now()}.json`;writeFileSync(artifact,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,artifact}));
 }
}
if(import.meta.main)await runFixedProbe();
