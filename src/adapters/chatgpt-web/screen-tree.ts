export type ScreenTreeSource='cv'|'ocr'|'uia';

export interface ScreenTreeBounds {x:number;y:number;width:number;height:number}
export interface ScreenTreeRegion extends ScreenTreeBounds {}

export interface ScreenTreeNodeInput {
  source:ScreenTreeSource;
  bounds:ScreenTreeBounds;
  id?:string;
  parent_id?:string|null;
  name?:string;
  role?:string;
  redacted?:boolean;
  patterns?:readonly string[];
  confidence?:number|null;
  is_enabled?:boolean;
  is_offscreen?:boolean;
  is_focused?:boolean;
}

export interface ScreenTreeInput {
  region:ScreenTreeRegion;
  frame_id:number;
  target_generation:number;
  nodes:readonly ScreenTreeNodeInput[];
  sources?:{
    cv?:{status:string;source_count:number;truncated:boolean};
    uia?:{status:string;partial:boolean;temporal_relation:'after_final_frame';pixel_correspondence:'unverified';sample_start_ms?:number;sample_end_ms?:number};
    ocr?:{status:'UNAVAILABLE'|'empty'|'completed';reason?:string;confidence_available:false;language?:string;truncated?:boolean;frame_id?:number;target_generation?:number};
  };
}

export type ScreenTreeFormat='compact'|'json'|'both';
export interface ScreenTreeOptions {maxBytes?:number;maxDepth?:number}

export interface ProjectedScreenTreeNode {
  ephemeral_id:string;
  source:ScreenTreeSource;
  depth:number;
  bounds:ScreenTreeBounds;
  normalized_bounds:ScreenTreeBounds;
  parent:{status:'none'}|{status:'linked';ephemeral_id:string}|{status:'unresolved';reason:'unknown_provider_parent'|'ambiguous_provider_parent'|'provider_parent_not_returned'};
  provider_id?:string;
  provider_parent_id?:string;
  name:string;
  role?:string;
  redacted?:true;
  patterns?:string[];
  confidence?:number|null;
  confidence_status?:'unavailable';
  pixel_correspondence?:'unverified';
  is_enabled?:boolean;
  is_offscreen?:boolean;
  is_focused?:boolean;
}

export interface ProjectedScreenTree {
  version:1;
  format:ScreenTreeFormat;
  frame_id:number;
  target_generation:number;
  coordinate_space:'authorized_viewport';
  identity_scope:'ephemeral_per_projection';
  region:ScreenTreeRegion;
  sources?:ScreenTreeInput['sources'];
  source_counts:{input:Record<ScreenTreeSource,number>;returned:Record<ScreenTreeSource,number>};
  returned_count:number;
  truncated:boolean;
  truncation_reasons:Array<'node_limit'|'depth_limit'|'byte_limit'>;
  absence_is_proven:false;
  nodes?:ProjectedScreenTreeNode[];
  compact?:string;
}

interface PreparedNode {index:number;node:ScreenTreeNodeInput;depth:number;parentIndex?:number;parentProblem?:'unknown_provider_parent'|'ambiguous_provider_parent'}
const SOURCES:readonly ScreenTreeSource[]=['cv','ocr','uia'];
const UIA_STATE_FIELDS=['is_enabled','is_offscreen','is_focused'] as const;
const MAX_NODES=200,DEFAULT_MAX_BYTES=16*1024,MAX_BYTES=32*1024,MAX_DEPTH=8,MIN_BYTES=256;

