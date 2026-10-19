import * as z from 'zod/v4';
import {createHash,randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import {StringDecoder} from 'node:string_decoder';
import type {BrokerToolResult} from './turn-broker';
import {projectScreenTree,type ProjectedScreenTree} from './screen-tree';
import {diffVerifiedUiaTrees,diffVerifiedMixedTrees} from './screen-tree-diff';

const regionSchema=z.object({x:z.number().int().min(0),y:z.number().int().min(0),width:z.number().int().positive(),height:z.number().int().positive()}).strict();
const boundsSchema=z.object({x:z.number().finite().min(0),y:z.number().finite().min(0),width:z.number().finite().positive(),height:z.number().finite().positive()}).strict();
const grantSchema=z.object({observer_protocol:z.literal(1),reader_lease:z.string().regex(/^reader_[0-9a-f]{64}$/),
  session:z.uuid(),hwnd:z.string().regex(/^[1-9][0-9]*$/),pid:z.number().int().positive(),consumer_owner:z.uuid(),capability_epoch:z.uuid(),
  owner_epoch:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),expires_in_ms:z.number().int().min(1).max(300000),region:regionSchema,
  observer_tree_available:z.literal(false),image_delivery_status:z.literal('UNAVAILABLE')}).strict();
export type ScreenReaderGrant=z.infer<typeof grantSchema>;
const readinessRequestSchema=z.object({mode:z.literal('ui_ready'),region:regionSchema,
  contains:z.string().min(1).max(128).refine(value=>Buffer.byteLength(value,'utf8')<=128,
    'Readiness predicate must fit native 128-byte UTF-8 limit')}).strict();
type ReadinessRequest=z.infer<typeof readinessRequestSchema>;
export interface NativeScreenProvider {
  observe(grant:ScreenReaderGrant,args:{operation_id:string;timeout_ms:number;max_nodes:number;readiness?:ReadinessRequest},signal?:AbortSignal):Promise<Record<string,unknown>>;
}
export class NativeScreenObservationError extends Error {
  constructor(readonly code:string){super(code);this.name='NativeScreenObservationError';}
}
// Only the registry's own monotonic publication fence may grant a harmless
// stale-frame outcome. A native provider error with the same code is untrusted.
export class NativeScreenPublishedFrameStaleError extends NativeScreenObservationError {
  constructor(){super('SCREEN_READER_STALE_FRAME');this.name='NativeScreenPublishedFrameStaleError';}
}
export const screenObserveArguments={reader_lease:z.string().regex(/^reader_[0-9a-f]{64}$/),
  timeout_ms:z.number().int().min(1).max(3000).default(1000),max_nodes:z.number().int().min(1).max(200).default(64),
  tree_format:z.enum(['compact','json','both']).optional(),
  // Explicit evidence that the caller received the preceding full/patch reply.
  // A cache entry alone never counts as model-visible frame acknowledgement.
  ack_snapshot_id:z.uuid().optional(),prefer_diff:z.boolean().optional(),prefer_mixed_diff:z.boolean().optional(),
  readiness:readinessRequestSchema.optional()};
const counter=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),identity=counter.min(1),timing=z.number().finite().min(0);
const cvNode=z.object({source:z.literal('cv'),bounds:boundsSchema,name:z.literal(''),frame_id:identity,target_generation:identity,
  id:z.string().max(256).optional(),role:z.literal('visual_region').optional(),confidence:z.number().finite().min(0).max(1).optional()}).strict();
const uiaNode=z.object({source:z.literal('uia'),bounds:boundsSchema,pixel_correspondence:z.literal('unverified'),
  id:z.string().max(256).optional(),role:z.string().max(128).optional(),name:z.string().max(512).optional(),
  parent_id:z.string().max(256).nullable().optional(),automation_id:z.string().max(256).optional(),
  is_enabled:z.boolean().optional(),is_offscreen:z.boolean().optional(),is_focused:z.boolean().optional(),redacted:z.boolean().optional(),
  confidence:z.literal(1).optional(),patterns:z.array(z.enum(['Invoke','Value','RangeValue','SelectionItem','ExpandCollapse','Toggle','Text'])).max(7).optional()}).strict();
