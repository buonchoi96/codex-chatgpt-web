/** Isolated real-Codex compaction semantics probe. Synthetic usage is NOT a recall benchmark. */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WEB_CONTEXT_POLICY, WEB_CONTEXT_CATALOG_POLICY } from '../src/web-context-policy';

const executable=resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the actual installed codex executable path');
const root=mkdtempSync(join(tmpdir(),'cgw-context-probe-'));
const environment:Record<string,string>={};
for(const name of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','USERPROFILE','LOCALAPPDATA','APPDATA'])
  if(process.env[name])environment[name]=process.env[name]!;
environment.CODEX_HOME=join(root,'codex');
mkdirSync(environment.CODEX_HOME);
const bundled=spawnSync(executable,['debug','models','--bundled'],{env:environment,encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:16*1024*1024});
if(bundled.status!==0)throw new Error('Isolated bundled catalog unavailable: '+bundled.stderr.slice(-1000));
const catalog=JSON.parse(bundled.stdout);
const template=catalog.models.find((model:{visibility?:string})=>model.visibility==='list');
if(!template)throw new Error('No native template');
const model={...template,slug:'chatgpt-web/context-probe',display_name:'Synthetic local context probe',
  supported_in_api:true,visibility:'list',tool_mode:null,context_window:WEB_CONTEXT_CATALOG_POLICY.contextWindow,
  max_context_window:WEB_CONTEXT_CATALOG_POLICY.contextWindow,effective_context_window_percent:WEB_CONTEXT_CATALOG_POLICY.effectiveContextWindowPercent,
  auto_compact_token_limit:WEB_CONTEXT_POLICY.autoCompactTokenLimit};
delete model.comp_hash;
if (process.argv[3]) model.context_window=model.max_context_window=Number(process.argv[3]);
if (process.argv[4]) model.effective_context_window_percent=Number(process.argv[4]);
const catalogFile=join(root,'catalog.json');
writeFileSync(catalogFile,JSON.stringify({models:[model]}));
const results:unknown[]=[];
try {
  for(const reportedTokens of [1000,244799,244800,258399,258400,258401,271999,272000]){
    let responses=0,compactRequests=0;const paths:string[]=[];const lastUserPrompts:string[]=[];
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
      const path=new URL(request.url).pathname;paths.push(path);
      if(path.endsWith('/compact')){
        compactRequests++;
        return Response.json({object:'response.compaction',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic checkpoint.'}]}],usage:{input_tokens:reportedTokens,output_tokens:0,total_tokens:reportedTokens}});
      }
      if(!path.endsWith('/responses'))return new Response('Fixture endpoint only',{status:404});
      const body=await request.json() as {input?:Array<{role?:string;content?:Array<{text?:string}>}>};
      const lastUser=body.input?.findLast(item=>item.role==='user');
      lastUserPrompts.push((lastUser?.content?.map(part=>part.text??'').join('\n')??'').slice(-400));
      responses++;
      const id=`resp_fixture_${responses}`;
      const output=responses===1 ? [{type:'function_call' as const,id:'fc_fixture',call_id:'call_fixture',name:'exec_command',arguments:JSON.stringify({cmd:'echo context-fixture',max_output_tokens:10})}]
        : [{type:'message' as const,id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'CONTEXT FIXTURE COMPLETE',annotations:[]}]}];
      const response={id,object:'response',created_at:1,status:'completed',model:model.slug,output,usage:{input_tokens:reportedTokens,output_tokens:0,total_tokens:reportedTokens}};
      const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]} },
        ...output.flatMap((item,output_index)=>[
          {type:'response.output_item.added',output_index,item:{...item,...(item.type==='function_call'?{arguments:''}:{content:[]})}},
          ...(item.type==='function_call'?[{type:'response.function_call_arguments.delta',output_index,item_id:item.id,delta:item.arguments},
            {type:'response.function_call_arguments.done',output_index,item_id:item.id,arguments:item.arguments}]:[
            {type:'response.content_part.added',output_index,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},
            {type:'response.output_text.delta',output_index,content_index:0,item_id:item.id,delta:'CONTEXT FIXTURE COMPLETE'},
            {type:'response.output_text.done',output_index,content_index:0,item_id:item.id,text:'CONTEXT FIXTURE COMPLETE'}]),
          {type:'response.output_item.done',output_index,item},
        ]),{type:'response.completed',response}];
      return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    }});
    try{
      if (process.argv[5]==='app-server') {
        const child=spawn(executable,['app-server','--stdio','-c',`model_catalog_json=${JSON.stringify(catalogFile)}`,
          '-c','model_provider="fixture"','-c',`model_providers.fixture={name="Local fixture",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false}`],
          {env:environment,cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
        // Closing stdin or signalling termination is not process settlement. Await close before
        // removing this child's CODEX_HOME, especially on Windows where live file handles lock it.
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        const lines=createInterface({input:child.stdout});const requests=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
        let sequence=0;let modelContextWindow:unknown;let completion:()=>void=()=>{};let stderr='';
        child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
        const finished=new Promise<void>(resolve=>{completion=resolve;});
        lines.on('line',line=>{
          const value=JSON.parse(line);
          if(value.id!==undefined){const pending=requests.get(value.id);if(pending){requests.delete(value.id);value.error?pending.reject(new Error(JSON.stringify(value.error))):pending.resolve(value.result);}}
          if(value.method==='thread/tokenUsage/updated')modelContextWindow=value.params?.tokenUsage?.modelContextWindow;
          if(value.method==='turn/completed')completion();
        });
        const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{
          const id=++sequence;requests.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');
        });
        const timer=setTimeout(()=>{child.kill();completion();for(const pending of requests.values())pending.reject(new Error('Isolated app-server probe timeout'));},20000);
        try {
          await rpc('initialize',{clientInfo:{name:'context-fixture',version:'1'},capabilities:{experimentalApi:true}});
          child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
          const thread=await rpc('thread/start',{cwd:root,model:model.slug,modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only',ephemeral:true});
          await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Run the harmless fixture echo once, then return the fixture final answer.'}]});
          await finished;
          results.push({reported_input_tokens:reportedTokens,responses,paths,model_context_window:modelContextWindow,
            local_compaction: lastUserPrompts.some(text=>text.includes('COMPACTION')),last_user_fixture_prompts:lastUserPrompts});
        } catch(error) {results.push({reported_input_tokens:reportedTokens,error:String(error),diagnostic:stderr.slice(-1000)});}
        finally {
          clearTimeout(timer);
          child.stdin.end();
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await closed;
          lines.close();
        }
        continue;
      }
      const child=Bun.spawn([executable,'exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--json','--color','never',
        '--sandbox','read-only','-C',root,'-c','approval_policy="never"','-c',`model_catalog_json=${JSON.stringify(catalogFile)}`,
        '-c','model_provider="fixture"','-c',`model_providers.fixture={name="Local fixture",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false}`,
        '-m',model.slug,'Run the harmless fixture echo once, then return the fixture final answer.'],{env:environment,stdout:'pipe',stderr:'pipe',stdin:'ignore'});
      const timer=setTimeout(()=>child.kill(),20000);
      const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      clearTimeout(timer);
      results.push({reported_input_tokens:reportedTokens,responses,compact_requests:compactRequests,paths,last_user_fixture_prompts:lastUserPrompts,exit,
        completed:stdout.includes('CONTEXT FIXTURE COMPLETE'),diagnostic:exit===0?undefined:stderr.slice(-1000)});
    }finally{server.stop(true);}
  }
  console.log(JSON.stringify({boundary:'real installed Codex with loopback synthetic Responses usage; excludes browser/recall',policy:WEB_CONTEXT_POLICY,
    catalog:{context_window:model.context_window,effective_context_window_percent:model.effective_context_window_percent,auto_compact_token_limit:model.auto_compact_token_limit},results},null,2));
}finally{
  // Root is an exact mkdtemp result owned by this probe; never touch a pre-existing CODEX_HOME.
  rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
