import {expect,test} from 'bun:test';
import {diffVerifiedUiaTrees,diffVerifiedMixedTrees} from '../src/adapters/chatgpt-web/screen-tree-diff';
import {projectScreenTree,type ScreenTreeNodeInput} from '../src/adapters/chatgpt-web/screen-tree';

const box=(x:number)=>({x,y:0,width:10,height:10});
const ui=(id:string,x:number,name=id):ScreenTreeNodeInput=>({source:'uia',id,name,bounds:box(x)});
const tree=(frame_id:number,nodes:ScreenTreeNodeInput[])=>projectScreenTree({
  region:{x:0,y:0,width:100,height:100},frame_id,target_generation:7,nodes,
  sources:{uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified'}},
},'json');

test('diffs verified UIA provider identities with added, updated, and removed nodes',()=>{
  const previous=tree(3,[ui('a',0),ui('b',20),ui('gone',40)]);
  const current=tree(4,[ui('a',0),ui('b',30,'new label'),ui('added',50)]);
  const delta=diffVerifiedUiaTrees(previous,current);
  expect(delta).toBeDefined();
  expect(delta?.added.map(n=>n.provider_id)).toEqual(['added']);
  expect(delta?.updated.map(n=>n.provider_id)).toEqual(['b']);
  expect(delta?.removed).toEqual(['gone']);
  expect(delta?.added[0]).not.toHaveProperty('ephemeral_id');
  expect(delta?.added[0]).not.toHaveProperty('parent');
});

test('UIA focus, enabled and offscreen transitions remain visible in both snapshots and provider diffs',()=>{
  const previous=tree(3,[{...ui('control',0),is_focused:false,is_enabled:true,is_offscreen:false}]);
  const current=tree(4,[{...ui('control',0),is_focused:true,is_enabled:false,is_offscreen:true}]);
  expect(previous.nodes?.[0]).toMatchObject({is_focused:false,is_enabled:true,is_offscreen:false});
  expect(current.nodes?.[0]).toMatchObject({is_focused:true,is_enabled:false,is_offscreen:true});
  const delta=diffVerifiedUiaTrees(previous,current);
  expect(delta?.updated).toMatchObject([{provider_id:'control',is_focused:true,is_enabled:false,is_offscreen:true}]);
});

test('refuses non-authoritative, redacted, ambiguous and incomplete provider nodes',()=>{
  const base=tree(3,[ui('a',0)]);
  expect(diffVerifiedUiaTrees(base,tree(4,[{source:'ocr',name:'dialogue',bounds:box(0)}]))).toBeUndefined();
  expect(diffVerifiedUiaTrees(base,tree(4,[{...ui('a',0),redacted:true}]))).toBeUndefined();
  expect(diffVerifiedUiaTrees(base,tree(4,[ui('a',0),ui('a',20)]))).toBeUndefined();
  const partial=tree(4,[ui('a',0)]);partial.truncated=true;
  expect(diffVerifiedUiaTrees(base,partial)).toBeUndefined();
  const unknown=tree(4,[ui('a',0)]);unknown.sources!.uia!.partial=true;
  expect(diffVerifiedUiaTrees(base,unknown)).toBeUndefined();
});

test('never acknowledges synthesized UIA traversal-index IDs as stable across frames',()=>{
  // The native UIA reader emits fallback.<index> when GetRuntimeId fails.
  // Inserting a new sibling changes those indices without changing elements.
  const before=tree(10,[ui('fallback.0',0,'original')]);
  const after=tree(11,[ui('fallback.0',0,'different element')]);
  expect(diffVerifiedUiaTrees(before,after)).toBeUndefined();
  expect(diffVerifiedUiaTrees(tree(10,[ui('stable',0)]),after)).toBeUndefined();
  // Native runtime identifiers are truncated to 120 bytes, so a 120-byte
  // value may alias other providers after truncation.
  const clipped='1.'.repeat(60);
  expect(diffVerifiedUiaTrees(tree(10,[ui(clipped,0)]),tree(11,[ui(clipped,1)]))).toBeUndefined();
});

test('mixed-diff requires complete native source metadata and refuses unstable UIA ancestry',()=>{
 const make=(frame_id:number,id='uia-parent')=>projectScreenTree({
  region:{x:0,y:0,width:100,height:100},frame_id,target_generation:7,
  nodes:[ui(id,0),{source:'ocr',id:'ocr-'+frame_id,name:'Hello',bounds:box(30)},
   {source:'cv',id:'cv-'+frame_id,name:'',bounds:box(50)}],
  sources:{uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified'},
   cv:{status:'completed',source_count:1,truncated:false},
   ocr:{status:'completed',confidence_available:false,frame_id,target_generation:7}},
 },'json');
 const earlier=make(3),later=make(4);
 const diff=diffVerifiedMixedTrees(earlier,later);
 expect(diff?.transient_mode).toBe('replace_all_for_current_frame');
 expect(diff?.transient_nodes).toHaveLength(2);
 expect(diff?.transient_nodes.some(n=>n.provider_id!==undefined)).toBe(false);
 expect(diff?.source_counts.returned).toEqual({cv:1,ocr:1,uia:1});
 expect(diffVerifiedMixedTrees(earlier,make(4,'fallback.0'))).toBeUndefined();
 expect(diffVerifiedMixedTrees(earlier,make(4,'1.'.repeat(60)))).toBeUndefined();
 const cvTruncated=make(4);cvTruncated.sources!.cv!.truncated=true;
 expect(diffVerifiedMixedTrees(earlier,cvTruncated)).toBeUndefined();
 const cvIncomplete=make(4);cvIncomplete.sources!.cv!.source_count=8;
 expect(diffVerifiedMixedTrees(earlier,cvIncomplete)).toBeUndefined();
 const cvUnknown=make(4);cvUnknown.sources!.cv!.status='unknown';
 expect(diffVerifiedMixedTrees(earlier,cvUnknown)).toBeUndefined();
 const ocrStale=make(4);ocrStale.sources!.ocr!.frame_id=3;
 expect(diffVerifiedMixedTrees(earlier,ocrStale)).toBeUndefined();
 const treeTruncated=make(4);treeTruncated.truncated=true;
 expect(diffVerifiedMixedTrees(earlier,treeTruncated)).toBeUndefined();
 const uiaPartial=make(4);uiaPartial.sources!.uia!.partial=true;
 expect(diffVerifiedMixedTrees(earlier,uiaPartial)).toBeUndefined();
 expect(diffVerifiedMixedTrees(later,earlier)).toBeUndefined();
});

test('mixed-diff falls back to a complete snapshot when OCR becomes unavailable',()=>{
  const make=(frame_id:number,ocrStatus:'completed'|'empty'|'UNAVAILABLE',includeOcr:boolean)=>
    projectScreenTree({region:{x:0,y:0,width:100,height:100},frame_id,target_generation:7,
      nodes:[ui('stable',0),{source:'cv',id:`cv-${frame_id}`,name:'',bounds:box(40)},
        ...(includeOcr?[{source:'ocr' as const,name:'Ready',bounds:box(60)}]:[])],
      sources:{uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified'},
        cv:{status:'completed',source_count:1,truncated:false},
        ocr:{status:ocrStatus,confidence_available:false,
          ...(ocrStatus!=='UNAVAILABLE'?{frame_id,target_generation:7}:{reason:'provider_error'})}}},'json');
  const earlier=make(3,'completed',true);
  const unavailable=make(4,'UNAVAILABLE',false);
  expect(diffVerifiedMixedTrees(earlier,unavailable)).toBeUndefined();
  expect(diffVerifiedMixedTrees(unavailable,make(5,'completed',true))).toBeUndefined();
  // A completed OCR scan with no text is a valid, empty transient set.
  expect(diffVerifiedMixedTrees(earlier,make(4,'empty',false))?.transient_nodes).toHaveLength(1);
});
