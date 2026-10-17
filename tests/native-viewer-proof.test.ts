import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {execGatewayProgram} from '../src/adapters/chatgpt-web/mcp-server';
import {NativeViewerProofGuard,NativeViewerReceiptCollector,extractViewerMetadataMarker,validateViewerInvocation,withViewerDeadline} from '../scripts/native-viewer-proof';

const path='C:\\owned\\fixture.png',marker=`codex-tool-result:${'a'.repeat(48)}:`;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
const jpeg='/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABgAGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyeiiivyw/vUKKKKACiiigD02iiisj/GIKKKKACiiigDzKiiitT/Z0KKKKACiiigD02iiisj/GIKKKKACiiigDzKiiitT/AGdCiiigAooooA9NooorI/xiCiiigAooooA8Xooor/Ss/UwooooAKKKKAP0wooor/DQ/qIKKKKACiiigD8z6KKK/3LP5dCiiigAooooA/TCiiiv8ND+ogooooAKKKKAPzPooor/cs/l0KKKKACiiigD9MKKKK/w0P6iCiiigAooooA//2Q==';
const image=(data=png,mime='image/png')=>({type:'input_image',image_url:`data:${mime};base64,${data}`});
const call=(id='call-viewer')=>({type:'function_call',call_id:id,name:'view_image',arguments:JSON.stringify({path,detail:'original'})});
const output=(id='call-viewer',blocks:unknown[]=[image()])=>({type:'function_call_output',call_id:id,output:blocks});
const program=(detail='original')=>execGatewayProgram('view_image',false,{arguments:{path,detail}},['exec'],marker);
const nestedCall=()=>({type:'custom_tool_call',call_id:'call-nested',name:'exec',input:program()});
const nestedOutput=(metadata:unknown={version:1,mcp:false})=>({type:'custom_tool_call_output',call_id:'call-nested',output:[image(),
 {type:'input_text',text:marker+JSON.stringify(metadata)}]});
const agent=(threadId='thread-owned',turnId='turn-owned',text:unknown='{"fixture":"answer"}')=>({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text}}});
const completed=(threadId='thread-owned',id='turn-owned',status='completed')=>({method:'turn/completed',params:{threadId,turn:{id,status,error:null}}});
function guard(){const value=new NativeViewerProofGuard();value.bindThread('thread-owned');value.bindTurn('turn-owned');return value;}

test('only matched native agent text and successful completion can complete the proof',()=>{
 const value=guard();value.onNativeNotification(agent());expect(()=>value.assertCompleted()).toThrow();
 value.onNativeNotification(completed());expect(value.assertCompleted()).toBe('{"fixture":"answer"}');
 value.childClosed();expect(value.assertCompleted()).toBe('{"fixture":"answer"}');
});
test('child exit before matched completion is permanently failed even after later valid success',()=>{
 const value=guard();value.onNativeNotification(agent());value.childClosed();value.onNativeNotification(completed());
 expect(()=>value.assertCompleted()).toThrow();expect(value.failureCode).toBe('NATIVE_CHILD_CLOSED_EARLY');
});
test('foreign or stale agent messages and turn completions cannot provide proof',()=>{
 const value=guard();value.onNativeNotification(agent('other'));value.onNativeNotification(agent('thread-owned','old'));
 value.onNativeNotification(completed('other'));value.onNativeNotification(completed('thread-owned','old'));
 expect(()=>value.assertCompleted()).toThrow();value.onNativeNotification(completed());
 expect(()=>value.assertCompleted()).toThrow();
 value.onNativeNotification(agent());expect(value.assertCompleted()).toBe('{"fixture":"answer"}');
});
test.each(['HTTP_ERROR','STREAM_ERROR','RPC_ERROR'])('first %s failure remains sticky through later completion and a later failure',code=>{
 const value=guard();value.fail(code);value.fail('LATER_ERROR');value.onNativeNotification(agent());value.onNativeNotification(completed());
 expect(value.failureCode).toBe(code);expect(()=>value.assertCompleted()).toThrow();
});
test.each([
 {method:'error',params:{message:'native failure'}},
 {id:3,error:{code:-1,message:'RPC failed'}},
 completed('thread-owned','turn-owned','failed'),
 {...completed(),params:{threadId:'thread-owned',turn:{id:'turn-owned',status:'completed',error:{message:'native error'}}}},
] as unknown[])('explicit native errors cannot be followed by a successful proof',notification=>{
 const value=guard();value.onNativeNotification(notification);value.onNativeNotification(agent());value.onNativeNotification(completed());
 expect(()=>value.assertCompleted()).toThrow();
});
test('agent text must be a real string on an agentMessage notification',()=>{
 const value=guard();value.onNativeNotification({method:'item/completed',params:{threadId:'thread-owned',turnId:'turn-owned',item:{type:'toolMessage',text:'fake'}}});
 value.onNativeNotification(agent('thread-owned','turn-owned',{text:'fake'}));value.onNativeNotification(completed());
 expect(()=>value.assertCompleted()).toThrow();
});
test('binding is immutable and pre-binding notifications cannot become evidence',()=>{
 const value=new NativeViewerProofGuard();value.onNativeNotification(agent());value.onNativeNotification(completed());
 value.bindThread('thread-owned');value.bindTurn('turn-owned');expect(()=>value.assertCompleted()).toThrow();
 expect(()=>value.bindThread('replacement')).toThrow();value.onNativeNotification(agent());value.onNativeNotification(completed());
 expect(()=>value.assertCompleted()).toThrow();
});