const ocrNode=z.object({source:z.literal('ocr'),bounds:boundsSchema,name:z.string().max(256),frame_id:identity,target_generation:identity,
  confidence:z.null(),confidence_status:z.literal('unavailable'),id:z.string().max(256).optional(),role:z.literal('text').optional()}).strict();
const dxgiDiagnostics=z.object({acquire_hresult:z.number().int(),acquire_attempted:z.boolean(),acquisition_count:counter,
  cached_frame_before:z.boolean(),last_present_time:counter,last_mouse_update_time:counter,accumulated_frames:counter,
  total_metadata_buffer_size:counter,protected_content_masked_out:z.literal(false)}).strict();
const captureReceipt=z.object({width:identity,height:identity,frame_id:identity,target_generation:identity,backend:z.enum(['gdi','dxgi']),
  dpi:identity,region:regionSchema,capture_type:z.literal('desktop_region'),image_encoded:z.literal(false),capture_pixels_ms:timing,
  raw_copy_ms:timing,image_encode_ms:z.literal(0),capture_total_ms:timing,
  pixel_freshness:z.enum(['sampled_visible_desktop','cached_desktop_frame','desktop_update']),dxgi_diagnostics:dxgiDiagnostics.optional(),
  fallback_reason:z.string().max(512).optional(),backend_requested:z.literal('auto').optional(),selection_reason:z.string().max(256).optional()}).strict();
const sourcesReceipt=z.object({
  cv:z.object({status:z.string().max(64),source_count:counter,truncated:z.boolean()}).strict(),
  uia:z.object({status:z.string().max(64),partial:z.boolean(),temporal_relation:z.literal('after_final_frame'),pixel_correspondence:z.literal('unverified'),
    sample_start_ms:timing.optional(),sample_end_ms:timing.optional()}).strict()
    .refine(value=>value.status==='not_attempted'
      ? value.sample_start_ms===undefined&&value.sample_end_ms===undefined
      : value.sample_start_ms!==undefined&&value.sample_end_ms!==undefined&&value.sample_start_ms<=value.sample_end_ms,
    {message:'UIA sample must have a valid attempted time interval'}),
  ocr:z.object({status:z.enum(['UNAVAILABLE','empty','completed']),reason:z.string().max(128).optional(),confidence_available:z.literal(false),
    language:z.string().max(64).optional(),materialized_copies:counter.max(3).optional(),truncated:z.boolean().optional(),
    frame_id:identity.optional(),target_generation:identity.optional()}).strict(),
}).strict();
const computeReceipt=z.object({mode:z.literal('AUTO'),worker_threads:identity.max(8),control_threads:identity,
  concurrency_limit:identity.max(8),active:counter,queued:counter,governor_reason:z.string().max(128),
  // Optional additive native v1 telemetry, measured on the actual immutable
  // frame. A missing/partial timing must not be mistaken for performance proof.
  cv_tasks_completed:counter.optional(),cv_peak_parallel:counter.max(8).optional(),
  cv_task_wall_ms_sum:timing.optional(),analysis_join_ms:timing.optional(),
  analysis_timings_complete:z.boolean().optional(),additional_task_ms:timing.nullable().optional(),
  available_logical_processors:identity.nullable(),allocation_status:z.enum(['uncertain','verified']),allocation_reasons:z.array(z.string().max(256)).max(32),
  foreground_reserved:counter,bootstrap_workers:identity.max(8),uia_provider_ownership:z.literal('isolated_private_helper'),
  ocr_provider_ownership:z.literal('isolated_private_helper'),ocr_engine_internal_parallelism:z.literal('not_measured')}).strict()
  .refine(value=>value.cv_peak_parallel===undefined||(
    value.cv_tasks_completed!==undefined&&value.cv_peak_parallel<=value.cv_tasks_completed&&
    value.cv_peak_parallel<=value.worker_threads),{message:'invalid measured CV callback overlap'});
