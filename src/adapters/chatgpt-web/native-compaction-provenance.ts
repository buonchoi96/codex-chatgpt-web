import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {getCodexHome} from '../../codex-integration-shared';
import {decodeCompactionSummary,encodeCompactionSummary,isReadableCompactionSummaryText,SUMMARY_PREFIX} from '../../responses/compaction';
import type {CodexParsedRequest} from '../../types';
import {ChatGptWebAdapterError} from './adapter-error';
import {extractChatGptRootThreadMetadata,extractChatGptThreadSpawnLineage,userRevision,
  type ChatGptTurnIdentity,type ChatGptTurnUserRevision} from './environment';
import {inspectCurrentCodexRollout,latestNativeCompactionRecord,verifyLatestNativeCompactionSource,verifyNativeGoalContinuationItems} from './codex-rollout-environment';

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
/** Diagnostics are bounded reason codes, never rollout paths or user message contents. */
export type NativeCompactionDiagnostic =
  | 'lineage_unverified'
  | 'request_checkpoint_missing'
  | 'checkpoint_not_installed'
  | 'checkpoint_identity_conflict'
  | 'source_identity_conflict'
  | 'latest_turn_mismatch'
  | 'model_effort_mismatch'
  | 'rollout_changed'
  | 'native_rollout_unavailable';
export interface NativeCompactionRecoveryOptions {
  codexHome?: string;
  sqliteHome?: string;
  onDiagnostic?: (reason: NativeCompactionDiagnostic) => void;
}
export interface NativeCompactionSource {
  source:ChatGptTurnUserRevision;
  summaryIndex:number;
  provenance:{kind:'native_compacted';checkpoint_sha256:string;source_id:string;source_revision:string};
}

/**
 * Authorize a cross-turn /goal resume without manufacturing a compaction checkpoint.
 * The native thread must itself record the exact old human instruction, a new
 * task_started boundary and the exact new goal-control item. Never use cached
 * browser summaries or an unverified incoming XML string as the witness.
 */
export function isAuthenticatedNativeGoalContinuation(
  parsed: CodexParsedRequest, identity: ChatGptTurnIdentity,
  historical: ChatGptTurnUserRevision,
  options: NativeCompactionRecoveryOptions = {},
): boolean {
  if(parsed._compactionRequest || !identity.threadId || !identity.turnId
    || !boundedString(historical.itemId) || !boundedString(historical.turnId)
    || historical.turnId === identity.turnId) return false;
  const body=record(parsed._rawBody),client=record(body?.client_metadata);
  let metadata:Record<string,unknown>|undefined;
  const encoded=client?.['x-codex-turn-metadata'];
  try { metadata=typeof encoded==='string'?record(JSON.parse(encoded)):record(encoded); } catch { return false; }
  if(metadata?.request_kind!=='turn' || metadata.turn_id!==identity.turnId
    || metadata.thread_id!==identity.threadId) return false;
  const input=body?.input;
  if(!Array.isArray(input))return false;
  // A /goal ACTIVE instruction is the control-plane anchor for this native
  // turn, not necessarily the final Responses item. Subsequent assistant/tool
  // rounds append after the goal item. Require exactly one current-turn goal
  // item with its own native ID; never accept a copied older-turn goal.
  const goalItems=input.flatMap((value,index)=>{
    const item=record(value);
    if(item?.type!=='message'||item.role!=='user'||!boundedString(item.id)
      || (owner(item)!==undefined&&owner(item)!==identity.turnId))return [];
    const parts=item.content;
    const content=typeof parts==='string'?parts:Array.isArray(parts)
      && parts.length===1 && record(parts[0])?.type==='input_text'
      ? record(parts[0])?.text : undefined;
    return typeof content==='string'
      && /^<codex_internal_context source="goal">[\s\S]+<\/codex_internal_context>$/.test(content.trim())
      ? [{item,index}]:[];
  });
  if(goalItems.length!==1)return false;
  const {item:goal,index:goalIndex}=goalItems[0]!;
  // Any later native user message in the request is a competing instruction,
  // unless its exact non-human nature is established independently. Do not
  // silently promote an old human instruction past newer user input.
  if(input.slice(goalIndex+1).some(value=>{
    const item=record(value);
    return item?.type==='message'&&item.role==='user';
  }))return false;
  console.info('[chatgpt-web] native_goal_continuation_candidate '+JSON.stringify({
    implementation:'goal-anchor-with-trailing-tool-rounds-v1',
    goalNotLast:goalIndex<input.length-1,
    trailingItems:Math.min(input.length-goalIndex-1,100000),
  }));
  const lineage=extractChatGptThreadSpawnLineage(parsed)??extractChatGptRootThreadMetadata(parsed);
  if(!lineage || lineage.threadId!==identity.threadId)return false;
  try {
    return inspectCurrentCodexRollout({
      codexHome:options.codexHome??getCodexHome(),
      ...(options.sqliteHome?{sqliteHome:options.sqliteHome}:{}),
      lineage,turnId:identity.turnId,
    },({fd,size,turn})=>{
      if(typeof body?.model!=='string'||turn.model!==body.model
        || !boundedString(turn.effort)||!NATIVE_EFFORTS.has(turn.effort)
        || (parsed.options.reasoning!==undefined && turn.effort!==parsed.options.reasoning))return false;
      return verifyNativeGoalContinuationItems(fd,size,identity.turnId!,{
        id:historical.itemId!,turnId:historical.turnId!,content:historical.content,
      },{id:goal.id as string,content:goal.content});
    }) === true;
  } catch {
    return false;
  }
}

