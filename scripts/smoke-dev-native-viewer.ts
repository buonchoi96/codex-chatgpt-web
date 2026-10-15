// Actual isolated Codex app-server -> DEV Responses bridge -> Native2 -> Web model.
// Diagnostic local-file viewer only. No desktop capture, user image upload, or input action.
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,createHash,randomInt} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {loadConfig,DEV_CHATGPT_CONNECTOR_NAME} from '../src/config';
import {resolveDevProfilePaths,activateDevProfileEnvironment} from '../src/dev-chat/profile';
import {DEV_CONFIG_PURPOSE,DEV_LAUNCHER_PROFILE} from '../src/dev-chat/constants';
import {startDevChatTransport} from '../src/dev-chat/transport';
import {createLauncherDevAdapter} from '../src/dev-chat/driver';
import {responseRequest} from '../src/server';
import {inspectLauncherBrowserHost,readLauncherBrowserHostDescriptor,releaseLauncherRetainedConversation} from '../src/launcher-browser-host';
import {chromium} from 'playwright-core';
import {ChatGptBrowserWorker,closeChatGptBrowserWorkers,type BrowserTurn} from '../src/adapters/chatgpt-web/browser-worker';
import {assertFixedProbeInline} from './smoke-dev-fixed-probe';
import {parseRequest} from '../src/responses/parser';
import {extractChatGptTurnEnvironmentClaim} from '../src/adapters/chatgpt-web/environment';
import {ChatGptThreadEnvironmentStore} from '../src/adapters/chatgpt-web/thread-environment';
import {NativeViewerProofGuard,NativeViewerReceiptCollector,validateViewerInvocation,withViewerDeadline} from './native-viewer-proof';
import type {AdapterEvent} from '../src/types';

