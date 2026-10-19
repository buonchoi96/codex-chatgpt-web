import {createHash} from 'node:crypto';
import {zipSync,unzipSync,strToU8,strFromU8,type Zippable} from 'fflate';
import {BoundedCache} from '../../lib/bounded-cache';
import type {ChatGptWebPromptImage} from './prompt';
import type {ChatGptSkillFile} from './skill-attachments';

const MAX_BYTES=50_000_000;
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const liveHandle=/(?<![A-Za-z0-9_-])(?:(?:turn|request|binding)_[A-Za-z0-9_-]{32}|reader_[0-9a-f]{64})(?![A-Za-z0-9_-])/;
const safeName=(path:string)=>/^(?:context\.txt|manifest\.json|(?:images|skills)\/[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,180})$/u.test(path)&&!path.includes('..');
type FileEntry={path:string;sha256:string;bytes:number;ref?:string;detail?:string;mediaType?:string};
export interface ContextArchive {bytes:Uint8Array;name:string;sha256:string;contextText:string;acknowledgement:string;manifestSha256:string}
// Adapted immutable-byte reuse from 3c1567a/49fc25c/b7ed23d. Never cache a live
// capability, account/target authority, or the uncompressed source request string.
type CachedArchive=Omit<ContextArchive,'contextText'>;
const archiveCache=new BoundedCache<string,CachedArchive>(4,32*1024*1024,120000);
let cacheBuilds=0,cacheHits=0;
export const contextArchiveCacheStats=()=>({...archiveCache.stats(),builds:cacheBuilds,hits:cacheHits});
export function clearContextArchiveCache(){archiveCache.clear();cacheBuilds=cacheHits=0;}
function archiveKey(contextText:string,images:readonly ChatGptWebPromptImage[],skills:readonly ChatGptSkillFile[]):string{
 const hash=createHash('sha256');
 const field=(value:string)=>hash.update(`${Buffer.byteLength(value,'utf8')}:`).update(value);
 field('context-archive-v1-integrity-text6-images0');field(JSON.stringify(contextText));field(String(images.length));
 for(const image of images){field(JSON.stringify(image.ref));field(image.imageUrl);field(JSON.stringify(image.detail??null));}
 field(String(skills.length));for(const skill of skills){field(JSON.stringify(skill.name));field(JSON.stringify(skill.text));}
 return hash.digest('hex');
}

/** Contains historical data only. No live capability, account state or runtime secrets are accepted. */
export function buildContextArchive(contextText:string,images:readonly ChatGptWebPromptImage[],skills:readonly ChatGptSkillFile[]):ContextArchive{
  if(liveHandle.test(contextText)||images.some(image=>liveHandle.test(image.ref))
    ||skills.some(file=>liveHandle.test(file.text)||liveHandle.test(file.name)))throw new Error('Live capabilities must remain outside the context archive');
  const key=archiveKey(contextText,images,skills),cached=archiveCache.get(key);
  if(cached){cacheHits++;return{...cached,bytes:cached.bytes.slice(),contextText};}
  const files:Record<string,Uint8Array>={};const entries:FileEntry[]=[];let total=0;
  const add=(path:string,bytes:Uint8Array,extra:Partial<FileEntry>={})=>{
    if(!safeName(path)||Object.hasOwn(files,path))throw new Error('Invalid or duplicate archive path');
    total+=bytes.length;if(total>MAX_BYTES)throw new Error('Complete context archive exceeds 50 MB; compact before retrying');
    files[path]=bytes;entries.push({path,sha256:sha(bytes),bytes:bytes.length,...extra});
  };
  add('context.txt',strToU8(contextText));
  const manifestImages:Array<Record<string,unknown>>=[],manifestSkills:Array<Record<string,unknown>>=[];
  for(const [index,image] of images.entries()){
    const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(image.imageUrl);
    if(!match||!match[2])throw new Error('Archive images must be supported inline image data');
    // Logical image refs are JSON metadata, not trusted ZIP paths. Numeric paths
    // preserve Unicode/unpaired UTF-16 metadata without path traversal or collisions.
    const extension=match[1]!.split('/')[1];
    const legacyPath=`images/${image.ref}.${extension}`;
    let path=safeName(legacyPath)&&!Object.hasOwn(files,legacyPath)?legacyPath
      :`images/opaque_${index+1}_${sha(JSON.stringify(image.ref)).slice(0,12)}.${extension}`;
    let collision=0;
    while(Object.hasOwn(files,path))path=`images/opaque_${index+1}_${++collision}.${extension}`;
    add(path,Buffer.from(match[2]!,'base64'),{ref:image.ref,mediaType:match[1],...(image.detail?{detail:image.detail}:{})});
    manifestImages.push({attachment_ref:image.ref,path,mime_type:match[1],...(image.detail?{detail:image.detail}:{})});
  }
  for(const skill of skills){const path=`skills/${skill.name}`;add(path,strToU8(skill.text));manifestSkills.push({filename:skill.name,path,mime_type:'text/plain; charset=utf-8'});}
  const manifest=strToU8(JSON.stringify({version:1,context:{path:'context.txt',mime_type:'text/plain; charset=utf-8'},images:manifestImages,skills:manifestSkills,files:entries}));
  if(total+manifest.length>MAX_BYTES)throw new Error('Complete context archive including manifest exceeds 50 MB');
  files['manifest.json']=manifest;
  // A fixed timestamp makes identical historical bytes deterministic across calls.
  const zipEntries:Zippable={};for(const [path,data] of Object.entries(files))zipEntries[path]=path.startsWith('images/')?[data,{level:0}]:data;
  const bytes=zipSync(zipEntries,{level:6,mtime:new Date('2000-01-01T00:00:00Z')});
  if(bytes.length>MAX_BYTES)throw new Error('Context ZIP exceeds upload budget');
  const digest=sha(bytes);
  const result={bytes,name:`codex-context-${digest.slice(0,24)}.zip`,sha256:digest,
    manifestSha256:sha(manifest),acknowledgement:`CODEX_CONTEXT_ARCHIVE_ACK ${digest}`};
  cacheBuilds++;archiveCache.set(key,{...result,bytes:bytes.slice()},bytes.length+1024);
  return{...result,contextText};
}

