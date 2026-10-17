// Diagnostic proof checks only. This module never invokes a native tool or executes code.
import {createHash} from 'node:crypto';
import {execGatewayProgram} from '../src/adapters/chatgpt-web/mcp-server';

export type NativeViewerRoute='direct'|'nested';
export class NativeViewerProofError extends Error{
 constructor(readonly code:string){super(code);this.name='NativeViewerProofError';}
}
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function reject(code:string):never{throw new NativeViewerProofError(code);}

/** Bound fixture awaits; late owned resources still receive their disposal callback. */
export function withViewerDeadline<T>(operation:()=>Promise<T>,timeoutMs:number,label:string,
 signal?:AbortSignal,onLate?:(value:T)=>Promise<void>):Promise<T>{
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid viewer wait budget');
 if(signal?.aborted)return Promise.reject(new Error(`${label} cancelled`));
 return new Promise<T>((resolve,rejectWait)=>{
  let settled=false,abandoned=false;
  const finish=(error?:unknown,value?:T)=>{
   if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
   if(error!==undefined)rejectWait(error);else resolve(value!);
  };
  const cancel=()=>{abandoned=true;finish(new Error(`${label} cancelled`));};
  const timer=setTimeout(()=>{abandoned=true;finish(new Error(`${label} exceeded deadline`));},timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});
  Promise.resolve().then(()=>{if(abandoned)throw new Error(`${label} cancelled before start`);return operation();}).then(value=>{
   if(abandoned){if(onLate)void onLate(value).catch(()=>{});return;}
   finish(undefined,value);
  },error=>finish(error));
 });
}

/** Main owns HTTP/stream/RPC timeouts and must call fail() on their first error. */
export class NativeViewerProofGuard{
 private threadId:string|undefined;
 private turnId:string|undefined;
 private firstFailure:string|undefined;
 private matchedCompletion=false;
 private matchedText:string|undefined;
 get failureCode():string|undefined{return this.firstFailure;}
 fail(code:string):void{this.firstFailure??=typeof code==='string'&&code.length>0&&code.length<=128?code:'INVALID_FAILURE_CODE';}
 bindThread(threadId:string):void{
  if(typeof threadId!=='string'||!threadId||threadId.length>512||(this.threadId!==undefined&&this.threadId!==threadId)){
   this.fail('INVALID_THREAD_BINDING');reject(this.firstFailure!);
  }
  this.threadId=threadId;
 }
 bindTurn(turnId:string):void{
  if(!this.threadId||typeof turnId!=='string'||!turnId||turnId.length>512||(this.turnId!==undefined&&this.turnId!==turnId)){
   this.fail('INVALID_TURN_BINDING');reject(this.firstFailure!);
  }
  this.turnId=turnId;
 }
 onNativeNotification(value:unknown):void{
  if(this.firstFailure||!object(value))return;
  if(value.error!==undefined&&value.error!==null){this.fail('NATIVE_RPC_ERROR');return;}
  if(value.method==='error'){this.fail('NATIVE_ERROR');return;}
  const params=value.params;
  if(!this.threadId||!this.turnId||!object(params)||params.threadId!==this.threadId)return;
  if(value.method==='item/completed'){
   if(params.turnId!==this.turnId||!object(params.item)||params.item.type!=='agentMessage')return;
   if(params.item.phase==='commentary')return;
   if(typeof params.item.text!=='string'||!params.item.text.trim()||params.item.text.length>16384){this.fail('INVALID_NATIVE_AGENT_TEXT');return;}
   this.matchedText=params.item.text;
  }
  if(value.method==='turn/completed'){
   if(!object(params.turn)||params.turn.id!==this.turnId||(params.turnId!==undefined&&params.turnId!==this.turnId))return;
   if(params.turn.status!=='completed'||params.turn.error!=null){this.fail('NATIVE_TURN_FAILED');return;}
   this.matchedCompletion=true;
  }
 }
 childClosed():void{if(!this.matchedCompletion)this.fail('NATIVE_CHILD_CLOSED_EARLY');}
 assertCompleted():string{
  if(this.firstFailure)reject(this.firstFailure);
  if(!this.matchedCompletion||this.matchedText===undefined)reject('MATCHED_NATIVE_COMPLETION_REQUIRED');
  return this.matchedText;
 }
}