/**
 * A new /compact may have an explicit older-turn human source but no matching
 * completed checkpoint yet. Recovering the PREVIOUS checkpoint before checking
 * this source can fail when Codex has advanced its persisted turn_context.
 * Verify the request's exact human item against the newest native human input
 * in the owning rollout instead; never use a bridge/browser copy as authority.
 */
export function isAuthenticatedNativeCompactionSource(
  parsed: CodexParsedRequest, identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
  options: NativeCompactionRecoveryOptions = {},
): boolean {
  // Native /compact can replay an ID-only user item: the request has no
  // per-item turn_id, but the original typed native user item does. Authenticate
  // the exact ID + full content against the newest native human instruction
  // before accepting it. A claimed, conflicting turn_id still fails closed.
  if (!parsed._compactionRequest || !identity.threadId || !identity.turnId
    || !boundedString(source.itemId)
    || (source.turnId !== undefined && (!boundedString(source.turnId)
      || source.turnId === identity.turnId))) return false;
  const body = record(parsed._rawBody);
  const client = record(body?.client_metadata);
  let metadata: Record<string, unknown> | undefined;
  const encoded = client?.['x-codex-turn-metadata'];
  try { metadata = typeof encoded === 'string' ? record(JSON.parse(encoded)) : record(encoded); }
  catch { return false; }
  if (metadata?.request_kind !== 'compaction' || metadata.turn_id !== identity.turnId
    || metadata.thread_id !== identity.threadId) return false;
  const input = body?.input;
  if (!Array.isArray(input) || !input.some(value => {
    const item = record(value);
    return item !== undefined && item.id === source.itemId && owner(item) === source.turnId
      && isDeepStrictEqual(item?.content, source.content)
      && item?.type === 'message' && item.role === 'user';
  })) return false;
  const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
  if (!lineage || lineage.threadId !== identity.threadId) return false;
  const witness = { id: source.itemId!, ...(source.turnId ? {turnId: source.turnId} : {}), content: source.content };
  try {
    return inspectCurrentCodexRollout({
      codexHome: options.codexHome ?? getCodexHome(),
      ...(options.sqliteHome ? {sqliteHome: options.sqliteHome} : {}),
      lineage, turnId: identity.turnId,
      ...(source.turnId ? {compactionSourceTurnId: source.turnId} : {}),
      compactionSource: witness,
    }, ({fd,size,turn}) => {
      if (typeof body?.model !== 'string' || turn.model !== body.model
        || !boundedString(turn.effort) || !NATIVE_EFFORTS.has(turn.effort)
        || (parsed.options.reasoning !== undefined && turn.effort !== parsed.options.reasoning)) return false;
      return verifyLatestNativeCompactionSource(fd, size, witness);
    }) === true;
  } catch {
    return false;
  }
}

