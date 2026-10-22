import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,openSync,closeSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {recoverCompactionInstruction} from '../src/adapters/chatgpt-web/compaction-continuation';
import {encodeCompactionSummary,SUMMARY_PREFIX} from '../src/responses/compaction';
import {parseRequest} from '../src/responses/parser';
import {extractChatGptTurnIdentity,extractChatGptTurnUserRevision,extractChatGptCompactionSourceRevision,isChatGptCompactionContinuation} from '../src/adapters/chatgpt-web/environment';
import {inspectCurrentCodexRollout,latestNativeCompactionRecord,diagnoseLatestNativeCompactionSource} from '../src/adapters/chatgpt-web/codex-rollout-environment';
import {isAuthenticatedNativeCompactionSource,isAuthenticatedNativeGoalContinuation,resolveNativeCompactionSource} from '../src/adapters/chatgpt-web/native-compaction-provenance';

const owned:string[]=[];
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==';
afterEach(()=>{for(const path of owned.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(version:'v1'|'v2'='v2'){
  const home=mkdtempSync(join(tmpdir(),'cw-native-source-'));owned.push(home);
  const thread=randomUUID(),turn=randomUUID(),oldTurn=randomUUID(),root=resolve(process.cwd());
  const sessionDir=join(home,'sessions','2026','10','15');mkdirSync(sessionDir,{recursive:true});
  const file=join(sessionDir,`rollout-2026-10-15T08-00-00-${thread}.jsonl`);
  const source={type:'message',role:'user',id:'msg_native_source',content:[{type:'input_text',text:'Finish the authorized repository change.'}],
    internal_chat_message_metadata_passthrough:{turn_id:oldTurn,content_item_kinds:['user.text']}};
  const summary=version==='v2'?{type:'compaction',id:'cmp_native_fixture',encrypted_content:encodeCompactionSummary('Accepted native checkpoint.'),
    internal_chat_message_metadata_passthrough:{turn_id:oldTurn}}:
    {type:'message',role:'user',id:'msg_native_summary',content:[{type:'input_text',text:SUMMARY_PREFIX+'\nAccepted native checkpoint.'}],
      internal_chat_message_metadata_passthrough:{turn_id:oldTurn}};
  const ack={type:'compacted',payload:{compaction_response_id:'resp_native_ack',replacement_history:[source,summary],
    replacement_history_metadata:[{retained_source:{id:'retained_native_source',revision:'revision_one',complete:true},user_input_order:1,client_authored:false},
      {retained_source:null,user_input_order:null,client_authored:false}]}};
  const records:Array<Record<string,unknown>>=[{type:'session_meta',payload:{id:thread,source:'vscode'}},ack,
    {type:'turn_context',payload:{turn_id:turn,cwd:root,workspace_roots:[root],sandbox_policy:{type:'danger-full-access'},
      permission_profile:{type:'disabled'},model:'chatgpt-web/gpt-6-sol',effort:'high'}}];
  const parsed=parseRequest({model:'chatgpt-web/gpt-6-sol',reasoning:{effort:'high'},
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({request_kind:'turn',thread_id:thread,turn_id:turn,
      sandbox:'none',workspaces:{[root]:{has_changes:false}}})},
    input:[structuredClone(summary),{type:'message',role:'user',id:'msg_goal',content:[{type:'input_text',
      text:'<codex_internal_context source="goal">Continue the active goal</codex_internal_context>'}]}]});
  const write=()=>writeFileSync(file,records.map(record=>JSON.stringify(record)).join('\n')+'\n');write();
  return {home,file,thread,turn,oldTurn,root,source,summary,ack,records,parsed,write};
}
test.each(['v1','v2'] as const)('empty bridge registry recovers source only through an installed native %s checkpoint',version=>{
  const f=fixture(version);
  const result=recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home});
  expect(result?.source).toEqual({content:f.source.content,itemId:f.source.id,turnId:f.oldTurn});
  expect(result?.summaryIndex).toBe(0);
});

// Exact structural differences observed in native0.162.0-alpha.17.2's real
// compacted installation (day10-native-install-1792093910639.json).
function nativeWireFixture(){
  const f=fixture();
  delete (f.summary as Record<string,unknown>).internal_chat_message_metadata_passthrough;
  const retained=f.ack.payload.replacement_history_metadata[0]!.retained_source!;
  (retained as Record<string,unknown>).id={message_id:f.source.id,turn_id:f.oldTurn,role:'user'};
  ((f.parsed._rawBody as {input:unknown[]}).input)[0]=structuredClone(f.summary);
  f.write();return f;
}
test('native structured retained identity and ownerless checkpoint authenticate through exact installed id',()=>{
  const f=nativeWireFixture();
  const result=recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home});
  expect(result?.source).toEqual({content:f.source.content,itemId:f.source.id,turnId:f.oldTurn});
  expect(resolveNativeCompactionSource(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})?.provenance.source_id).toBe(f.source.id);
});
test.each(['foreign-message','foreign-turn','foreign-role','missing-message','missing-id'] as const)(
  'structured native retained identity rejects an invalid binding: %s',change=>{
    const f=nativeWireFixture();
    const retained=f.ack.payload.replacement_history_metadata[0]!.retained_source! as Record<string,unknown>;
    const id=retained.id as Record<string,unknown>;
    if(change==='foreign-message')id.message_id='msg_foreign';
    if(change==='foreign-turn')id.turn_id=randomUUID();
    if(change==='foreign-role')id.role='assistant';
    if(change==='missing-message')delete id.message_id;
    if(change==='missing-id')delete retained.id;
    f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
  });
test.each(['request-id-missing','installed-id-missing','request-id-changed','foreign-request-owner'] as const)(
  'ownerless native checkpoint requires its installed item identity: %s',change=>{
    const f=nativeWireFixture();const checkpoint=(f.parsed._rawBody as {input:Record<string,unknown>[]}).input[0]!;
    if(change==='request-id-missing')delete checkpoint.id;
    if(change==='installed-id-missing')delete (f.summary as Record<string,unknown>).id;
    if(change==='request-id-changed')checkpoint.id='cmp_other';
    if(change==='foreign-request-owner')checkpoint.internal_chat_message_metadata_passthrough={turn_id:randomUUID()};
    f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
  });