test.each(['original','high'])('direct and nested calls admit only the exact owned path with detail %s',detail=>{
 expect(validateViewerInvocation('view_image',{path,detail},'direct',path)).toMatchObject({route:'direct',path,detail});
 expect(validateViewerInvocation('exec',{input:program(detail)},'nested',path)).toMatchObject({route:'nested',path,detail,metadataMarker:marker});
});
test.each([
 ['exec',{input:'text("arbitrary")'},'direct'],
 ['exec_command',{cmd:'read fixture'},'direct'],
 ['view_image',{path:'C:\\other.png',detail:'original'},'direct'],
 ['view_image',{path,detail:'auto'},'direct'],
 ['view_image',{path},'direct'],
 ['view_image',{path,detail:'original',extra:true},'direct'],
 ['view_image',{path,detail:'original'},'nested'],
 ['exec',{input:program(),extra:true},'nested'],
 ['exec',{input:program()+'\ntext("extra");'},'nested'],
 ['exec',{input:program().replace('await nestedTool','await tools.exec_command')},'nested'],
 ['exec',{input:program().replace(path.replaceAll('\\','\\\\'),'C:\\\\wrong.png')},'nested'],
 ['exec',{input:program()+'\n'+program()},'nested'],
])('rejects extra tools, changed paths or arbitrary nested code: %j',(name,args,route)=>{
 expect(()=>validateViewerInvocation(name as string,args,route as 'direct'|'nested',path)).toThrow();
});
test('metadata marker is extracted only from one exact 48-hex control text statement',()=>{
 expect(extractViewerMetadataMarker(program())).toBe(marker);
 for(const input of [`const x = "${marker}";`,program()+`\ntext("${marker}" + JSON.stringify(relayMetadata));`,
  program().replace('a'.repeat(48),'a'.repeat(47)),program().replace('a'.repeat(48),'g'.repeat(48))])
  expect(()=>extractViewerMetadataMarker(input)).toThrow();
});

test('correlated native receipts expose only MIME, size and digests; historical duplicates are idempotent',()=>{
 const value=new NativeViewerReceiptCollector('direct',path);
 const first=value.collect([call(),output()]);
 expect(first).toEqual([{mime:'image/png',bytes:70,sha256:createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'),
  callIdHash:createHash('sha256').update('call-viewer').digest('hex')}]);
 expect(value.collect([call(),output(),output()])).toEqual(first);expect(value.assertImageReceived()).toEqual(first);
 expect(JSON.stringify(value)).not.toContain(png);expect(JSON.stringify(first)).not.toContain('call-viewer');
 first[0]!.bytes=0;expect(value.assertImageReceived()[0]!.bytes).toBe(70);
});
test('nested receipts require both the validated custom call and matching successful control metadata',()=>{
 const value=new NativeViewerReceiptCollector('nested',path);
 value.observeInvocation(nestedCall());expect(value.collect([nestedOutput()])).toHaveLength(1);
 expect(value.assertImageReceived()[0]!.mime).toBe('image/png');
});

