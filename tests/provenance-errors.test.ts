import {expect,test} from 'bun:test';
import {extractChatGptTurnUserRevision,MissingTrustedCodexEnvironmentError} from '../src/adapters/chatgpt-web/environment';
import {ChatGptWebAdapterError} from '../src/adapters/chatgpt-web/adapter-error';
import {parseRequest} from '../src/responses/parser';
import {responseRequest} from '../src/server';
import {defaultConfig} from '../src/config';
import {chatGptTurnExecutionKey,chatGptTurnRoundKey,chatGptTurnRetryKey,chatGptInstructionLineage} from '../src/adapters/chatgpt-web/turn-execution';
import {ChatGptThreadEnvironmentStore} from '../src/adapters/chatgpt-web/thread-environment';
import {resolve} from 'node:path';

function request(turn=true){return parseRequest({model:'chatgpt-web/high',stream:true,
  client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'test_thread',...(turn?{turn_id:'test_turn'}:{})})},
  input:[{type:'message',role:'user',id:'goal_fragment',content:[{type:'input_text',
    text:'<codex_internal_context source="goal">Continue the active goal</codex_internal_context>'}]}]});}
test('missing trusted environment exposes a nonretryable provenance error without claiming filesystem authority',()=>{
  const error=new MissingTrustedCodexEnvironmentError('cwd');
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({code:'TRUSTED_CWD_MISSING_OR_UNVERIFIED',status:400,retryable:false});
  expect(error.message).toContain('missing cwd');
  expect(error.message).toContain('authentic Codex');
});
function environmentRequest(){const root=resolve(process.cwd());return parseRequest({model:'chatgpt-web/high',
  client_metadata:{'x-codex-turn-metadata':JSON.stringify({request_kind:'turn',thread_id:'thread_authority',turn_id:'turn_authority',
    sandbox:'none',workspaces:{[root]:{has_changes:true}}})},
  input:[{type:'message',role:'user',id:'msg_authority_context',content:[{type:'input_text',text:
    `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`}]},
    {type:'message',role:'user',id:'msg_authority_user',content:[{type:'input_text',text:'Inspect the workspace'}]}]});}
test('cache reads do not renew the lifetime of previously verified filesystem authority',()=>{
  let now=1000;const store=new ChatGptThreadEnvironmentStore(undefined,()=>now);
  const initial=environmentRequest();expect(store.resolve(initial).cwd).toBe(resolve(process.cwd()));
  const followup=environmentRequest();(followup._rawBody as {input:unknown[]}).input=[{type:'message',role:'user',id:'msg_followup',
    content:[{type:'input_text',text:'Continue'}]}];
  now+=29*24*60*60_000;expect(store.resolve(followup).cwd).toBe(resolve(process.cwd()));
  now+=2*24*60*60_000;expect(()=>store.resolve(followup)).toThrow('missing cwd');
});
test('a malformed current workspace declaration cannot fall back to cached authority',()=>{
  const store=new ChatGptThreadEnvironmentStore();store.resolve(environmentRequest());
  const followup=environmentRequest(),body=followup._rawBody as {input:unknown[];client_metadata:Record<string,string>};
  body.input=[{type:'message',role:'user',id:'msg_followup',content:[{type:'input_text',text:'Continue'}]}];
  const metadata=JSON.parse(body.client_metadata['x-codex-turn-metadata']!);metadata.workspaces=['invalid-root-list'];
  body.client_metadata['x-codex-turn-metadata']=JSON.stringify(metadata);
  expect(()=>store.resolve(followup)).toThrow();
});
test('every replay identity boundary preserves the typed nonretryable failure',()=>{
  for(const key of [chatGptTurnExecutionKey,chatGptTurnRoundKey,chatGptTurnRetryKey]){
    let error:unknown;try{key(request(false));}catch(caught){error=caught;}
    expect(error).toMatchObject({code:'REPLAY_PROVENANCE_UNVERIFIED',retryable:false});
  }
  let lineageError:unknown;try{chatGptInstructionLineage(request());}catch(caught){lineageError=caught;}
  expect(lineageError).toMatchObject({code:'CURRENT_TURN_USER_REVISION_MISSING',retryable:false});
});
test.each([true,false])('HTTP rejects repeated invalid replay before constructing any browser adapter: metadata %s',async turn=>{
  let constructions=0;
  const body=request(turn)._rawBody;
  for(let attempt=0;attempt<2;attempt++){
    const response=await responseRequest(new Request('http://127.0.0.1/v1/responses',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    }),defaultConfig('browser-only'),()=>{++constructions;throw new Error('Browser must remain untouched');});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:{code:turn?'CURRENT_TURN_USER_REVISION_MISSING':'REPLAY_PROVENANCE_UNVERIFIED'}});
  }
  expect(constructions).toBe(0);
});
test.each([true,false])('goal-only replay has a typed nonretryable fault before browser work: turn metadata %s',turn=>{
  let error:unknown;try{extractChatGptTurnUserRevision(request(turn));}catch(caught){error=caught;}
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({code:turn?'CURRENT_TURN_USER_REVISION_MISSING':'REPLAY_PROVENANCE_UNVERIFIED',status:400,retryable:false});
  expect((error as Error).message).not.toContain('test_thread');
  expect((error as Error).message).not.toContain('Continue the active goal');
});
