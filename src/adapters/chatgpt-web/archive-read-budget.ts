import {ChatGptWebAdapterError} from './adapter-error';

/** Runs after the one accepted Send; ingestion uncertainty never grants another Send. */
export async function waitForArchiveReadBounded(wait:(signal:AbortSignal)=>Promise<void>,signal?:AbortSignal,
  now:()=>number=()=>performance.now(),schedule:(callback:()=>void,ms:number)=>()=>void=(callback,ms)=>{
    const timer=setTimeout(callback,ms);return()=>clearTimeout(timer);
  }):Promise<void>{
  signal?.throwIfAborted();
  const abort=new AbortController(),deadline=now()+180_000;
  const outerAbort=()=>abort.abort(signal!.reason);
  signal?.addEventListener('abort',outerAbort,{once:true});
  let clearDeadline=()=>{};
  const check=()=>{
    const remaining=deadline-now();
    if(remaining<=0)abort.abort(new ChatGptWebAdapterError('The attached archive did not produce a verified in-turn read receipt.',
      {status:409,errorType:'server_error',code:'context_archive_ingestion_timeout',retryable:false}));
    else clearDeadline=schedule(check,remaining);
  };
  clearDeadline=schedule(check,180_000);
  try{
    await new Promise<void>((resolve,reject)=>{
      const interrupted=()=>reject(abort.signal.reason);
      abort.signal.addEventListener('abort',interrupted,{once:true});
      Promise.resolve().then(()=>wait(abort.signal)).then(()=>{
        abort.signal.removeEventListener('abort',interrupted);resolve();
      },error=>{abort.signal.removeEventListener('abort',interrupted);reject(error);});
      if(abort.signal.aborted)interrupted();
    });
  }finally{clearDeadline();signal?.removeEventListener('abort',outerAbort);}
}
