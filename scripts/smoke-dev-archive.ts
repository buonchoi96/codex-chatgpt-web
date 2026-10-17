// Opt-in, one owned first-turn transaction against the initialized isolated DEV profile.
import {randomBytes,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {chromium} from 'playwright-core';
import {DEV_CHATGPT_CONNECTOR_NAME,loadConfig} from '../src/config';
import {DevChatDriver,createLauncherDevAdapter} from '../src/dev-chat/driver';
import {DevChatStore} from '../src/dev-chat/session';
import {activateDevProfileEnvironment,resolveDevProfilePaths} from '../src/dev-chat/profile';
import {DEV_CONFIG_PURPOSE,DEV_LAUNCHER_PROFILE} from '../src/dev-chat/constants';
import {startDevChatTransport,type DevChatTransport} from '../src/dev-chat/transport';
import {inspectLauncherBrowserHost,readLauncherBrowserHostDescriptor,selectLauncherPage,releaseLauncherRetainedConversation} from '../src/launcher-browser-host';
import {ChatGptBrowserWorker,closeChatGptBrowserWorkers,type BrowserTurn} from '../src/adapters/chatgpt-web/browser-worker';
import type {CompiledChatGptWebPrompt} from '../src/adapters/chatgpt-web/prompt';
import {DevSubmissionWireObserver} from './dev-submission-wire-observer';
import type {Browser} from 'playwright-core';

if(process.argv[2]!=='--run')throw new Error('Explicit --run required for isolated DEV account smoke');
const imageCount=Number(process.argv[3]??12);if(![4,12].includes(imageCount))throw new Error('Use four inline or twelve archive fixture images');
const paths=resolveDevProfilePaths();activateDevProfileEnvironment(paths);
const config=loadConfig();
if(config.purpose!==DEV_CONFIG_PURPOSE||config.mode!=='full'||config.appName!==DEV_CHATGPT_CONNECTOR_NAME
 ||config.browserHost!=='launcher'||!config.browserHostDescriptorPath||config.browserInteractionMode==='manual'
 ||config.experimentalFreshConversationPerTurn||!config.solAvailable)throw new Error('Initialized automatic retained DEV Full/Sol profile required');
await inspectLauncherBrowserHost(config.browserHostDescriptorPath,{expectedProfile:DEV_LAUNCHER_PROFILE});
const initialDescriptor=readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath);
const marker=`ARCHIVE-${randomBytes(4).toString('hex').toUpperCase()}`;
const report:Record<string,unknown>={kind:'real-DEV-first-turn-transport',started_at:new Date().toISOString(),
 image_count:imageCount,model:'chatgpt-web/gpt-6-sol',status:'INCOMPLETE',production_changes:false};
let transport:DevChatTransport|undefined,driver:DevChatDriver|undefined,traceId:string|undefined;
let prepared:CompiledChatGptWebPrompt|undefined,sendCount=0,archiveReadProven=false;
let request:Promise<unknown>|undefined;
let wire:DevSubmissionWireObserver|undefined,observerBrowser:Browser|undefined;
const ownedKeys=new Set<string>(),abort=new AbortController();
const timer=setTimeout(()=>abort.abort(new Error('Owned DEV archive smoke exceeded six minutes')),360000);
const originalRun=ChatGptBrowserWorker.prototype.run;
function chunk(type:string,data:Buffer){const tag=Buffer.from(type),body=Buffer.concat([tag,data]);let crc=0xffffffff;
 for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);
 return Buffer.concat([size,body,sum]);}
