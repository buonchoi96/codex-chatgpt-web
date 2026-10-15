import {expect,test} from 'bun:test';
import {createChatGptWebAdapter} from '../src/adapters/chatgpt-web/index';
import {ChatGptBrowserWorker} from '../src/adapters/chatgpt-web/browser-worker';
import {chatGptTurnSessions} from '../src/adapters/chatgpt-web/turn-execution';
import {TurnBroker,callTurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {createArchiveReadProof} from '../src/adapters/chatgpt-web/archive-read-proof';
import {parseRequest} from '../src/responses/parser';
import {defaultBrokerEndpoint} from '../src/config';
import {CHATGPT_WEB_MODEL_ID} from '../src/adapters/chatgpt-web/model';
import type {CodexProviderConfig,AdapterEvent} from '../src/types';
import {deflateSync} from 'node:zlib';

function distinctPng(base64:string,index:number):string {
  const original=Buffer.from(base64,'base64'),label=Buffer.from(`fixture\0${index}`),type=Buffer.from('tEXt');
  let crc=0xffffffff;
  for(const byte of Buffer.concat([type,label])){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
  const chunk=Buffer.alloc(label.length+12);chunk.writeUInt32BE(label.length);type.copy(chunk,4);label.copy(chunk,8);
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return `data:image/png;base64,${Buffer.concat([original.subarray(0,-12),chunk,original.subarray(-12)]).toString('base64')}`;
}
function fixturePng():string {
  const chunk=(type:string,data:Buffer)=>{
    const label=Buffer.from(type);let crc=0xffffffff;
    for(const byte of Buffer.concat([label,data])){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
    const output=Buffer.alloc(data.length+12);output.writeUInt32BE(data.length);label.copy(output,4);data.copy(output,8);
    output.writeUInt32BE((crc^0xffffffff)>>>0,output.length-4);return output;
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
  const row=Buffer.from([0,255,0,0,255,0,0,255,255]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.concat([row,row]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}

test('the real native adapter installs an archive read gate before exposing its first browser capability',async()=>{
  const key=crypto.randomUUID(),broker=TurnBroker.forSocket(defaultBrokerEndpoint(`${process.cwd()}/archive-adapter-${key}`));
  const provider:CodexProviderConfig={adapter:'chatgpt-web',baseUrl:`fixture://${key}`,chatgptWeb:{browserHost:'launcher',
    browserHostDescriptorPath:`${process.cwd()}/fixture-launcher.json`,brokerSocketPath:broker.socketPath,
    localToolsEnabled:true,solAvailable:true,extraHighAvailable:true,proAvailable:true}};
  const png=fixturePng();
  const parsed=parseRequest({model:CHATGPT_WEB_MODEL_ID,stream:true,reasoning:{effort:'high'},
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:`archive_${key}`,turn_id:'turn_fixture'})},
    tools:[{type:'function',name:'fixture_read',description:'Read an inert fixture',parameters:{type:'object',properties:{}}}],
    input:[{type:'message',role:'user',content:[{type:'input_text',text:`<environment_context><cwd>${process.cwd()}</cwd><filesystem><workspace_roots><root>${process.cwd()}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`}],
      internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}},
      {type:'message',role:'user',content:[{type:'input_text',text:'Inspect all historical fixture images.'},
        ...Array.from({length:12},(_,index)=>({type:'input_image',image_url:distinctPng(png,index),detail:'low'}))],internal_chat_message_metadata_passthrough:{turn_id:'turn_fixture'}}]});
  const worker=ChatGptBrowserWorker.forProvider(provider),originalRun=worker.run;
  let prepares=0,sends=0;
  worker.run=async turn=>{
    const compiled=await turn.prepare();prepares++;
    expect(compiled.contextArchive).toBeDefined();
    expect(await turn.completionFence!.begin(true)).toBeUndefined();
    const token=compiled.text.match(/(?<![A-Za-z0-9_-])turn_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/)?.[0];
    if(!token)throw new Error('Missing current inline capability');
    const proof=createArchiveReadProof(compiled.contextArchive!.contextText,12,compiled.skillFiles?.length??0);
    expect(compiled.text).not.toContain(proof.context_head_sha256);
    expect(compiled.text).not.toContain(proof.context_tail_sha256);
    await turn.onSendActivated?.();await turn.onSubmitted?.();sends++;
    await callTurnBroker(broker.socketPath,{method:'archive_confirm',token,arguments:proof});
    await broker.waitForArchiveRead(token);
    const revision=await turn.completionFence!.begin();expect(revision).toBeNumber();
    expect(await turn.completionFence!.commit(revision!)).toBe(true);
    turn.onTextDelta('Archive task finished');return 'Archive task finished';
  };
  try{
    const events:AdapterEvent[]=[];
    await createChatGptWebAdapter(provider,{broker}).runTurn!(parsed,{headers:new Headers()},event=>events.push(event));
    expect(events.at(-1)).toMatchObject({type:'done',endTurn:true});
    expect([prepares,sends]).toEqual([1,1]);
    expect(events.filter(event=>event.type==='tool_call_start')).toHaveLength(0);
  }finally{worker.run=originalRun;chatGptTurnSessions.clear();await broker.close();}
},10000);