export interface ValidatedViewerInvocation{
 route:NativeViewerRoute;path:string;detail:'high'|'original';metadataMarker?:string;
}
function argumentsObject(args:unknown):Record<string,unknown>{
 if(typeof args==='string'){
  if(args.length>65536)reject('INVALID_VIEWER_ARGUMENTS');
  try{args=JSON.parse(args);}catch{reject('INVALID_VIEWER_ARGUMENTS');}
 }
 if(!object(args))reject('INVALID_VIEWER_ARGUMENTS');return args;
}
/** Extract only the generator's exact control statement, never arbitrary code literals. */
export function extractViewerMetadataMarker(input:string):string{
 if(typeof input!=='string'||input.length>65536)reject('INVALID_VIEWER_GATEWAY');
 const frames=[...input.matchAll(/^text\("(codex-tool-result:[a-f0-9]{48}:)" \+ JSON.stringify\(relayMetadata\)\);$/gm)];
 if(frames.length!==1)reject('INVALID_VIEWER_METADATA_MARKER');return frames[0]![1]!;
}
export function validateViewerInvocation(name:string,args:unknown,route:NativeViewerRoute,imagePath:string):ValidatedViewerInvocation{
 if(typeof imagePath!=='string'||!imagePath||imagePath.length>16384)reject('INVALID_OWNED_IMAGE_PATH');
 const value=argumentsObject(args),keys=Object.keys(value).sort();
 if(route==='direct'){
  if(name!=='view_image'||JSON.stringify(keys)!=='["detail","path"]'||value.path!==imagePath||!['original','high'].includes(value.detail as string))
   reject('INVALID_DIRECT_VIEWER_INVOCATION');
  return{route,path:imagePath,detail:value.detail as 'high'|'original'};
 }
 if(route!=='nested'||name!=='exec'||JSON.stringify(keys)!=='["input"]'||typeof value.input!=='string')reject('INVALID_NESTED_VIEWER_INVOCATION');
 const metadataMarker=extractViewerMetadataMarker(value.input as string);
 for(const detail of ['original','high'] as const){
  const expected=execGatewayProgram('view_image',false,{arguments:{path:imagePath,detail}},['exec'],metadataMarker);
  if(value.input===expected)return{route,path:imagePath,detail,metadataMarker};
 }
 reject('FORBIDDEN_NESTED_VIEWER_CODE');
}

export interface NativeViewerImageReceipt{mime:'image/png'|'image/jpeg';bytes:number;sha256:string;callIdHash:string;}
export const MAX_NATIVE_VIEWER_IMAGE_BYTES=20*1024*1024;
function completePng(bytes:Buffer):boolean{
 if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
 let offset=8,header=false,data=false;
 while(offset+12<=bytes.length){
  const size=bytes.readUInt32BE(offset),end=offset+12+size;if(end>bytes.length)return false;
  const kind=bytes.toString('ascii',offset+4,offset+8);
  if(!header){if(kind!=='IHDR'||size!==13||bytes.readUInt32BE(offset+8)===0||bytes.readUInt32BE(offset+12)===0)return false;header=true;}
  else if(kind==='IHDR')return false;
  if(kind==='IDAT'&&size>0)data=true;
  if(kind==='IEND')return size===0&&data&&end===bytes.length&&bytes.readUInt32BE(offset+8)===0xae426082;
  offset=end;
 }
 return false;
}
function completeJpeg(bytes:Buffer):boolean{
 if(bytes.length<12||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)return false;
 let offset=2,frame=false,scan=false,entropy=false;
 while(offset<bytes.length){
  if(bytes[offset]!==255)return false;
  while(bytes[offset]===255)offset++;
  const marker=bytes[offset++];
  if(marker===217)return frame&&scan&&entropy&&offset===bytes.length;
  if(marker===undefined||marker===0||marker===216||(marker>=208&&marker<=215)||offset+2>bytes.length)return false;
  const size=bytes.readUInt16BE(offset),end=offset+size;if(size<2||end>bytes.length)return false;
  if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
   if(size<8||bytes.readUInt16BE(offset+3)===0||bytes.readUInt16BE(offset+5)===0)return false;frame=true;
  }
  offset=end;
  if(marker===218){
   if(!frame||size<6)return false;scan=true;
   while(offset<bytes.length){
    if(bytes[offset]!==255){entropy=true;offset++;continue;}
    const next=bytes[offset+1];
    if(next===0||(next!==undefined&&next>=208&&next<=215)){entropy=true;offset+=2;continue;}
    break;
   }
  }
 }
 return false;
}
function imageReceipt(imageUrl:unknown,callIdHash:string):NativeViewerImageReceipt{
 if(typeof imageUrl!=='string'||imageUrl.length>Math.ceil(MAX_NATIVE_VIEWER_IMAGE_BYTES/3)*4+64)reject('INVALID_NATIVE_IMAGE_SIZE');
 const match=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageUrl as string);
 if(!match)reject('INVALID_NATIVE_IMAGE_DATA_URL');
 const bytes=Buffer.from(match[2]!,'base64');
 if(!bytes.length||bytes.length>MAX_NATIVE_VIEWER_IMAGE_BYTES||bytes.toString('base64')!==match[2])reject('INVALID_NATIVE_IMAGE_ENCODING');
 const mime=match[1] as 'image/png'|'image/jpeg';
 if(!(mime==='image/png'?completePng(bytes):completeJpeg(bytes)))reject('INVALID_NATIVE_IMAGE_MAGIC');
 return{mime,bytes:bytes.length,sha256:hash(bytes),callIdHash};
}
function explicitError(value:unknown):boolean{
 return object(value)&&(value.isError===true||value.error!=null||['failed','error','cancelled'].includes(value.status));
}

