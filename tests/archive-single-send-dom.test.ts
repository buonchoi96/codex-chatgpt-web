import {expect,test} from 'bun:test';
import {chromium,type Page} from 'playwright-core';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatGptBrowserWorker} from '../src/adapters/chatgpt-web/browser-worker';
import {CHATGPT_WEB_MODEL_ID} from '../src/adapters/chatgpt-web/model';
import {buildContextArchive} from '../src/adapters/chatgpt-web/context-archive';
import type {CompiledChatGptWebPrompt} from '../src/adapters/chatgpt-web/prompt';

const fixture=`<main id="history"></main><form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true" style="min-height:40px"></div><input type="file" multiple><div id="files"></div><button type="submit">Send</button></form>
<script>
window.submissions=[];window.archiveAck='';
const form=document.querySelector('form'),composer=document.querySelector('#prompt-textarea');
document.querySelector('input').onchange=async event=>{
 document.querySelector('#files').innerHTML='';
 for(const file of event.target.files){
  const tile=document.createElement('button');tile.type='button';tile.className='composer-attachment-surface';tile.setAttribute('aria-label',file.name);tile.textContent=file.name;document.querySelector('#files').append(tile);
  await fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:file.name,file_id:'fixture-file'})});
  if(window.dropConnector)composer.querySelector('[data-keyword]')?.remove();
 }
};
form.onsubmit=event=>{
 event.preventDefault();const index=window.submissions.length+1,text=composer.innerText;
 const selected=composer.querySelector('[data-keyword="Codex Native2 DEV"]');
 window.submissions.push({id:'fixture-user-'+index,connector:!!selected,zip:!!document.querySelector('#files [aria-label$=".zip"]'),liveCapability:text.includes('turn_'+ 'x'.repeat(32))});
 const history=document.querySelector('#history');
 for(const role of ['user','assistant']){
  const id='fixture-'+role+'-'+index,container=document.createElement('div');container.setAttribute('data-turn-id-container',id);
  const node=document.createElement('section');node.setAttribute('data-testid','conversation-turn-'+index+'-'+role);node.setAttribute('data-turn',role);node.setAttribute('data-turn-id',id);
  if(role==='assistant')node.innerHTML='<div class="markdown"></div><button data-testid="copy-turn-action-button">Copy</button>';
  if(role==='assistant')node.querySelector('.markdown').textContent=window.archiveAck;
  else node.textContent=text;
  container.append(node);history.append(container);
 }
 composer.innerHTML='';document.querySelector('#files').innerHTML='';document.querySelector('input').value='';
};
</script>`;

async function archiveDomFixture(dropConnector=false){
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>new URL(request.url).pathname==='/backend-api/files/process_upload_stream'
    ?new Response(JSON.stringify({event:'file.processing.completed',file_id:'fixture-file'})+'\n',{headers:{'content-type':'application/x-ndjson'}})
    :new Response(fixture,{headers:{'content-type':'text/html'}})});
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  const root=mkdtempSync(join(tmpdir(),'archive-one-message-'));
  try{
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.port}`);
    await page.evaluate(drop=>{(window as any).dropConnector=drop;},dropConnector);
    const archive=buildContextArchive(JSON.stringify({version:3,system:[],messages:[{role:'user',content:'Historical fixture task.'}]}),[],[]);
    const prepared:CompiledChatGptWebPrompt={text:'Read the attached history and execute the latest fixture task. Current capability: '+ 'turn_'+ 'x'.repeat(32),images:[],
      contextArchive:{name:archive.name,base64:Buffer.from(archive.bytes).toString('base64'),sha256:archive.sha256,
        manifestSha256:archive.manifestSha256,contextText:archive.contextText,acknowledgement:archive.acknowledgement}};
    await page.evaluate(ack=>{(window as any).archiveAck=ack;},archive.acknowledgement);
    const worker=ChatGptBrowserWorker.forProvider({adapter:'chatgpt-web',baseUrl:`fixture://${root}`,chatgptWeb:{
      browserDiagnosticsPath:root,appName:'Codex Native2 DEV',localToolsEnabled:true,solAvailable:true}}) as any;
    const attach=async(_page:Page,text:string,connector:boolean)=>{
      await page.locator('#prompt-textarea').evaluate((composer,options)=>{
        composer.innerHTML='';
        if(options.connector){const pill=document.createElement('span');pill.setAttribute('data-id','plugin:fixture');pill.setAttribute('data-keyword','Codex Native2 DEV');pill.contentEditable='false';pill.textContent='Codex Native2 DEV';composer.append(pill);}
        composer.append(document.createTextNode(options.text));
      },{text,connector});
    };
    // Substitute the external account picker/catalog only; file upload observation,
    // actual Send activation, DOM acceptance and response ownership use production code.
    worker.prepareChatSurface=async()=>page.locator('#prompt-textarea');
    worker.selectModelAndEffort=async()=>({effort:'high',displayLabel:'High',localTools:true,thinkEnabled:true});
    worker.attachPrompt=attach;worker.attachPromptWithCompactionRetry=attach;
    const failure=await worker.runBrowserTurn({traceId:'archive_one_send_fixture',modelId:CHATGPT_WEB_MODEL_ID,reasoning:'high',
      capabilities:{localToolsEnabled:true,solAvailable:true,extraHighAvailable:false,proAvailable:false},
      prepare:async()=>({...prepared,release(){}}),onTextDelta(){},
      onSubmitted:()=>{throw new Error('Fixture stopped after accepted task Send');}},undefined,page).then(()=>undefined,(error:unknown)=>error);
    return {failure,submissions:await page.evaluate(()=>(window as any).submissions)};
  }finally{await browser.close();server.stop(true);rmSync(root,{recursive:true,force:true});}
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('owned DOM receives ZIP, selected Native2 and live task in exactly one accepted user message',async()=>{
  const result=await archiveDomFixture();
  expect((result.failure as Error).message).toContain('Fixture stopped after accepted task Send');
  expect(result.submissions).toEqual([{id:'fixture-user-1',connector:true,zip:true,liveCapability:true}]);
},30000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('losing the selected Native2 connector during ZIP upload prevents every Send',async()=>{
  const result=await archiveDomFixture(true);
  expect(result.submissions).toEqual([]);
  expect(result.failure).toMatchObject({code:'connector_selection_lost',retryable:false});
},15000);
