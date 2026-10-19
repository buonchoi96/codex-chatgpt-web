import type {ProjectedScreenTree,ProjectedScreenTreeNode} from './screen-tree';

export interface VerifiedUiaTreeDiff {
  identity:'uia_provider_within_authorized_lease';
  // Delta nodes are keyed by the provider identity. Ephemeral IDs and their
  // per-projection parent links cannot safely be reused across frames.
  added:VerifiedUiaDiffNode[];
  updated:VerifiedUiaDiffNode[];
  removed:string[];
}
export type VerifiedUiaDiffNode=Omit<ProjectedScreenTreeNode,'ephemeral_id'|'parent'>;
export interface VerifiedMixedTreeDiff extends VerifiedUiaTreeDiff {
  // UIA provider IDs are stable only within the same native reader grant.
  // OCR/CV IDs are frame-local: replace their *entire* previous set, never
  // merge on ephemeral_id, image geometry, text or array order.
  transient_mode:'replace_all_for_current_frame';
  transient_nodes:ProjectedScreenTreeNode[];
  source_counts:ProjectedScreenTree['source_counts'];
  sources:NonNullable<ProjectedScreenTree['sources']>;
}

// A projected CV/OCR ID is ephemeral. A native UIA provider ID is useful only
// within the same lease/target/epoch, which the owning registry must verify.
// Fail closed whenever the provider tree or its selection is incomplete.
function verifiedNativeRuntimeId(id:string):boolean {
  // Swift's UIA helper uses fallback.<traversal-index> when GetRuntimeId
  // fails. That position can refer to a different element in the next frame.
  // It also clips native runtime IDs to 120 bytes, which can alias providers.
  return !/^fallback\.\d+$/.test(id) && Buffer.byteLength(id,'utf8')<120;
}
function stableNodes(tree:ProjectedScreenTree,allowTransient=false):Map<string,ProjectedScreenTreeNode>|undefined {
  const source=tree.sources?.uia;
  if(tree.format!=='json'||!tree.nodes||tree.truncated||source?.status!=='ok'||source.partial||
     tree.nodes.length!==tree.returned_count)return undefined;
  if(allowTransient) {
    const counts=tree.source_counts;
    if(!tree.sources?.cv||!tree.sources?.ocr||tree.sources.cv.truncated||tree.sources.ocr.truncated||
       !['completed','empty'].includes(tree.sources.cv.status)||
       !['completed','empty'].includes(tree.sources.ocr.status)||
       tree.sources.cv.source_count!==counts.input.cv||
       counts.input.cv!==counts.returned.cv||counts.input.ocr!==counts.returned.ocr||
       counts.input.uia!==counts.returned.uia||
       Object.values(counts.returned).reduce((sum,n)=>sum+n,0)!==tree.nodes.length)return undefined;
    if(tree.sources.ocr.frame_id!==undefined&&tree.sources.ocr.frame_id!==tree.frame_id)return undefined;
    if(tree.sources.ocr.target_generation!==undefined&&tree.sources.ocr.target_generation!==tree.target_generation)return undefined;
  } else if(tree.source_counts.input.cv!==0||tree.source_counts.input.ocr!==0||
            tree.source_counts.input.uia!==tree.returned_count)return undefined;
  const byId=new Map<string,ProjectedScreenTreeNode>();
  for(const node of tree.nodes) {
    if(allowTransient&&node.source!=='uia')continue;
    if(node.source!=='uia'||!node.provider_id||!verifiedNativeRuntimeId(node.provider_id)||
       (node.provider_parent_id!==undefined&&!verifiedNativeRuntimeId(node.provider_parent_id))||
       node.redacted||node.parent.status==='unresolved'||
       (node.parent.status==='linked'&&!node.provider_parent_id)||
       byId.has(node.provider_id))return undefined;
    byId.set(node.provider_id,node);
  }
  return byId;
}

function comparisonKey(node:ProjectedScreenTreeNode):string {
  // Ignore per-projection n1/n2 identities. Compare the verified provider
  // relationship, labels, patterns and geometry instead of array positions.
  return JSON.stringify([node.provider_parent_id??null,node.parent.status,node.depth,node.name,
    node.role??null,node.bounds,node.normalized_bounds,node.patterns??[],node.confidence??null,
    node.is_enabled??null,node.is_offscreen??null,node.is_focused??null]);
}
function stableNode(node:ProjectedScreenTreeNode):VerifiedUiaDiffNode {
  const {ephemeral_id:_ephemeral,parent:_parent,...stable}=node;
  return stable;
}

function sameFrameScope(previous:ProjectedScreenTree,current:ProjectedScreenTree):boolean {
  return current.frame_id>previous.frame_id&&current.target_generation===previous.target_generation&&
    JSON.stringify(current.region)===JSON.stringify(previous.region);
}
function deltaFromNodes(before:Map<string,ProjectedScreenTreeNode>,after:Map<string,ProjectedScreenTreeNode>):VerifiedUiaTreeDiff {
  const added:VerifiedUiaDiffNode[]=[],updated:VerifiedUiaDiffNode[]=[],removed:string[]=[];
  for(const [id,node] of after) {
    const old=before.get(id);
    if(!old)added.push(stableNode(node));
    else if(comparisonKey(old)!==comparisonKey(node))updated.push(stableNode(node));
  }
  for(const id of before.keys())if(!after.has(id))removed.push(id);
  return {identity:'uia_provider_within_authorized_lease',added,updated,removed};
}

export function diffVerifiedUiaTrees(previous:ProjectedScreenTree,current:ProjectedScreenTree):VerifiedUiaTreeDiff|undefined {
  if(!sameFrameScope(previous,current))return undefined;
  const before=stableNodes(previous),after=stableNodes(current);
  if(!before||!after)return undefined;
  return deltaFromNodes(before,after);
}

/** Explicit opt-in to safe hybrid patch semantics. UIA diffs must have
 * complete provider IDs; OCR/CV are sent afresh for *every* accepted frame.
 * The receiver must discard the entire previous transient set before applying
 * transient_nodes. Partial/ambiguous/truncated frames always require full.
 */
export function diffVerifiedMixedTrees(previous:ProjectedScreenTree,current:ProjectedScreenTree):VerifiedMixedTreeDiff|undefined {
  if(!sameFrameScope(previous,current))return undefined;
  const before=stableNodes(previous,true),after=stableNodes(current,true);
  if(!before||!after||!current.nodes||!current.sources)return undefined;
  return {...deltaFromNodes(before,after),transient_mode:'replace_all_for_current_frame',
    transient_nodes:current.nodes.filter(node=>node.source!=='uia').map(node=>{
      // Historic full-tree format may surface native-provided per-frame OCR/CV
      // IDs as provider_id. Those are not stable provider identities: never
      // include them in the incremental patch contract.
      const {provider_id:_id,provider_parent_id:_parent,...transient}=node;
      return transient;
    }),
    source_counts:current.source_counts,sources:current.sources};
}
