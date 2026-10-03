import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { chatGptPromptFilePayloads } from '../src/adapters/chatgpt-web/browser-worker';
import { estimateTokens, ChunkTokenEstimator } from '../src/lib/token-estimate';
import type { CompiledChatGptWebPrompt } from '../src/adapters/chatgpt-web/prompt';
if (process.argv.includes('--retention')) {
  const estimator = new ChunkTokenEstimator(text => text.length);
  Bun.gc(true);
  const before = process.memoryUsage();
  for (let i = 0; i < 32; i++) estimator.estimate(String(i).padStart(8, '0') + 'x'.repeat(5_000_000));
  Bun.gc(true);
  const after = process.memoryUsage();
  console.log(JSON.stringify({kind: 'substring retention benchmark; not throughput', before, after,
    heap_delta_bytes: after.heapUsed - before.heapUsed, rss_delta_bytes: after.rss - before.rss}, null, 2));
  process.exit(0);
}
// Deterministic valid PNG containing noise: models never see this synthetic microbenchmark.
let seed=123456; const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
function crc32(b:Buffer){let c=0xffffffff;for(const x of b){c^=x;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type:string,b:Buffer){const h=Buffer.alloc(4);h.writeUInt32BE(b.length);const data=Buffer.concat([Buffer.from(type),b]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(data));return Buffer.concat([h,data,c]);}
const raw=Buffer.alloc(480*(640*3+1));for(let y=0;y<480;y++)for(let x=1;x<=640*3;x++)raw[y*(640*3+1)+x]=next();
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(640);ihdr.writeUInt32BE(480,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
const imageUrl=`data:image/png;base64,${png.toString('base64')}`;
const samples=10; const quantiles=(a:number[])=>{a.sort((a,b)=>a-b);return {p50_ms:a[Math.floor(a.length*.5)],p95_ms:a[Math.min(a.length-1,Math.ceil(a.length*.95)-1)]};};
const results:any[]=[];
for(const words of [20000,100000,200000,500000]) {
  const text='word '.repeat(words);
  const times:number[]=[];let count=0;
  for(let i=0;i<samples;i++){const start=performance.now();count=estimateTokens(text);times.push(performance.now()-start);}
  results.push({scenario:`tokens-${words}`,samples,count,...quantiles(times)});
}
for(const images of [0,4,20]){
  const prompt={text:'archive transport wrapper',images:Array.from({length:images},(_,i)=>({ref:`image-${i}`,imageUrl,detail:'high' as const})),archive:{name:'codex-context-bench.zip',contextText:'word '.repeat(200000)}} as CompiledChatGptWebPrompt;
  const times:number[]=[];let bytes=0;
  for(let i=0;i<samples;i++){const start=performance.now();bytes=chatGptPromptFilePayloads(structuredClone(prompt))[0]!.buffer.length;times.push(performance.now()-start);}
  results.push({scenario:`archive-200k-${images}-images`,samples,bytes,...quantiles(times)});
}
for(const level of [0,1,3,6,'mixed'] as const){
  const entries={'context.txt':strToU8('word '.repeat(200000)),'image.png':png};
  const times:number[]=[];let bytes=0;
  for(let i=0;i<samples;i++){const start=performance.now();bytes=(level === 'mixed' ? zipSync({'context.txt':entries['context.txt'],'image.png':[png,{level:0}]},{level:6}) : zipSync(entries,{level})).length;times.push(performance.now()-start);}
  results.push({scenario:`zip-level-${level}`,samples,bytes,...quantiles(times)});
}
const report={kind:'synthetic microbenchmark; not E2E speedup',bun:Bun.version,platform:process.platform,results};
console.log(JSON.stringify(report,null,2));

