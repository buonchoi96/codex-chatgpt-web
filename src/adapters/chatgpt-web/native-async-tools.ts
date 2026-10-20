import {randomBytes} from "node:crypto";

export const NATIVE_ASYNC_AUTO_WAIT_MS=8_000;
export const NATIVE_ASYNC_POLL_MAX_CHARS=12_000;
export const NATIVE_ASYNC_MAX_RESULT_CHARS=8_000_000;
type State="running"|"completed"|"failed"|"unknown";
interface Entry<T>{
  id:string;owner:string;scope:string;tool:string;state:State;created:number;finished?:number;
  payload?:string;original?:T;error?:string;finishedPromise:Promise<void>;
}
export type AsyncToolTicket={status:"pending";job_id:string;tool:string;poll_with:"codex.control.async_poll"};

/**
 * A turn-bound, in-process transport continuation. Jobs never escape the
 * authenticated turn token or outlive its broker authority. No persisted
 * job is automatically resumed following process loss or turn retirement.
 */
export class NativeAsyncToolJobs<T>{
  private jobs=new Map<string,Entry<T>>();
  private activeScopes=new Set<string>();
  constructor(private now:()=>number=Date.now){}
  private key(owner:string,scope:string):string{return JSON.stringify([owner,scope]);}
  isBusy(owner:string,scope:string):boolean{return this.activeScopes.has(this.key(owner,scope));}
  start(owner:string,scope:string,tool:string,run:()=>Promise<T>):AsyncToolTicket{
    if(!owner||!scope||!tool)throw Error("Async job requires an authenticated turn and tool scope");
    this.prune();
    const scopeKey=this.key(owner,scope);
    if(this.activeScopes.has(scopeKey))throw Error("NATIVE_ASYNC_BUSY: Existing tool invocation in this MCP server must finish before another starts");
    if(this.jobs.size>=128)throw Error("NATIVE_ASYNC_FULL: Job receipt capacity exhausted");
    const entry:Entry<T>={
      id:"native_job_"+randomBytes(24).toString("hex"),owner,scope,tool,
      created:this.now(),state:"running",finishedPromise:Promise.resolve(),
    };
    this.jobs.set(entry.id,entry);this.activeScopes.add(scopeKey);
    entry.finishedPromise=Promise.resolve().then(run).then(value=>{
      const serialized=JSON.stringify(value);
      if(serialized===undefined||serialized.length>NATIVE_ASYNC_MAX_RESULT_CHARS){
        entry.state="unknown";
        entry.error="NATIVE_ASYNC_RESULT_UNAVAILABLE: Result exceeded bounded buffer. Do not automatically retry.";
        return;
      }
      entry.payload=serialized;entry.original=value;
      entry.state=(value!==null&&typeof value==="object"&&(value as {isError?:unknown}).isError===true)
        ?"failed":"completed";
    },error=>{
      // A transport rejection is not proof the underlying MCP command stopped.
      entry.state="unknown";
      entry.error=("NATIVE_ASYNC_OUTCOME_UNVERIFIED: "+String(error instanceof Error?error.message:error)).slice(0,1200);
    }).finally(()=>{
      entry.finished=this.now();
      // Unknown keeps the backend namespace locked against conflicting effects
      // until the capability expires or an operator reconciles it.
      if(entry.state!=="unknown")this.activeScopes.delete(scopeKey);
    });
    return{status:"pending",job_id:entry.id,tool,poll_with:"codex.control.async_poll"};
  }
  async quick(owner:string,id:string,timeoutMs:number):Promise<T|AsyncToolTicket>{
    const entry=this.require(owner,id);
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>30_000)throw Error("Invalid auto-yield duration");
    if(entry.state==="running"){
      await Promise.race([entry.finishedPromise,new Promise<void>(resolve=>setTimeout(resolve,timeoutMs))]);
    }
    if((entry.state==="completed"||entry.state==="failed")&&entry.original!==undefined)
      return entry.original;
    return{status:"pending",job_id:entry.id,tool:entry.tool,poll_with:"codex.control.async_poll"};
  }
  poll(owner:string,id:string,offset=0,maxChars=8000):Record<string,unknown>{
    const entry=this.require(owner,id);
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxChars)
      ||maxChars<1||maxChars>NATIVE_ASYNC_POLL_MAX_CHARS)throw Error("Invalid tool poll range");
    const base={job_id:entry.id,tool:entry.tool,status:entry.state};
    if(entry.state==="running")return base;
    if(entry.payload===undefined)return {...base,error:entry.error??"Result was not verified",
      retryable:false};
    if(offset>entry.payload.length)throw Error("Tool result offset beyond payload");
    const chunk=entry.payload.slice(offset,offset+maxChars),end=offset+chunk.length;
    return{...base,offset,chunk,total_chars:entry.payload.length,
      next_offset:end<entry.payload.length?end:null};
  }
  private require(owner:string,id:string):Entry<T>{
    if(!/^native_job_[0-9a-f]{48}$/.test(id))throw Error("Invalid native async job ID");
    const entry=this.jobs.get(id);
    if(!entry||entry.owner!==owner)throw Error("NATIVE_ASYNC_NOT_FOUND: Current turn has no matching tool receipt; do not replay an uncertain operation");
    return entry;
  }
  private prune():void{
    for(const [id,entry] of this.jobs){
      if(entry.state!=="running"&&entry.finished!==undefined&&this.now()-entry.finished>30*60_000){
        this.jobs.delete(id);
        // Unknown may be evicted for bounded memory, but it never clears the
        // locked namespace. A new authenticated turn is required for recovery.
      }
    }
  }
}

/** Group one backend's tools, not independent MCP servers, under one lock. */
export function nativeAsyncToolScope(wireName:string,namespace?:string):string{
  if(namespace)return namespace;
  const parts=wireName.split("__");
  if(parts.length>=3&&parts[0]==="mcp")return parts.slice(0,2).join("__");
  return wireName;
}
