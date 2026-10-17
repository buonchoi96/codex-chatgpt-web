import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {getCodexHome} from '../../codex-integration-shared';
import {decodeCompactionSummary,encodeCompactionSummary,isReadableCompactionSummaryText,SUMMARY_PREFIX} from '../../responses/compaction';
import type {CodexParsedRequest} from '../../types';
import {ChatGptWebAdapterError} from './adapter-error';
import {extractChatGptRootThreadMetadata,extractChatGptThreadSpawnLineage,userRevision,
  type ChatGptTurnIdentity,type ChatGptTurnUserRevision} from './environment';
import {inspectCurrentCodexRollout,latestNativeCompactionRecord} from './codex-rollout-environment';

function record(value:unknown):Record<string,unknown>|undefined{
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
function boundedString(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256;}
const NATIVE_EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
function checkpointKey(item:Record<string,unknown>):string|undefined{
  let key:unknown;
  if(['compaction','compaction_summary','context_compaction'].includes(String(item.type))){
    // Opaque native summaries cannot be interpreted by the routed Web model.
    if(typeof item.encrypted_content!=='string')return undefined;
    const decoded=decodeCompactionSummary(item.encrypted_content);
    if(!decoded?.trim()||encodeCompactionSummary(decoded)!==item.encrypted_content)return undefined;
    key=['compaction',item.encrypted_content];
  }else{
    if(item.type!=='message'||item.role!=='user')return undefined;
    let text:unknown=item.content;
    if(Array.isArray(text)){
      if(text.some(part=>!['text','input_text'].includes(String(record(part)?.type))||typeof record(part)?.text!=='string'))return undefined;
      text=text.map(part=>record(part)!.text).join('\n');
    }
    if(!isReadableCompactionSummaryText(text)||!text.slice(SUMMARY_PREFIX.length).trim())return undefined;
    key=['message',text];
  }
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}
function owner(item:Record<string,unknown>):unknown{return record(item.internal_chat_message_metadata_passthrough)?.turn_id;}
function contentMatchesKinds(item:Record<string,unknown>,kinds:unknown[]):boolean{
  if(typeof item.content==='string')return kinds.every(kind=>kind==='user.text');
  if(!Array.isArray(item.content)||item.content.length===0)return false;
  const actual=new Set<string>();
  for(const value of item.content){
    const part=record(value);
    if(part?.type==='input_text'&&typeof part.text==='string')actual.add('user.text');
    else if(part?.type==='input_image'&&typeof part.image_url==='string'&&part.image_url.length>0)actual.add('user.image');
    else return false;
  }
  return kinds.every(kind=>typeof kind==='string'&&actual.has(kind))&&[...actual].every(kind=>kinds.includes(kind));
}
export interface NativeCompactionRecoveryOptions {codexHome?:string;sqliteHome?:string;}
export interface NativeCompactionSource {
  source:ChatGptTurnUserRevision;
  summaryIndex:number;
  provenance:{kind:'native_compacted';checkpoint_sha256:string;source_id:string;source_revision:string};
}

/** No bridge JSON cache, prompt XML or supplied file path establishes this proof.
 * Only the newest installed native checkpoint in the exact current rollout can. */
export function resolveNativeCompactionSource(parsed:CodexParsedRequest,identity:ChatGptTurnIdentity,
  options:NativeCompactionRecoveryOptions={}):NativeCompactionSource|undefined{
  const lineage=extractChatGptThreadSpawnLineage(parsed)??extractChatGptRootThreadMetadata(parsed);
  if(!lineage||lineage.threadId!==identity.threadId||!identity.turnId)return undefined;
  const body=record(parsed._rawBody),input=body?.input;
  if(!Array.isArray(input))return undefined;
  let requestCheckpoint:Record<string,unknown>|undefined,summaryIndex=-1,key:string|undefined;
  for(let index=input.length-1;index>=0;index--){
    const item=record(input[index]);if(!item)continue;
    const candidate=checkpointKey(item);
    if(candidate){requestCheckpoint=item;summaryIndex=index;key=candidate;break;}
    if(['compaction','compaction_summary','context_compaction'].includes(String(item.type)))return undefined;
  }
  if(!requestCheckpoint||!key)return undefined;
  let installationDigest:string|undefined;
  const installationHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');
  try{
    return inspectCurrentCodexRollout({codexHome:options.codexHome??getCodexHome(),
      ...(options.sqliteHome?{sqliteHome:options.sqliteHome}:{}),lineage,turnId:identity.turnId},({fd,size,turn})=>{
      // An omitted request preference is not a claimed model setting. The current
      // native turn must still supply actual effort evidence; never infer a default.
      if(typeof body?.model!=='string'||turn.model!==body.model||!boundedString(turn.effort)||!NATIVE_EFFORTS.has(turn.effort)||
        (parsed.options.reasoning!==undefined&&turn.effort!==parsed.options.reasoning))
        throw new Error('Native current model/effort does not authenticate this replay');
      const installed=latestNativeCompactionRecord(fd,size);
      if(!installed||!boundedString(installed.compaction_response_id)||!Array.isArray(installed.replacement_history)||
        installed.replacement_history.length>10000||!Array.isArray(installed.replacement_history_metadata)||
        installed.replacement_history_metadata.length!==installed.replacement_history.length)return undefined;
      const history=installed.replacement_history.map(record),metadata=installed.replacement_history_metadata.map(record);
      const checkpointIndices=history.flatMap((item,index)=>item&&checkpointKey(item)!==undefined?[index]:[]);
      if(checkpointIndices.length!==1)return undefined;
      const nativeCheckpoint=history[checkpointIndices[0]!]!;
      if(checkpointKey(nativeCheckpoint)!==key)return undefined;
      const nativeOwner=owner(nativeCheckpoint);
      // Native compaction items have no message owner. Their server-generated
      // item id must instead match the exact installation in this rollout.
      if(nativeOwner===undefined){
        if(!boundedString(nativeCheckpoint.id)||requestCheckpoint!.id!==nativeCheckpoint.id)return undefined;
      }else if(!boundedString(nativeOwner))return undefined;
      const requestOwner=owner(requestCheckpoint!);
      if(requestOwner!==undefined&&requestOwner!==nativeOwner&&requestOwner!==identity.turnId)return undefined;
      if(requestCheckpoint!.id!==undefined&&nativeCheckpoint.id!==undefined&&requestCheckpoint!.id!==nativeCheckpoint.id)return undefined;
      let selected:{item:Record<string,unknown>;meta:Record<string,unknown>;order:number;retained:Record<string,unknown>}|undefined;
      const seenOrders=new Set<number>();
      for(let index=0;index<history.length;index++){
        const item=history[index],meta=metadata[index];if(!item||!meta)return undefined;
        if(item.type!=='message'||item.role!=='user')continue;
        const kinds=record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
        if(!Array.isArray(kinds)||kinds.length===0||kinds.some(kind=>kind!=='user.text'&&kind!=='user.image')){
          // Native context/summary entries have no retained source or user order.
          // A declared source with corrupt kinds is not contextual history.
          if(meta.retained_source!=null||meta.user_input_order!=null||
            Array.isArray(kinds)&&kinds.some(kind=>kind==='user.text'||kind==='user.image'))return undefined;
          continue;
        }
        // A native instruction with missing retention proof must not disappear
        // from ordering and silently revive an older authorized instruction.
        const retained=record(meta.retained_source);
        if(!retained||!contentMatchesKinds(item,kinds))return undefined;
        if(!Number.isSafeInteger(meta.user_input_order)||Number(meta.user_input_order)<0||seenOrders.has(Number(meta.user_input_order)))return undefined;
        seenOrders.add(Number(meta.user_input_order));
        if(!selected||Number(meta.user_input_order)>selected.order)selected={item,meta,order:Number(meta.user_input_order),retained};
      }
      if(!selected)return undefined;
      const source=userRevision(selected.item,undefined,{turn_id:owner(selected.item)});
      // Validate the newest retained instruction; never silently substitute an
      // older complete one when the newest is incomplete or context-only.
      if(!source||!boundedString(source.itemId)||!boundedString(source.turnId)||selected.meta.client_authored!==false||
        selected.retained.complete!==true||!boundedString(selected.retained.revision))return undefined;
      const retainedId=selected.retained.id,structuredId=record(retainedId);
      if(structuredId){
        if(structuredId.message_id!==source.itemId||structuredId.turn_id!==source.turnId||structuredId.role!=='user')return undefined;
      }else if(!boundedString(retainedId))return undefined;
      // The current request may still contain the retained item. Conflicting
      // content under its exact native identity cannot be repaired from history.
      const conflicts=input.map(record).filter(item=>item?.id===source.itemId);
      if(conflicts.some(item=>!isDeepStrictEqual(item!.content,source.content)||owner(item!)!==source.turnId))return undefined;
      installationDigest=installationHash(installed);
      return {source:structuredClone(source),summaryIndex,provenance:{kind:'native_compacted' as const,
        checkpoint_sha256:key!,source_id:structuredId?source.itemId:retainedId as string,source_revision:selected.retained.revision as string}};
    },({fd,size})=>{
      if(installationDigest!==undefined&&installationHash(latestNativeCompactionRecord(fd,size))!==installationDigest)
        throw new Error('Native checkpoint changed during provenance lookup');
    });
  }catch(cause){
    throw new ChatGptWebAdapterError('Replay provenance is unverified in the current native rollout. Preserve the task and supply an authentic Codex instruction or a matching installed checkpoint.',
      {status:400,errorType:'invalid_request_error',code:'REPLAY_PROVENANCE_UNVERIFIED',retryable:false,cause});
  }
}