export function onlyNativeViewerTools(tools:unknown,route:'direct'|'nested'):unknown[]{
 const source=Array.isArray(tools)?tools:[],wanted=route==='direct'?'view_image':'exec';
 let declarations=0;
 const selected=source.flatMap((value:any)=>{
  if(value?.type==='namespace'&&Array.isArray(value.tools)){
   if(value.name!=='functions')return[];
   const children=value.tools.filter((tool:any)=>tool?.name===wanted&&tool.type===(route==='direct'?'function':'custom'));
   declarations+=children.length;
   return children.length?[{...value,tools:children}]:[];
  }
  if(value?.name===wanted&&value.type===(route==='direct'?'function':'custom')){declarations++;return[value];}
  return[];
 });
 if(selected.length!==1||declarations!==1)throw new Error(`Actual native ${route} viewer interface is unavailable or ambiguous`);
 return selected;
}
export function nativeImageReceipts(input:unknown):Array<{mime:string;bytes:number;sha256:string}>{
 const result:Array<{mime:string;bytes:number;sha256:string}>=[];
 if(!Array.isArray(input))return result;
 for(const item of input){
  if(!item||typeof item!=='object'||!['function_call_output','custom_tool_call_output'].includes(item.type))continue;
  if(!Array.isArray(item.output))continue;
  for(const block of item.output){
   const value=block?.image_url;if(block?.type!=='input_image'||typeof value!=='string')continue;
   const parsed=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(value);if(!parsed)continue;
   const bytes=Buffer.from(parsed[2]!,'base64');result.push({mime:parsed[1]!,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
 return result;
}
export function nativeViewerRequestShape(body:Record<string,any>){
 let metadata:Record<string,any>={};
 try{const value=body.client_metadata?.['x-codex-turn-metadata'];metadata=typeof value==='string'?JSON.parse(value):value??{};}catch{}
 return{metadata_fields:Object.keys(metadata).slice(0,32),request_kind:metadata.request_kind??null,sandbox:metadata.sandbox??null,sandbox_mode:metadata.sandbox_mode??null,
  root_agent_matches:metadata.agent_name==null||metadata.agent_name==='/root',
  workspaces_count:metadata.workspaces&&typeof metadata.workspaces==='object'?Object.keys(metadata.workspaces).length:0,
  input:(Array.isArray(body.input)?body.input:[]).slice(0,32).map((item:any)=>{
   const texts=Array.isArray(item?.content)?item.content.map((part:any)=>typeof part?.text==='string'?part.text:''):[];
   return{type:item?.type,role:item?.role,id_present:typeof item?.id==='string',turn_provenance_present:typeof item?.internal_chat_message_metadata_passthrough?.turn_id==='string',
    environment_envelope:texts.some((text:string)=>/^<environment_context>/.test(text.trim())),
    xml_tags:[...new Set(texts.flatMap((text:string)=>[...text.matchAll(/<([a-z_]+)(?:\s|>)/g)].map(match=>match[1]!)))].slice(0,20)};
  })};
}

async function run(){
 if(process.argv[2]!=='--run'||!['direct','nested'].includes(process.argv[3]??''))throw new Error('Explicit --run direct|nested required');
 const route=process.argv[3] as 'direct'|'nested';
 const executable=resolve(process.argv[4]??'C:/Users/Long-PC/AppData/Local/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe');
 if(!existsSync(executable))throw new Error('Actual installed native Codex executable required');
 const paths=resolveDevProfilePaths();activateDevProfileEnvironment(paths);const config=loadConfig();
 const originalCodexHome=process.env.CODEX_HOME,originalSqliteHome=process.env.CODEX_SQLITE_HOME;
 if(config.purpose!==DEV_CONFIG_PURPOSE||config.mode!=='full'||config.appName!==DEV_CHATGPT_CONNECTOR_NAME||!config.browserHostDescriptorPath)throw new Error('Ready isolated DEV Full profile required');
 await inspectLauncherBrowserHost(config.browserHostDescriptorPath,{expectedProfile:DEV_LAUNCHER_PROFILE});
 const initialDescriptor=readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath);
 const root=mkdtempSync(join(tmpdir(),'cgw-native-viewer-')),codexHome=join(root,'codex');mkdirSync(codexHome);
 const imagePath=join(root,'fixture.png'),marker=`VIEW-${randomBytes(4).toString('hex')}`;
 const challenge=String(randomInt(100000000)).padStart(8,'0');
 const palette=[{name:'red',rgb:[225,35,40]},{name:'green',rgb:[35,180,65]},{name:'blue',rgb:[35,70,225]},{name:'yellow',rgb:[235,220,35]}];
 for(let i=3;i>0;i--){const j=randomInt(i+1);[palette[i],palette[j]]=[palette[j]!,palette[i]!];}
 const psPath=imagePath.replaceAll("'","''");
 const paint=palette.map((color,i)=>`$b${i}=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(${color.rgb.join(',')}));$g.FillRectangle($b${i},${i%2*240},${Math.floor(i/2)*160},240,160);$b${i}.Dispose()`).join(';');
 const generated=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',
  `Add-Type -AssemblyName System.Drawing;$bitmap=[Drawing.Bitmap]::new(480,320);$g=[Drawing.Graphics]::FromImage($bitmap);${paint};$g.FillRectangle([Drawing.Brushes]::White,20,130,440,60);$font=[Drawing.Font]::new('Consolas',40,[Drawing.FontStyle]::Bold);$g.DrawString('${challenge}',$font,[Drawing.Brushes]::Black,90,131);$bitmap.Save('${psPath}',[Drawing.Imaging.ImageFormat]::Png);$font.Dispose();$g.Dispose();$bitmap.Dispose()`],
  {encoding:'utf8',timeout:10000,windowsHide:true});
 if(generated.status!==0||!existsSync(imagePath))throw new Error('Owned randomized fixture generation failed');
 const nativeEnv:Record<string,string>={CODEX_HOME:codexHome,CODEX_SQLITE_HOME:codexHome,OPENAI_API_KEY:'local-viewer-fixture'};
 for(const name of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','USERPROFILE','LOCALAPPDATA','APPDATA'])
  if(process.env[name])nativeEnv[name]=process.env[name]!;
 const bundled=spawnSync(executable,['debug','models','--bundled'],{env:nativeEnv,encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:16000000});
 if(bundled.status!==0)throw new Error('Native bundled catalog is unavailable');
 const model={...JSON.parse(bundled.stdout).models.find((value:any)=>value.slug==='gpt-6-sol'),slug:'chatgpt-web/gpt-6-sol',
  tool_mode:route==='nested'?'code_mode_only':null,use_responses_lite:false,context_window:302223,max_context_window:302223,
  effective_context_window_percent:90,auto_compact_token_limit:258400,supported_in_api:true,visibility:'list'};
 delete model.comp_hash;
 const catalogPath=join(root,'catalog.json');writeFileSync(catalogPath,JSON.stringify({models:[model]}));
 const report:Record<string,any>={kind:'actual-native-Codex-client-viewer-model-probe',route,status:'INCOMPLETE',
  model_pixel_recognition_verified:false,production_changes:false,screenshot_composer_uploads:0,
  native_client:'installed Codex app-server in owned ephemeral CODEX_HOME',started_at:new Date().toISOString(),scratch:root,
  native_tool_image_receipts:[],native_http_rounds:0,accepted_sends:0,browser_owners:0};
 const abort=new AbortController(),keys=new Set<string>(),originalRun=ChatGptBrowserWorker.prototype.run;
 const proof=new NativeViewerProofGuard(),receipts=new NativeViewerReceiptCollector(route,imagePath,challenge);
 let ownedThreadId:string|undefined;
 let transport:Awaited<ReturnType<typeof startDevChatTransport>>|undefined,server:ReturnType<typeof Bun.serve>|undefined;
 let transportStarting=false;
 let child:ReturnType<typeof spawn>|undefined,childClosed=false,finalText='',nativeFailure='',completed:()=>void=()=>{};
 const rpcPending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
 const completedTurn=new Promise<void>(resolveDone=>{completed=resolveDone;});
 const timeout=setTimeout(()=>{nativeFailure='Owned native viewer exceeded six minutes';proof.fail('NATIVE_VIEWER_DEADLINE');abort.abort();completed();
  for(const pending of rpcPending.values())pending.reject(new Error(nativeFailure));rpcPending.clear();child?.kill();},360000);
 try{
  transportStarting=true;
  transport=await withViewerDeadline(()=>startDevChatTransport(config,paths.runtimePath),15000,'Owned DEV transport startup',abort.signal,
   late=>withViewerDeadline(()=>late.close(),5000,'Late owned DEV transport cleanup'));
  transportStarting=false;
  const originalComplete=transport.broker.completeTool.bind(transport.broker);
  transport.broker.completeTool=async(token,callId,result)=>{
   const images=result.content.filter((part:any)=>part?.type==='image').map((part:any)=>{
    const bytes=Buffer.from(part.data,'base64');return{mime:part.mimeType,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),callIdHash:createHash('sha256').update(callId).digest('hex')};
   });
   report.broker_image_receipts=(report.broker_image_receipts??[]).concat(images);
   return originalComplete(token,callId,result);
  };
  // The bridge verifies a managed native filesystem claim against the exact
  // current rollout. Point only this test process at its own real native home;
  // do not manufacture environment XML or read the production user's rollouts.
  process.env.CODEX_HOME=codexHome;process.env.CODEX_SQLITE_HOME=codexHome;
  const runtime=createLauncherDevAdapter(transport.config,paths.runtimePath,{broker:transport.broker});
  const failProbe=(code:string)=>{proof.fail(code);nativeFailure ||= code;abort.abort();completed();child?.kill();};
  const guardedFactory:typeof runtime.adapterFactory=provider=>{
   const adapter=runtime.adapterFactory(provider);
   return{...adapter,runTurn:async(input,context,emit)=>{
    const events:AdapterEvent[]=[];let call:{id:string;name:string;arguments:string}|undefined;
    try{await adapter.runTurn!(input,context,event=>{
     if(proof.failureCode)return;
     if(event.type==='error'){emit(event);failProbe(`BRIDGE_${event.code??'ERROR'}`);return;}
     if(event.type==='incomplete'){emit(event);failProbe('BRIDGE_INCOMPLETE');return;}
     if(event.type==='tool_call_start'){
      if(call)throw new Error('Overlapping native viewer requests are forbidden');
      call={id:event.id,name:event.name,arguments:''};events.push(event);return;
     }
     if(event.type==='tool_call_delta'){
      if(!call||call.arguments.length+event.arguments.length>65536)throw new Error('Invalid bounded viewer argument stream');
      call.arguments+=event.arguments;events.push(event);return;
     }
     if(event.type==='tool_call_end'){
      if(!call)throw new Error('Viewer request ended without an owned invocation');
      const args=JSON.parse(call.arguments),validated=validateViewerInvocation(call.name,args,route,imagePath);
      report.native_viewer_detail=validated.detail;
      receipts.observeInvocation(route==='direct'
       ?{type:'function_call',call_id:call.id,name:call.name,arguments:call.arguments}
       :{type:'custom_tool_call',call_id:call.id,name:call.name,input:args.input});
      events.push(event);for(const buffered of events)emit(buffered);events.length=0;call=undefined;return;
     }
     if(event.type==='done'&&call)throw new Error('Unsettled viewer arguments cannot complete a native tool round');
     emit(event);
    });}catch(error){failProbe('NATIVE_VIEWER_OUTBOUND_VALIDATION_FAILED');throw error;}
   }};
  };
  ChatGptBrowserWorker.prototype.run=function(turn:BrowserTurn){
   report.browser_owners++;if(report.browser_owners!==1)throw new Error('Another browser owner is forbidden in the viewer probe');
   report.trace_id=turn.traceId;if(turn.conversationKey)keys.add(turn.conversationKey);
   return originalRun.call(this,{...turn,prepare:async()=>{const prepared=await turn.prepare();
    try{assertFixedProbeInline(prepared);if(prepared.images.length)throw new Error('Viewer fixture cannot upload screenshots to the composer');return prepared;}
    catch(error){prepared.release();throw error;}},onSubmitted:async()=>{report.accepted_sends++;await turn.onSubmitted?.();}});
  };
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
   try{
    if(!new URL(request.url).pathname.endsWith('/responses'))return new Response('Owned Responses fixture only',{status:404});
    const body=await request.json() as Record<string,any>;report.native_http_rounds++;
    if(!report.first_native_request_shape)report.first_native_request_shape=nativeViewerRequestShape(body);
    if(!report.environment_diagnostic){
     const parsed=parseRequest(body),diagnostic:Record<string,unknown>={};
     try{const claim=extractChatGptTurnEnvironmentClaim(parsed);diagnostic.claim_type=claim.environment.sandboxPolicy.type;diagnostic.network_explicit=claim.statesNetworkAccess;}
     catch(error){diagnostic.claim_error=error instanceof Error?error.message:'Unknown environment claim error';}
     try{const verified=new ChatGptThreadEnvironmentStore(undefined,Date.now,codexHome,codexHome).resolve(parsed);diagnostic.rollout_type=verified.sandboxPolicy.type;diagnostic.rollout_cwd_matches=resolve(verified.cwd)===resolve(root);}
     catch(error){diagnostic.rollout_error=error instanceof Error?error.message:'Unknown environment rollout error';}
     report.environment_diagnostic=diagnostic;
    }
    body.tools=onlyNativeViewerTools(body.tools,route);
    report.native_tool_image_receipts=receipts.collect(body.input);
    const response=await responseRequest(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body),signal:abort.signal}),
     transport!.config,guardedFactory,{rememberState:false});
    if(!response.ok)failProbe(`NATIVE_VIEWER_HTTP_${response.status}`);
    return response;
   }catch(error){nativeFailure=error instanceof Error?error.message:String(error);failProbe('NATIVE_VIEWER_REQUEST_FAILED');return Response.json({error:{code:'owned_native_viewer_probe_failed',message:'Owned native viewer diagnostic failed'}},{status:400});}
  }});
  child=spawn(executable,['app-server','--stdio','-c',`model_catalog_json=${JSON.stringify(catalogPath)}`,'-c','model_provider="viewer_fixture"',
   '-c','model_reasoning_effort="high"',
   '-c',`model_providers.viewer_fixture={name="Owned DEV viewer",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false}`],
   {env:nativeEnv,cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const failNative=(code:string)=>{
   proof.fail('NATIVE_RPC_OR_PIPE_ERROR');nativeFailure ||= code;abort.abort();completed();
   for(const pending of rpcPending.values())pending.reject(new Error(nativeFailure));rpcPending.clear();
  };
  child.once('error',()=>failNative('Owned native app-server spawn failed'));
  child.stdin!.once('error',()=>failNative('Owned native app-server stdin failed'));
  child.stdout!.once('error',()=>failNative('Owned native app-server stdout failed'));
  const closed=new Promise<void>(resolveClosed=>child!.once('close',()=>{proof.childClosed();childClosed=true;resolveClosed();completed();
   for(const pending of rpcPending.values())pending.reject(new Error('Owned native app-server closed before RPC settlement'));rpcPending.clear();}));
  report.native_pid=child.pid;
  let sequence=0;
  const lines=createInterface({input:child.stdout!});
  child.stderr!.on('data',()=>{}); // Native logs can contain tool payloads. Do not export them.
  lines.on('line',line=>{
   try{
    const value=JSON.parse(line);
    if(value.method==='turn/started'&&value.params?.threadId===ownedThreadId&&typeof value.params?.turn?.id==='string')proof.bindTurn(value.params.turn.id);
    proof.onNativeNotification(value);
    if(proof.failureCode){failNative(proof.failureCode);return;}
    if(value.id!==undefined){const pending=rpcPending.get(value.id);if(pending){rpcPending.delete(value.id);value.error?pending.reject(new Error('Native RPC rejected the owned fixture request')):pending.resolve(value.result);}}
    if(value.method==='thread/tokenUsage/updated'&&value.params?.threadId===ownedThreadId)
     report.native_resolved_context_window=value.params.tokenUsage?.modelContextWindow??null;
    if(value.method==='turn/completed'&&value.params?.threadId===ownedThreadId)completed();
   }catch{failNative('Native app-server returned invalid notification JSON');}
  });
  const rpc=(method:string,params:unknown)=>new Promise<any>((resolveRpc,reject)=>{
   if(abort.signal.aborted||childClosed||!child?.stdin?.writable){reject(new Error('Owned native RPC cannot start after cancellation or child closure'));return;}
   const id=++sequence,rpcTimer=setTimeout(()=>{rpcPending.delete(id);reject(new Error(`Owned native ${method} RPC exceeded 15000ms`));failNative('Owned native RPC deadline expired');},15000);
   rpcPending.set(id,{resolve:value=>{clearTimeout(rpcTimer);resolveRpc(value);},reject:error=>{clearTimeout(rpcTimer);reject(error);}});
   child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  await rpc('initialize',{clientInfo:{name:'owned-native-viewer-probe',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin!.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const thread=await rpc('thread/start',{cwd:root,model:model.slug,modelProvider:'viewer_fixture',approvalPolicy:'never',sandbox:'read-only',ephemeral:false});
  ownedThreadId=thread.thread.id;proof.bindThread(ownedThreadId!);
  const started=await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:`Authorized local image-only diagnostic. Use codex_view_image exactly once on ${JSON.stringify(imagePath)} with detail original. No shell, clipboard, web, OCR program, screenshots or extra viewer calls. Read the eight printed digits and dominant top-left, top-right, bottom-left, bottom-right colors directly from the tool pixels. Return only JSON {"marker":"${marker}","challenge":"digits","colors":["color names"]}. If pixels are inaccessible, report that explicitly rather than guessing.`}]});
  proof.bindTurn(started.turn.id);
  await completedTurn;
  if(nativeFailure)throw new Error(nativeFailure);
  finalText=proof.assertCompleted();report.native_tool_image_receipts=receipts.assertImageReceived();
  report.fixture_answer=finalText.slice(0,512);
  const answer=JSON.parse(finalText.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  report.reported_challenge=answer.challenge;report.reported_colors=answer.colors;
  if(answer.marker!==marker||answer.challenge!==challenge||JSON.stringify(answer.colors?.map((value:string)=>value.toLowerCase()))!==JSON.stringify(palette.map(value=>value.name)))throw new Error('Actual Web-model pixel challenge failed');
  if(report.native_tool_image_receipts.length!==1||report.accepted_sends!==1||report.browser_owners!==1)throw new Error('Viewer must deliver one actual native tool image through one owned user Send');
  report.model_pixel_recognition_verified=true;report.status='PASS';
  child.stdin!.end();await Promise.race([closed,new Promise(resolveWait=>setTimeout(resolveWait,2500))]);
 }catch(error){report.status='FAIL';report.error=error instanceof Error?error.message:String(error);report.proof_failure=proof.failureCode??receipts.failureCode;process.exitCode=1;}
 finally{
  clearTimeout(timeout);abort.abort();ChatGptBrowserWorker.prototype.run=originalRun;
  const errors:string[]=[];child?.stdin?.end();
  if(transportStarting&&!transport)errors.push('DEV startup resolution/late cleanup not yet observed; cleanup is unverified');
  if(child&&!childClosed){const exited=new Promise<void>(resolveExit=>child!.once('close',()=>{childClosed=true;resolveExit();}));child.kill();await Promise.race([exited,new Promise(resolveWait=>setTimeout(resolveWait,2500))]);}
  report.native_process_exited=childClosed;if(child&&!childClosed)errors.push('Owned native child exit was not observed');
  await withViewerDeadline(()=>closeChatGptBrowserWorkers(),5000,'Owned browser worker cleanup').catch(error=>errors.push(String(error)));
  if(report.status==='FAIL'&&typeof report.trace_id==='string'){
   try{
    const descriptor=readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
    if(descriptor.profile!==DEV_LAUNCHER_PROFILE||descriptor.pid!==initialDescriptor.pid)throw new Error('DEV host ownership changed before terminal cleanup');
    const browser=await chromium.connectOverCDP(descriptor.endpoint,{noDefaults:true,timeout:5000});
    try{
     const shells=browser.contexts().flatMap(context=>context.pages()).filter(page=>/^http:\/\/(127\.0\.0\.1|localhost):4178\//.test(page.url()));
     if(shells.length!==1)throw new Error('Unique source DEV renderer required for cleanup');
     report.terminal_tab_cleanup=await withViewerDeadline(()=>shells[0]!.evaluate(async trace=>{
      const api=(window as any).codexWebLauncher,state=await api.snapshot();
      if(state.profile!=='development')throw new Error('Renderer profile changed');
      const matches=state.browser.tabs.filter((tab:any)=>tab.id!=='home'&&tab.traceId===trace);
      if(matches.length===0)return{owned_tab_absent:true};
      if(matches.length!==1)throw new Error('Ambiguous owned trace during cleanup');
      const tab=matches[0];
      if(['ready','completed','complete'].includes(tab.status))return{terminal_status:tab.status};
      if(tab.status!=='error'||!tab.closable)throw new Error('Owned tab has not reached a terminal cleanup boundary');
      await api.closeBrowserTab(tab.id);return{terminal_error_tab_closed:true};
     },report.trace_id),5000,'Owned terminal renderer cleanup');
    }finally{await withViewerDeadline(()=>browser.close(),5000,'Owned CDP cleanup');}
   }catch(error){errors.push(`Owned terminal tab cleanup: ${String(error)}`);}
  }
  let released=0;for(const key of keys)await withViewerDeadline(()=>releaseLauncherRetainedConversation(config.browserHostDescriptorPath!,key),5000,'Owned retained-surface cleanup').then(count=>{released+=count;},error=>errors.push(String(error)));
  if(transport)await withViewerDeadline(()=>transport!.close(),5000,'Owned DEV transport cleanup').catch(error=>errors.push(String(error)));server?.stop(true);
  if(originalCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=originalCodexHome;
  if(originalSqliteHome===undefined)delete process.env.CODEX_SQLITE_HOME;else process.env.CODEX_SQLITE_HOME=originalSqliteHome;
  report.cleanup={released,errors};if(errors.length){report.status='FAIL';process.exitCode=1;}
  report.finished_at=new Date().toISOString();const artifact=`output/dev-native-viewer-${route}-${Date.now()}.json`;
  writeFileSync(artifact,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,artifact}));
 }
}
if(import.meta.main)await run();