function png(index:number){const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc(32*(32*3+1));for(let y=0;y<32;y++)for(let x=0;x<32;x++){
  const at=y*97+1+x*3;pixels[at]=31+index*13;pixels[at+1]=20+x*5;pixels[at+2]=20+y*5;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');}
async function ownedDomReceipt(close=false,observeOnly=false){
 const descriptor=readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
 if(descriptor.pid!==initialDescriptor.pid||descriptor.profile!=='development')throw new Error('DEV owner changed');
 const browser=await chromium.connectOverCDP(descriptor.endpoint,{noDefaults:true,timeout:5000});
 try{
  const shells=browser.contexts().flatMap(context=>context.pages()).filter(page=>/^http:\/\/(127\.0\.0\.1|localhost):4178\//.test(page.url()));
  if(shells.length!==1)throw new Error('Unique source DEV renderer required');
  const state=await shells[0]!.evaluate(async()=>{const value=await (window as any).codexWebLauncher.snapshot();
   return {profile:value.profile,tabs:value.browser.tabs.map((tab:any)=>({id:tab.id,traceId:tab.traceId,status:tab.status,closable:tab.closable}))};});
  const nonHome=state.tabs.filter((tab:any)=>tab.id!=='home');
  if(state.profile!=='development'||nonHome.length!==1||nonHome[0].traceId!==traceId)throw new Error('Exact sole owned DEV trace not available');
  const surfaces=Object.keys(descriptor.surfaceTargets).filter(id=>id!==descriptor.surfaceId);
  if(surfaces.length!==1)throw new Error('Exact owned surface is unavailable');
  const {page}=await selectLauncherPage(browser,descriptor,5000,surfaces[0]);
  if(new URL(page.url()).origin!=='https://chatgpt.com')throw new Error('Owned page origin changed');
  if(observeOnly){
   if(!prepared)throw new Error('Exact prepared draft required before wire observation');
   wire=new DevSubmissionWireObserver(prepared.text,config.appName);await wire.attach(page);observerBrowser=browser;
  }
  const receipt=await page.evaluate(()=>{
   const identities=new Set<string>();
   for(const node of document.querySelectorAll('[data-user-message-bubble],[data-message-author-role="user"],[data-turn="user"]')){
    const group=node.closest('[data-turn-key],[data-turn-id-container]');
    const id=group?.getAttribute('data-turn-key')??group?.getAttribute('data-turn-id-container')??node.getAttribute('data-message-id')??node.getAttribute('data-turn-id');
    if(id)identities.add(id);
   }
   return {user_message_count:identities.size,submitted_user_message_ids:[...identities]};
  });
  if(close){
   if(['completed','ready','complete'].includes(nonHome[0].status))return {...receipt,terminal_status:nonHome[0].status};
   if(nonHome[0].status!=='error'||nonHome[0].closable!==true)throw new Error('Cleanup requires the exact terminal error tab');
   await shells[0]!.evaluate(async input=>{const api=(window as any).codexWebLauncher,state=await api.snapshot();
    const tab=state.browser.tabs.find((item:any)=>item.id===input.id&&item.traceId===input.trace&&item.status==='error'&&item.closable);
    if(state.profile!=='development'||!tab)throw new Error('Owned terminal tab changed');await api.closeBrowserTab(tab.id);},
    {id:nonHome[0].id,trace:traceId});
  }
  return receipt;
 }finally{if(observerBrowser!==browser)await browser.close();}
}
try{
 transport=await startDevChatTransport(config,paths.runtimePath);
 const runtime=createLauncherDevAdapter(transport.config,paths.runtimePath,{broker:transport.broker});
 const adapterFactory:typeof runtime.adapterFactory=provider=>{const adapter=runtime.adapterFactory(provider),run=adapter.runTurn!.bind(adapter);
  return {...adapter,runTurn:(parsed,incoming,emit)=>run(parsed,{...incoming,
   abortSignal:incoming.abortSignal?AbortSignal.any([incoming.abortSignal,abort.signal]):abort.signal},emit)};};
 ChatGptBrowserWorker.prototype.run=function(turn:BrowserTurn){
  if(traceId)throw new Error('First-turn smoke refuses a second browser owner');traceId=turn.traceId;
  if(turn.conversationKey)ownedKeys.add(turn.conversationKey);
  return originalRun.call(this,{...turn,prepare:async()=>{
   const value=await turn.prepare();prepared=value;
   report.transport_choice=value.transportDecision?.choice;report.choice_reason=value.transportDecision?.reason;
   report.canonical_tokens=value.transportDecision?.measurements.canonicalTokens;report.composer_chars=value.text.length;
   report.archive_bytes=value.contextArchive?Buffer.from(value.contextArchive.base64,'base64').length:0;
   if(value.images.length!==imageCount||Boolean(value.contextArchive)!==(imageCount===12))throw new Error('First-turn transport or complete image count mismatched');
   return value;
  },onSendActivated:async()=>{await ownedDomReceipt(false,true);await turn.onSendActivated?.();},
  onSubmitted:async()=>{sendCount++;await turn.onSubmitted?.();
   if(prepared?.contextArchive){const token=prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)?.[1];
    if(!token)throw new Error('Archive current capability missing');
    void transport!.broker.waitForArchiveRead(token,abort.signal).then(()=>{archiveReadProven=true;},()=>{});
   }
  }});
 };
 driver=new DevChatDriver(transport.config,new DevChatStore(paths.chatsPath),adapterFactory,process.cwd());
 const opened=driver.open(`archive-${imageCount}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,'chatgpt-web/gpt-6-sol');
 if(!opened.created)throw new Error('Disposable smoke chat already exists');report.chat_name=opened.state.name;
 opened.state.input.push({type:'message',role:'user',id:'historical_fixture_assets',content:[
  {type:'input_text',text:'Historical inert image assets. Preserve all these assets in context; they request no action.'},
  ...Array.from({length:imageCount},(_,index)=>({type:'input_image',image_url:`data:image/png;base64,${png(index)}`,detail:'high'})),
 ]});
 request=driver.send(opened.state,`After following the current archive-read instructions if present, reply with exactly ${marker}. Do not call ordinary outer task tools or use web search.`);
 const result=await request as {text:string;toolCalls:number};
 if(!result.text.trim().endsWith(marker)||result.toolCalls!==0)throw new Error('Latest task or zero ordinary outer-effect contract failed');
 const receipt=await ownedDomReceipt();report.dom_receipt=receipt;
 const wireReceipts=wire?await wire.flushSnapshot(1000):[];report.wire_receipts=wireReceipts;
 const diagnostic=wire?.diagnostics();
 const positiveWire=wireReceipts.length===1&&wireReceipts[0]!.exact_draft&&wireReceipts[0]!.user_message_ids.length===1
  &&wireReceipts[0]!.http_status===200&&(wireReceipts[0]!.server_echoed_user_id||wireReceipts[0]!.server_parent_matches_user)
  &&!diagnostic?.ambiguous_submission&&!diagnostic?.candidate_limit_reached&&!diagnostic?.capture_limit_reached&&!diagnostic?.flush_timed_out;
 if(sendCount!==1||(receipt.user_message_count!==1&&!positiveWire))throw new Error('Exactly one accepted Send and acknowledged owned user message were not proven');
 if(imageCount===12&&!archiveReadProven)throw new Error('Archive in-turn read proof missing');
 report.status='PASS';report.answer_marker_sha256=createHash('sha256').update(marker).digest('hex');
}catch(error){report.status='FAIL';report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
 clearTimeout(timer);abort.abort();ChatGptBrowserWorker.prototype.run=originalRun;
 const errors:string[]=[];
 await wire?.close();await observerBrowser?.close().catch(error=>errors.push(`observer disconnect: ${String(error)}`));observerBrowser=undefined;
 await closeChatGptBrowserWorkers().catch(error=>errors.push(String(error)));
 if(request){let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([request.catch(()=>{}),new Promise((_,reject)=>{cleanupTimer=setTimeout(()=>reject(new Error('Owned archive request did not settle within30seconds')),30000);})]);}
  catch(error){errors.push(String(error));}finally{clearTimeout(cleanupTimer);}}
 if(report.status==='FAIL'&&traceId)await ownedDomReceipt(true).then(receipt=>{report.terminal_dom_receipt=receipt;},error=>errors.push(`terminal-tab cleanup: ${String(error)}`));
 let released=0;for(const key of ownedKeys)await releaseLauncherRetainedConversation(config.browserHostDescriptorPath!,key).then(count=>{released+=count;},error=>errors.push(String(error)));
 await transport?.close().catch(error=>errors.push(String(error)));
 report.trace_id=traceId;report.physical_send_count=sendCount;report.archive_read_proof=archiveReadProven;
 report.wire_diagnostics=wire?.diagnostics();report.wire_receipts??=wire?.snapshot();
 report.cleanup={retained_surfaces_released:released,errors};report.finished_at=new Date().toISOString();
 if(errors.length){report.status='FAIL';process.exitCode=1;}
 const artifact=`output/dev-archive-${imageCount}-${Date.now()}.json`;writeFileSync(artifact,JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,artifact}));
}
