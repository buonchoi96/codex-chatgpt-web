import {randomBytes} from 'node:crypto';
import * as z from 'zod/v4';
import type {BrokerToolResult} from './turn-broker';

export const CODEX_PARALLEL_COMMAND_CONTROL_WIRE_NAME='codex.control.parallel_exec';
export const parallelCommandSchema=z.object({
 cmd:z.string().min(1).max(100000),workdir:z.string().max(16384).optional(),
 yield_time_ms:z.number().int().min(250).max(30000).optional(),
 max_output_tokens:z.number().int().min(1).max(1000000).optional(),tty:z.boolean().optional(),
}).strict();
export const parallelCommandBatchSchema=z.object({commands:z.array(parallelCommandSchema).min(2).max(8)}).strict();
export type ParallelCommand=z.infer<typeof parallelCommandSchema>;

// Conservative admission, not a shell security boundary: the native tool remains the
// approval/sandbox authority. Unrecognized operations stay on the ordinary serial path.
export function isIndependentLiteralRead(command:ParallelCommand):boolean{
 if(command.tty===true||/[\x00-\x1f\x7f;$`&|<>(){}%!^@~*?\[\],#]/.test(command.cmd))return false;
 const tokens:string[]=[];const lexer=/\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/gy;
 let offset=0;
 while(offset<command.cmd.length){
  if(!command.cmd.slice(offset).trim())break;
  lexer.lastIndex=offset;const match=lexer.exec(command.cmd);if(!match)return false;
  // Adjacent quoted/bare words have shell-specific concatenation semantics.
  if(lexer.lastIndex<command.cmd.length&&!/\s/.test(command.cmd[lexer.lastIndex]!))return false;
  tokens.push(match[1]??match[2]??match[3]!);offset=lexer.lastIndex;
 }
 const [program,...args]=tokens;if(!program||args.some(value=>!value))return false;
 const literal=(value:string|undefined)=>!!value&&!value.startsWith('-');
 switch(program.toLowerCase()){
  case 'get-content':return args[0]?.toLowerCase()==='-literalpath'&&literal(args[1])
    &&(args.length===2||(args.length===3&&args[2]?.toLowerCase()==='-raw'));
  case 'get-filehash':return args[0]?.toLowerCase()==='-literalpath'&&literal(args[1])
    &&(args.length===2||(args.length===4&&args[2]?.toLowerCase()==='-algorithm'&&args[3]?.toLowerCase()==='sha256'));
  case 'cat':case 'sha256sum':return args.length>0&&args.every(literal);
  case 'rg':{
   const safeFlags=new Set(['-n','-i','-F','--line-number','--ignore-case','--fixed-strings','--files']);
   if(args.some(arg=>arg.startsWith('-')&&!safeFlags.has(arg)))return false;
   const operands=args.filter(arg=>!arg.startsWith('-'));
   return args.includes('--files')?operands.length<=1:operands.length>=2;
  }
  case 'git':{
   // Avoid optional index refresh locks and config overrides/external diff commands.
   if(args[0]!=='--no-optional-locks')return false;
   if(args[1]==='status')return args.length===3&&['--short','--porcelain'].includes(args[2]!);
   if(args[1]==='rev-parse')return args.length===3&&['HEAD','--show-toplevel'].includes(args[2]!);
   if(args[1]==='diff')return args.length===3&&['--stat','--name-only','--numstat'].includes(args[2]!);
   return false;
  }
  default:return false;
 }
}

type CommandMode='read'|'exclusive';
interface Reservation{reserved:number;remaining:number;uncertain:number;mode:CommandMode;released:boolean;settledSessions:Set<number>;}
interface OwnerCapacity{reservations:Set<Reservation>;sessions:Map<number,{mode:CommandMode;reservation:Reservation}>;}
/** Callable for compatibility. Keep this handle to reconcile a lost dispatch receipt. */
export interface NativeCommandLease{
 /** Release untransferred slots. Live sessions and uncertain slots remain held. */
 ():void;
 /** Mark lost dispatch receipts before release; session-transferred slots already remain held. */
 retainUncertain(count?:number):void;
 /** Reconcile this lease only. Multiple unknown children require distinct session identities. */
 observeResult(result:BrokerToolResult):void;
}
const validSession=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const terminalExit=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&Number.isInteger(value);

export class NativeCommandCapacity{
 private readonly owners=new Map<string,OwnerCapacity>();
 private readonly maxOwners:number;
 constructor(options:{maxOwners?:number}={}){
  this.maxOwners=options.maxOwners??1024;
  if(!Number.isSafeInteger(this.maxOwners)||this.maxOwners<1||this.maxOwners>4096)throw new Error('Native command owner storage bound must be between one and 4096');
 }
 private validateOwner(owner:string):void{
  if(typeof owner!=='string'||!owner||owner.length>512)throw new Error('A bounded stable native command owner ID is required');
 }
 private state(owner:string):OwnerCapacity{
  this.validateOwner(owner);const existing=this.owners.get(owner);if(existing)return existing;
  // Never evict a running/uncertain owner just because its token rotated or time elapsed.
  if(this.owners.size>=this.maxOwners)throw new Error('Native command owner storage capacity exceeded; reconcile existing leases first');
  const created:OwnerCapacity={reservations:new Set(),sessions:new Map()};this.owners.set(owner,created);return created;
 }
 private used(state:OwnerCapacity):number{
  return [...state.reservations].reduce((sum,item)=>sum+item.remaining,0)+state.sessions.size;
 }
 private prune(owner:string,state:OwnerCapacity):void{
  if(!state.reservations.size&&!state.sessions.size&&this.owners.get(owner)===state)this.owners.delete(owner);
 }
 acquire(owner:string,count:number,mode:CommandMode='read'):NativeCommandLease{
  this.validateOwner(owner);
  if(!Number.isInteger(count)||count<1||count>8)throw new Error('Native command capacity exceeded: at most eight in-flight commands per bound turn');
  if(!['read','exclusive'].includes(mode)||(mode==='exclusive'&&count!==1))throw new Error('Mutable or opaque commands require one exclusive native command lease');
  const existing=this.owners.get(owner),current=existing?this.used(existing):0;
  const exclusive=existing&&([...existing.reservations].some(item=>item.mode==='exclusive')||[...existing.sessions.values()].some(item=>item.mode==='exclusive'));
  if(exclusive||(mode==='exclusive'&&current>0))throw new Error('Native command dependency conflict: mutable or opaque work must run serially after active reads');
  if(current+count>8)throw new Error('Native command capacity exceeded: at most eight in-flight commands per bound turn');
  if(existing&&existing.reservations.size>=8)throw new Error('Native command lease storage capacity exceeded: release completed parent leases first');
  const state=this.state(owner),reservation:Reservation={reserved:count,remaining:count,uncertain:0,mode,released:false,settledSessions:new Set()};state.reservations.add(reservation);
  const release=(()=>{
   if(reservation.released)return;reservation.released=true;
   reservation.remaining=reservation.uncertain;
   if(!reservation.remaining)state.reservations.delete(reservation);
   this.prune(owner,state);
  }) as NativeCommandLease;
  release.retainUncertain=(retained=1)=>{
   if(reservation.released||!Number.isInteger(retained)||retained<1||retained>reservation.reserved)
    throw new Error('Native command lease cannot retain more uncertain slots than it reserved');
   // A legacy observer may already have transferred these slots to live sessions.
   // Those sessions retain capacity themselves; never manufacture a ninth slot.
   reservation.uncertain+=Math.min(retained,reservation.remaining-reservation.uncertain);
  };
  release.observeResult=result=>this.observe(owner,result,undefined,reservation);
  return release;
 }
 observeResult(owner:string,result:BrokerToolResult,pollSession?:number):void{
  this.observe(owner,result,pollSession);
 }
 private observe(owner:string,result:BrokerToolResult,pollSession?:number,reservation?:Reservation):void{
  this.validateOwner(owner);
  if(pollSession!==undefined&&!validSession(pollSession))return;
  const candidates:Record<string,unknown>[]=[];
  const structured=result.structuredContent;
  const authoritative=structured&&typeof structured==='object'&&!Array.isArray(structured)
   ?structured as Record<string,unknown>:undefined;
  if(authoritative)candidates.push(authoritative);
  // Native stdout can itself be JSON that resembles a lifecycle receipt.
  // Once the connector supplies structured lifecycle metadata, ignore
  // conflicting text rather than fabricating a terminal process observation.
  if(!authoritative||(!Object.hasOwn(authoritative,'session_id')&&!Object.hasOwn(authoritative,'exit_code'))){
   for(const block of result.content){
    if(!block||typeof block!=='object'||(block as any).type!=='text')continue;
    try{const parsed=JSON.parse((block as any).text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))candidates.push(parsed);}catch{}
   }
  }
  const state=this.owners.get(owner);
  if(pollSession!==undefined){
   const terminal=candidates.some(value=>terminalExit(value.exit_code)&&(value.session_id===undefined||value.session_id===pollSession));
   const held=state?.sessions.get(pollSession);
   if(terminal&&held&&state){held.reservation.settledSessions.add(pollSession);state.sessions.delete(pollSession);this.prune(owner,state);}
   return; // Unknown polls never manufacture a new session or forget an old one.
  }
  const sessionReceipt=candidates.find(value=>validSession(value.session_id));
  if(!sessionReceipt){
   // An unidentified lost dispatch can only be settled through its exact lease handle.
   // An in-flight batch may finish a known sibling while another child's
   // dispatch is uncertain. Only a separate post-release reconciliation may
   // settle an unidentified terminal proof, and only for a single-child lease.
   if(reservation?.released&&reservation.uncertain>0&&candidates.some(value=>terminalExit(value.exit_code))){
    if(reservation.reserved!==1)throw new Error('An uncertain batch child needs a distinct session identity for terminal reconciliation');
    reservation.uncertain--;reservation.remaining--;
    if(reservation.released&&!reservation.remaining)state?.reservations.delete(reservation);
    if(state)this.prune(owner,state);
   }
   return;
  }
  const session=sessionReceipt.session_id as number;
  if(reservation?.settledSessions.has(session))return;
  const terminal=candidates.some(value=>value.session_id===session&&terminalExit(value.exit_code));
  if(reservation?.released&&!reservation.remaining){
   if(terminal)return;
   throw new Error('Cannot attach a new native session to a settled lease');
  }
  if(terminal){
   const held=state?.sessions.get(session);
   if(held&&state){
    if(reservation&&held.reservation!==reservation)throw new Error('Terminal session receipt does not belong to this native command lease');
    held.reservation.settledSessions.add(session);state.sessions.delete(session);this.prune(owner,state);
   }
   else if(reservation&&reservation.uncertain>0){
    reservation.settledSessions.add(session);
    reservation.uncertain--;reservation.remaining--;
    if(reservation.released&&!reservation.remaining)state?.reservations.delete(reservation);
    if(state)this.prune(owner,state);
   }
   return;
  }
  const existingSession=state?.sessions.get(session);
  if(existingSession){
   if(reservation&&existingSession.reservation!==reservation)
    throw new Error('Native session receipt belongs to a different command lease');
   return;
  }
  const donor=reservation??(state&&[...state.reservations].find(item=>!item.released&&item.remaining>item.uncertain));
  if(donor&&!donor.remaining)throw new Error('Native command lease has no remaining session slots');
  if(!donor||!state)throw new Error('New native session requires an outstanding reserved lease');
  // An ordinary sibling receipt must not consume a different uncertain dispatch.
  if(donor.remaining===donor.uncertain&&donor.uncertain>0)donor.uncertain--;
  donor.remaining--;
  if(donor.released&&!donor.remaining)state.reservations.delete(donor);
  state.sessions.set(session,{mode:donor.mode,reservation:donor});
 }
}

export async function runParallelNativeCommands(options:{
 owner:string;commands:ParallelCommand[];capacity:NativeCommandCapacity;signal?:AbortSignal;
 invoke:(command:ParallelCommand,index:number)=>Promise<BrokerToolResult>;
}):Promise<BrokerToolResult>{
 const {commands}=parallelCommandBatchSchema.parse({commands:options.commands});
 if(commands.some(command=>!isIndependentLiteralRead(command)))throw new Error('Parallel commands require independent literal reads; use serial codex_exec for mutable, interactive, compound or unrecognized commands');
 options.signal?.throwIfAborted();
 const release=options.capacity.acquire(options.owner,commands.length),started=Date.now();
 const batch_id=`batch_${randomBytes(12).toString('hex')}`;
 try{
  const receipts=await Promise.all(commands.map(async(command,index)=>{
   const dispatched_at=Date.now();
   if(options.signal?.aborted)return{index,status:'not_dispatched',dispatched_at:null,finished_at:Date.now(),execution:'not_started',error:'Request cancelled before dispatch'};
   try{
    const invocation=options.invoke(command,index);
    // A dispatched native call may never settle after its caller is cancelled.
    // Return an uncertain child without waiting indefinitely or issuing a retry.
    // Promise.race observes late rejections, but cannot prove native termination.
    const cancelled=Symbol('native-call-cancelled');
    let onAbort:(()=>void)|undefined;
    let result:BrokerToolResult|typeof cancelled;
    try{
     if(options.signal){
      const signal=options.signal;
      const abort=new Promise<typeof cancelled>(resolve=>{
       if(signal.aborted)resolve(cancelled);
       else{onAbort=()=>resolve(cancelled);signal.addEventListener('abort',onAbort,{once:true});}
      });
      result=await Promise.race([invocation,abort]);
     }else result=await invocation;
    }finally{if(onAbort)options.signal?.removeEventListener('abort',onAbort);}
    if(result===cancelled){
     release.retainUncertain();
     return{index,status:'uncertain',dispatched_at,finished_at:Date.now(),execution:'unknown',
      error:'Native command request cancelled after dispatch; execution is unverified',retryable:false};
    }
    // Successful siblings cannot reconcile another child's lost receipt. Only
    // explicit use of an exact lease handle can reconcile unidentified execution.
    // A sibling batch may share the stable turn owner. Attribute a child
    // receipt to this batch's exact lease before releasing its reservation.
    release.observeResult(result);
    const failureDetails=result.structuredContent&&typeof result.structuredContent==='object'&&
      !Array.isArray(result.structuredContent)
      ?result.structuredContent as Record<string,unknown>:undefined;
    const errorCode=failureDetails?.code;
    if(result.isError===true&&(errorCode==='codex_tool_timeout'||errorCode==='safety_status_unknown_or_blocked'||
      failureDetails?.execution_state==='unknown'||failureDetails?.dispatch_state==='unknown')){
     // A returned timeout/safety error confirms an uncertain transport outcome,
     // not native process termination. New error codes explicitly reporting
     // unknown execution/dispatch must preserve the same capacity invariant.
     release.retainUncertain();
     return{index,status:'uncertain',dispatched_at,finished_at:Date.now(),execution:'unknown',
      error:`Native command returned ${String(errorCode??'unknown_execution')}; execution is unverified`,retryable:false,result};
    }
    return{index,status:result.isError===true?'failed':'succeeded',dispatched_at,finished_at:Date.now(),execution:'receipt_received',result};
   }catch(error){
    // Dispatch failure/retirement does not prove a native process or side effect stopped.
    release.retainUncertain();
    return{index,status:'uncertain',dispatched_at,finished_at:Date.now(),execution:'unknown',
     error:error instanceof Error?error.message:String(error),retryable:false};
   }
  }));
  const succeeded=receipts.filter(receipt=>receipt.status==='succeeded').length;
  const summary={parallel:true,command_count:commands.length,batch_id,elapsed_ms:Date.now()-started,succeeded,failed:commands.length-succeeded};
  const content:unknown[]=[{type:'text',text:JSON.stringify(summary)}];
  for(const receipt of receipts){
   content.push({type:'text',text:JSON.stringify({index:receipt.index,status:receipt.status,execution:receipt.execution,...('error'in receipt?{error:receipt.error,retryable:false}:{})})});
   if('result'in receipt&&receipt.result)content.push(...receipt.result.content);
  }
  // Media bytes belong only to real content blocks. Keep an explicit index in the
  // structured child receipt rather than serializing another image into JSON.
  const structuredReceipts=receipts.map(receipt=>{
   if(!('result'in receipt)||!receipt.result)return receipt;
   return{...receipt,result:{...receipt.result,content:receipt.result.content.map(block=>{
    if(block&&typeof block==='object'&&['image','audio'].includes((block as any).type)){
     return{type:'media_reference',mimeType:(block as any).mimeType,content_index:content.indexOf(block)};
    }return block;
   })}};
  });
  return{isError:succeeded!==commands.length,content,structuredContent:{...summary,commands:structuredReceipts}};
 }finally{release();}
}