test.each([false,true])('restart recovery reaches replay, lineage and model input in a fresh process: historical image %s',async withImage=>{
  const f=fixture();
  if(withImage){f.source.internal_chat_message_metadata_passthrough.content_item_kinds.push('user.image');
    (f.source.content as Array<Record<string,unknown>>).push({type:'input_image',image_url:png,detail:'low'});f.write();}
  const environment=pathToFileURL(resolve('src/adapters/chatgpt-web/environment.ts')).href;
  const execution=pathToFileURL(resolve('src/adapters/chatgpt-web/turn-execution.ts')).href;
  const prompt=pathToFileURL(resolve('src/adapters/chatgpt-web/prompt.ts')).href;
  const program=`const e=await import(${JSON.stringify(environment)});const t=await import(${JSON.stringify(execution)});const c=await import(${JSON.stringify(prompt)});const p=${JSON.stringify(f.parsed)};
    p.modelId='gpt-5.6-sol';p._chatgptModelFamily='6';
    const before=JSON.stringify(p._rawBody);const caps={localToolsEnabled:true,solAvailable:true,extraHighAvailable:true,proAvailable:true};
    const compiled=c.compileChatGptWebPrompt(p,caps,'turn_fixture_native_source_1234567890');
    const lineage=t.chatGptInstructionLineage(p);const next=structuredClone(p);
    next._rawBody.input.push({type:'message',role:'user',id:'msg_new_steering',content:[{type:'input_text',text:'Show the verified diff next.'}],
      internal_chat_message_metadata_passthrough:{turn_id:${JSON.stringify(f.turn)}}});
    const nextLineage=t.chatGptInstructionLineage(next);
    const {createHash}=await import('node:crypto');const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    console.log(JSON.stringify({revisionHash:hash(e.extractChatGptTurnUserRevision(p)),key:t.chatGptTurnExecutionKey(p),lineage:t.chatGptInstructionLineage(p).current,
      sourceDelivered:compiled.text.includes('Finish the authorized repository change.'),historical:compiled.text.includes('native_retained_instruction'),
      rawUnchanged:before===JSON.stringify(p._rawBody),imageCount:compiled.images.length,imageHash:hash(compiled.images.map(item=>item.imageUrl)),
      steeringPreserved:nextLineage.predecessors.has(lineage.current),latestWins:JSON.stringify(e.extractChatGptTurnUserRevision(next)).includes('Show the verified diff next.')}));`;
  const child=Bun.spawn([process.execPath,'--eval',program],{env:{...process.env,CODEX_HOME:f.home,CODEX_SQLITE_HOME:f.home},stdout:'pipe',stderr:'pipe'});
  const [output,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(exit,error).toBe(0);const lastLine=output.trim().split(/\r?\n/).at(-1);
  expect(lastLine).toBeDefined();const result=JSON.parse(lastLine!);
  expect(result.revisionHash).toBe(createHash('sha256').update(JSON.stringify(f.source.content)).digest('hex'));
  expect(result.key).toMatch(/^[0-9a-f]{64}$/);expect(result.lineage).toMatch(/^[0-9a-f]{64}$/);
  expect(result.sourceDelivered).toBe(true);expect(result.historical).toBe(true);expect(result.rawUnchanged).toBe(true);
  expect(result.imageCount).toBe(withImage?1:0);expect(result.imageHash).toBe(createHash('sha256').update(JSON.stringify(withImage?[png]:[])).digest('hex'));
  expect(result.steeringPreserved).toBe(true);expect(result.latestWins).toBe(true);
});
test.each(['foreign-session','foreign-turn','foreign-model','foreign-effort'] as const)('native identity mismatch is terminal: %s',change=>{
  const f=fixture();
  if(change==='foreign-session')(f.records[0]!.payload as Record<string,unknown>).id=randomUUID();
  else (f.records[2]!.payload as Record<string,unknown>)[change==='foreign-turn'?'turn_id':change==='foreign-model'?'model':'effort']=
    change==='foreign-turn'?randomUUID():change==='foreign-model'?'chatgpt-web/gpt-6-pro':'medium';
  f.write();expect(()=>recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home}))
    .toThrow('Replay provenance is unverified');
});
test('an omitted request effort uses the actual native effort witness without inventing a requested setting',()=>{
  const f=fixture();delete f.parsed.options.reasoning;
  delete (f.parsed._rawBody as {reasoning?:unknown}).reasoning;
  const before=JSON.stringify(f.parsed._rawBody);
  expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})?.source.itemId).toBe(f.source.id);
  expect(f.parsed.options.reasoning).toBeUndefined();
  expect(JSON.stringify(f.parsed._rawBody)).toBe(before);
});
test.each([undefined,'',42])('missing native effort cannot authenticate a request with omitted effort: %s',effort=>{
  const f=fixture();delete f.parsed.options.reasoning;
  delete (f.parsed._rawBody as {reasoning?:unknown}).reasoning;
  (f.records[2]!.payload as Record<string,unknown>).effort=effort;f.write();
  expect(()=>recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home}))
    .toThrow('Replay provenance is unverified');
});
test.each(['missing-ack','incomplete-source','client-authored-source','wrong-summary','foreign-summary-owner','conflicting-source'] as const)(
  'unproven checkpoint cannot manufacture an instruction: %s',change=>{
    const f=fixture();
    const retained=f.ack.payload.replacement_history_metadata[0]!;
    if(change==='missing-ack')f.ack.payload.compaction_response_id='';
    if(change==='incomplete-source')retained.retained_source!.complete=false;
    if(change==='client-authored-source')retained.client_authored=true;
    if(change==='wrong-summary')f.summary.encrypted_content=encodeCompactionSummary('A different summary.');
    if(change==='foreign-summary-owner'){
      const input=(f.parsed._rawBody as {input:Array<Record<string,unknown>>}).input;
      (input[0]!.internal_chat_message_metadata_passthrough as Record<string,unknown>).turn_id=randomUUID();
    }
    if(change==='conflicting-source')((f.parsed._rawBody as {input:unknown[]}).input).push({...f.source,content:[{type:'input_text',text:'Altered source under the same id.'}]});
    f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
});
test('a newer installed checkpoint prevents replaying an older matching one',()=>{
  const f=fixture();const newer=structuredClone(f.ack);
  (newer.payload.replacement_history[1] as Record<string,unknown>).encrypted_content=encodeCompactionSummary('Superseding checkpoint.');
  f.records.splice(2,0,newer);f.write();
  expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
});
test('a legitimate model rebind needs its new current native context, not an old bridge checkpoint',()=>{
  const f=fixture();(f.parsed._rawBody as {model:string}).model='chatgpt-web/gpt-6-pro';f.parsed.modelId='gpt-6-pro';
  (f.records[2]!.payload as Record<string,unknown>).model='chatgpt-web/gpt-6-pro';f.write();
  expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})?.source.content).toEqual(f.source.content);
});
test.each([false,true])('latest retained source controls recovery; old incomplete content is not promoted: newest complete %s',complete=>{
  const f=fixture();const older=structuredClone(f.source);older.id='msg_older';older.content=[{type:'input_text',text:'Earlier bounded instruction.'}];
  const olderMeta={retained_source:{id:'old_source',revision:'old_revision',complete:!complete},user_input_order:0,client_authored:false};
  f.ack.payload.replacement_history.unshift(older);
  f.ack.payload.replacement_history_metadata.unshift(olderMeta);
  f.ack.payload.replacement_history_metadata[1]!.retained_source!.complete=complete;
  f.write();const result=recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home});
  if(complete)expect(result?.source.itemId).toBe(f.source.id);else expect(result).toBeUndefined();
});
test.each(['missing-id','missing-revision','unretained-newest'] as const)(
  'an unverified newest retained-source record cannot fall back to an older instruction: %s',change=>{
    const f=fixture();const newest=structuredClone(f.source);newest.id='msg_newest_native_source';
    newest.content=[{type:'input_text',text:'Newest bounded instruction.'}];
    const retained={id:'new_source',revision:'new_revision',complete:true};
    if(change==='missing-id')delete (retained as {id?:string}).id;
    if(change==='missing-revision')delete (retained as {revision?:string}).revision;
    const meta={retained_source:change==='unretained-newest'?null:retained,user_input_order:2,client_authored:false};
    f.ack.payload.replacement_history.splice(1,0,newest);
    (f.ack.payload.replacement_history_metadata as Array<Record<string,unknown>>).splice(1,0,meta);
    f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
  });

