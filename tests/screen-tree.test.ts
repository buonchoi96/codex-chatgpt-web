import {expect, test} from 'bun:test';
import {projectScreenTree, type ScreenTreeInput} from '../src/adapters/chatgpt-web/screen-tree';

const viewport={x:10,y:20,width:100,height:200};

test('projects mixed sources into one viewport-relative node set and matching compact output',()=>{
  const input:ScreenTreeInput={region:viewport,frame_id:4,target_generation:9,nodes:[
    {source:'cv',id:'cv-α',bounds:{x:15,y:40,width:30,height:60},name:'invented label',confidence:0.83},
    {source:'ocr',id:'ocr-1',bounds:{x:20,y:30,width:20,height:10},name:'Résumé "one"',confidence:0.92},
    {source:'uia',id:'uia-root',bounds:{x:11,y:21,width:50,height:80},name:'Main',role:'Window'},
    {source:'uia',id:'uia-child',parent_id:'uia-root',bounds:{x:12,y:22,width:20,height:12},name:'Save',role:'button',patterns:['Invoke'],
      is_enabled:true,is_offscreen:false,is_focused:true},
  ],sources:{
    cv:{status:'ready',source_count:1,truncated:false},
    uia:{status:'partial',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified'},
    ocr:{status:'completed',confidence_available:false,language:'en-US'},
  }};

  const result=projectScreenTree(input,'both');
  expect(result).toMatchObject({version:1,frame_id:4,target_generation:9,coordinate_space:'authorized_viewport',
    identity_scope:'ephemeral_per_projection',returned_count:4,truncated:false,absence_is_proven:false});
  expect(result.region).toEqual(viewport);
  expect(result.source_counts).toEqual({input:{cv:1,ocr:1,uia:2},returned:{cv:1,ocr:1,uia:2}});
  expect(result.nodes).toHaveLength(4);
  const nodes=result.nodes!;
  expect(new Set(nodes.map(node=>node.ephemeral_id)).size).toBe(4);
  expect(nodes[0]).toMatchObject({source:'cv',provider_id:'cv-α',name:'',normalized_bounds:{x:0.05,y:0.1,width:0.3,height:0.3}});
  expect(nodes[1]).toMatchObject({source:'ocr',name:'Résumé "one"',confidence:null,confidence_status:'unavailable'});
  expect(nodes[2].parent).toEqual({status:'none'});
  expect(nodes[3]).toMatchObject({source:'uia',provider_id:'uia-child',provider_parent_id:'uia-root',
    parent:{status:'linked',ephemeral_id:nodes[2].ephemeral_id},pixel_correspondence:'unverified',patterns:['Invoke'],
    is_enabled:true,is_offscreen:false,is_focused:true});
  expect(result.sources?.uia).toMatchObject({temporal_relation:'after_final_frame',pixel_correspondence:'unverified'});
  expect(result.compact).toContain('[cv]');
  expect(result.compact).toContain('[ocr]');
  expect(result.compact).toContain('[uia]');
  expect(result.compact).toContain('is_enabled=true is_offscreen=false is_focused=true');
  expect(result.compact).toContain('Résumé \\"one\\"');
  for(const node of nodes)expect(result.compact).toContain(node.ephemeral_id);
});

test('does not infer UIA parents from unknown, duplicate, or non-UIA provider IDs',()=>{
  const result=projectScreenTree({region:viewport,frame_id:1,target_generation:1,nodes:[
    {source:'cv',id:'visual-parent',bounds:{x:10,y:20,width:10,height:10}},
    {source:'uia',id:'duplicate',bounds:{x:10,y:20,width:10,height:10}},
    {source:'uia',id:'duplicate',bounds:{x:20,y:30,width:10,height:10}},
    {source:'uia',id:'ambiguous-child',parent_id:'duplicate',bounds:{x:30,y:40,width:10,height:10}},
    {source:'uia',id:'unknown-child',parent_id:'missing',bounds:{x:40,y:50,width:10,height:10}},
    {source:'uia',id:'cross-source-child',parent_id:'visual-parent',bounds:{x:50,y:60,width:10,height:10}},
  ]},'json');

  expect(result.nodes?.[3].parent).toEqual({status:'unresolved',reason:'ambiguous_provider_parent'});
  expect(result.nodes?.[4].parent).toEqual({status:'unresolved',reason:'unknown_provider_parent'});
  expect(result.nodes?.[5].parent).toEqual({status:'unresolved',reason:'unknown_provider_parent'});
  expect(result.nodes?.slice(3).every(node=>node.depth===0)).toBe(true);
});

test('rejects forged non-UIA focus flags and malformed UIA state fields',()=>{
  const input=(node:any):ScreenTreeInput=>({region:viewport,frame_id:1,target_generation:1,nodes:[node]});
  const bounds={x:10,y:20,width:10,height:10};
  expect(()=>projectScreenTree(input({source:'ocr',name:'text',bounds,is_focused:true}),'json')).toThrow('SCREEN_TREE_INPUT_INVALID');
  expect(()=>projectScreenTree(input({source:'uia',id:'control',bounds,is_enabled:'yes'}),'json')).toThrow('SCREEN_TREE_INPUT_INVALID');
});

test('fails boundedly when unambiguous UIA parent links form a cycle',()=>{
  const input:ScreenTreeInput={region:viewport,frame_id:1,target_generation:1,nodes:[
    {source:'uia',id:'one',parent_id:'two',bounds:{x:10,y:20,width:10,height:10}},
    {source:'uia',id:'two',parent_id:'one',bounds:{x:20,y:30,width:10,height:10}},
  ]};
  expect(()=>projectScreenTree(input,'both')).toThrow('SCREEN_TREE_CYCLE');
});

test('redacts UIA labels and identity fields and escapes controls in compact labels',()=>{
  const result=projectScreenTree({region:viewport,frame_id:1,target_generation:1,nodes:[
    {source:'uia',id:'private-provider-id',parent_id:'private-parent-id',bounds:{x:10,y:20,width:10,height:10},
      name:'Private label',role:'button',redacted:true,patterns:['Invoke']},
    {source:'uia',id:'control-node',bounds:{x:20,y:30,width:10,height:10},name:'A\nB\u001b[31m\u202e'},
    {source:'cv',bounds:{x:30,y:40,width:10,height:10},name:'must stay empty'},
    {source:'ocr',bounds:{x:40,y:50,width:10,height:10},name:'Text',confidence:0.99},
  ]},'both');

  const [redacted,controlled,cv,ocr]=result.nodes!;
  expect(redacted).toMatchObject({name:'[REDACTED]',redacted:true,patterns:['Invoke']});
  expect(redacted).not.toHaveProperty('provider_id');
  expect(redacted).not.toHaveProperty('provider_parent_id');
  expect(JSON.stringify(result)).not.toContain('Private label');
  expect(JSON.stringify(result)).not.toContain('private-provider-id');
  expect(JSON.stringify(result)).not.toContain('private-parent-id');
  const controlLine=result.compact!.split('\n').find(line=>line.includes(controlled.ephemeral_id))!;
  expect(controlLine).toContain('"A\\nB\\u001b[31m\\u202e"');
  expect(controlLine).not.toContain('\u001b');
  expect(cv.name).toBe('');
  expect(ocr.confidence).toBeNull();
  expect(ocr.confidence_status).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('permission');
});

test('depth truncation reports omitted source nodes while compact and JSON retain the same selection',()=>{
  const result=projectScreenTree({region:viewport,frame_id:2,target_generation:3,nodes:[
    {source:'uia',id:'root',bounds:{x:10,y:20,width:40,height:40}},
    {source:'uia',id:'child',parent_id:'root',bounds:{x:11,y:21,width:20,height:20}},
    {source:'uia',id:'grandchild',parent_id:'child',bounds:{x:12,y:22,width:10,height:10}},
  ]},'both',{maxDepth:1});

  expect(result.truncated).toBe(true);
  expect(result.truncation_reasons).toContain('depth_limit');
  expect(result.source_counts).toEqual({input:{cv:0,ocr:0,uia:3},returned:{cv:0,ocr:0,uia:2}});
  expect(result.nodes).toHaveLength(2);
  const compactIds=result.compact!.split('\n').flatMap(line=>line.match(/^  - (n\d+) /)?.slice(1)??[]);
  expect(compactIds).toEqual(result.nodes!.map(node=>node.ephemeral_id));
  expect(result.absence_is_proven).toBe(false);
});

test('byte budget truncation covers the whole projection and keeps compact and JSON node sets aligned',()=>{
  const result=projectScreenTree({region:viewport,frame_id:2,target_generation:3,nodes:Array.from({length:8},(_,index)=>({
    source:'ocr' as const,id:`ocr-${index}`,bounds:{x:10+index,y:20,width:10,height:10},name:'界'.repeat(100),
  }))},'both',{maxBytes:1200});

  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(1200);
  expect(result.truncated).toBe(true);
  expect(result.truncation_reasons).toContain('byte_limit');
  expect(result.returned_count).toBeLessThan(8);
  expect(result.source_counts.input.ocr).toBe(8);
  const compactIds=result.compact!.split('\n').flatMap(line=>line.match(/^  - (n\d+) /)?.slice(1)??[]);
  expect(compactIds).toEqual(result.nodes!.map(node=>node.ephemeral_id));
});

test('caps source nodes at 200 and validates projector budget options',()=>{
  const input:ScreenTreeInput={region:viewport,frame_id:2,target_generation:3,nodes:Array.from({length:205},(_,index)=>({
    source:'cv' as const,id:`cv-${index}`,bounds:{x:10,y:20,width:1,height:1},
  }))};
  const result=projectScreenTree(input,'compact',{maxBytes:32768});
  expect(result.returned_count).toBe(200);
  expect(result.source_counts.input.cv).toBe(205);
  expect(result.truncation_reasons).toContain('node_limit');
  expect(result.truncation_reasons).not.toContain('byte_limit');
  expect(()=>projectScreenTree(input,'json',{maxBytes:32769})).toThrow('SCREEN_TREE_OPTIONS_INVALID');
  expect(()=>projectScreenTree(input,'json',{maxDepth:9})).toThrow('SCREEN_TREE_OPTIONS_INVALID');
});

test('does not mutate input and emits deterministic unique ephemeral IDs per projection',()=>{
  const input:ScreenTreeInput={region:viewport,frame_id:7,target_generation:8,nodes:[
    {source:'uia',id:'root',bounds:{x:10,y:20,width:50,height:50},name:'Root'},
    {source:'uia',id:'child',parent_id:'root',bounds:{x:12,y:22,width:10,height:10},name:'Child'},
  ]};
  const before=structuredClone(input);
  const first=projectScreenTree(input,'both');
  const second=projectScreenTree(input,'both');
  expect(input).toEqual(before);
  expect(first).toEqual(second);
  expect(new Set(first.nodes!.map(node=>node.ephemeral_id)).size).toBe(first.returned_count);
  expect(first.identity_scope).toBe('ephemeral_per_projection');
});

test('does not expose a redacted UIA parent ID through an unredacted child',()=>{
  const secretId='redacted-parent-provider-id';
  const result=projectScreenTree({region:viewport,frame_id:10,target_generation:11,nodes:[
    {source:'uia',id:secretId,bounds:{x:10,y:20,width:40,height:40},name:'Restricted parent label',redacted:true},
    {source:'uia',id:'visible-child',parent_id:secretId,bounds:{x:11,y:21,width:10,height:10},name:'Child'},
  ]},'both');

  expect(result.nodes?.[1].parent).toEqual({status:'linked',ephemeral_id:result.nodes![0]!.ephemeral_id});
  expect(result.nodes?.[1]).not.toHaveProperty('provider_parent_id');
  expect(JSON.stringify(result)).not.toContain(secretId);
  expect(JSON.stringify(result)).not.toContain('Restricted parent label');
});

test('suppresses duplicate raw IDs when one matching UIA candidate is redacted',()=>{
  const secretId='ambiguous-redacted-provider-id';
  const result=projectScreenTree({region:viewport,frame_id:10,target_generation:11,nodes:[
    {source:'uia',id:secretId,bounds:{x:10,y:20,width:10,height:10},name:'Hidden duplicate',redacted:true},
    {source:'uia',id:secretId,bounds:{x:20,y:30,width:10,height:10},name:'Visible duplicate'},
    {source:'uia',id:'ambiguous-child',parent_id:secretId,bounds:{x:30,y:40,width:10,height:10},name:'Child'},
  ]},'both');

  expect(result.nodes?.[1]).not.toHaveProperty('provider_id');
  expect(result.nodes?.[2]).not.toHaveProperty('provider_parent_id');
  expect(result.nodes?.[2].parent).toEqual({status:'unresolved',reason:'ambiguous_provider_parent'});
  expect(JSON.stringify(result)).not.toContain(secretId);
  expect(JSON.stringify(result)).not.toContain('Hidden duplicate');
});

test('keeps a redacted parent ID private when byte truncation omits that parent',()=>{
  const secretId='omitted-redacted-parent-provider-id';
  const result=projectScreenTree({region:viewport,frame_id:10,target_generation:11,nodes:[
    {source:'uia',id:'early-child',parent_id:secretId,bounds:{x:10,y:20,width:10,height:10},name:'Child'},
    {source:'ocr',id:'large-middle-node',bounds:{x:20,y:30,width:10,height:10},name:'M'.repeat(512)},
    {source:'uia',id:secretId,bounds:{x:30,y:40,width:10,height:10},name:'Hidden parent',redacted:true},
  ]},'both',{maxBytes:1500});

  expect(result.truncation_reasons).toContain('byte_limit');
  expect(result.nodes).toHaveLength(1);
  expect(result.nodes?.[0].parent).toEqual({status:'unresolved',reason:'provider_parent_not_returned'});
  expect(result.nodes?.[0]).not.toHaveProperty('provider_parent_id');
  expect(JSON.stringify(result)).not.toContain(secretId);
  expect(JSON.stringify(result)).not.toContain('Hidden parent');
});
