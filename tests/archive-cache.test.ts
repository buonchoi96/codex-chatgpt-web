import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import {buildContextArchive,validateContextArchive,contextArchiveCacheStats,clearContextArchiveCache} from '../src/adapters/chatgpt-web/context-archive';
import {compileChatGptWebPrompt} from '../src/adapters/chatgpt-web/prompt';
import {chatGptPromptFilePayloads, assertChatGptPromptAttachments} from '../src/adapters/chatgpt-web/browser-worker';
const image={ref:'image_1',imageUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==',detail:'original'};
test('archive preserves UTF-8 context, historical images, selected skills and content identities',()=>{
  const archive=buildContextArchive('Xin chào\nHistory',[image],[{name:'skill.txt',text:'Skill instruction'}]);
  const files=validateContextArchive(archive.bytes,archive.sha256);
  expect(new TextDecoder().decode(files['context.txt'])).toBe('Xin chào\nHistory');
  expect(files['images/image_1.png']).toBeDefined();
  expect(new TextDecoder().decode(files['skills/skill.txt'])).toBe('Skill instruction');
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
  expect(manifest.files.find((file:{path:string})=>file.path.startsWith('images/'))).toMatchObject({detail:'original',mediaType:'image/png'});
  expect(buildContextArchive('Xin chào\nHistory',[image],[{name:'skill.txt',text:'Changed'}]).sha256).not.toBe(archive.sha256);
  expect(buildContextArchive('Xin chào\nHistory',[{...image,detail:'low'}],[{name:'skill.txt',text:'Skill instruction'}]).sha256).not.toBe(archive.sha256);
  expect(buildContextArchive('Xin chào\nHistory',[image],[{name:'skill.txt',text:'Skill instruction'}]).sha256).toBe(archive.sha256);
});

test('archive reuses bounded immutable bytes, isolates callers and evicts the oldest content',()=>{
 clearContextArchiveCache();
 const first=buildContextArchive('cache-owned-context',[image],[]),before=first.bytes.slice();
 first.bytes[0]^=255;
 const second=buildContextArchive('cache-owned-context',[image],[]);
 expect(second.bytes).toEqual(before);expect(second.bytes).not.toBe(first.bytes);
 expect(contextArchiveCacheStats()).toMatchObject({builds:1,hits:1,entries:1});
 for(let i=0;i<5;i++)buildContextArchive(`other-${i}`,[image],[]);
 expect(contextArchiveCacheStats().entries).toBeLessThanOrEqual(4);
 const builds=contextArchiveCacheStats().builds;buildContextArchive('cache-owned-context',[image],[]);
 expect(contextArchiveCacheStats().builds).toBe(builds+1);
 expect(contextArchiveCacheStats().bytes).toBeLessThanOrEqual(32*1024*1024);
});

test('archive manifest preserves archival context/images/skills fields and exact Unicode metadata',()=>{
 clearContextArchiveCache();
 const first=buildContextArchive('Unicode history',[{...image,ref:'ref-\uD800'}],[{name:'技能.md',text:'Hướng dẫn'}]);
 const second=buildContextArchive('Unicode history',[{...image,ref:'ref-\uD801'}],[{name:'技能.md',text:'Hướng dẫn'}]);
 expect(second.sha256).not.toBe(first.sha256);
 const files=validateContextArchive(second.bytes,second.sha256),manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
 expect(manifest.context).toEqual({path:'context.txt',mime_type:'text/plain; charset=utf-8'});
 expect(manifest.images[0]).toMatchObject({attachment_ref:'ref-\uD801',mime_type:'image/png',detail:'original'});
 expect(files[manifest.images[0].path]).toEqual(unzipSync(first.bytes)[JSON.parse(new TextDecoder().decode(unzipSync(first.bytes)['manifest.json'])).images[0].path]);
 expect(manifest.skills[0]).toEqual({filename:'技能.md',path:'skills/技能.md',mime_type:'text/plain; charset=utf-8'});
 expect(contextArchiveCacheStats()).toMatchObject({builds:2,hits:0});
});

test('archive preserves ordered image bytes and MIME metadata for four and twelve historical images',()=>{
  clearContextArchiveCache();
  const media=[
    {type:'image/png',data:'AQIDBA=='},
    {type:'image/jpeg',data:'BQYHCA=='},
    {type:'image/webp',data:'CQoLDA=='},
    {type:'image/gif',data:'DQ4PEA=='}
  ];
  for(const count of [4,12]){
    const images=Array.from({length:count},(_,index)=>{
      const item=media[index%media.length]!;
      return{ref:`historical-${index+1}`,imageUrl:`data:${item.type};base64,${item.data}`,detail:index%2?'low':'original'};
    });
    const archive=buildContextArchive(`History with ${count} images`,images,[]);
    const files=validateContextArchive(archive.bytes,archive.sha256);
    const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest.images).toHaveLength(count);
    expect(manifest.images.map((entry:{attachment_ref:string})=>entry.attachment_ref)).toEqual(images.map(item=>item.ref));
    for(const [index,image] of images.entries()){
      const entry=manifest.images[index]!;
      const expectedType=media[index%media.length]!.type;
      expect(entry).toMatchObject({attachment_ref:image.ref,mime_type:expectedType,detail:image.detail});
      expect(entry.path).toMatch(/^images\//);
      expect(files[entry.path]).toEqual(Buffer.from(image.imageUrl.split(',')[1]!, 'base64'));
      expect(manifest.files.find((file:{path:string})=>file.path===entry.path)).toMatchObject({mediaType:expectedType});
    }
  }
});

test('archive keeps Unicode text and traversal-like Unicode image refs out of ZIP paths',()=>{
  clearContextArchiveCache();
  const context='Tiếng Việt — 中文 — עברית — 😀';
  const ref='../图像/💡';
  const archive=buildContextArchive(context,[{...image,ref}],[]);
  const files=validateContextArchive(archive.bytes,archive.sha256);
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
  expect(new TextDecoder().decode(files['context.txt'])).toBe(context);
  expect(manifest.images[0]).toMatchObject({attachment_ref:ref,mime_type:'image/png'});
  expect(manifest.images[0].path).toMatch(/^images\/opaque_/);
  expect(manifest.images[0].path).not.toContain('..');
  expect(files[manifest.images[0].path]).toEqual(Buffer.from(image.imageUrl.split(',')[1]!, 'base64'));
});

test('archive cache identity preserves repeated refs, order and MIME without dropping occurrences',()=>{
  clearContextArchiveCache();
  const repeated=[
    {...image,ref:'same-ref'},
    {...image,ref:'same-ref',imageUrl:image.imageUrl.replace('image/png','image/jpeg'),detail:'low'}
  ];
  const first=buildContextArchive('Repeated historical reference',repeated,[]);
  const cached=buildContextArchive('Repeated historical reference',repeated,[]);
  const files=validateContextArchive(cached.bytes,cached.sha256);
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
  expect(cached.sha256).toBe(first.sha256);
  expect(contextArchiveCacheStats()).toMatchObject({builds:1,hits:1});
  expect(manifest.images.map((entry:{attachment_ref:string})=>entry.attachment_ref)).toEqual(['same-ref','same-ref']);
  expect(manifest.images[0].path).not.toBe(manifest.images[1].path);
  expect(manifest.images.map((entry:{mime_type:string})=>entry.mime_type)).toEqual(['image/png','image/jpeg']);
  expect(files[manifest.images[0].path]).toEqual(files[manifest.images[1].path]);

  const reversed=buildContextArchive('Repeated historical reference',[...repeated].reverse(),[]);
  expect(reversed.sha256).not.toBe(first.sha256);
  const reversedFiles=validateContextArchive(reversed.bytes,reversed.sha256);
  const reversedManifest=JSON.parse(new TextDecoder().decode(reversedFiles['manifest.json']));
  expect(reversedManifest.images.map((entry:{mime_type:string})=>entry.mime_type)).toEqual(['image/jpeg','image/png']);
  expect(contextArchiveCacheStats()).toMatchObject({builds:2,hits:1});
});

test('archive rejects traversal, remote images, live capability handles and tampered contents',()=>{
  expect(()=>buildContextArchive('History',[],[{name:'../outside',text:'x'}])).toThrow();
  expect(()=>buildContextArchive('History',[{...image,imageUrl:'https://example.test/private'}],[])).toThrow();
  expect(()=>buildContextArchive(`History turn_${'a'.repeat(32)}`,[],[])).toThrow();
  expect(()=>buildContextArchive('History',[{...image,ref:`turn_${'a'.repeat(32)}`}],[])).toThrow();
  const readerLease=`reader_${'e'.repeat(64)}`;
  expect(()=>buildContextArchive(`History ${readerLease}`,[],[])).toThrow();
  expect(()=>buildContextArchive('History',[{...image,ref:readerLease}],[])).toThrow();
  expect(()=>buildContextArchive('History',[],[{name:`${readerLease}.txt`,text:'ordinary historical skill'}])).toThrow();
  expect(()=>buildContextArchive('History',[],[{name:'skill.txt',text:`serialized receipt: ${JSON.stringify({reader_lease:readerLease})}`}])).toThrow();
  expect(()=>buildContextArchive(`Historical digest ${'f'.repeat(64)}`,[],[])).not.toThrow();
  const archive=buildContextArchive('History',[],[]);
  const readerArchive=buildContextArchive('History',[],[{name:'skill.txt',text:'ordinary skill'}]);
  const readerArchiveFiles=unzipSync(readerArchive.bytes);
  readerArchiveFiles['skills/skill.txt']=strToU8(`receipt ${readerLease}`);
  const readerManifest=JSON.parse(new TextDecoder().decode(readerArchiveFiles['manifest.json']));
  const skillEntry=readerManifest.files.find((entry:{path:string})=>entry.path==='skills/skill.txt');
  skillEntry.bytes=Buffer.byteLength(`receipt ${readerLease}`);
  skillEntry.sha256=createHash('sha256').update(`receipt ${readerLease}`).digest('hex');
  readerArchiveFiles['manifest.json']=strToU8(JSON.stringify(readerManifest));
  expect(()=>validateContextArchive(zipSync(readerArchiveFiles))).toThrow();
  const namedAssetArchive=buildContextArchive('History',[],[{name:'asset.txt',text:'ordinary historical skill'}]);
  const namedAssetFiles=unzipSync(namedAssetArchive.bytes);
  const renamedSkill=`skills/${readerLease}.txt`;
  namedAssetFiles[renamedSkill]=namedAssetFiles['skills/asset.txt']!;
  delete namedAssetFiles['skills/asset.txt'];
  const namedManifest=JSON.parse(new TextDecoder().decode(namedAssetFiles['manifest.json']));
  namedManifest.skills[0].filename=`${readerLease}.txt`;
  namedManifest.skills[0].path=renamedSkill;
  namedManifest.files[1].path=renamedSkill;
  namedAssetFiles['manifest.json']=strToU8(JSON.stringify(namedManifest));
  expect(()=>validateContextArchive(zipSync(namedAssetFiles))).toThrow();
  expect(()=>validateContextArchive(archive.bytes,'0'.repeat(64))).toThrow();
  const files=unzipSync(archive.bytes);files['context.txt']=strToU8('Tampered');
  expect(()=>validateContextArchive(zipSync(files))).toThrow();
  files['../outside']=strToU8('escape');expect(()=>validateContextArchive(zipSync(files))).toThrow();
});
test('cold compiler sends the full image archive with an in-turn proof call; proven warm history stays a delta',()=>{
  const parsed={modelId:'gpt-5.6-sol',stream:true,options:{reasoning:'high'},context:{systemPrompt:['Native policy'],messages:[{role:'user' as const,content:[{type:'text' as const,text:'Inspect the complete image history.'},...Array.from({length:12},(_,index)=>({type:'image' as const,imageUrl:image.imageUrl,detail:'low' as const,ref:`image_${index+1}`}))],timestamp:1}]}} as Parameters<typeof compileChatGptWebPrompt>[0];
  const capabilities={solAvailable:true,extraHighAvailable:false,proAvailable:false,localToolsEnabled:true};
  const live=`turn_${'b'.repeat(32)}`;
  const cold=compileChatGptWebPrompt(parsed,capabilities,live,{contextArchive:true});
  expect(cold.transportDecision).toMatchObject({choice:'ZIP_SINGLE_MESSAGE'});
  expect(cold.contextArchive).toBeDefined();
  expect(cold.text).toContain(live);expect(cold.contextArchive!.contextText).not.toContain(live);
  expect(cold.text).toContain('wire_name "codex_context_archive_ack"');
  expect(cold.text).toContain('before any ordinary task tool call or final answer');
  expect(cold.text).toContain('attached-file tools');
  expect(cold.transportDecision?.measurements.archive).toMatchObject({imageCount:12,skillCount:0});
  const file=chatGptPromptFilePayloads(cold)[0]!;
  expect(file.mimeType).toBe('application/zip');
  validateContextArchive(file.buffer,cold.contextArchive!.sha256);
  const delta={...parsed,context:{...parsed.context,messages:[{role:'user' as const,content:'Continue from the retained conversation.',timestamp:2}]}};
  const warm=compileChatGptWebPrompt(delta,capabilities,live,{contextArchive:true,retainedHistoryProven:true});
  expect(warm.transportDecision).toMatchObject({choice:'RETAINED_DELTA'});
  expect(warm.contextArchive).toBeUndefined();
});

test('cold ZIP carries more than ten historical images as one attachment; readable fallback fails without dropping any',()=>{
  const images=Array.from({length:12},(_,index)=>({...image,ref:`image_${index+1}`}));
  const archive=buildContextArchive('Complete historical image context',images,[]);
  const compiled={text:'Live delta',images,contextArchive:{...archive,base64:Buffer.from(archive.bytes).toString('base64')}};
  expect(()=>assertChatGptPromptAttachments(compiled)).not.toThrow();
  expect(chatGptPromptFilePayloads(compiled)).toHaveLength(1);
  expect(Object.keys(validateContextArchive(archive.bytes)).filter(path=>path.startsWith('images/'))).toHaveLength(12);
  expect(()=>chatGptPromptFilePayloads({...compiled,contextArchive:undefined,contextFiles:[{name:'context.txt',text:archive.contextText}]}))
    .toThrow(/attachment/i);
});