/** No bridge JSON cache, prompt XML or supplied file path establishes this proof.
 * Only the newest installed native checkpoint in the exact current rollout can. */
export function resolveNativeCompactionSource(parsed:CodexParsedRequest,identity:ChatGptTurnIdentity,
  options:NativeCompactionRecoveryOptions={}):NativeCompactionSource|undefined{
  const reject=(reason:NativeCompactionDiagnostic):undefined=>{options.onDiagnostic?.(reason);return undefined;};
  const lineage=extractChatGptThreadSpawnLineage(parsed)??extractChatGptRootThreadMetadata(parsed);
  if(!lineage||lineage.threadId!==identity.threadId||!identity.turnId)return reject('lineage_unverified');
  const body=record(parsed._rawBody),input=body?.input;
  if(!Array.isArray(input))return reject('request_checkpoint_missing');
  let requestCheckpoint:Record<string,unknown>|undefined,summaryIndex=-1,key:string|undefined;
  for(let index=input.length-1;index>=0;index--){
    const item=record(input[index]);if(!item)continue;
    const candidate=checkpointKey(item);
    if(candidate){requestCheckpoint=item;summaryIndex=index;key=candidate;break;}
    if(['compaction','compaction_summary','context_compaction'].includes(String(item.type)))return reject('request_checkpoint_missing');
  }
  if(!requestCheckpoint||!key)return reject('request_checkpoint_missing');
  // Standalone /compact may run under its own transient native turn while the
  // latest persisted turn_context still belongs to the source instruction turn.
  // Only a native-owned source item in this exact request can name that alternate
  // turn, and the installed checkpoint must still match byte-for-byte below.
  const nativeSource = parsed._compactionRequest
    ? input.flatMap(item => {
      const message = record(item);
      // A tool result or goal-control payload cannot attest to the human
      // instruction that preceded the stopped native turn.
      if (message?.type !== 'message' || message.role !== 'user') return [];
      const revision = userRevision(item, identity.turnId);
      return revision?.itemId ? [revision] : [];
    }).at(-1) : undefined;
  const compactionSourceTurnId = nativeSource?.turnId && nativeSource.turnId !== identity.turnId
    ? nativeSource.turnId : undefined;
  // A current compact request may replay an ID-only user item after a cancelled
  // turn: the exact most-recent persisted native human item establishes its owner.
  // Never accept an ID alone; verifyLatestNativeCompactionSource checks full content,
  // typed native human metadata, recency, and rejects intervening instructions.
  const compactionSource = nativeSource?.itemId
    ? { id: nativeSource.itemId, ...(nativeSource.turnId ? {turnId:nativeSource.turnId} : {}),
      content: nativeSource.content } : undefined;
  if (parsed._compactionRequest) {
    // Revision marker proves which implementation is running; no source IDs,
    // text, local paths or other request content enter this diagnostic.
    console.info('[chatgpt-web] native_compaction_candidate ' + JSON.stringify({
      implementation: 'ownerless-native-source-v2',
      checkpointPresent: requestCheckpoint !== undefined,
      sourcePresent: compactionSource !== undefined,
      sourceHasTurnId: nativeSource?.turnId !== undefined,
    }));
  }
  let installationDigest:string|undefined;
  const installationHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');
  try{
    return inspectCurrentCodexRollout({codexHome:options.codexHome??getCodexHome(),
      ...(options.sqliteHome?{sqliteHome:options.sqliteHome}:{}),lineage,turnId:identity.turnId,
      ...(compactionSourceTurnId?{compactionSourceTurnId}:{}),
      ...(compactionSource?{compactionSource}:{})},({fd,size,turn})=>{
      // An omitted request preference is not a claimed model setting. The current
      // native turn must still supply actual effort evidence; never infer a default.
      if(typeof body?.model!=='string'||turn.model!==body.model||!boundedString(turn.effort)||!NATIVE_EFFORTS.has(turn.effort)||
        (parsed.options.reasoning!==undefined&&turn.effort!==parsed.options.reasoning))
        throw new Error('Native current model/effort does not authenticate this replay');
      const installed=latestNativeCompactionRecord(fd,size);
      if(!installed||!boundedString(installed.compaction_response_id)||!Array.isArray(installed.replacement_history)||
        installed.replacement_history.length>10000||!Array.isArray(installed.replacement_history_metadata)||
        installed.replacement_history_metadata.length!==installed.replacement_history.length)return reject('checkpoint_not_installed');
      const history=installed.replacement_history.map(record),metadata=installed.replacement_history_metadata.map(record);
      const checkpointIndices=history.flatMap((item,index)=>item&&checkpointKey(item)!==undefined?[index]:[]);
      if(checkpointIndices.length!==1)return reject('checkpoint_identity_conflict');
      const nativeCheckpoint=history[checkpointIndices[0]!]!;
      if(checkpointKey(nativeCheckpoint)!==key)return reject('checkpoint_identity_conflict');
      const nativeOwner=owner(nativeCheckpoint);
      // Native compaction items have no message owner. Their server-generated
      // item id must instead match the exact installation in this rollout.
      if(nativeOwner===undefined){
        if(!boundedString(nativeCheckpoint.id)||requestCheckpoint!.id!==nativeCheckpoint.id)return reject('checkpoint_identity_conflict');
      }else if(!boundedString(nativeOwner))return reject('checkpoint_identity_conflict');
      const requestOwner=owner(requestCheckpoint!);
      if(requestOwner!==undefined&&requestOwner!==nativeOwner&&requestOwner!==identity.turnId)return reject('checkpoint_identity_conflict');
      if(requestCheckpoint!.id!==undefined&&nativeCheckpoint.id!==undefined&&requestCheckpoint!.id!==nativeCheckpoint.id)return reject('checkpoint_identity_conflict');
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
      if(conflicts.some(item=>!isDeepStrictEqual(item!.content,source.content)
        || (owner(item!)!==source.turnId
          && !(parsed._compactionRequest && owner(item!)===undefined
            && item!.type==='message' && item!.role==='user'
            // The raw request lacks owner metadata. Accept only when the
            // native rollout independently proves this exact message is its
            // latest typed human instruction with the installed source owner.
            && verifyLatestNativeCompactionSource(fd,size,{
              id:source.itemId!,turnId:source.turnId!,content:source.content,
            })))))return reject('source_identity_conflict');
      installationDigest=installationHash(installed);
      return {source:structuredClone(source),summaryIndex,provenance:{kind:'native_compacted' as const,
        checkpoint_sha256:key!,source_id:structuredId?source.itemId:retainedId as string,source_revision:selected.retained.revision as string}};
    },({fd,size})=>{
      if(installationDigest!==undefined&&installationHash(latestNativeCompactionRecord(fd,size))!==installationDigest)
        throw new Error('Native checkpoint changed during provenance lookup');
    });
  }catch(cause){
    const detail=cause instanceof Error?cause.message:'';
    // Categorize without ever exposing native rollout paths or source content.
    const reason:NativeCompactionDiagnostic = detail.includes('current model/effort')
      ? 'model_effort_mismatch'
      : detail.includes('does not belong to the requested turn') || detail.includes('current turn')
        ? 'latest_turn_mismatch'
        : detail.includes('changed during provenance') || detail.includes('rollout was rewritten')
          || detail.includes('rollout shrank') || detail.includes('rollout turn changed')
          ? 'rollout_changed'
          : 'native_rollout_unavailable';
    options.onDiagnostic?.(reason);
    throw new ChatGptWebAdapterError(
      `Replay provenance is unverified in the current native rollout (reason=${reason}). Preserve the task and supply an authentic Codex instruction or a matching installed checkpoint.`,
      {status:400,errorType:'invalid_request_error',code:'REPLAY_PROVENANCE_UNVERIFIED',retryable:false,cause});
  }
}