const observerReceipt=z.object({observer_protocol:z.literal(1),operation_id:z.uuid(),session:z.uuid(),hwnd:z.string(),pid:identity,owner_epoch:identity,
  region:regionSchema,status:z.enum(['READY','NOT_READY','PARTIAL']),image_encoded:z.literal(false),image_delivery_status:z.literal('UNAVAILABLE'),
  frame_id:identity,target_generation:identity,nodes:z.array(z.discriminatedUnion('source',[cvNode,uiaNode,ocrNode])).max(200),
  dpi:identity.optional(),partial:z.boolean().optional(),reason:z.string().max(256).optional(),image_delivery_reason:z.literal('MODEL_IMAGE_RELAY_UNAVAILABLE').optional(),
  readiness:z.object({status:z.string().max(64),semantic_ready:z.boolean(),final_frames:z.literal(1),
    mode:z.literal('ui_ready').optional(),pixel_stable:z.boolean().optional(),capture_attempts:counter.optional(),
    accepted_samples:counter.optional(),rejected_samples:counter.optional(),semantic_frame_id:identity.optional(),
    semantic_generation:identity.optional(),predicate:z.string().min(1).max(128).optional(),
    predicate_sha256:z.string().regex(/^[0-9a-f]{64}$/).optional(),
    region:regionSchema.optional(),wait_ms:timing.optional()}).strict().optional(),
  capture:captureReceipt.optional(),sources:sourcesReceipt.optional(),compute:computeReceipt.optional(),total_ms:timing.optional(),
}).strict();
type Entry={grant:ScreenReaderGrant;owner:string;expiresAt:number};
type CaptureScope={backend:'gdi'|'dxgi';dpi:number;width:number;height:number};
type AcknowledgableSnapshot={entry:Entry;id:string;tree:ProjectedScreenTree;status:string;captureScope?:CaptureScope};
type PublishedFrame={entry:Entry;generation:number;frame:number};

/** Authority enters only from the configured native grant tool's broker receipt,
 * never a model's arguments, filesystem roots or historical context. */