test.each(['missing-kinds','empty-kinds','mixed-kinds','context-kinds','missing-metadata'] as const)(
  'malformed newest source declarations cannot be skipped in favor of an older instruction: %s',change=>{
    const f=fixture();const newest=structuredClone(f.source);newest.id='msg_newest_invalid_kinds';
    newest.content=[{type:'input_text',text:'Newest instruction cannot silently disappear.'}];
    const metadata=newest.internal_chat_message_metadata_passthrough as Record<string,unknown>;
    if(change==='missing-kinds')delete metadata.content_item_kinds;
    if(change==='empty-kinds')metadata.content_item_kinds=[];
    if(change==='mixed-kinds')metadata.content_item_kinds=['user.text','environments.environment_context'];
    if(change==='context-kinds')metadata.content_item_kinds=['environments.environment_context'];
    f.ack.payload.replacement_history.splice(1,0,newest);
    const entries=f.ack.payload.replacement_history_metadata as unknown[];
    entries.splice(1,0,change==='missing-metadata'?null:{retained_source:{id:'new_source',revision:'new_revision',complete:true},
      user_input_order:2,client_authored:false});
    f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
  });
test.each(['negative','fractional','missing','duplicate'] as const)(
  'corrupted retained-source user input order rejects the installed checkpoint: %s',change=>{
    const f=fixture();const metadata=f.ack.payload.replacement_history_metadata[0]!;
    if(change==='negative')metadata.user_input_order=-1;
    if(change==='fractional')metadata.user_input_order=1.5;
    if(change==='missing')delete (metadata as {user_input_order?:number|null}).user_input_order;
    if(change==='duplicate'){
      const older=structuredClone(f.source);older.id='msg_duplicate_order';
      older.content=[{type:'input_text',text:'Earlier ordered instruction.'}];
      f.ack.payload.replacement_history.unshift(older);
      f.ack.payload.replacement_history_metadata.unshift({retained_source:{id:'older_source',revision:'older_revision',complete:true},
        user_input_order:1,client_authored:false});
    }
    f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
  });
test.each(['undeclared-image','text-declared-as-image'] as const)(
  'retained source content must agree with its declared native content kinds: %s',change=>{
    const f=fixture();const kinds=f.source.internal_chat_message_metadata_passthrough.content_item_kinds as string[];
    if(change==='undeclared-image'){
      (f.source.content as Array<Record<string,unknown>>).push({type:'input_image',image_url:png,detail:'low'});
    }else{
      kinds.splice(0,kinds.length,'user.image');
    }
    f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
  });
test.each(['missing-lineage','opaque-checkpoint','no-installed-checkpoint','malformed-workspaces'] as const)('context hints alone do not provide native installation evidence: %s',change=>{
  const f=fixture();
  if(change==='missing-lineage')((f.parsed._rawBody as {client_metadata:Record<string,string>}).client_metadata)['x-codex-turn-metadata']=
    JSON.stringify({thread_id:f.thread,turn_id:f.turn});
  if(change==='opaque-checkpoint'){
    const opaque='opaque_native_blob';f.summary.encrypted_content=opaque;
    ((f.parsed._rawBody as {input:Array<Record<string,unknown>>}).input[0]!).encrypted_content=opaque;
  }
  if(change==='no-installed-checkpoint')f.records.splice(1,1);
  if(change==='malformed-workspaces'){
    const metadata=(f.parsed._rawBody as {client_metadata:Record<string,string>}).client_metadata;
    const fields=JSON.parse(metadata['x-codex-turn-metadata']!);fields.workspaces=['malformed'];
    metadata['x-codex-turn-metadata']=JSON.stringify(fields);
  }
  f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
});
test('authenticated rollout reader fences a concurrent native turn change',()=>{
  const f=fixture();
  expect(()=>inspectCurrentCodexRollout({codexHome:f.home,turnId:f.turn,
    lineage:{threadId:f.thread,sandboxType:'dangerFullAccess',workspaceRoots:[f.root]}},()=>{
    const newer=structuredClone(f.records[2]!);(newer.payload as Record<string,unknown>).turn_id=randomUUID();f.records.push(newer);f.write();
    return 'stale result';
  })).toThrow('turn changed');
});
test('native checkpoint installation is revalidated when the rollout grows without changing turn id',()=>{
  const f=fixture();let initial:string|undefined;
  expect(()=>inspectCurrentCodexRollout({codexHome:f.home,turnId:f.turn,
    lineage:{threadId:f.thread,sandboxType:'dangerFullAccess',workspaceRoots:[f.root]}},({fd,size})=>{
    initial=JSON.stringify(latestNativeCompactionRecord(fd,size));
    const newer=structuredClone(f.ack);newer.payload.compaction_response_id='resp_new_installation';f.records.push(newer);f.write();return 'stale result';
  },({fd,size})=>{
    if(JSON.stringify(latestNativeCompactionRecord(fd,size))!==initial)throw new Error('installed checkpoint changed');
  })).toThrow('installed checkpoint changed');
});
test.each(['v1','v2'] as const)('empty or malformed native %s checkpoint is not accepted',version=>{
  const f=fixture(version);
  if(version==='v2'){
    f.summary.encrypted_content='ocx1:!!!!';
    ((f.parsed._rawBody as {input:Array<Record<string,unknown>>}).input[0]!).encrypted_content='ocx1:!!!!';
  }else{
    f.summary.content=[{type:'input_text',text:SUMMARY_PREFIX+'\n   '}];
    ((f.parsed._rawBody as {input:Array<Record<string,unknown>>}).input[0]!).content=structuredClone(f.summary.content);
  }
  f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})).toBeUndefined();
});
test('native retained user images remain structured content in the recovered instruction',()=>{
  const f=fixture();
  (f.source.internal_chat_message_metadata_passthrough.content_item_kinds as string[]).push('user.image');
  (f.source.content as Array<Record<string,unknown>>).push({type:'input_image',image_url:png,detail:'low'});
  f.write();expect(recoverCompactionInstruction(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home})?.source.content).toEqual(f.source.content);
});

