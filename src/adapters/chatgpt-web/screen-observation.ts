import * as z from 'zod/v4';
import {randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import type {BrokerToolResult} from './turn-broker';
import {projectScreenTree} from './screen-tree';

const regionSchema=z.object({x:z.number().int().min(0),y:z.number().int().min(0),width:z.number().int().positive(),height:z.number().int().positive()}).strict();
const boundsSchema=z.object({x:z.number().finite().min(0),y:z.number().finite().min(0),width:z.number().finite().positive(),height:z.number().finite().positive()}).strict();
const grantSchema=z.object({observer_protocol:z.literal(1),reader_lease:z.string().regex(/^reader_[0-9a-f]{64}$/),
  session:z.uuid(),hwnd:z.string().regex(/^[1-9][0-9]*$/),pid:z.number().int().positive(),consumer_owner:z.uuid(),capability_epoch:z.uuid(),
  owner_epoch:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),expires_in_ms:z.number().int().min(1).max(300000),region:regionSchema,
  observer_tree_available:z.literal(false),image_delivery_status:z.literal('UNAVAILABLE')}).strict();
export type ScreenReaderGrant=z.infer<typeof grantSchema>;
const readinessRequestSchema=z.object({mode:z.literal('ui_ready'),region:regionSchema,
  contains:z.string().min(1).max(128)}).strict();
type ReadinessRequest=z.infer<typeof readinessRequestSchema>;
export interface NativeScreenProvider {
  observe(grant:ScreenReaderGrant,args:{operation_id:string;timeout_ms:number;max_nodes:number;readiness?:ReadinessRequest},signal?:AbortSignal):Promise<Record<string,unknown>>;
}
export class NativeScreenObservationError extends Error {
  constructor(readonly code:string){super(code);this.name='NativeScreenObservationError';}
}
export const screenObserveArguments={reader_lease:z.string().regex(/^reader_[0-9a-f]{64}$/),
  timeout_ms:z.number().int().min(1).max(3000).default(1000),max_nodes:z.number().int().min(1).max(200).default(64),
  tree_format:z.enum(['compact','json','both']).optional(),
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
    sample_start_ms:timing,sample_end_ms:timing}).strict(),
  ocr:z.object({status:z.enum(['UNAVAILABLE','empty','completed']),reason:z.string().max(128).optional(),confidence_available:z.literal(false),
    language:z.string().max(64).optional(),materialized_copies:counter.max(3).optional(),truncated:z.boolean().optional(),
    frame_id:identity.optional(),target_generation:identity.optional()}).strict(),
}).strict();
const computeReceipt=z.object({mode:z.literal('AUTO'),worker_threads:identity.max(8),control_threads:identity,
  concurrency_limit:identity.max(8),active:counter,queued:counter,governor_reason:z.string().max(128),
  available_logical_processors:identity.nullable(),allocation_status:z.enum(['uncertain','verified']),allocation_reasons:z.array(z.string().max(256)).max(32),
  foreground_reserved:counter,bootstrap_workers:identity.max(8),uia_provider_ownership:z.literal('isolated_private_helper'),
  ocr_provider_ownership:z.literal('isolated_private_helper'),ocr_engine_internal_parallelism:z.literal('not_measured')}).strict();
const observerReceipt=z.object({observer_protocol:z.literal(1),operation_id:z.uuid(),session:z.uuid(),hwnd:z.string(),pid:identity,owner_epoch:identity,
  region:regionSchema,status:z.enum(['READY','NOT_READY','PARTIAL']),image_encoded:z.literal(false),image_delivery_status:z.literal('UNAVAILABLE'),
  frame_id:identity,target_generation:identity,nodes:z.array(z.discriminatedUnion('source',[cvNode,uiaNode,ocrNode])).max(200),
  dpi:identity.optional(),partial:z.boolean().optional(),reason:z.string().max(256).optional(),image_delivery_reason:z.literal('MODEL_IMAGE_RELAY_UNAVAILABLE').optional(),
  readiness:z.object({status:z.string().max(64),semantic_ready:z.boolean(),final_frames:z.literal(1),
    mode:z.literal('ui_ready').optional(),pixel_stable:z.boolean().optional(),capture_attempts:counter.optional(),
    accepted_samples:counter.optional(),rejected_samples:counter.optional(),semantic_frame_id:identity.optional(),
    semantic_generation:identity.optional(),predicate:z.string().min(1).max(128).optional(),
    region:regionSchema.optional(),wait_ms:timing.optional()}).strict().optional(),
  capture:captureReceipt.optional(),sources:sourcesReceipt.optional(),compute:computeReceipt.optional(),total_ms:timing.optional(),
}).strict();
type Entry={grant:ScreenReaderGrant;owner:string;expiresAt:number};

/** Authority enters only from the configured native grant tool's broker receipt,
 * never a model's arguments, filesystem roots or historical context. */
