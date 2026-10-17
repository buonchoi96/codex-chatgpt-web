// Account-bound opt-in smoke: run only against an already initialized isolated DEV Launcher.
import {randomBytes} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DEV_CHATGPT_CONNECTOR_NAME,loadConfig} from '../src/config';
import {DevChatDriver,createLauncherDevAdapter} from '../src/dev-chat/driver';
import {DEV_CONFIG_PURPOSE,DEV_LAUNCHER_PROFILE} from '../src/dev-chat/constants';
import {DevChatStore} from '../src/dev-chat/session';
import {activateDevProfileEnvironment,resolveDevProfilePaths} from '../src/dev-chat/profile';
import {startDevChatTransport,type DevChatTransport} from '../src/dev-chat/transport';
import {inspectLauncherBrowserHost,releaseLauncherRetainedConversation} from '../src/launcher-browser-host';
import {ChatGptBrowserWorker,closeChatGptBrowserWorkers,type BrowserTurn} from '../src/adapters/chatgpt-web/browser-worker';
import {chatGptTurnSessions} from '../src/adapters/chatgpt-web/turn-execution';
import {responseRequest} from '../src/server';
import type {CodexParsedRequest} from '../src/types';

if(process.argv[2]!=='--run')throw new Error('This live DEV steering smoke requires explicit --run');
const paths=resolveDevProfilePaths();activateDevProfileEnvironment(paths);
if(!existsSync(paths.configPath))throw new Error('The isolated DEV harness is not configured');
const config=loadConfig();
if(config.purpose!==DEV_CONFIG_PURPOSE||config.browserHost!=='launcher'||!config.browserHostDescriptorPath)
  throw new Error('Steering smoke requires the isolated DEV Launcher profile');
if(config.experimentalFreshConversationPerTurn||config.browserInteractionMode==='manual'||!config.solAvailable)
  throw new Error('Steering smoke requires automatic retained Sol conversations');
if(config.mode==='full'&&config.appName!==DEV_CHATGPT_CONNECTOR_NAME)throw new Error('The DEV connector identity is outdated');
await inspectLauncherBrowserHost(config.browserHostDescriptorPath,{expectedProfile:DEV_LAUNCHER_PROFILE});

const marker=`STEER-${randomBytes(4).toString('hex').toUpperCase()}`;
const report:{[key:string]:unknown}={kind:'real-isolated-DEV-steering',started_at:new Date().toISOString(),
  model:'chatgpt-web/gpt-6-sol',marker,status:'INCOMPLETE',production_changes:false};
const events:Array<{event:string;at:string;[key:string]:unknown}>=[];
const ownedKeys=new Set<string>(),ownedTurns=new Set<string>();
const originalRun=ChatGptBrowserWorker.prototype.run;
let transport:DevChatTransport|undefined,driver:DevChatDriver|undefined,initialParsed:CodexParsedRequest|undefined;
let steeringRequest:Promise<Record<string,unknown>>|undefined,steeringQueued=false,originalAccepted=false;
let startSteering=()=>{},initialRequest:Promise<unknown>|undefined;
let observedToolCalls=0;
let oldObserverTerminal:{code:string;retryable:boolean}|undefined;
const record=(event:string,detail:Record<string,unknown>={})=>events.push({event,at:new Date().toISOString(),...detail});
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(new Error('DEV steering smoke exceeded four minutes')),240000);
let threadId:string|undefined;