test.each([
  ['no-installed-checkpoint','checkpoint_not_installed'],
  ['wrong-summary','checkpoint_identity_conflict'],
  ['conflicting-source','source_identity_conflict'],
] as const)('retry provenance reports bounded diagnostic %s without authenticating an invalid checkpoint', (change, expected) => {
  const f = fixture();
  if (change === 'no-installed-checkpoint') f.records.splice(1, 1);
  if (change === 'wrong-summary') f.summary.encrypted_content = encodeCompactionSummary('Not the request checkpoint.');
  if (change === 'conflicting-source') {
    (f.parsed._rawBody as {input:unknown[]}).input.push({
      ...f.source, content: [{type:'input_text', text:'Conflicting task'}],
    });
  }
  f.write();
  const diagnostics:string[] = [];
  const recovered = resolveNativeCompactionSource(f.parsed, extractChatGptTurnIdentity(f.parsed), {
    codexHome:f.home, onDiagnostic:code=>diagnostics.push(code),
  });
  expect(recovered).toBeUndefined();
  expect(diagnostics).toContain(expected);
});

test.each([
  ['foreign-turn','latest_turn_mismatch'],
  ['foreign-model','model_effort_mismatch'],
  ['foreign-effort','model_effort_mismatch'],
] as const)('retry provenance categorizes a rejected native %s without bypassing the rollout witness', (change, expected) => {
  const f = fixture();
  const ctx = f.records[2]!.payload as Record<string,unknown>;
  ctx[change === 'foreign-turn' ? 'turn_id' : change === 'foreign-model' ? 'model' : 'effort'] =
    change === 'foreign-turn' ? randomUUID() : change === 'foreign-model' ? 'chatgpt-web/gpt-6-pro' : 'medium';
  f.write();
  const diagnostics:string[] = [];
  expect(() => resolveNativeCompactionSource(f.parsed, extractChatGptTurnIdentity(f.parsed), {
    codexHome:f.home, onDiagnostic:code=>diagnostics.push(code),
  })).toThrow('Replay provenance is unverified');
  expect(diagnostics).toContain(expected);
});

function goalContinuationFixture() {
  const f = fixture();
  const goal = {
    type: 'message', role: 'user', id: 'msg_native_goal_resume',
    content: [{type:'input_text',text:'<codex_internal_context source="goal">Continue the active goal</codex_internal_context>'}],
    internal_chat_message_metadata_passthrough: {turn_id:f.turn},
  };
  const body=f.parsed._rawBody as {input:unknown[];client_metadata:Record<string,string>};
  body.input=[structuredClone(f.source),structuredClone(f.summary),structuredClone(goal)];
  const previous=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...previous,request_kind:'turn'});
  f.records.splice(1,1,
    {type:'response_item',payload:structuredClone(f.source)},
    {type:'event_msg',payload:{type:'task_started',turn_id:f.turn}},
    {type:'response_item',payload:structuredClone(goal)},
  );
  f.write();
  return {...f,goal};
}