export class ScreenObservationRegistry {
  private entries=new Map<string,Entry>();
  private snapshots=new Map<string,AcknowledgableSnapshot>();
  // Native frames are monotonic for *every* output format, including the
  // legacy receipt and compact/both trees that have no ACK snapshot ID.
  private publishedFrames=new Map<string,PublishedFrame>();
  constructor(readonly provider:NativeScreenProvider,private now:()=>number=Date.now){}
  private prune(){for(const [binding,entry] of this.entries)if(entry.expiresAt<=this.now()){
    this.entries.delete(binding);this.snapshots.delete(binding);this.publishedFrames.delete(binding);
  }}
  remember(binding:string,owner:string,response:BrokerToolResult):void {
    this.prune();
    if(response.isError===true)return;
    const envelope=response.structuredContent;
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw new Error('SCREEN_READER_PROTOCOL: native grant needs a structured receipt');
    const record=envelope as Record<string,unknown>;
    if(record.ok!==true)throw new Error('SCREEN_READER_PROTOCOL: grant was not confirmed');
    const grant=grantSchema.parse(record.data);
    const current=this.entries.get(binding);
    // Native input-owner epochs increase within a session. An out-of-order
    // broker completion must not roll back the latest granted capture owner.
    if(current?.owner===owner&&current.grant.session===grant.session&&
       grant.owner_epoch<current.grant.owner_epoch)
      throw new NativeScreenObservationError('SCREEN_READER_STALE_GRANT');
    if(!this.entries.has(binding)&&this.entries.size>=32)throw new Error('SCREEN_READER_CAPACITY');
    this.entries.set(binding,{grant,owner,expiresAt:this.now()+grant.expires_in_ms});
    this.snapshots.delete(binding); // Fresh grant invalidates all old delivery proofs.
    this.publishedFrames.delete(binding);
  }
  async observe(binding:string,owner:string,args:{reader_lease:string;timeout_ms:number;max_nodes:number;readiness?:ReadinessRequest;
    tree_format?:'compact'|'json'|'both';ack_snapshot_id?:string;prefer_diff?:boolean;prefer_mixed_diff?:boolean},
    validate:()=>Promise<void>,signal?:AbortSignal,onDispatched?:()=>void):Promise<Record<string,unknown>> {
    this.prune();
    const entry=this.entries.get(binding);
    if(!entry||entry.owner!==owner||entry.grant.reader_lease!==args.reader_lease)throw new Error('SCREEN_READER_NOT_AUTHORIZED: grant belongs to another or retired turn binding');
    await validate();
    // Validation may yield while the native owner rotates or the lease
    // expires. Do not dispatch any observation using that retired authority.
    if(this.entries.get(binding)!==entry||entry.expiresAt<=this.now())
      throw new NativeScreenObservationError('SCREEN_READER_STALE');
    if(signal?.aborted)throw signal.reason??new Error('Screen observation cancelled');
    // Validate the entire native argument contract before recording dispatch.
    // An oversized UTF-8 predicate must not produce a synthetic tool receipt.
    const readiness=args.readiness?readinessRequestSchema.parse(args.readiness):undefined;
    if(readiness) {
      const roi=readiness.region,viewport=entry.grant.region;
      // Match Swift's bounded native ROI admission before dispatch. An
      // invalid read-only request must not retire an otherwise usable turn.
      if(roi.x>16384||roi.y>16384||roi.width>16384||roi.height>16384||
        roi.x<viewport.x||roi.y<viewport.y||
        roi.x+roi.width>viewport.x+viewport.width||
        roi.y+roi.height>viewport.y+viewport.height||
        roi.width*roi.height*4>viewport.width*viewport.height*3)
        throw new NativeScreenObservationError('SCREEN_READER_READINESS_ROI_INVALID');
    }
    const operation_id=randomUUID();
    onDispatched?.();
    const nativeResponse=await this.provider.observe(entry.grant,{operation_id,timeout_ms:args.timeout_ms,max_nodes:args.max_nodes,
      ...(readiness?{readiness}:{})},signal);
    await validate();
    if(signal?.aborted)throw signal.reason??new Error('Screen observation cancelled');
    if(this.entries.get(binding)!==entry||entry.expiresAt<=this.now())throw new Error('SCREEN_READER_STALE');
    // Publish only the strict declared protocol: encoded pixels and undeclared
    // nested fields cannot hide behind an UNAVAILABLE/image_encoded:false flag.
    const parsed=observerReceipt.safeParse(nativeResponse);
    if(!parsed.success)throw new Error('SCREEN_OBSERVATION_PROTOCOL: undeclared or invalid native receipt field');
    const response=parsed.data;
    // Native UIA timing spans only the provider attempt and must fit inside
    // the complete observed operation. Unattempted providers have no timing.
    if(response.sources?.uia.sample_end_ms!==undefined&&response.total_ms!==undefined&&
      response.sources.uia.sample_end_ms>response.total_ms)
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: UIA provider timing exceeds final observation duration');
    // READY is a decision about an explicitly requested predicate on this
    // final native frame, not a free-standing native status flag.
    if(response.status==='READY'&&(!args.readiness||response.readiness?.status!=='READY'||
      response.readiness.mode!=='ui_ready'||response.readiness.semantic_ready!==true||
      response.readiness.semantic_frame_id!==response.frame_id||
      response.readiness.semantic_generation!==response.target_generation||
      response.readiness.predicate!=='ocr_text_contains'))
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: final-frame semantic readiness proof is absent');
    if(response.status!=='READY'&&response.readiness?.semantic_ready===true)
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: readiness claims success for an unfinished observation');
    if(args.readiness) {
      const requested=readinessRequestSchema.parse(args.readiness);
      const result=response.readiness;
      if(!result||result.status!==response.status||result.mode!==requested.mode||!result.region||
        JSON.stringify(result.region)!==JSON.stringify(requested.region)||
        result.predicate_sha256!==createHash('sha256').update(requested.contains,'utf8').digest('hex')||
        (response.status==='READY'&&(!result.semantic_ready||result.semantic_frame_id!==response.frame_id||
          result.semantic_generation!==response.target_generation||result.predicate!=='ocr_text_contains')))
        throw new Error('SCREEN_OBSERVATION_PROTOCOL: semantic readiness/frame/ROI mismatch');
    }
    // An early successful OCR predicate does not prove that the final native
    // observation survived downstream CV/OCR processing and its deadline.
    // The native reader always reports final source receipts: fail closed if
    // its final OCR/CV receipts contradict a prior READY assertion.
    if(response.status==='READY'&&(!response.sources||
      response.sources.cv.status!=='completed'||response.sources.ocr.status!=='completed'||
      response.sources.ocr.frame_id!==response.frame_id||
      response.sources.ocr.target_generation!==response.target_generation||
      response.reason==='observation_deadline'))
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: READY contradicts final-frame source completion');
    const region=regionSchema.safeParse(response.region);
    if(response.observer_protocol!==1||response.operation_id!==operation_id||response.session!==entry.grant.session||
       response.hwnd!==entry.grant.hwnd||response.pid!==entry.grant.pid||response.owner_epoch!==entry.grant.owner_epoch||
       !region.success||JSON.stringify(region.data)!==JSON.stringify(entry.grant.region)||
       !['READY','NOT_READY','PARTIAL'].includes(String(response.status))||response.image_delivery_status!=='UNAVAILABLE'||response.image_encoded!==false||
       !Number.isSafeInteger(response.frame_id)||Number(response.frame_id)<1||!Number.isSafeInteger(response.target_generation)||Number(response.target_generation)<1||
       !Array.isArray(response.nodes)||response.nodes.length>args.max_nodes||Buffer.byteLength(JSON.stringify(response),'utf8')>65536)
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: native target/frame/modality receipt mismatch');
    // The summary must describe the same final frame that produced OCR/CV
    // nodes. Validating individual nodes alone does not validate nested
    // capture and OCR-source receipts (which also reach the model).
    const capture=response.capture;
    if(capture&&(capture.frame_id!==response.frame_id||capture.target_generation!==response.target_generation||
      capture.width!==response.region.width||capture.height!==response.region.height||
      JSON.stringify(capture.region)!==JSON.stringify(response.region)||
      (response.dpi!==undefined&&capture.dpi!==response.dpi)))
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: capture belongs to another frame or viewport');
    const sourceOcr=response.sources?.ocr;
    if(sourceOcr&&(
      (sourceOcr.frame_id===undefined)!==(sourceOcr.target_generation===undefined)||
      (sourceOcr.frame_id!==undefined&&sourceOcr.frame_id!==response.frame_id)||
      (sourceOcr.target_generation!==undefined&&sourceOcr.target_generation!==response.target_generation)))
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: OCR source belongs to another frame');
    // Source availability and completeness are part of the native receipt,
    // not inferred from the mere presence of a node array. Reject a source
    // that contradicts its published nodes before projecting or caching it.
    // Enhanced semantic trees require the native provenance envelope, even
    // for a PARTIAL or empty observation. Legacy raw receipts remain compatible.
    if(args.tree_format&&!response.sources)
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: semantic tree lacks native source provenance');
    if(response.sources) {
      const cvCount=response.nodes.filter(node=>node.source==='cv').length;
      const ocrCount=response.nodes.filter(node=>node.source==='ocr').length;
      const uiaCount=response.nodes.filter(node=>node.source==='uia').length;
      if(response.sources.cv.source_count<cvCount||
        (cvCount>0&&response.sources.cv.status!=='completed')||
        (uiaCount>0&&!(response.sources.uia.status==='ok'||
          (response.sources.uia.status==='timeout'&&response.sources.uia.partial)))||
        (ocrCount>0&&(sourceOcr?.status!=='completed'||
          sourceOcr.frame_id!==response.frame_id||
          sourceOcr.target_generation!==response.target_generation)))
        throw new Error('SCREEN_OBSERVATION_PROTOCOL: source availability/count contradicts published nodes');
    }
    for(const value of response.nodes) {
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('SCREEN_OBSERVATION_PROTOCOL: invalid node');
      const node=value as Record<string,unknown>,box=boundsSchema.safeParse(node.bounds);
      if(!box.success||box.data.x<entry.grant.region.x||box.data.y<entry.grant.region.y||
        box.data.x+box.data.width>entry.grant.region.x+entry.grant.region.width||box.data.y+box.data.height>entry.grant.region.y+entry.grant.region.height)
        throw new Error('SCREEN_OBSERVATION_PROTOCOL: node outside authorized viewport');
      if(node.source==='cv') {
        if(node.frame_id!==response.frame_id||node.target_generation!==response.target_generation||node.name!=='')
          throw new Error('SCREEN_OBSERVATION_PROTOCOL: stale/invented CV node');
      } else if(node.source==='uia') {
        if(node.pixel_correspondence!=='unverified')throw new Error('SCREEN_OBSERVATION_PROTOCOL: UIA snapshot is not pixel evidence');
      } else if(node.source==='ocr') {
        if(node.frame_id!==response.frame_id||node.target_generation!==response.target_generation||typeof node.name!=='string'||
          node.confidence!==null||node.confidence_status!=='unavailable')throw new Error('SCREEN_OBSERVATION_PROTOCOL: unverified OCR provenance/confidence');
      } else throw new Error('SCREEN_OBSERVATION_PROTOCOL: unsupported/unverified source');
    }
    const published=this.publishedFrames.get(binding);
    if(published?.entry===entry && (response.target_generation<published.generation||
      (response.target_generation===published.generation&&response.frame_id<published.frame)))
      throw new NativeScreenPublishedFrameStaleError();
    // The native nodes can include provider IDs of redacted UIA ancestors.
    // For explicit tree mode publish only the privacy-projected representation;
    // retaining the raw array would undo the projector's redactions. Omitted
    // tree_format preserves the legacy native receipt unchanged.
    let nextSnapshot:AcknowledgableSnapshot|undefined;
    const projected=(()=>{
      if(!args.tree_format)return response;
      const tree=projectScreenTree(response,args.tree_format);
      const {nodes: _rawNodes,...receipt}=response;
      if(args.tree_format!=='json'){
        return {...receipt,tree};
      }
      const older=this.snapshots.get(binding),snapshotId=randomUUID();
      if(older?.entry===entry && (tree.target_generation<older.tree.target_generation||
        (tree.target_generation===older.tree.target_generation&&tree.frame_id<older.tree.frame_id)))
        throw new NativeScreenPublishedFrameStaleError();
      // Only an explicit echo of the last actually returned snapshot can
      // acknowledge it. Bind cached identities to the same live grant object;
      // exact frame/generation and completeness are checked by the diff.
      // A stable tree generation/region alone cannot certify geometry after
      // DPI scaling, viewport capture dimensions or capture backend changes.
      // The incremental contract is opt-in: if either snapshot lacks a
      // capture descriptor, the receiver needs a complete tree again.
      const captureScope:CaptureScope|undefined=capture?{
        backend:capture.backend,dpi:capture.dpi,width:capture.width,height:capture.height}:undefined;
      const previousCapture=older?.captureScope;
      const sameCaptureScope=previousCapture&&captureScope?
        previousCapture.backend===captureScope.backend&&previousCapture.dpi===captureScope.dpi&&
        previousCapture.width===captureScope.width&&previousCapture.height===captureScope.height:
        false;
      const acknowledged=args.ack_snapshot_id!==undefined&&older?.entry===entry&&sameCaptureScope&&
        older.id===args.ack_snapshot_id&&older.status==='READY'&&response.status==='READY';
      const mixed=acknowledged&&args.prefer_mixed_diff===true
        ?diffVerifiedMixedTrees(older!.tree,tree):undefined;
      // An explicit mixed ACK carries every volatile OCR/CV node from the new
      // frame. Cap it independently; otherwise fall back to a complete tree.
      const acceptedMixed=mixed&&Buffer.byteLength(JSON.stringify(mixed),'utf8')<=16384?mixed:undefined;
      const delta=acknowledged&&args.prefer_diff===true&&args.prefer_mixed_diff!==true
        ?diffVerifiedUiaTrees(older!.tree,tree):undefined;
      // A provider delta can be larger than either bounded full tree when
      // many long provider IDs disappear while an equally large set appears.
      // Fall back to the complete current snapshot instead of oversizing it.
      const acceptedDelta=delta&&Buffer.byteLength(JSON.stringify(delta),'utf8')<=16384?delta:undefined;
      nextSnapshot={entry,id:snapshotId,tree,status:response.status,captureScope};
      if(acceptedMixed)return {...receipt,tree_update:{mode:'mixed_diff',snapshot_id:snapshotId,
        base_snapshot_id:older!.id,frame_id:tree.frame_id,target_generation:tree.target_generation},tree_diff:acceptedMixed};
      if(acceptedDelta)return {...receipt,tree_update:{mode:'diff',snapshot_id:snapshotId,
        base_snapshot_id:older!.id,frame_id:tree.frame_id,target_generation:tree.target_generation},tree_diff:acceptedDelta};
      return {...receipt,tree,tree_update:{mode:'full',snapshot_id:snapshotId,
        frame_id:tree.frame_id,target_generation:tree.target_generation}};
    })();
    if(this.entries.get(binding)!==entry||entry.expiresAt<=this.now())throw new Error('SCREEN_READER_STALE');
    if(signal?.aborted)throw signal.reason??new Error('Screen observation cancelled');
    // Commit delivery state only after final authority/cancellation checks.
    // No await follows this point: a rejected observation cannot replace an
    // acknowledged frame or erase it through a legacy/compact response.
    this.publishedFrames.set(binding,{entry,generation:response.target_generation,frame:response.frame_id});
    if(nextSnapshot)this.snapshots.set(binding,nextSnapshot);
    else this.snapshots.delete(binding);
    return projected;
  }
}