/** One diagnostic invocation, one actual image. Stores hashes, never image bytes or gateway code. */
export class NativeViewerReceiptCollector{
 #oracle:string|undefined;
 private call:{hash:string;kind:string;signature:string;metadataMarker?:string}|undefined;
 private receipt:NativeViewerImageReceipt|undefined;
 private firstFailure:string|undefined;
 constructor(private readonly route:NativeViewerRoute,private readonly imagePath:string,oracle?:string){
  if(oracle!==undefined&&!/^\d{8}$/.test(oracle))reject('INVALID_NATIVE_VIEWER_ORACLE');
  this.#oracle=oracle;
 }
 private rejectOracleLeak(value:unknown):void{
  if(this.#oracle===undefined)return;
  const stack:Array<{value:unknown;depth:number}>=[{value,depth:0}],digits:string[]=[];let seen=0;
  while(stack.length){
   const entry=stack.pop()!;
   if(++seen>10000||entry.depth>32)reject('INVALID_NATIVE_VIEWER_METADATA_BUDGET');
   if(typeof entry.value==='string'){
    if(entry.value.length>65536)reject('INVALID_NATIVE_VIEWER_METADATA_BUDGET');
    digits.push(entry.value.replace(/\D/g,''));
    if(entry.value.includes(this.#oracle)||[...entry.value.matchAll(/\d(?:[\s,-]*\d){7}/g)].some(match=>match[0].replace(/\D/g,'')===this.#oracle))reject('NATIVE_VIEWER_ORACLE_LEAK');
   }else if(typeof entry.value==='number'){
    digits.push(String(entry.value).replace(/\D/g,''));
    if(entry.value===Number(this.#oracle))reject('NATIVE_VIEWER_ORACLE_LEAK');
   }else if(Array.isArray(entry.value)){
    for(const child of [...entry.value].reverse())stack.push({value:child,depth:entry.depth+1});
   }else if(object(entry.value)){
    for(const [key,child]of Object.entries(entry.value).reverse()){
     // Only the image data is excluded. Any text/metadata alongside it is
     // model-visible non-pixel evidence and must not contain the oracle.
     if(entry.value.type==='input_image'&&key==='image_url')continue;
     stack.push({value:child,depth:entry.depth+1},{value:key,depth:entry.depth+1});
    }
   }
  }
  if(digits.join('').includes(this.#oracle))reject('NATIVE_VIEWER_ORACLE_LEAK');
 }
 get failureCode():string|undefined{return this.firstFailure;}
 private healthy():void{if(this.firstFailure)reject(this.firstFailure);}
 private checked<T>(action:()=>T):T{
  this.healthy();try{return action();}catch(error){
   this.firstFailure??=error instanceof NativeViewerProofError?error.code:'INVALID_NATIVE_VIEWER_HISTORY';reject(this.firstFailure);
  }
 }
 observeInvocation(value:unknown):void{this.checked(()=>this.invocation(value));}
 private invocation(value:unknown):void{
  if(!object(value)||value.type!==(this.route==='direct'?'function_call':'custom_tool_call')||typeof value.call_id!=='string'||!value.call_id||value.call_id.length>512)
   reject('INVALID_NATIVE_VIEWER_CALL');
  const validated=validateViewerInvocation(value.name,value.type==='function_call'?value.arguments:{input:value.input},this.route,this.imagePath);
  const callIdHash=hash(value.call_id),signature=hash(JSON.stringify(validated));
  if(this.call){if(this.call.hash!==callIdHash||this.call.signature!==signature)reject('EXTRA_OR_CHANGED_NATIVE_VIEWER_CALL');return;}
  this.call={hash:callIdHash,kind:value.type,signature,metadataMarker:validated.metadataMarker};
 }
 collect(input:unknown):NativeViewerImageReceipt[]{
  return this.checked(()=>{
   if(!Array.isArray(input)||input.length>8192)reject('INVALID_NATIVE_VIEWER_HISTORY');
   for(const item of input as unknown[]){
    if(!object(item))continue;
    if(['function_call','custom_tool_call'].includes(item.type)){this.invocation(item);continue;}
    if(['function_call_output','custom_tool_call_output'].includes(item.type)){this.output(item);continue;}
    if(['input_image','image'].includes(item.type)||(item.type==='message'&&Array.isArray(item.content)&&item.content.some((block:unknown)=>object(block)&&['input_image','image'].includes(block.type))))
     reject('NON_TOOL_IMAGE_FORBIDDEN');
   }
   return this.receipt?[{...this.receipt}]:[];
  });
 }
 private output(item:Record<string,any>):void{
  if(!this.call||typeof item.call_id!=='string'||hash(item.call_id)!==this.call.hash||item.type!==`${this.call.kind}_output`)reject('UNCORRELATED_NATIVE_VIEWER_OUTPUT');
  this.rejectOracleLeak(item);
  if(explicitError(item)||explicitError(item.structuredContent))reject('NATIVE_VIEWER_ERROR');
  if(!Array.isArray(item.output))reject('NATIVE_VIEWER_IMAGE_REQUIRED');
  const images=item.output.filter((block:unknown)=>object(block)&&block.type==='input_image');
  if(images.length!==1)reject('SINGLE_NATIVE_VIEWER_IMAGE_REQUIRED');
  const text=item.output.filter((block:unknown)=>object(block)&&block.type==='input_text'&&typeof block.text==='string');
  for(const block of text){
   if(/^Error:/i.test(block.text))reject('NATIVE_VIEWER_ERROR');
   if(block.text.startsWith('{')&&block.text.length<=65536){
    let parsed:unknown;try{parsed=JSON.parse(block.text);}catch{}
    this.rejectOracleLeak(parsed);
    if(explicitError(parsed))reject('NATIVE_VIEWER_ERROR');
   }
  }
  if(this.call.metadataMarker){
   const frames=text.filter((block:any)=>block.text.startsWith(this.call!.metadataMarker!));
   if(frames.length!==1)reject('INVALID_NATIVE_VIEWER_CONTROL_FRAME');
   let metadata:unknown;try{metadata=JSON.parse(frames[0]!.text.slice(this.call.metadataMarker.length));}catch{reject('INVALID_NATIVE_VIEWER_CONTROL_FRAME');}
   if(!object(metadata)||metadata.version!==1||typeof metadata.mcp!=='boolean'||Object.keys(metadata).some(key=>!['version','mcp','isError','structuredContent','_meta'].includes(key))
    ||(metadata.isError!==undefined&&typeof metadata.isError!=='boolean')
    ||(metadata.structuredContent!==undefined&&!object(metadata.structuredContent))
    ||(metadata._meta!==undefined&&!object(metadata._meta))
    ||(metadata.mcp===false&&Object.keys(metadata).some(key=>!['version','mcp'].includes(key))))reject('INVALID_NATIVE_VIEWER_CONTROL_FRAME');
   this.rejectOracleLeak(metadata);
   if(explicitError(metadata)||explicitError(metadata.structuredContent))reject('NATIVE_VIEWER_ERROR');
  }
  const observed=imageReceipt(images[0]!.image_url,this.call.hash);
  if(this.receipt&&(this.receipt.sha256!==observed.sha256||this.receipt.mime!==observed.mime||this.receipt.bytes!==observed.bytes))reject('NATIVE_VIEWER_IMAGE_CHANGED');
  this.receipt=observed;
 }
 assertImageReceived():NativeViewerImageReceipt[]{
  return this.checked(()=>{if(!this.receipt)reject('NATIVE_VIEWER_IMAGE_REQUIRED');return[{...this.receipt}];});
 }
}