test('goal resume authenticates an older user instruction only across the exact native task boundary',()=>{
  const f=goalContinuationFixture();
  const prior=process.env.CODEX_HOME;
  process.env.CODEX_HOME=f.home;
  try {
    expect(extractChatGptTurnUserRevision(f.parsed)).toEqual(f.source.content);
  } finally {
    if(prior===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=prior;
  }
});

test.each(['missing-native-goal','changed-goal-content','changed-source-content','newer-instruction','foreign-native-turn'] as const)(
  'goal resume refuses missing or conflicting native evidence: %s',change=>{
  const f=goalContinuationFixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  if(change==='missing-native-goal')f.records.splice(3,1);
  if(change==='changed-goal-content'){
    (body.input.at(-1)!.content as Array<{text:string}>)[0]!.text=
      '<codex_internal_context source="goal">Different goal</codex_internal_context>';
  }
  if(change==='changed-source-content'){
    (body.input[0]!.content as Array<{text:string}>)[0]!.text='Wrong historical task';
  }
  if(change==='newer-instruction'){
    f.records.splice(2,0,{type:'response_item',payload:{
      ...structuredClone(f.source),id:'msg_newer_task',
      content:[{type:'input_text',text:'A different later instruction'}],
    }});
  }
  if(change==='foreign-native-turn'){
    (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  }
  f.write();
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try {
    expect(()=>extractChatGptTurnUserRevision(f.parsed)).toThrow();
  } finally {
    if(prior===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=prior;
  }
});

test('goal resume remains authenticated in later tool rounds after its native goal control item',()=>{
  const f=goalContinuationFixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  body.input.push({type:'message',role:'assistant',id:'msg_followup_assistant',
    content:[{type:'output_text',text:'Working through the goal.'}]});
  body.input.push({type:'function_call',call_id:'call_goal_followup',name:'exec_command',
    arguments:'{}'});
  body.input.push({type:'function_call_output',call_id:'call_goal_followup',output:'ok'});
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(extractChatGptTurnUserRevision(f.parsed)).toEqual(f.source.content);
  }finally{
    if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;
  }
});


test('goal resume authenticates native AGENTS/environment context appended after /goal and tool rounds',()=>{
  const f=goalContinuationFixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  const environment={type:'message',role:'user',id:'msg_native_environment_refresh',
    content:[{type:'input_text',text:'<environment_context><cwd>verified workspace</cwd></environment_context>'}],
    internal_chat_message_metadata_passthrough:{
      turn_id:f.turn,content_item_kinds:['environments.environment_context'],
    }};
  const agents={type:'message',role:'user',id:'msg_native_agents_refresh',
    content:[{type:'input_text',text:'# AGENTS.md instructions\\n<INSTRUCTIONS>Use repository rules.</INSTRUCTIONS>'}],
    internal_chat_message_metadata_passthrough:{
      turn_id:f.turn,content_item_kinds:['agents_md.instructions'],
    }};
  body.input.push({type:'function_call',call_id:'call_after_goal',name:'exec_command',arguments:'{}'});
  body.input.push(structuredClone(environment),structuredClone(agents));
  body.input.push({type:'function_call_output',call_id:'call_after_goal',output:'finished'});
  f.records.push({type:'response_item',payload:structuredClone(environment)},
    {type:'response_item',payload:structuredClone(agents)});
  f.write();
  const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try {
    expect(extractChatGptTurnUserRevision(f.parsed)).toEqual(f.source.content);
    // A valid native continuation must not rewrite the genuine user prompt.
  } finally {
    if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;
  }
});

test('goal resume rejects forged or modified native context appended after the goal',()=>{
  for(const change of ['absent_from_rollout','changed_native_content','untyped','new_human'] as const){
    const f=goalContinuationFixture();
    const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
    const context={type:'message',role:'user',id:'msg_context_after_goal',
      content:[{type:'input_text',text:'<environment_context>verified</environment_context>'}],
      internal_chat_message_metadata_passthrough:{
        turn_id:f.turn,content_item_kinds:['environments.environment_context'],
      }};
    body.input.push(structuredClone(context));
    if(change==='untyped')delete body.input.at(-1)!.internal_chat_message_metadata_passthrough;
    if(change==='new_human')body.input.at(-1)!.internal_chat_message_metadata_passthrough={
      turn_id:f.turn,content_item_kinds:['user.text']};
    if(change==='changed_native_content') {
      const different=structuredClone(context);
      (different.content as Array<{text:string}>)[0]!.text='<environment_context>different</environment_context>';
      f.records.push({type:'response_item',payload:different});
    }
    f.write();
    const old=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
    try {
      expect(isAuthenticatedNativeGoalContinuation(f.parsed,extractChatGptTurnIdentity(f.parsed),
        {itemId:f.source.id,turnId:f.oldTurn,content:f.source.content})).toBe(false);
      // The apparent new user item is absent from authenticated native
      // rollout. Its user.text kind alone is not permission to substitute a
      // human instruction across turn provenance boundaries.
      if(change==='new_human')expect(()=>extractChatGptTurnUserRevision(f.parsed))
        .toThrow("conflicts with native Codex turn_id metadata");
    } finally {if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;}
  }
});

test('goal resume cannot borrow the older instruction when a later raw user item supersedes goal',()=>{
  const f=goalContinuationFixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  body.input.push({type:'message',role:'assistant',id:'msg_followup_assistant',
    content:[{type:'output_text',text:'Previous tool response.'}]});
  body.input.push({type:'message',role:'user',id:'new_user_instruction',
    content:[{type:'input_text',text:'A different task.'}],
    internal_chat_message_metadata_passthrough:{turn_id:f.turn,content_item_kinds:['user.text']}});
  const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(isAuthenticatedNativeGoalContinuation(f.parsed,extractChatGptTurnIdentity(f.parsed),
      {itemId:f.source.id,turnId:f.oldTurn,content:f.source.content})).toBe(false);
  }finally{
    if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;
  }
});

test('goal continuation provenance fails closed for an untyped native user after the goal receipt',()=>{
  const f=goalContinuationFixture();
  f.records.splice(f.records.length-1,0,{type:'response_item',payload:{
    type:'message',role:'user',id:'untyped_after_goal',
    content:[{type:'input_text',text:'Potential newer instruction'}],
  }});
  f.write();
  const old=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(isAuthenticatedNativeGoalContinuation(f.parsed,extractChatGptTurnIdentity(f.parsed),
      {itemId:f.source.id,turnId:f.oldTurn,content:f.source.content})).toBe(false);
  }finally{
    if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;
  }
});

test('goal continuation provenance rejects a later native human instruction after goal receipt',()=>{
  const f=goalContinuationFixture();
  const later={type:'message',role:'user',id:'native_human_after_goal',
    content:[{type:'input_text',text:'New native task'}],
    internal_chat_message_metadata_passthrough:{turn_id:f.turn,content_item_kinds:['user.text']}};
  f.records.splice(f.records.length-1,0,{type:'response_item',payload:later});
  f.write();
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(isAuthenticatedNativeGoalContinuation(f.parsed,extractChatGptTurnIdentity(f.parsed),
      {itemId:f.source.id,turnId:f.oldTurn,content:f.source.content})).toBe(false);
  }finally{
    if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;
  }
});

test('fresh current-turn human input bypasses an unrelated stale checkpoint without borrowing its instruction',()=>{
  const f=goalContinuationFixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  const fresh={type:'message',role:'user',id:'msg_real_new',
    content:[{type:'input_text',text:'Start a new unrelated task'}],
    internal_chat_message_metadata_passthrough:{turn_id:f.turn}};
  body.input.push(fresh);
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try {
    expect(extractChatGptTurnUserRevision(f.parsed)).toEqual(fresh.content);
  } finally {
    if(prior===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=prior;
  }
});

test('standalone compact can authenticate the installed checkpoint against its last native source turn',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:unknown[];client_metadata:Record<string,string>};
  const meta=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...meta,request_kind:'compaction'});
  body.input.push(structuredClone(f.source));
  f.parsed._compactionRequest=true;
  // Codex has not yet emitted a turn_context for its standalone compact turn.
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=f.oldTurn;
  f.write();
  const recovered=resolveNativeCompactionSource(
    f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home});
  expect(recovered?.source.itemId).toBe(f.source.id);
});