export function validateContextArchive(bytes:Uint8Array,expectedSha256?:string):Record<string,Uint8Array>{
  if(bytes.length>MAX_BYTES||expectedSha256&&sha(bytes)!==expectedSha256)throw new Error('Archive integrity mismatch');
  let size=0;const paths=new Set<string>();
  const files=unzipSync(bytes,{filter:file=>{
    if(!safeName(file.name)||paths.has(file.name))throw new Error('Unsafe or duplicate archive path');
    paths.add(file.name);size+=file.originalSize;
    if(!Number.isSafeInteger(size)||size>MAX_BYTES||paths.size>1024)throw new Error('Archive expanded size exceeds budget');
    return true;
  }});
  if(!files['context.txt']||!files['manifest.json'])throw new Error('Archive is missing context or manifest');
  const manifestText=strFromU8(files['manifest.json']);
  const manifest=JSON.parse(manifestText);
  if(manifest.version!==1||!Array.isArray(manifest.files)||manifest.files.length!==paths.size-1)throw new Error('Invalid archive manifest');
  const declared=new Set<string>();
  const entriesByPath=new Map<string,FileEntry>();
  for(const entry of manifest.files){
    if(!entry||typeof entry.path!=='string'||entry.path==='manifest.json'||!safeName(entry.path)||declared.has(entry.path))throw new Error('Invalid archive manifest path');
    declared.add(entry.path);const content=files[entry.path];
    if(!content||content.length!==entry.bytes||sha(content)!==entry.sha256)throw new Error('Archive content hash mismatch');
    entriesByPath.set(entry.path,entry);
  }
  // File hashes alone do not establish which historical images and skills a
  // model should read. Check that every asset has one matching manifest mapping.
  if(!manifest.context||manifest.context.path!=='context.txt'||manifest.context.mime_type!=='text/plain; charset=utf-8'
    ||!Array.isArray(manifest.images)||!Array.isArray(manifest.skills)
    ||manifest.images.length+manifest.skills.length+1!==declared.size)
    throw new Error('Invalid archive manifest asset inventory');
  const mapped=new Set<string>(['context.txt']);
  for(const image of manifest.images){
    if(!image||typeof image.path!=='string'||!image.path.startsWith('images/')||mapped.has(image.path)
      ||typeof image.attachment_ref!=='string'||!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mime_type)
      ||!image.path.endsWith(`.${image.mime_type.split('/')[1]}`)
      ||image.detail!==undefined&&typeof image.detail!=='string')
      throw new Error('Invalid archive manifest image mapping');
    const file=entriesByPath.get(image.path);
    if(!file||file.ref!==image.attachment_ref||file.mediaType!==image.mime_type||file.detail!==image.detail)
      throw new Error('Invalid archive manifest image metadata');
    mapped.add(image.path);
  }
  for(const skill of manifest.skills){
    if(!skill||typeof skill.filename!=='string'||typeof skill.path!=='string'
      ||skill.path!==`skills/${skill.filename}`||mapped.has(skill.path)
      ||skill.mime_type!=='text/plain; charset=utf-8'||!entriesByPath.has(skill.path))
      throw new Error('Invalid archive manifest skill mapping');
    mapped.add(skill.path);
  }
  if([...declared].some(path=>!mapped.has(path)))throw new Error('Invalid archive manifest unreferenced asset');
  if(liveHandle.test(manifestText)||[...paths].some(path=>liveHandle.test(path))
    ||Object.entries(files).some(([path,content])=>(path==='context.txt'||path.startsWith('skills/'))&&liveHandle.test(strFromU8(content))))
    throw new Error('Archive contains a live capability');
  return files;
}