test.each([
  {type:'input_text',text:'Digits: 58271639'},
  {type:'input_text',text:'Digits: 5 8 2 7 1 6 3 9'},
  {type:'input_text',text:'{"answer":58271639}'},
])('non-image oracle leakage permanently invalidates an image-bearing result', block=>{
  const value=new NativeViewerReceiptCollector('direct',path,'58271639');
  expect(()=>value.collect([call(),output('call-viewer',[image(),block])])).toThrow('NATIVE_VIEWER_ORACLE_LEAK');
  expect(()=>value.assertImageReceived()).toThrow('NATIVE_VIEWER_ORACLE_LEAK');
  expect(JSON.stringify(value)).not.toContain('58271639');
});
test('oracle leakage through structured metadata is rejected',()=>{
  const value=new NativeViewerReceiptCollector('direct',path,'58271639');
  expect(()=>value.collect([call(),{...output(),_meta:{nested:{digits:'58271639'}}}])).toThrow('NATIVE_VIEWER_ORACLE_LEAK');
});
test.each([
  {blocks:[{type:'input_text',text:'58'},{type:'input_text',text:'271639'}]},
  {blocks:[{type:'input_text',text:'["5","8","2","7","1","6","3","9"]'}]},
])('fragmented non-pixel digits cannot supply the challenge oracle',({blocks})=>{
  const value=new NativeViewerReceiptCollector('direct',path,'58271639');
  expect(()=>value.collect([call(),output('call-viewer',[image(),...blocks])])).toThrow('NATIVE_VIEWER_ORACLE_LEAK');
});
test('numeric metadata fragments cannot supply the oracle',()=>{
  const value=new NativeViewerReceiptCollector('direct',path,'58271639');
  expect(()=>value.collect([call(),{...output(),_meta:{digits:[5,8,2,7,1,6,3,9]}}])).toThrow('NATIVE_VIEWER_ORACLE_LEAK');
});
test.each([
  {version:1,mcp:true,structuredContent:4},
  {version:1,mcp:true,structuredContent:[]},
  {version:1,mcp:true,_meta:'text'},
  {version:1,mcp:true,_meta:[]},
  {version:1,mcp:false,isError:false},
  {version:1,mcp:false,structuredContent:{}},
  {version:1,mcp:false,_meta:{}},
])('nested metadata must obey the actual MCP result shape',metadata=>{
  const value=new NativeViewerReceiptCollector('nested',path);
  expect(()=>value.collect([nestedCall(),nestedOutput(metadata)])).toThrow('INVALID_NATIVE_VIEWER_CONTROL_FRAME');
});
test('a complete native JPEG is admitted while a truncated JPEG cannot supply proof',()=>{
 const value=new NativeViewerReceiptCollector('direct',path);
 const receipts=value.collect([call(),output('call-viewer',[image(jpeg,'image/jpeg')])]);
 expect(receipts).toHaveLength(1);expect(receipts[0]!.mime).toBe('image/jpeg');expect(receipts[0]!.bytes).toBe(826);
 expect(receipts[0]!.sha256).toBe('a453979bcaac30b4c858d2197b5ec5428d576306086583de692c17c1f5b07401');
 const truncated=new NativeViewerReceiptCollector('direct',path);
 expect(()=>truncated.collect([call(),output('call-viewer',[image(Buffer.from(jpeg,'base64').subarray(0,-2).toString('base64'),'image/jpeg')])])).toThrow();
});
test.each([
 {input:[output()],code:'UNCORRELATED_NATIVE_VIEWER_OUTPUT'},
 {input:[output(),call()],code:'UNCORRELATED_NATIVE_VIEWER_OUTPUT'},
 {input:[call(),output('unrelated')],code:'UNCORRELATED_NATIVE_VIEWER_OUTPUT'},
 {input:[call(),{...output(),type:'custom_tool_call_output'}],code:'UNCORRELATED_NATIVE_VIEWER_OUTPUT'},
 {input:[call(),output('call-viewer',[])],code:'SINGLE_NATIVE_VIEWER_IMAGE_REQUIRED'},
 {input:[call(),output('call-viewer',[{type:'input_text',text:JSON.stringify([image()])}])],code:'SINGLE_NATIVE_VIEWER_IMAGE_REQUIRED'},
 {input:[{type:'message',role:'user',content:[image()]},call(),output()],code:'NON_TOOL_IMAGE_FORBIDDEN'},
 {input:[call(),{...output(),isError:true}],code:'NATIVE_VIEWER_ERROR'},
 {input:[call(),output(),call('second-call'),output('second-call')],code:'EXTRA_OR_CHANGED_NATIVE_VIEWER_CALL'},
 {input:[call(),output('call-viewer',[image(),image()])],code:'SINGLE_NATIVE_VIEWER_IMAGE_REQUIRED'},
])('rejects uncorrelated, absent, user, JSON-only or extra native tool images',({input,code})=>{
 const value=new NativeViewerReceiptCollector('direct',path);expect(()=>value.collect(input)).toThrow(code);
 expect(value.failureCode).toBe(code);
 expect(()=>value.assertImageReceived()).toThrow();
});
test('no images cannot be accepted as completed proof',()=>{
 const value=new NativeViewerReceiptCollector('direct',path);value.collect([call()]);expect(()=>value.assertImageReceived()).toThrow();
});
test('a final missing-image failure cannot later be replaced by success',()=>{
 const value=new NativeViewerReceiptCollector('direct',path);value.collect([call()]);
 expect(()=>value.assertImageReceived()).toThrow();expect(()=>value.collect([output()])).toThrow();
});
test('changed image bytes on the same call ID fail irreversibly',()=>{
 const value=new NativeViewerReceiptCollector('direct',path);value.collect([call(),output()]);
 const changed=Buffer.from(png,'base64');changed[45]^=1;
 expect(()=>value.collect([output('call-viewer',[image(changed.toString('base64'))])])).toThrow();
 expect(()=>value.collect([output()])).toThrow();expect(()=>value.assertImageReceived()).toThrow();
});
test.each([
 'data:image/png;base64,AQID',
 'data:image/png;base64,iVBORw0KGgo=',
 'data:image/jpeg;base64,/9j/',
 'data:image/jpeg;base64,'+png,
 'https://example.test/image.png',
 'data:image/png;base64,'+png.replace(/=+$/,''),
 'data:image/png;base64,'+Buffer.alloc(20*1024*1024+1).toString('base64'),
])('rejects malformed, truncated, MIME-mismatched and oversized image data',image_url=>{
 const value=new NativeViewerReceiptCollector('direct',path);
 expect(()=>value.collect([call(),output('call-viewer',[{type:'input_image',image_url}])])).toThrow();
});
test.each([{version:1,mcp:true,isError:true},{version:2,mcp:false},{version:1,mcp:false,structuredContent:{error:{code:'NATIVE_ERROR'}}}])('explicit nested error or invalid control metadata fails despite an image',metadata=>{
 const value=new NativeViewerReceiptCollector('nested',path);
 expect(()=>value.collect([nestedCall(),nestedOutput(metadata)])).toThrow();
});
test('nested missing or duplicate control frames cannot attest an image',()=>{
 for(const blocks of [[image()],[image(),{type:'input_text',text:marker+'{"version":1,"mcp":false}'},{type:'input_text',text:marker+'{"version":1,"mcp":false}'}]]){
  const value=new NativeViewerReceiptCollector('nested',path);
  expect(()=>value.collect([nestedCall(),{...nestedOutput(),output:blocks}])).toThrow();
 }
});

test('deadline bounds startup and disposes a resource that arrives after timeout',async()=>{
 let deliver!:(value:{owned:boolean})=>void,disposed=0;
 const pending=new Promise<{owned:boolean}>(resolve=>{deliver=resolve;});
 const result=withViewerDeadline(()=>pending,10,'fixture startup',undefined,async value=>{expect(value.owned).toBe(true);disposed++;});
 await expect(result).rejects.toThrow('fixture startup exceeded deadline');
 deliver({owned:true});await new Promise(resolve=>setTimeout(resolve,1));expect(disposed).toBe(1);
});
test('pre-aborted waits do not start an operation and live abort rejects without waiting for it',async()=>{
 const stop=new AbortController();stop.abort();let started=0;
 await expect(withViewerDeadline(async()=>{started++;},100,'fixture cleanup',stop.signal)).rejects.toThrow('cancelled');
 expect(started).toBe(0);
 const live=new AbortController();const result=withViewerDeadline(()=>new Promise<void>(()=>{}),100,'fixture await',live.signal);
 live.abort();await expect(result).rejects.toThrow('cancelled');
});