export class ScreenObservationRegistry {
  private entries=new Map<string,Entry>();
  constructor(readonly provider:NativeScreenProvider,private now:()=>number=Date.now){}
  private prune(){for(const [binding,entry] of this.entries)if(entry.expiresAt<=this.now())this.entries.delete(binding);}
  remember(binding:string,owner:string,response:BrokerToolResult):void {
    this.prune();
    if(response.isError===true)return;
    const envelope=response.structuredContent;
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw new Error('SCREEN_READER_PROTOCOL: native grant needs a structured receipt');
    const record=envelope as Record<string,unknown>;
    if(record.ok!==true)throw new Error('SCREEN_READER_PROTOCOL: grant was not confirmed');
    const grant=grantSchema.parse(record.data);
    if(!this.entries.has(binding)&&this.entries.size>=32)throw new Error('SCREEN_READER_CAPACITY');
    this.entries.set(binding,{grant,owner,expiresAt:this.now()+grant.expires_in_ms});
  }
  async observe(binding:string,owner:string,args:{reader_lease:string;timeout_ms:number;max_nodes:number;readiness?:ReadinessRequest;tree_format?:'compact'|'json'|'both'},
    validate:()=>Promise<void>,signal?:AbortSignal,onDispatched?:()=>void):Promise<Record<string,unknown>> {
    this.prune();
    const entry=this.entries.get(binding);
    if(!entry||entry.owner!==owner||entry.grant.reader_lease!==args.reader_lease)throw new Error('SCREEN_READER_NOT_AUTHORIZED: grant belongs to another or retired turn binding');
    await validate();
    if(signal?.aborted)throw signal.reason??new Error('Screen observation cancelled');
    const operation_id=randomUUID();
    onDispatched?.();
    const nativeResponse=await this.provider.observe(entry.grant,{operation_id,timeout_ms:args.timeout_ms,max_nodes:args.max_nodes,
      ...(args.readiness?{readiness:readinessRequestSchema.parse(args.readiness)}:{})},signal);
    await validate();
    if(signal?.aborted)throw signal.reason??new Error('Screen observation cancelled');
    if(this.entries.get(binding)!==entry||entry.expiresAt<=this.now())throw new Error('SCREEN_READER_STALE');
    // Publish only the strict declared protocol: encoded pixels and undeclared
    // nested fields cannot hide behind an UNAVAILABLE/image_encoded:false flag.
    const parsed=observerReceipt.safeParse(nativeResponse);
    if(!parsed.success)throw new Error('SCREEN_OBSERVATION_PROTOCOL: undeclared or invalid native receipt field');
    const response=parsed.data;
    if(response.status==='READY'&&response.readiness?.semantic_ready!==true)
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: semantic readiness proof is absent');
    if(args.readiness) {
      const requested=readinessRequestSchema.parse(args.readiness);
      const result=response.readiness;
      if(!result||result.mode!==requested.mode||!result.region||
        JSON.stringify(result.region)!==JSON.stringify(requested.region)||
        (response.status==='READY'&&(!result.semantic_ready||result.semantic_frame_id!==response.frame_id||
          result.semantic_generation!==response.target_generation||result.predicate!=='ocr_text_contains')))
        throw new Error('SCREEN_OBSERVATION_PROTOCOL: semantic readiness/frame/ROI mismatch');
    }
    const region=regionSchema.safeParse(response.region);
    if(response.observer_protocol!==1||response.operation_id!==operation_id||response.session!==entry.grant.session||
       response.hwnd!==entry.grant.hwnd||response.pid!==entry.grant.pid||response.owner_epoch!==entry.grant.owner_epoch||
       !region.success||JSON.stringify(region.data)!==JSON.stringify(entry.grant.region)||
       !['READY','NOT_READY','PARTIAL'].includes(String(response.status))||response.image_delivery_status!=='UNAVAILABLE'||response.image_encoded!==false||
       !Number.isSafeInteger(response.frame_id)||Number(response.frame_id)<1||!Number.isSafeInteger(response.target_generation)||Number(response.target_generation)<1||
       !Array.isArray(response.nodes)||response.nodes.length>args.max_nodes||Buffer.byteLength(JSON.stringify(response),'utf8')>65536)
      throw new Error('SCREEN_OBSERVATION_PROTOCOL: native target/frame/modality receipt mismatch');
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
    // Formatting consumes only the authenticated, strictly validated receipt;
    // it adds no provider call, native-parent inference or input authority.
    const projected=args.tree_format?{...response,tree:projectScreenTree(response,args.tree_format)}:response;
    if(this.entries.get(binding)!==entry||entry.expiresAt<=this.now())throw new Error('SCREEN_READER_STALE');
    if(signal?.aborted)throw signal.reason??new Error('Screen observation cancelled');
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
  private request(cmd:'observer_read'|'observer_cancel',args:Record<string,unknown>,timeout:number):Promise<Record<string,unknown>> {
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),socket=createConnection(this.pipe);let text='';
      const timer=setTimeout(()=>socket.destroy(new Error('SCREEN_OBSERVER_TIMEOUT')),timeout);
      const finish=()=>clearTimeout(timer);
      socket.once('error',error=>{finish();reject(error);});
      socket.once('connect',()=>socket.write(JSON.stringify({id,cmd,args})+'\n'));
      socket.on('data',bytes=>{
        text+=bytes.toString('utf8');if(Buffer.byteLength(text,'utf8')>68000){socket.destroy(new Error('SCREEN_OBSERVER_RESPONSE_TOO_LARGE'));return;}
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
    const cancel=()=>{void this.request('observer_cancel',scope,2000).catch(()=>{});};
    signal?.addEventListener('abort',cancel,{once:true});
    try {return await this.request('observer_read',{...scope,timeout_ms:args.timeout_ms,max_nodes:args.max_nodes,
      ...(args.readiness?{readiness:args.readiness}:{})},args.timeout_ms+1500);}
    catch(error){cancel();throw error;}
    finally {signal?.removeEventListener('abort',cancel);}
  }
}