/** Thin persistent-controller client. No process launch, screenshot, viewer,
 * file lookup, input command or alternate transport exists here. */
export class NativeReaderPipeProvider implements NativeScreenProvider {
  constructor(private pipe:string) {
    if(process.platform!=='win32'||!pipe.startsWith('\\\\.\\pipe\\')||!pipe.endsWith('_observer_v1'))
      throw new Error('SCREEN_OBSERVER_ENDPOINT_INVALID: explicit local reader pipe required');
  }
  private request(cmd:'observer_read'|'observer_cancel',args:Record<string,unknown>,timeout:number,signal?:AbortSignal):Promise<Record<string,unknown>> {
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),socket=createConnection(this.pipe),decoder=new StringDecoder('utf8');let text='';
      const timer=setTimeout(()=>socket.destroy(new Error('SCREEN_OBSERVER_TIMEOUT')),timeout);
      const onAbort=()=>socket.destroy(signal?.reason instanceof Error?signal.reason:
        new NativeScreenObservationError('SCREEN_OBSERVER_CANCELLED'));
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);};
      socket.once('error',error=>{finish();reject(error);});
      socket.once('connect',()=>socket.write(JSON.stringify({id,cmd,args})+'\n'));
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted)onAbort();
      socket.on('data',bytes=>{
        // Named pipes are byte streams: an OCR glyph may span data events.
        text+=decoder.write(bytes);if(Buffer.byteLength(text,'utf8')>68000){socket.destroy(new Error('SCREEN_OBSERVER_RESPONSE_TOO_LARGE'));return;}
        const end=text.indexOf('\n');if(end<0)return;
        try {const value=JSON.parse(text.slice(0,end));if(value.id!==id)throw new Error('SCREEN_OBSERVER_RECEIPT_MISMATCH');
          if(value.ok!==true)throw new NativeScreenObservationError(typeof value.error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(value.error.code)?value.error.code:'SCREEN_OBSERVER_NATIVE_ERROR');
          if(!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw new Error('SCREEN_OBSERVER_PROTOCOL');
          finish();socket.end();resolve(value.data);
        } catch(error){finish();socket.destroy();reject(error);}
      });
      socket.once('close',()=>{finish();if(!text.includes('\n'))reject(new Error('SCREEN_OBSERVER_DISCONNECTED'));});
    });
  }
  async observe(grant:ScreenReaderGrant,args:{operation_id:string;timeout_ms:number;max_nodes:number;readiness?:ReadinessRequest},signal?:AbortSignal) {
    const scope={reader_lease:grant.reader_lease,consumer_owner:grant.consumer_owner,capability_epoch:grant.capability_epoch,operation_id:args.operation_id};
    if(signal?.aborted)throw signal.reason??new Error('Screen observation cancelled');
    // Abort and the resulting rejected read may both call cancel. Keep one
    // native cancellation request for the original operation identity.
    let cancellationRequested=false;
    const cancel=()=>{
      if(cancellationRequested)return;
      cancellationRequested=true;
      void this.request('observer_cancel',scope,2000).catch(()=>{});
    };
    signal?.addEventListener('abort',cancel,{once:true});
    try {return await this.request('observer_read',{...scope,timeout_ms:args.timeout_ms,max_nodes:args.max_nodes,
      ...(args.readiness?{readiness:args.readiness}:{})},args.timeout_ms+1500,signal);}
    catch(error){cancel();throw error;}
    finally {signal?.removeEventListener('abort',cancel);}
  }
}