function invalidInput():never {throw new Error('SCREEN_TREE_INPUT_INVALID')}
function invalidOptions():never {throw new Error('SCREEN_TREE_OPTIONS_INVALID')}
function isRecord(value:unknown):value is Record<string,unknown> {return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function finite(value:unknown):value is number {return typeof value==='number'&&Number.isFinite(value)}
function sourceOf(value:unknown):value is ScreenTreeSource {return value==='cv'||value==='ocr'||value==='uia'}

function validateInput(input:ScreenTreeInput):void {
  if(!isRecord(input)||!isRecord(input.region)||!Array.isArray(input.nodes)||
    !Number.isSafeInteger(input.frame_id)||input.frame_id<1||!Number.isSafeInteger(input.target_generation)||input.target_generation<1)invalidInput();
  const region=input.region;
  if(!Number.isSafeInteger(region.x)||!Number.isSafeInteger(region.y)||!Number.isSafeInteger(region.width)||!Number.isSafeInteger(region.height)||
    region.x<0||region.y<0||region.width<1||region.height<1||!Number.isSafeInteger(region.x+region.width)||!Number.isSafeInteger(region.y+region.height))invalidInput();
  for(const node of input.nodes) {
    if(!isRecord(node)||!sourceOf(node.source)||!isRecord(node.bounds))invalidInput();
    const box=node.bounds;
    if(!finite(box.x)||!finite(box.y)||!finite(box.width)||!finite(box.height)||box.x<region.x||box.y<region.y||box.width<=0||box.height<=0||
      box.x+box.width>region.x+region.width||box.y+box.height>region.y+region.height)invalidInput();
    if(node.id!==undefined&&(typeof node.id!=='string'||node.id.length>256))invalidInput();
    if(node.parent_id!==undefined&&node.parent_id!==null&&(typeof node.parent_id!=='string'||node.parent_id.length>256))invalidInput();
    if(node.name!==undefined&&(typeof node.name!=='string'||node.name.length>512))invalidInput();
    if(node.role!==undefined&&(typeof node.role!=='string'||node.role.length>128))invalidInput();
    if(node.redacted!==undefined&&typeof node.redacted!=='boolean')invalidInput();
    if(node.patterns!==undefined&&(!Array.isArray(node.patterns)||node.patterns.length>7||node.patterns.some(pattern=>typeof pattern!=='string'||pattern.length>64)))invalidInput();
    if(node.confidence!==undefined&&node.confidence!==null&&(!finite(node.confidence)||node.confidence<0||node.confidence>1))invalidInput();
    for(const key of UIA_STATE_FIELDS){const value=node[key];
      if(value!==undefined&&(node.source!=='uia'||typeof value!=='boolean'))invalidInput();}
  }
}

function validateOptions(format:ScreenTreeFormat,options?:ScreenTreeOptions):{maxBytes:number;maxDepth:number} {
  if(format!=='compact'&&format!=='json'&&format!=='both')invalidOptions();
  const rawOptions:unknown=options;
  if(rawOptions!==undefined&&!isRecord(rawOptions))invalidOptions();
  const record=rawOptions as Record<string,unknown>|undefined;
  const maxBytes=record?.maxBytes??DEFAULT_MAX_BYTES,maxDepth=record?.maxDepth??MAX_DEPTH;
  if(typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<MIN_BYTES||maxBytes>MAX_BYTES||
    typeof maxDepth!=='number'||!Number.isSafeInteger(maxDepth)||maxDepth<0||maxDepth>MAX_DEPTH)invalidOptions();
  return {maxBytes,maxDepth};
}

function countSources(nodes:readonly ScreenTreeNodeInput[]):Record<ScreenTreeSource,number> {
  const counts:Record<ScreenTreeSource,number>={cv:0,ocr:0,uia:0};
  for(const node of nodes)if(sourceOf((node as ScreenTreeNodeInput).source))counts[node.source]++;
  return counts;
}

function validateParentGraph(nodes:readonly ScreenTreeNodeInput[]):Map<number,PreparedNode> {
  const uiById=new Map<string,number[]>();
  for(let index=0;index<nodes.length;index++) {
    const node=nodes[index]!;
    if(node.source==='uia'&&typeof node.id==='string') {
      const matches=uiById.get(node.id)??[];matches.push(index);uiById.set(node.id,matches);
    }
  }
  const prepared=new Map<number,PreparedNode>();
  for(let index=0;index<nodes.length;index++) {
    const node=nodes[index]!;const item:PreparedNode={index,node,depth:0};
    if(node.source==='uia'&&typeof node.parent_id==='string') {
      const matches=uiById.get(node.parent_id)??[];
      if(matches.length===1)item.parentIndex=matches[0];
      else item.parentProblem=matches.length===0?'unknown_provider_parent':'ambiguous_provider_parent';
    }
    prepared.set(index,item);
  }

  // Each UIA node has at most one resolved parent, so an iterative walk is
  // sufficient and stays bounded by the 200-node projection ceiling.
  const complete=new Set<number>();
  for(const start of prepared.keys()) {
    if(complete.has(start))continue;
    const path:number[]=[],active=new Set<number>();let current:number|undefined=start;
    while(current!==undefined&&!complete.has(current)) {
      if(active.has(current))throw new Error('SCREEN_TREE_CYCLE');
      active.add(current);path.push(current);current=prepared.get(current)?.parentIndex;
    }
    for(let i=path.length-1;i>=0;i--) {
      const index=path[i]!,item=prepared.get(index)!;
      item.depth=item.parentIndex===undefined?0:(prepared.get(item.parentIndex)?.depth??0)+1;
      complete.add(index);
    }
  }
  return prepared;
}

function summarizeSources(sources:ScreenTreeInput['sources']):ScreenTreeInput['sources'] {
  if(!sources)return undefined;
  const result:NonNullable<ScreenTreeInput['sources']>={};
  const short=(value:string)=>value.slice(0,64);
  if(sources.cv)result.cv={status:short(sources.cv.status),source_count:sources.cv.source_count,truncated:sources.cv.truncated};
  if(sources.uia)result.uia={status:short(sources.uia.status),partial:sources.uia.partial,
    temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
    ...(sources.uia.sample_start_ms!==undefined?{sample_start_ms:sources.uia.sample_start_ms}:{}),
    ...(sources.uia.sample_end_ms!==undefined?{sample_end_ms:sources.uia.sample_end_ms}:{})};
  if(sources.ocr)result.ocr={status:sources.ocr.status,confidence_available:false,
    ...(sources.ocr.reason!==undefined?{reason:short(sources.ocr.reason)}:{}),
    ...(sources.ocr.language!==undefined?{language:short(sources.ocr.language)}:{}),
    ...(sources.ocr.truncated!==undefined?{truncated:sources.ocr.truncated}:{}),
    ...(sources.ocr.frame_id!==undefined?{frame_id:sources.ocr.frame_id}:{}),
    ...(sources.ocr.target_generation!==undefined?{target_generation:sources.ocr.target_generation}:{})};
  return result;
}

function quote(value:string):string {
  let result='"';
  for(const char of value) {
    const code=char.codePointAt(0)!;
    if(char==='"')result+='\\"';
    else if(char==='\\')result+='\\\\';
    else if(char==='\n')result+='\\n';
    else if(char==='\r')result+='\\r';
    else if(char==='\t')result+='\\t';
    else if(char==='\b')result+='\\b';
    else if(char==='\f')result+='\\f';
    else if(code<0x20||(code>=0x7f&&code<=0x9f)||(code>=0x202a&&code<=0x202e)||(code>=0x2066&&code<=0x2069)||code===0x2028||code===0x2029) {
      if(code<=0xffff)result+=`\\u${code.toString(16).padStart(4,'0')}`;
      else {const adjusted=code-0x10000;result+=`\\u${(0xd800+(adjusted>>10)).toString(16)}\\u${(0xdc00+(adjusted&0x3ff)).toString(16)}`;}
    } else result+=char;
  }
  return result+'"';
}

function compactText(projection:Omit<ProjectedScreenTree,'compact'>,nodes:ProjectedScreenTreeNode[]):string {
  const counts=(value:Record<ScreenTreeSource,number>)=>SOURCES.map(source=>`${source}:${value[source]}`).join(' ');
  const tuple=(value:ScreenTreeBounds)=>`[${value.x},${value.y},${value.width},${value.height}]`;
  const lines=[`screen-tree v${projection.version} frame=${projection.frame_id} generation=${projection.target_generation} coordinate_space=${projection.coordinate_space} identity_scope=${projection.identity_scope} bounds_order=x,y,width,height`,
    `viewport=${JSON.stringify(projection.region)}`,
    `counts input=${counts(projection.source_counts.input)} returned=${counts(projection.source_counts.returned)} truncated=${projection.truncated} absence_is_proven=false reasons=${projection.truncation_reasons.join(',')||'none'}`];
  if(projection.sources)for(const source of SOURCES) {
    const receipt=projection.sources[source];
    if(receipt)lines.push(`availability ${source}=${quote(receipt.status)}`);
  }
  for(const source of SOURCES) {
    lines.push(`[${source}]`);
    for(const node of nodes.filter(item=>item.source===source)) {
      const parts=[`  - ${node.ephemeral_id}`,`depth=${node.depth}`,`bounds=${tuple(node.bounds)}`,
        `normalized=${tuple(node.normalized_bounds)}`];
      if(node.provider_id!==undefined)parts.push(`provider_id=${quote(node.provider_id)}`);
      if(node.provider_parent_id!==undefined)parts.push(`provider_parent_id=${quote(node.provider_parent_id)}`);
      if(node.parent.status==='linked')parts.push(`parent=${quote(node.parent.ephemeral_id)}`);
      else if(node.parent.status==='unresolved')parts.push(`parent=${quote(`unresolved:${node.parent.reason}`)}`);
      parts.push(`name=${quote(node.name)}`);
      if(node.role!==undefined)parts.push(`role=${quote(node.role)}`);
      if(node.confidence_status)parts.push(`confidence=${quote(node.confidence_status)}`);
      else if(node.confidence!==undefined)parts.push(`confidence=${node.confidence===null?'null':node.confidence}`);
      if(node.pixel_correspondence)parts.push(`pixel_correspondence=${quote(node.pixel_correspondence)}`);
      if(node.source==='uia')for(const key of UIA_STATE_FIELDS)
        if(node[key]!==undefined)parts.push(`${key}=${node[key]}`);
      if(node.patterns)parts.push(`patterns=[${node.patterns.map(quote).join(',')}]`);
      if(node.redacted)parts.push('redacted=true');
      lines.push(parts.join(' '));
    }
  }
  return lines.join('\n');
}

function makeNode(item:PreparedNode,ephemeralId:string,parentEphemeralId:string|undefined,parentReturned:boolean,
  region:ScreenTreeRegion,redactedProviderIds:ReadonlySet<string>):ProjectedScreenTreeNode {
  const {node}=item,redacted=node.source==='uia'&&node.redacted===true;
  const parent:ProjectedScreenTreeNode['parent']=node.source!=='uia'||node.parent_id===undefined||node.parent_id===null?{status:'none'}:
    item.parentProblem?{status:'unresolved',reason:item.parentProblem}:
      item.parentIndex===undefined?{status:'unresolved',reason:'unknown_provider_parent'}:
        parentReturned&&parentEphemeralId?{status:'linked',ephemeral_id:parentEphemeralId}:
          {status:'unresolved',reason:'provider_parent_not_returned'};
  const result:ProjectedScreenTreeNode={ephemeral_id:ephemeralId,source:node.source,depth:item.depth,
    bounds:{x:node.bounds.x,y:node.bounds.y,width:node.bounds.width,height:node.bounds.height},
    normalized_bounds:{x:(node.bounds.x-region.x)/region.width,y:(node.bounds.y-region.y)/region.height,
      width:node.bounds.width/region.width,height:node.bounds.height/region.height},parent,
    name:node.source==='cv'?'':redacted?'[REDACTED]':node.name??''};
  if(!redacted&&node.id!==undefined&&!redactedProviderIds.has(node.id))result.provider_id=node.id;
  if(!redacted&&node.source==='uia'&&typeof node.parent_id==='string'&&!redactedProviderIds.has(node.parent_id))result.provider_parent_id=node.parent_id;
  if(node.role!==undefined)result.role=node.role;
  if(redacted)result.redacted=true;
  if(node.patterns!==undefined)result.patterns=[...node.patterns];
  if(node.source==='ocr'){result.confidence=null;result.confidence_status='unavailable';}
  else if(node.confidence!==undefined)result.confidence=node.confidence;
  if(node.source==='uia'){
    result.pixel_correspondence='unverified';
    if(node.is_enabled!==undefined)result.is_enabled=node.is_enabled;
    if(node.is_offscreen!==undefined)result.is_offscreen=node.is_offscreen;
    if(node.is_focused!==undefined)result.is_focused=node.is_focused;
  }
  return result;
}

export function projectScreenTree(input:ScreenTreeInput,format:ScreenTreeFormat,options?:ScreenTreeOptions):ProjectedScreenTree {
  validateInput(input);
  const {maxBytes,maxDepth}=validateOptions(format,options);
  const redactedProviderIds=new Set(input.nodes.flatMap(node=>node.source==='uia'&&node.redacted===true&&typeof node.id==='string'?[node.id]:[]));
  const sourceCounts=countSources(input.nodes),considered=input.nodes.slice(0,MAX_NODES);
  const prepared=validateParentGraph(considered);
  const all=Array.from(prepared.values());
  const eligible=all.filter(item=>item.depth<=maxDepth);
  const reasons:Array<'node_limit'|'depth_limit'|'byte_limit'>=[];
  if(input.nodes.length>MAX_NODES)reasons.push('node_limit');
  if(eligible.length<considered.length)reasons.push('depth_limit');
  let retained=eligible.length;

  for(;;) {
    const selected=eligible.slice(0,retained),selectedIndices=new Set(selected.map(item=>item.index));
    const ids=new Map<number,string>();selected.forEach((item,index)=>ids.set(item.index,`n${index+1}`));
    const projectedNodes=selected.map(item=>makeNode(item,ids.get(item.index)!,
      item.parentIndex===undefined?undefined:ids.get(item.parentIndex),item.parentIndex!==undefined&&selectedIndices.has(item.parentIndex),input.region,redactedProviderIds));
    const returnedCounts=countSources(selected.map(item=>item.node));
    const truncated=reasons.length>0;
    const base:Omit<ProjectedScreenTree,'compact'>={version:1,format,frame_id:input.frame_id,target_generation:input.target_generation,
      coordinate_space:'authorized_viewport',identity_scope:'ephemeral_per_projection',
      region:{x:input.region.x,y:input.region.y,width:input.region.width,height:input.region.height},
      ...(input.sources?{sources:summarizeSources(input.sources)}:{}),
      source_counts:{input:sourceCounts,returned:returnedCounts},returned_count:selected.length,truncated,
      truncation_reasons:[...reasons],absence_is_proven:false,
      ...(format!=='compact'?{nodes:projectedNodes}:{})};
    const compact=format!=='json'?compactText(base,projectedNodes):undefined;
    const result:ProjectedScreenTree={...base,...(compact!==undefined?{compact}:{})};
    if(new TextEncoder().encode(JSON.stringify(result)).length<=maxBytes)return result;
    if(retained===0)throw new Error('SCREEN_TREE_BUDGET_TOO_SMALL');
    retained--;
    if(!reasons.includes('byte_limit'))reasons.push('byte_limit');
  }
}
