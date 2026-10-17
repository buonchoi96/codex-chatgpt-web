import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRequest} from '../src/responses/parser';
import {createChatGptWebAdapter} from '../src/adapters/chatgpt-web/index';
import {ChatGptBrowserWorker} from '../src/adapters/chatgpt-web/browser-worker';
import {BlockedOperationLedger} from '../src/adapters/chatgpt-web/blocked-operation-ledger';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {chatGptTurnSessions} from '../src/adapters/chatgpt-web/turn-execution';
import {defaultBrokerEndpoint} from '../src/config';
import {CHATGPT_WEB_MODEL_ID} from '../src/adapters/chatgpt-web/model';
import type {CodexProviderConfig} from '../src/types';

test('new adapter, retained delta and recovery read current scoped blockers without changing canonical input',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cgw-review-adapter-')),file=join(dir,'ledger.json');
 const scope={cwd:dir,roots:[dir]},ledger=new BlockedOperationLedger(file),socket=defaultBrokerEndpoint(dir),broker=TurnBroker.forSocket(socket);
 const provider:CodexProviderConfig={adapter:'chatgpt-web',baseUrl:`fixture://${crypto.randomUUID()}`,chatgptWeb:{browserHost:'launcher',browserHostDescriptorPath:join(dir,'launcher.json'),brokerSocketPath:socket,threadEnvironmentStatePath:join(dir,'environment.json'),localToolsEnabled:true,solAvailable:true,extraHighAvailable:true,proAvailable:true}};
 const user=(text:string,turn:string)=>({type:'message',role:'user',content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:turn}});
 const firstBody={model:CHATGPT_WEB_MODEL_ID,stream:true,reasoning:{effort:'high'},client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:`review_${crypto.randomUUID()}`,turn_id:'turn_one',sandbox:'none'})},input:[user(`<environment_context><cwd>${dir}</cwd><filesystem><workspace_roots><root>${dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`,'turn_one'),user('First authorized fixture instruction.','turn_one')]};
 const first=parseRequest(firstBody),metadata=JSON.parse(firstBody.client_metadata['x-codex-turn-metadata']);
 const second=parseRequest({...firstBody,client_metadata:{'x-codex-turn-metadata':JSON.stringify({...metadata,turn_id:'turn_two'})},input:[...firstBody.input,{type:'message',role:'assistant',content:[{type:'output_text',text:'First fixture answer.'}]},user('Continue the same fixture.','turn_two')]});
 const before=[first,second].map(value=>JSON.stringify(value._rawBody));
 const add=(index:number)=>ledger.recordSafetyRefusal({tool:'exec_command',arguments:{cmd:`PRIVATE_FIXTURE_${index}`},owner:`fixture-${index}`,targetScope:scope,affectedGoalRequirement:'SAFE-P0-02'});
 const one=add(1);let starts=0,recoveryReads=0;
 const worker=ChatGptBrowserWorker.forProvider(provider),original=worker.run;
 worker.run=async turn=>{
  starts++;const compiled=starts===1?await turn.prepare():await turn.prepareResume!();
  expect(compiled.text).toContain(one.blocker_id);
  expect(compiled.text).not.toContain('PRIVATE_FIXTURE');
  if(starts===2){
   expect(compiled.transportDecision?.choice).toBe('RETAINED_DELTA');
   expect(compiled.text).toContain(two!.blocker_id);
   await turn.onSendActivated?.();turn.onSubmitted?.();
   const three=add(3),recovery=await turn.prepareRecovery!();recoveryReads++;
   expect(recovery.text).toContain(three.blocker_id);expect(recovery.text).toContain('"unresolved_count":3');
   expect(recovery.contextArchive).toBeUndefined();expect(recovery.transportDecision?.choice).toBe('RETAINED_DELTA');recovery.release();
  }
  compiled.release();const answer=starts===1?'First fixture answer.':'Second fixture answer.';turn.onTextDelta(answer);return answer;
 };
 let two:ReturnType<typeof add>|undefined;
 try{
  await createChatGptWebAdapter(provider,{broker,blockedOperationLedger:new BlockedOperationLedger(file)} as any).runTurn!(first,{headers:new Headers()},()=>{});
  two=add(2);
  await createChatGptWebAdapter(provider,{broker,blockedOperationLedger:new BlockedOperationLedger(file)} as any).runTurn!(second,{headers:new Headers()},()=>{});
  expect([starts,recoveryReads]).toEqual([2,1]);expect([first,second].map(value=>JSON.stringify(value._rawBody))).toEqual(before);
  expect(new BlockedOperationLedger(file).unresolved()).toHaveLength(3);
  expect(readFileSync(file,'utf8')).not.toContain('PRIVATE_FIXTURE');
 }finally{worker.run=original;chatGptTurnSessions.clear();await broker.close();rmSync(dir,{recursive:true,force:true});}
},10000);
