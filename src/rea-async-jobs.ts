import {randomBytes} from "node:crypto";

export const REA_ASYNC_ALLOWED_TOOLS=new Set(["procedure_info","binary_overview"]);
export const REA_ASYNC_MAX_POLL_CHARS=12000;
export const REA_ASYNC_MAX_RESULT_CHARS=8000000;
export type ReaAsyncState="running"|"completed"|"failed"|"unknown";
type Job={id:string;tool:string;state:ReaAsyncState;created:number;finished?:number;body?:string;error?:string};

/** A lost REA call is never replayed or considered stopped. */
export class ReaAsyncJobs{
 private jobs=new Map<string,Job>();
 private activeId?:string;
 constructor(private supported:ReadonlySet<string>,private invoke:(name:string,args:Record<string,unknown>)=>Promise<unknown>,private now:()=>number=Date.now){}
 active():boolean{return this.activeId!==undefined;}
 start(tool:string,args:Record<string,unknown>):{status:"running";job_id:string;tool:string}{
  this.prune();
  if(!REA_ASYNC_ALLOWED_TOOLS.has(tool)||!this.supported.has(tool))
   throw Error("REA_ASYNC_UNSUPPORTED: Only advertised read-only procedure_info and binary_overview are eligible");
  if(this.activeId)throw Error("REA_ASYNC_BUSY: Poll/reconcile the current job; do not dispatch another REA tool");
  if(this.jobs.size>=24)throw Error("REA_ASYNC_REGISTRY_FULL: Reconcile old job receipts before starting");
  const job:Job={id:"rea_job_"+randomBytes(24).toString("hex"),tool,state:"running",created:this.now()};
  this.activeId=job.id;this.jobs.set(job.id,job);
  // The initial MCP call returns before the underlying REA operation begins.
  queueMicrotask(()=>{
   Promise.resolve().then(()=>this.invoke(tool,structuredClone(args))).then(
    result=>{
     const serialized=JSON.stringify(result);
     if(serialized===undefined||serialized.length>REA_ASYNC_MAX_RESULT_CHARS){
      job.state="unknown";job.error="REA_RESULT_UNAVAILABLE: Result exceeds bounded buffer; no automatic replay";
     }else{job.state=(result&&typeof result==="object"&&(result as {isError?:boolean}).isError===true)?"failed":"completed";job.body=serialized;}
    },
    error=>{job.state="unknown";job.error=("REA_OUTCOME_UNVERIFIED: "+String(error instanceof Error?error.message:error)).slice(0,1000);}
   ).finally(()=>{
    job.finished=this.now();
    // Transport failure cannot prove Ghidra stopped. Hold capacity until
    // the operator reconciles the target and deliberately restarts the proxy.
    if(job.state!=="unknown"&&this.activeId===job.id)this.activeId=undefined;
   });
  });
  return {status:"running",job_id:job.id,tool};
 }
 poll(jobId:string,offset=0,maxChars=8000):Record<string,unknown>{
  this.prune();
  if(!/^rea_job_[a-f0-9]{48}$/.test(jobId))throw Error("Invalid REA job ID");
  const job=this.jobs.get(jobId);
  if(!job)return{status:"unknown",error:"REA_JOB_NOT_FOUND: Previous execution cannot be verified; never automatically replay"};
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxChars)||maxChars<1||maxChars>REA_ASYNC_MAX_POLL_CHARS)
   throw Error("Invalid REA poll range");
  const common={job_id:job.id,tool:job.tool,status:job.state};
  if(job.state==="running")return common;
  if(job.body===undefined)return{...common,error:job.error??"REA result unavailable"};
  if(offset>job.body.length)throw Error("Result offset out of range");
  const chunk=job.body.slice(offset,offset+maxChars);
  const next=offset+chunk.length;
  return {...common,offset,chunk,total_chars:job.body.length,next_offset:next<job.body.length?next:null};
 }
 private prune():void{
  for(const [id,job] of this.jobs)if(job.finished!==undefined&&job.state!=="running"&&this.now()-job.finished>1800000)this.jobs.delete(id);
 }
}