try {
  transport=config.mode==='full'?await startDevChatTransport(config,paths.runtimePath):undefined;
  const runtimeConfig=transport?.config??config;
  const runtime=createLauncherDevAdapter(runtimeConfig,paths.runtimePath,{...(transport?{broker:transport.broker}:{})});
  const adapterFactory:typeof runtime.adapterFactory=provider=>{
    const adapter=runtime.adapterFactory(provider);
    const run=adapter.runTurn!.bind(adapter);
    return {...adapter,runTurn:async(parsed,incoming,emit)=>{
      initialParsed??=parsed;
      const raw=parsed._rawBody as {client_metadata?:Record<string,string>};
      const identity=JSON.parse(raw.client_metadata?.['x-codex-turn-metadata']??'{}') as {turn_id?:string;thread_id?:string};
      if(identity.turn_id)ownedTurns.add(identity.turn_id);threadId??=identity.thread_id;
      await run(parsed,{...incoming,abortSignal:incoming.abortSignal?AbortSignal.any([incoming.abortSignal,controller.signal]):controller.signal},event=>{
        if(parsed===initialParsed&&event.type==='error'){
          oldObserverTerminal={code:event.code??'',retryable:event.retryable===true};
          record('old_observer_terminal',oldObserverTerminal);
        }
        if(event.type==='tool_call_start'){
          observedToolCalls++;record('unexpected_simulated_tool_observed');
          controller.abort(new Error('This reasoning-only smoke does not accept simulated tool calls'));
        }
        emit(event);
      });
    }};
  };
  ChatGptBrowserWorker.prototype.run=function(turn:BrowserTurn){
    if(turn.conversationKey)ownedKeys.add(turn.conversationKey);
    record('browser_owner_started',{trace_id:turn.traceId});
    const tracked:BrowserTurn={...turn,
      prepare:async()=>{const prepared=await turn.prepare();record('initial_prompt_prepared',{zip_count:prepared.contextArchive?1:0});return prepared;},
      onSubmitted:async()=>{await turn.onSubmitted?.();originalAccepted=true;record('original_send_accepted');},
      onReasoningSummary:(text,continuation)=>{
        turn.onReasoningSummary?.(text,continuation);
        if(text.trim()&&originalAccepted&&!steeringQueued){record('reasoning_observed');startSteering();}
      },
      ...(turn.prepareRecovery?{prepareRecovery:async request=>{
        const prepared=await turn.prepareRecovery!(request);
        record('recovery_delta_prepared',{steering:request?.steering===true,delta_id:prepared.steeringDeltaId,
          zip_count:prepared.contextArchive?1:0});
        return prepared;
      }}:{}),
      ...(turn.onSteeringSubmitted?{onSteeringSubmitted:async deltaId=>{
        await turn.onSteeringSubmitted!(deltaId);record('steering_receipt_committed',{delta_id:deltaId});
      }}:{}),
    };
    return originalRun.call(this,tracked);
  };
  driver=new DevChatDriver(runtimeConfig,new DevChatStore(paths.chatsPath),adapterFactory,process.cwd());
  const opened=driver.open(`steering-smoke-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,'chatgpt-web/gpt-6-sol');
  if(!opened.created)throw new Error('Steering smoke chat unexpectedly already exists');
  report.chat_name=opened.state.name;
  startSteering=()=>{
    if(steeringQueued||!initialParsed) return;
    steeringQueued=true;
    const raw=structuredClone(initialParsed._rawBody) as Record<string,unknown>;
    const input=raw.input as Array<Record<string,unknown>>;
    const metadata=raw.client_metadata as Record<string,string>;
    const identity=JSON.parse(metadata['x-codex-turn-metadata']!) as Record<string,unknown>;
    const turnId=`dev_steer_${crypto.randomUUID().replaceAll('-','')}`;
    metadata['x-codex-turn-metadata']=JSON.stringify({...identity,turn_id:turnId});
    const environment=input.find(item=>Array.isArray(item.content)&&item.content.some(value=>
      typeof value==='object'&&value!==null&&typeof (value as {text?:unknown}).text==='string'
      &&(value as {text:string}).text.startsWith('<environment_context>')));
    if(!environment)throw new Error('The original DEV request has no canonical environment envelope');
    input.push({...structuredClone(environment),id:`msg_dev_steer_environment_${turnId}`,
      internal_chat_message_metadata_passthrough:{turn_id:turnId}},
      {type:'message',id:`msg_dev_steer_${turnId}`,role:'user',content:[{type:'input_text',text:
        `Replace the calculation with this new instruction. Reply with exactly ${marker}. Use no tools.`}],
      internal_chat_message_metadata_passthrough:{turn_id:turnId}});
    record('steering_request_started');
    steeringRequest=responseRequest(new Request('http://codex-web-gpt.dev/v1/responses',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(raw),signal:controller.signal}),runtimeConfig,adapterFactory,
      {rememberState:false}).then(async response=>await response.json() as Record<string,unknown>);
    void steeringRequest.catch(()=>{});
  };
  initialRequest=driver.send(opened.state,
    'Without tools, carefully derive and verify the number of trailing zeroes of 100000 factorial in each base from 2 through 37. Explain the prime-factor method and independently check the calculations before writing the final table.');
  const initialOutcome=await initialRequest.then(()=>({status:'completed'}),error=>({status:'detached_or_failed',message:error instanceof Error?error.message:String(error)}));
  report.initial_observer=initialOutcome;
  report.old_observer_terminal=oldObserverTerminal;
  if(!steeringRequest)throw new Error('The original answer completed without an observed active reasoning interval; mid-reasoning steering was not tested');
  const latest=await steeringRequest;
  if(latest.status!=='completed'||latest.end_turn!==true)throw new Error('The steered DEV response did not finish normally');
  const answer=(Array.isArray(latest.output)?latest.output:[]).flatMap(item=>{
    const message=item as {type?:string;phase?:string;content?:Array<{type?:string;text?:string}>};
    return message.type==='message'&&message.phase!=='commentary'?(message.content??[]).flatMap(block=>
      block.type==='output_text'&&typeof block.text==='string'?[block.text]:[]):[];
  }).join('').trim();
  if(!answer.endsWith(marker))throw new Error('The steered answer did not contain the exact latest instruction marker');
  if(events.filter(event=>event.event==='browser_owner_started').length!==1)throw new Error('Steering replaced the original browser owner');
  const deltas=events.filter(event=>event.event==='recovery_delta_prepared'&&event.steering===true);
  const receipts=events.filter(event=>event.event==='steering_receipt_committed');
  if(deltas.length!==1||receipts.length!==1||!deltas[0]!.delta_id||deltas[0]!.delta_id!==receipts[0]!.delta_id)
    throw new Error('The smoke requires exactly one steering delta and its matching canonical Send receipt');
  if(deltas[0]!.zip_count!==0)throw new Error('Warm steering did not prove zero archive uploads');
  if(observedToolCalls!==0)throw new Error('The reasoning-only smoke observed a simulated tool call');
  if(oldObserverTerminal?.code!=='client_cancelled'||oldObserverTerminal.retryable!==false)
    throw new Error('The displaced observer was not classified as a terminal client cancellation');
  if(events.some(event=>event.event==='recovery_delta_prepared'&&event.zip_count!==0))throw new Error('Warm steering uploaded historical ZIP');
  report.status='PASS';report.answer_ends_with_marker=true;
}catch(error){report.status='FAIL';report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally {
  clearTimeout(timeout);controller.abort();
  ChatGptBrowserWorker.prototype.run=originalRun;
  const cleanupErrors:string[]=[];
  const cancellations:Promise<void>[]=[];
  if(threadId)for(const turnId of ownedTurns){
    const cancellation=chatGptTurnSessions.cancelNativeTurn(threadId,turnId,new DOMException('Owned DEV smoke cleanup','AbortError'));
    cancellations.push(cancellation.settlement);
  }
  // Close this process's helper first: its owned-child shutdown/termination settles runs
  // even when a browser abort did not return. Never wait on that abort before closing.
  await closeChatGptBrowserWorkers().catch(error=>cleanupErrors.push(String(error)));
  const cleanupDeadline=async(action:Promise<unknown>,label:string)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([action,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`${label} did not settle within 30 seconds`)),30000);
    })]);}catch(error){cleanupErrors.push(String(error));}finally{clearTimeout(timer);}
  };
  await cleanupDeadline(Promise.allSettled([initialRequest,steeringRequest,...cancellations]),'Owned DEV request cleanup');
  let released=0;
  for(const key of ownedKeys)await releaseLauncherRetainedConversation(config.browserHostDescriptorPath!,key)
    .then(count=>{released+=count;},error=>cleanupErrors.push(String(error)));
  await transport?.close().catch(error=>cleanupErrors.push(String(error)));
  report.cleanup={known_owned_conversations:ownedKeys.size,retained_surfaces_released:released,errors:cleanupErrors};
  report.observed_simulated_tool_calls=observedToolCalls;
  if(cleanupErrors.length){report.status='FAIL';process.exitCode=1;}
  report.events=events;report.finished_at=new Date().toISOString();
  const artifact=join(process.cwd(),'output',`dev-steering-smoke-${Date.now()}.json`);
  writeFileSync(artifact,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,artifact}));
}
