import {createHash} from 'node:crypto';
import type {CodexMessage,CodexParsedRequest} from '../../types';
import {SteeringRevisionQueue,type CanonicalLineage,type DeltaReservation} from './steering-revisions';
import {chatGptInstructionLineage} from './turn-execution';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ancestry=(messages:CodexMessage[])=>hash(messages.map(({timestamp:_timestamp,...message})=>message));
const policy=(parsed:CodexParsedRequest)=>hash([parsed.modelId,parsed.options,parsed._chatgptModelFamily,
  parsed.context.systemPrompt,parsed.context.tools]);
export interface SteeringProgress {revision:number;pending:boolean;}
export interface SteeringProgressReader {
  snapshot():SteeringProgress;
  waitForChange(after:number,signal?:AbortSignal):Promise<SteeringProgress>;
}

/** Canonical admission and Send receipts stay in the daemon. The helper receives only liveness
 * and a prepared delta after it proves the owned browser is quiescent. */
export class LiveSteering implements SteeringProgressReader {
  private readonly queue:SteeringRevisionQueue;
  private lineage:CanonicalLineage;
  private newest:CodexParsedRequest;
  private readonly candidates=new Map<string,{canonical:CodexParsedRequest;delta:CodexMessage[]}>();
  private reservation?:DeltaReservation;
  private revision=0;
  private deliveryReady=false;
  private readonly listeners=new Set<{after:number;resolve:(value:SteeringProgress)=>void;reject:(error:Error)=>void;signal?:AbortSignal;abort?:()=>void}>();
  private readonly acknowledged=new Set<string>();
  constructor(initial:CodexParsedRequest,conversationId:string){
    this.newest=initial;
    this.lineage={verification:'proven',conversationId,epoch:0,canonicalRevisionId:chatGptInstructionLineage(initial).current,
      canonicalPrefixHash:ancestry(initial.context.messages),proofId:hash([conversationId,ancestry(initial.context.messages)])};
    this.queue=new SteeringRevisionQueue(this.lineage);
  }
  private canAdmit(incoming:CodexParsedRequest):boolean {
    if(incoming._compactionRequest||policy(incoming)!==policy(this.newest))return false;
    const next=chatGptInstructionLineage(incoming),previous=chatGptInstructionLineage(this.newest);
    if(next.current===previous.current)return true;
    if(!next.predecessors.has(previous.current)||incoming.context.messages.length<=this.newest.context.messages.length
      ||ancestry(incoming.context.messages.slice(0,this.newest.context.messages.length))!==ancestry(this.newest.context.messages))return false;
    // Receipts are settled by the existing session journal, never re-invoked or pasted as tools.
    const delta=incoming.context.messages.slice(this.newest.context.messages.length).filter(message=>message.role==='user');
    if(!delta.length)return false;
    return true;
  }
  async admitAfterGate(incoming:CodexParsedRequest,acquire:()=>Promise<boolean|void>|boolean|void,signal?:AbortSignal):Promise<boolean> {
    signal?.throwIfAborted();
    if(!this.canAdmit(incoming))return false;
    // A refused compaction/terminal gate leaves the canonical revision and queue untouched.
    // The session owner can then rebuild from the complete incoming history after retirement.
    if(await acquire()===false)return false;
    signal?.throwIfAborted();
    return this.admit(incoming);
  }
  admit(incoming:CodexParsedRequest):boolean {
    if(!this.canAdmit(incoming))return false;
    const next=chatGptInstructionLineage(incoming),previous=chatGptInstructionLineage(this.newest);
    if(next.current===previous.current)return true;
    const delta=incoming.context.messages.slice(this.newest.context.messages.length).filter(message=>message.role==='user');
    const admitted=this.queue.enqueueRevision({sourceRevisionId:next.current,predecessorRevisionId:previous.current,
      lineage:this.lineage,delta:JSON.stringify(delta)});
    if(admitted.status!=='queued'&&admitted.status!=='duplicate')throw new Error(`Steering revision cannot be admitted: ${admitted.status}`);
    this.candidates.set(next.current,{canonical:incoming,delta});this.newest=incoming;this.deliveryReady=false;this.changed();return true;
  }
  activateDelivery():void {if(!this.deliveryReady&&this.hasQueued()){this.deliveryReady=true;this.changed();}}
  hasQueued():boolean{return this.queue.snapshot().status==='open'&&this.queue.snapshot().pendingRevisionIds.length>0;}
  prepare(originalSendAccepted:boolean):{parsed:CodexParsedRequest;deltaId:string}|undefined {
    if(!this.deliveryReady)throw new Error('Steering Send is held until the current observer reconciles its receipts');
    const reserved=this.queue.reserve({epoch:this.lineage.epoch,generation:'idle',sendReceipt:originalSendAccepted?{status:'none'}:{status:'pending',deltaId:'original'},
      activeTool:'none',approval:'none',compaction:'none',rebind:'current',stop:'confirmed'});
    if(reserved.status==='idle')return undefined;
    if(reserved.status!=='reserved')throw new Error(`Steering Send is held: ${reserved.status==='held'?reserved.reason:reserved.status}`);
    const started=this.queue.beginSend(reserved.delta.deltaId,{epoch:this.lineage.epoch,generation:'idle',sendReceipt:{status:'none'},
      activeTool:'none',approval:'none',compaction:'none',rebind:'current',stop:'confirmed'});
    if(started.status!=='send_once')throw new Error('Steering reservation has no new Send authority');
    this.reservation=reserved.delta;
    const candidates=reserved.delta.sourceRevisionIds.map(id=>this.candidates.get(id)!);
    const latest=candidates.at(-1)!;
    return {parsed:{...latest.canonical,context:{...latest.canonical.context,systemPrompt:[],messages:candidates.flatMap(candidate=>candidate.delta)}},deltaId:reserved.delta.deltaId};
  }
  acknowledge(deltaId:string):void {
    if(this.acknowledged.has(deltaId))return;
    const reserved=this.reservation;
    if(!reserved||reserved.deltaId!==deltaId)throw new Error('Steering receipt does not identify the active reservation');
    const sourceId=reserved.sourceRevisionIds.at(-1)!,canonical=this.candidates.get(sourceId)!.canonical;
    const lineage={...this.lineage,canonicalRevisionId:sourceId,canonicalPrefixHash:ancestry(canonical.context.messages),
      proofId:hash([this.lineage.proofId,deltaId,ancestry(canonical.context.messages)])};
    const result=this.queue.resolveSend({kind:'positive',deltaId,revisionIds:reserved.revisionIds,lineage});
    if(result.status!=='accepted')throw new Error('Steering receipt failed canonical reconciliation');
    this.lineage=lineage;this.acknowledged.add(deltaId);this.reservation=undefined;
    for(const id of reserved.sourceRevisionIds)this.candidates.delete(id);
    this.changed();
  }
  cancel():void {this.queue.cancel();this.changed();}
  snapshot():SteeringProgress{return {revision:this.revision,pending:this.deliveryReady&&this.hasQueued()};}
  waitForChange(after:number,signal?:AbortSignal):Promise<SteeringProgress>{
    if(this.revision>after)return Promise.resolve(this.snapshot());
    if(signal?.aborted)return Promise.reject(new DOMException('Steering observation aborted','AbortError'));
    return new Promise((resolve,reject)=>{
      const listener={after,resolve,reject,signal,abort:undefined as (()=>void)|undefined};
      listener.abort=()=>{this.listeners.delete(listener);reject(new DOMException('Steering observation aborted','AbortError'));};
      signal?.addEventListener('abort',listener.abort,{once:true});this.listeners.add(listener);
    });
  }
  private changed():void {
    this.revision++;
    for(const listener of this.listeners)if(this.revision>listener.after){
      if(listener.abort)listener.signal?.removeEventListener('abort',listener.abort);
      this.listeners.delete(listener);listener.resolve(this.snapshot());
    }
  }
}
