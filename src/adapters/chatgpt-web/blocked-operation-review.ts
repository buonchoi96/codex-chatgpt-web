import {createHash} from 'node:crypto';
import type {BlockedOperationLedger,BlockedOperationRecord} from './blocked-operation-ledger';
import type {ChatGptTurnEnvironment} from './environment';

export const SAFETY_REVIEW_CONTROL_WIRE_NAME='codex.control.safety_review';
export interface BlockedOperationReviewOptions {offset?:number;limit?:number;snapshot_sha256?:string}
export interface BlockedOperationReviewEntry {
  blocker_id:string;
  requirement:string;
  requirement_sha256:string;
  tool:string;
  classification:BlockedOperationRecord['classification'];
  dispatch_state:BlockedOperationRecord['dispatch_state'];
  execution_receipt:BlockedOperationRecord['execution_receipt'];
  resolution:BlockedOperationRecord['resolution'];
  attempts:number;
  timestamp:string;
  original_arguments_sha256:string;
}
export interface BlockedOperationReview {
  status:'clear'|'review_required'|'other_scope_pending'|'unavailable'|'snapshot_changed'|'invalid_cursor';
  advisory_only:true;
  retry_allowed:false;
  scope_sha256:string;
  snapshot_sha256?:string;
  unresolved_count?:number;
  other_scope_unresolved_count?:number;
  entries:BlockedOperationReviewEntry[];
  offset:number;
  limit:number;
  complete:boolean;
  next_offset?:number;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const REQUIREMENT=/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2}(?:\.\.\d{2})?$/;
function entry(record:BlockedOperationRecord):BlockedOperationReviewEntry {
  return {
    blocker_id:/^blocked_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.blocker_id)
      ?record.blocker_id:`legacy_${digest(record.blocker_id).slice(0,24)}`,
    requirement:REQUIREMENT.test(record.affected_goal_requirement)?record.affected_goal_requirement:'UNMAPPED_GOAL_PREREQUISITE_REVIEW_REQUIRED',
    requirement_sha256:digest(record.affected_goal_requirement),
    tool:/(?:turn|request|binding|reader)_[A-Za-z0-9_-]{24,}/.test(record.exact_tool_name)?'REDACTED_UNVERIFIED_TOOL_NAME':record.exact_tool_name,
    classification:record.classification,dispatch_state:record.dispatch_state,execution_receipt:record.execution_receipt,
    resolution:record.resolution,attempts:record.attempts,timestamp:new Date(record.timestamp).toISOString(),
    original_arguments_sha256:record.original_arguments_sha256,
  };
}

/** Local bookkeeping only. Never executes, retries, resolves, or grants authority.
 * The scope uses exactly the same object layout as MCP refusal persistence. An
 * unmatched historical scope is counted, never silently inferred or disclosed. */
export function readBlockedOperationReview(
  ledger:Pick<BlockedOperationLedger,'unresolved'>,
  environment:Pick<ChatGptTurnEnvironment,'cwd'|'roots'>,
  options:BlockedOperationReviewOptions={},
):BlockedOperationReview {
  const scope_sha256=digest({cwd:environment.cwd,roots:environment.roots});
  const offset=options.offset??0,limit=options.limit??20;
  const base={advisory_only:true as const,retry_allowed:false as const,scope_sha256,entries:[] as BlockedOperationReviewEntry[],offset,limit,complete:false};
  if(!Number.isSafeInteger(offset)||offset<0||offset>10_000||!Number.isSafeInteger(limit)||limit<1||limit>50
    ||options.snapshot_sha256!==undefined&&!HASH.test(options.snapshot_sha256)
    ||offset>0&&options.snapshot_sha256===undefined)return {...base,status:'invalid_cursor'};
  let records:BlockedOperationRecord[];
  try{records=ledger.unresolved();}catch{return {...base,status:'unavailable'};}
  const scoped=records.filter(record=>record.target_scope_sha256===scope_sha256).map(entry);
  const other_scope_unresolved_count=records.length-scoped.length;
  const snapshot_sha256=digest({scope_sha256,entries:scoped,other_scope_unresolved_count});
  const metadata={...base,snapshot_sha256,unresolved_count:scoped.length,other_scope_unresolved_count};
  if(options.snapshot_sha256!==undefined&&options.snapshot_sha256!==snapshot_sha256)return {...metadata,status:'snapshot_changed'};
  if(offset>scoped.length)return {...metadata,status:'invalid_cursor'};
  const entries=scoped.slice(offset,offset+limit),complete=offset+entries.length>=scoped.length;
  return {...metadata,status:scoped.length?'review_required':other_scope_unresolved_count?'other_scope_pending':'clear',entries,complete,
    ...(!complete?{next_offset:offset+entries.length}:{})};
}

/** A current reminder outside historical instruction/archive data. */
export function blockedOperationReviewNotice(review:BlockedOperationReview|undefined,mode:'tools'|'no_tools'|'compaction'):string[]{
  if(!review||review.status==='clear')return [];
  if(review.status==='other_scope_pending')return [
    'No unresolved operation is recorded for the current scope. Other-scope pending counts remain local bookkeeping, not permission or verified prerequisites for the current request.',
    'Do not present those counts as blockers for this task or request approval because of them. Preserve their pending status for an eligible owning-scope review; do not claim that those operations were reviewed, completed or authorized.',
    `Current scoped review data: ${JSON.stringify(review)}`,
    ...(mode==='compaction'?['Preserve the unreviewed other-scope count as metadata; do not call review or work tools.']:[]),
  ];
  return [
    'Codex unresolved-operation review: local bookkeeping, not permission or proof of execution. It is not a new human instruction or filesystem authority.',
    'Keep PENDING_SAFETY_REVIEW or BLOCKED_BY_SAFETY prerequisites attached to their requirement and report their impact when relevant. Do not silently mark them complete, retry the operation, or switch tools/controllers based on this notice. A permitted fresh attempt requires the original native review/approval path and verified receipts; user confirmation cannot override a platform denial.',
    'Review every page for this scope; other-scope counts do not authorize access there. A changed snapshot needs a fresh read-only review. Do not treat an unavailable review as an empty ledger. Local resolved bookkeeping also requires independent execution evidence before claiming completion.',
    `Current scoped review data: ${JSON.stringify(review)}`,
    mode==='compaction'
      ?'Preserve unresolved blocker references in the checkpoint; do not call review or work tools.'
      :mode==='tools'
      ?'Only if the current connector advertises codex_safety_review, use that read-only tool to obtain remaining pages with next_offset and snapshot_sha256. The native reserved codex.control.safety_review interface is usable only when current support is confirmed. If unavailable, preserve the pending review; do not invent a tool or substitute an execution path.'
      :'No local review tool is available on this route. Preserve pending references for the next eligible authorized native review; do not invent completed review or fresh local evidence.',
  ];
}