test('an ordinary replay cannot claim a foreign latest native turn as a compaction source',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:unknown[]};
  body.input.push(structuredClone(f.source));
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=f.oldTurn;
  f.write();
  expect(()=>resolveNativeCompactionSource(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home}))
    .toThrow('latest_turn_mismatch');
});

test('a native goal fragment without an item turn owner is authenticated by its exact task boundary',()=>{
  const f=goalContinuationFixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  delete body.input.at(-1)!.internal_chat_message_metadata_passthrough;
  const native=f.records.find(record=>record.type==='response_item'
    && (record.payload as Record<string,unknown>)?.id==='msg_native_goal_resume')!;
  delete (native.payload as Record<string,unknown>).internal_chat_message_metadata_passthrough;
  f.write();
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try {
    expect(extractChatGptTurnUserRevision(f.parsed)).toEqual(f.source.content);
  } finally {
    if(prior===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=prior;
  }
});

test('an id-only new human message following a compact supersedes stale native provenance',()=>{
  const f=goalContinuationFixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  const fresh={type:'message',role:'user',id:'msg_id_only_fresh',
    content:[{type:'input_text',text:'Continue with this new instruction.'}]};
  body.input.push(fresh);
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try {
    expect(extractChatGptTurnUserRevision(f.parsed)).toEqual(fresh.content);
  } finally {
    if(prior===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=prior;
  }
});

test('standalone compact authenticates latest native user when the persisted turn_context belongs to a different turn',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:unknown[];client_metadata:Record<string,string>};
  const meta=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...meta,request_kind:'compaction'});
  body.input.push(structuredClone(f.source));
  f.parsed._compactionRequest=true;
  // The earlier user source is still the most recent native human instruction,
  // but neither its turn nor the compact turn equals the latest persisted context.
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const result=resolveNativeCompactionSource(f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home});
  expect(result?.source.itemId).toBe(f.source.id);
});

test.each(['different-source','newer-native-instruction','altered-source','wrong-current-model'] as const)(
  'standalone compact never borrows an obsolete native source when latest turn differs: %s',change=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:unknown[];client_metadata:Record<string,string>};
  const meta=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...meta,request_kind:'compaction'});
  body.input.push(structuredClone(f.source));
  f.parsed._compactionRequest=true;
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  if(change==='different-source'){
    const native=f.records[1]!.payload as Record<string,unknown>;
    native.id='msg_not_the_original_source';
  }
  if(change==='newer-native-instruction'){
    const newer=structuredClone(f.source);newer.id='msg_newer_task';
    newer.content=[{type:'input_text',text:'Newer unrelated user instruction'}];
    f.records.splice(2,0,{type:'response_item',payload:newer});
  }
  if(change==='altered-source'){
    const native=f.records[1]!.payload as Record<string,unknown>;
    native.content=[{type:'input_text',text:'Mutated native source'}];
  }
  if(change==='wrong-current-model'){
    (f.records.at(-1)!.payload as Record<string,unknown>).model='chatgpt-web/gpt-6-pro';
  }
  f.write();
  const diagnostics:string[]=[];
  expect(()=>{
    const source=resolveNativeCompactionSource(f.parsed,extractChatGptTurnIdentity(f.parsed),{
      codexHome:f.home,onDiagnostic:code=>diagnostics.push(code),
    });
    if(source!==undefined)throw new Error('Unexpectedly accepted a mismatched source');
  }).toThrow();
  expect(diagnostics).toContain(change==='wrong-current-model'?'model_effort_mismatch':'latest_turn_mismatch');
});

test('ordinary replay is not authorized by a latest-native-user compaction witness',()=>{
  const f=fixture();
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  (f.parsed._rawBody as {input:unknown[]}).input.push(structuredClone(f.source));
  f.write();
  expect(()=>resolveNativeCompactionSource(
    f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home},
  )).toThrow('latest_turn_mismatch');
});

test('standalone compact is never mistaken for the consumer of its earlier installed checkpoint',()=>{
  const f=fixture();
  f.parsed._compactionRequest=true;
  expect(isChatGptCompactionContinuation(f.parsed)).toBe(false);
});

test('an end-to-end compact source read survives a later turn_context when its native input is still the newest human message',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:unknown[];client_metadata:Record<string,string>};
  const meta=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...meta,request_kind:'compaction'});
  body.input.push(structuredClone(f.source));
  f.parsed._compactionRequest=true;
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  f.records.push({type:'response_item',payload:{
    type:'message',role:'user',id:'msg_goal_context',
    content:[{type:'input_text',text:'<codex_internal_context source="goal">Continue active goal</codex_internal_context>'}],
  }});
  f.records.push({type:'response_item',payload:{
    type:'message',role:'user',id:'msg_old_readable_summary',
    content:[{type:'input_text',text:SUMMARY_PREFIX+'\nEarlier verified compact summary.'}],
    internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']},
  }});
  (f.records[3]!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const previous=process.env.CODEX_HOME;
  process.env.CODEX_HOME=f.home;
  try{
    expect(extractChatGptCompactionSourceRevision(f.parsed)).toEqual({
      content:f.source.content,turnId:f.oldTurn,itemId:f.source.id,
    });
  }finally{
    if(previous===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=previous;
  }
});

test('standalone compact authenticates an ownerless latest native human preceding an old checkpoint',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[];client_metadata:Record<string,string>};
  const metadata=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...metadata,request_kind:'compaction'});
  const ownerless=structuredClone(f.source) as Record<string,unknown>;
  delete ownerless.internal_chat_message_metadata_passthrough;
  body.input.unshift(ownerless);
  f.parsed._compactionRequest=true;
  // Only the authentic native rollout, not an ID-only request, supplies the
  // real source owner. This remains valid even with a newer turn_context.
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(extractChatGptCompactionSourceRevision(f.parsed)).toEqual({
      content:f.source.content,itemId:f.source.id,
    });
  }finally{
    if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;
  }
});

test('ownerless native compact authenticates directly even when the old installed checkpoint is obsolete',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[];client_metadata:Record<string,string>};
  const metadata=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...metadata,request_kind:'compaction'});
  const ownerless=structuredClone(f.source) as Record<string,unknown>;
  delete ownerless.internal_chat_message_metadata_passthrough;
  body.input.unshift(ownerless);
  f.parsed._compactionRequest=true;
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  // This is explicitly NOT the checkpoint supplied in this new /compact.
  (f.ack.payload.replacement_history[1] as Record<string,unknown>).encrypted_content=
    encodeCompactionSummary('A previous installation, not this compaction checkpoint.');
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const prev=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(isAuthenticatedNativeCompactionSource(
      f.parsed,extractChatGptTurnIdentity(f.parsed),
      {itemId:f.source.id,content:f.source.content},
      {codexHome:f.home},
    )).toBe(true);
    expect(extractChatGptCompactionSourceRevision(f.parsed)).toEqual({
      itemId:f.source.id,content:f.source.content,
    });
  }finally{
    if(prev===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prev;
  }
});

test('ownerless compact does not accept an id match when the newest native content differs',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[];client_metadata:Record<string,string>};
  const metadata=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...metadata,request_kind:'compaction'});
  const ownerless=structuredClone(f.source) as Record<string,unknown>;
  delete ownerless.internal_chat_message_metadata_passthrough;
  body.input.unshift(ownerless);
  f.parsed._compactionRequest=true;
  const altered=structuredClone(f.source);
  altered.content=[{type:'input_text',text:'Not the real latest native human instruction.'}];
  f.records.splice(1,0,{type:'response_item',payload:altered});
  (f.ack.payload.replacement_history[1] as Record<string,unknown>).encrypted_content=
    encodeCompactionSummary('An obsolete installed checkpoint.');
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  expect(isAuthenticatedNativeCompactionSource(
    f.parsed,extractChatGptTurnIdentity(f.parsed),
    {itemId:f.source.id,content:f.source.content},
    {codexHome:f.home},
  )).toBe(false);
});

test('ownerless human compact source is rejected when newer native human supersedes it',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[];client_metadata:Record<string,string>};
  const metadata=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...metadata,request_kind:'compaction'});
  const ownerless=structuredClone(f.source) as Record<string,unknown>;
  delete ownerless.internal_chat_message_metadata_passthrough;
  body.input.unshift(ownerless);
  f.parsed._compactionRequest=true;
  const newer=structuredClone(f.source);newer.id='msg_subsequent_native_human';
  newer.content=[{type:'input_text',text:'A different newer instruction'}];
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)},
    {type:'response_item',payload:newer});
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(()=>extractChatGptCompactionSourceRevision(f.parsed)).toThrow('latest_turn_mismatch');
  }finally{
    if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;
  }
});

test('a later untyped native user item cannot silently reinstate the earlier compact source',()=>{
  const f=fixture();
  const body=f.parsed._rawBody as {input:unknown[];client_metadata:Record<string,string>};
  const meta=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...meta,request_kind:'compaction'});
  body.input.push(structuredClone(f.source));
  f.parsed._compactionRequest=true;
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)},
    {type:'response_item',payload:{
      type:'message',role:'user',id:'msg_untyped_new_task',
      content:[{type:'input_text',text:'A newer untyped request'}],
    }});
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  expect(()=>resolveNativeCompactionSource(f.parsed,extractChatGptTurnIdentity(f.parsed),{
    codexHome:f.home,
  })).toThrow('latest_turn_mismatch');
});

/** Regression: compact source is fresh native input, whereas the installed old
 * checkpoint may belong to an earlier completed handoff. */
function recompactAfterStaleCheckpoint() {
  const f=fixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[];client_metadata:Record<string,string>};
  const meta=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...meta,request_kind:'compaction'});
  body.input.push(structuredClone(f.source));
  f.parsed._compactionRequest=true;
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  // A prior completed compaction was installed, but is not the checkpoint
  // that will be produced by this latest explicit compact.
  (f.ack.payload.replacement_history[1] as Record<string,unknown>).encrypted_content=encodeCompactionSummary('Older installed summary, not the request summary.');
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  return f;
}
test('compact reads a newly authenticated historical-turn source before trying an obsolete checkpoint',()=>{
  const f=recompactAfterStaleCheckpoint();
  const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(extractChatGptCompactionSourceRevision(f.parsed)).toEqual({
      content:f.source.content,turnId:f.oldTurn,itemId:f.source.id,
    });
  }finally{
    if(previous===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=previous;
  }
});
test.each(['counterfeit-source','newer-human','wrong-request-kind','wrong-model'] as const)(
  'direct native compaction provenance rejects an invalid new source: %s',change=>{
  const f=recompactAfterStaleCheckpoint();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[];client_metadata:Record<string,string>};
  if(change==='counterfeit-source'){
    body.input.at(-1)!.content=[{type:'input_text',text:'A different instruction with the same id'}];
  }
  if(change==='newer-human'){
    const newer=structuredClone(f.source);
    newer.id='msg_later_native_human';
    newer.content=[{type:'input_text',text:'A later instruction superseding the source'}];
    f.records.splice(f.records.length-1,0,{type:'response_item',payload:newer});
  }
  if(change==='wrong-request-kind'){
    const meta=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
    body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...meta,request_kind:'turn'});
  }
  if(change==='wrong-model'){
    (f.records.at(-1)!.payload as Record<string,unknown>).model='chatgpt-web/gpt-6-pro';
  }
  f.write();
  const identity=extractChatGptTurnIdentity(f.parsed);
  expect(isAuthenticatedNativeCompactionSource(f.parsed,identity,{
    itemId:f.source.id,turnId:f.oldTurn,content:body.input.at(-1)!.content,
  },{codexHome:f.home})).toBe(false);
});
test('an accepted source on the exact same native turn can restore a source when stale checkpoint lookup fails',()=>{
  const f=fixture();
  f.parsed._compactionRequest=true;
  const nativeSource={content:[{type:'input_text',text:'Accepted native response source'}],turnId:f.turn,itemId:'msg_native_accepted'};
  f.parsed._trustedCompactionSource={
    threadId:f.thread,turnId:f.turn,modelId:f.parsed.modelId,reasoning:f.parsed.options.reasoning,
    revision:nativeSource,
  };
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=f.home;
  try{
    expect(extractChatGptCompactionSourceRevision(f.parsed)).toEqual(nativeSource);
    // An accepted browser witness is not interchangeable with another native turn.
    f.parsed._trustedCompactionSource={...f.parsed._trustedCompactionSource,turnId:randomUUID()};
    expect(()=>extractChatGptCompactionSourceRevision(f.parsed)).toThrow('Replay provenance is unverified');
  }finally{
    if(previous===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=previous;
  }
});

/** A stopped long-running goal may leave a standalone /compact request whose
 * newest human item has a native id but no item-level owner. The owning rollout
 * is the only authority allowed to resolve that owner, not the request itself. */
function ownerlessPostAbortCompact(){
  const f=fixture();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[];client_metadata:Record<string,string>};
  const metadata=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify({...metadata,request_kind:'compaction'});
  f.parsed._compactionRequest=true;
  const ownerless=structuredClone(f.source) as Record<string,unknown>;
  delete ownerless.internal_chat_message_metadata_passthrough;
  body.input.push(ownerless);
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  (f.records.at(-1)!.payload as Record<string,unknown>).turn_id=randomUUID();
  f.write();
  return f;
}

test('post-abort compact authenticates an ownerless input only through the latest exact native human',()=>{
  const f=ownerlessPostAbortCompact();
  expect(resolveNativeCompactionSource(
    f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home},
  )?.source).toEqual({content:f.source.content,turnId:f.oldTurn,itemId:f.source.id});
});
test.each(['altered-content','newer-human','missing-native-source','untyped-native-source','ordinary-replay'] as const)(
  'post-abort compact fails closed without latest native human proof: %s',change=>{
  const f=ownerlessPostAbortCompact();
  const body=f.parsed._rawBody as {input:Record<string,unknown>[]};
  if(change==='altered-content'){
    body.input.at(-1)!.content=[{type:'input_text',text:'Altered source'}];
  }
  if(change==='newer-human'){
    const newer=structuredClone(f.source);
    newer.id='msg_newer_human';
    newer.content=[{type:'input_text',text:'Newer task, not the compact source'}];
    f.records.splice(f.records.length-1,0,{type:'response_item',payload:newer});
  }
  if(change==='missing-native-source')f.records.splice(1,1);
  if(change==='untyped-native-source'){
    delete (f.records[1]!.payload as Record<string,unknown>).internal_chat_message_metadata_passthrough;
  }
  if(change==='ordinary-replay')f.parsed._compactionRequest=false;
  f.write();
  if(change==='ordinary-replay'){
    // An ordinary replay without an eligible current checkpoint may reject
    // by returning no authenticated source instead of raising a diagnostic.
    expect(resolveNativeCompactionSource(
      f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home},
    )).toBeUndefined();
  }else{
    expect(()=>resolveNativeCompactionSource(
      f.parsed,extractChatGptTurnIdentity(f.parsed),{codexHome:f.home},
    )).toThrow('latest_turn_mismatch');
  }
});

test('native compact mismatch diagnostics distinguish owner, content, newer instruction, and missing source',()=>{
  const f=fixture();
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  f.write();
  const check=(source:{id:string;turnId?:string;content:unknown})=>{
    const fd=openSync(f.file,'r');
    try{return diagnoseLatestNativeCompactionSource(fd,statSync(f.file).size,source);}
    finally{closeSync(fd);}
  };
  const exact={id:f.source.id,turnId:f.oldTurn,content:f.source.content};
  expect(check(exact)).toEqual({matches:true,reason:'matched'});
  expect(check({...exact,turnId:f.turn}).reason).toBe('native_source_owner_differs');
  expect(check({...exact,content:'tampered'}).reason).toBe('native_source_content_differs');
  expect(check({...exact,id:'unknown'}).reason).toBe('source_not_in_native_rollout');
  const later=structuredClone(f.source);later.id='newer_human';
  f.records.splice(2,0,{type:'response_item',payload:later});f.write();
  expect(check(exact).reason).toBe('superseded_by_newer_native_user');
});

test('native AGENTS, environment and open-page context kinds cannot supersede a verified human instruction',()=>{
  const f=fixture();
  const witness={id:f.source.id,turnId:f.oldTurn,content:f.source.content};
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)});
  for(const [i,kind] of ['agents_md.instructions','environments.environment_context',
    'additional_content.codex_apps_open_page'].entries()){
    f.records.splice(2+i,0,{type:'response_item',payload:{
      type:'message',role:'user',id:'native_context_'+i,
      // Ordinary prose must not be mistaken for an actual human instruction:
      content:[{type:'input_text',text:'System-injected context without an XML wrapper.'}],
      internal_chat_message_metadata_passthrough:{turn_id:f.turn,content_item_kinds:[kind]},
    }});
  }
  f.write();
  const fd=openSync(f.file,'r');
  try{
    expect(diagnoseLatestNativeCompactionSource(fd,statSync(f.file).size,witness))
      .toEqual({matches:true,reason:'matched'});
  }finally{closeSync(fd);}
});

test('an untyped native user between old and latest typed human does not invalidate the latest witness',()=>{
  const f=fixture();
  const older=structuredClone(f.source);older.id='earlier_human';
  f.records.splice(1,0,
    {type:'response_item',payload:older},
    {type:'response_item',payload:{type:'message',role:'user',id:'intervening_untyped',
      content:[{type:'input_text',text:'Unknown intermediate context.'}]}},
    {type:'response_item',payload:structuredClone(f.source)},
  );
  f.write();
  const fd=openSync(f.file,'r');
  try{
    expect(diagnoseLatestNativeCompactionSource(fd,statSync(f.file).size,
      {id:f.source.id,turnId:f.oldTurn,content:f.source.content}))
      .toEqual({matches:true,reason:'matched'});
  }finally{closeSync(fd);}
});

test('an unknown native kind after the latest typed instruction still fails closed',()=>{
  const f=fixture();
  f.records.splice(1,0,{type:'response_item',payload:structuredClone(f.source)},
    {type:'response_item',payload:{type:'message',role:'user',id:'unknown_context',
      content:[{type:'input_text',text:'Potential later human task.'}],
      internal_chat_message_metadata_passthrough:{turn_id:f.turn,content_item_kinds:['unknown.provider_kind']}}},
  );
  f.write();
  const fd=openSync(f.file,'r');
  try{
    expect(diagnoseLatestNativeCompactionSource(fd,statSync(f.file).size,
      {id:f.source.id,turnId:f.oldTurn,content:f.source.content}))
      .toEqual({matches:false,reason:'untyped_native_user_after_instruction'});
  }finally{closeSync(fd);}
});
