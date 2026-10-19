import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {defaultBrokerEndpoint,defaultConfig} from '../src/config';
import {mcpCommand} from '../src/tunnel';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';

const grantWire='mcp__computer_use_swift__swift_observer_reader_grant';
const pipe=()=>`\\\\.\\pipe\\cgw_test_${randomUUID().replaceAll('-','')}_observer_v1`;
async function bounded<T>(pending:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Private MCP stdio deadline')),10000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function fixture(args:string[],check:(client:Client,turnToken:string)=>Promise<void>,advertiseGrant=true,
  generatedArgs?:(socket:string)=>string[]){
  const parent=realpathSync(process.platform==='win32'?tmpdir():'/tmp');
  const root=mkdtempSync(join(parent,'cgw-observer-'));
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(join(root,'broker')));
  let client:Client|undefined,transport:StdioClientTransport|undefined,stderr='';
  try{
    const appHome=join(root,'app'),codexHome=join(root,'codex');mkdirSync(appHome);mkdirSync(codexHome);
    const turnToken=await broker.register({cwd:root,roots:[root],writableRoots:[],sandboxPolicy:{type:'readOnly',networkAccess:false},
      tools:advertiseGrant
        ?[{namespace:'mcp__computer_use_swift',name:'swift_observer_reader_grant',description:'Grant an owned read-only fixture reader',parameters:{}}]
        :[{namespace:'mcp__fixture',name:'unrelated_read',description:'Unrelated read-only fixture tool',parameters:{}}]},30000,'observer-stdio');
    transport=new StdioClientTransport({command:process.execPath,
      args:generatedArgs?generatedArgs(broker.socketPath):
        [join(process.cwd(),'src/cli.ts'),'mcp','--broker-socket',broker.socketPath,...args],cwd:process.cwd(),
      env:{CODEX_CHATGPT_WEB_HOME:appHome,CODEX_HOME:codexHome},stderr:'pipe'});
    transport.stderr?.on('data',chunk=>{if(stderr.length<4000)stderr+=String(chunk).slice(0,4000-stderr.length);});
    client=new Client({name:'private-screen-observer-stdio',version:'1'});
    try{await bounded(client.connect(transport));}catch(error){
      // Keep only bounded local CLI diagnostics; no credentials, pixels or oracle are involved.
      throw new Error(`Private MCP startup rejected: ${stderr.slice(0,1000)}`,{cause:error});
    }
    await check(client,turnToken);
  }finally{
    const errors:unknown[]=[];
    for(const close of [()=>client?.close(),()=>transport?.close(),()=>broker.close()]){
      try{await close();}catch(error){errors.push(error);}
    }
    const canonical=realpathSync(root);
    if(canonical!==resolve(root)||dirname(canonical)!==parent||!basename(canonical).startsWith('cgw-observer-'))throw Error('Refusing non-owned cleanup');
    rmSync(canonical,{recursive:true,force:true});
    if(errors.length)throw new AggregateError(errors,'Private MCP cleanup failed');
  }
}

function unpackTunnelCommand(command:string):string[]{
  // The tunnel's Windows mcp.command format is a sequence of quoted arguments
  // with backslashes escaped inside each argument; observer options contain
  // no embedded quotation marks by construction.
  const fields=[...command.matchAll(/"((?:\\\\|[^"\\])*)"/g)];
  const decoded=fields.map(field=>field[1]!.replaceAll('\\\\','\\'));
  if(decoded.map(field=>'"'+field.replaceAll('\\','\\\\')+'"').join(' ')!==command)
    throw Error('Generated MCP command could not be round-tripped safely');
  return decoded;
}

test.skipIf(process.platform!=='win32')('Launcher-generated native observer startup reaches private MCP stdio without granting guessed access',async()=>{
  const observer={readerPipe:pipe(),grantWireName:grantWire};
  await fixture([],async(client,turnToken)=>{
    const tools=await bounded(client.listTools());
    expect(tools.tools.some(item=>item.name==='codex_screen_observe')).toBe(true);
    const result=await bounded(client.callTool({name:'codex_screen_observe',arguments:{
      turn_token:turnToken,reader_lease:'reader_'+'d'.repeat(64)}},undefined,{timeout:10000,maxTotalTimeout:10000}));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('SCREEN_READER_NOT_AUTHORIZED');
  },true,brokerSocket=>{
    const config=defaultConfig('full');
    config.browserInteractionMode='automatic';
    config.runtimeCommand=[process.execPath,join(process.cwd(),'src/cli.ts')];
    config.brokerSocketPath=brokerSocket;
    config.nativeScreenObserver=observer;
    const fields=unpackTunnelCommand(mcpCommand(config,'win32'));
    expect(fields.slice(0,2)).toEqual(config.runtimeCommand);
    expect(fields.slice(2,5)).toEqual(['mcp','--contract','native']);
    expect(fields.slice(5)).toEqual(['--broker-socket',brokerSocket,'--screen-observer-pipe',
      observer.readerPipe,'--screen-observer-grant-tool',grantWire]);
    return fields.slice(1);
  });
},30000);

test('default native MCP startup does not advertise an unconfigured observer',async()=>{
  await fixture(['--contract','native'],async client=>{
    const listed=await bounded(client.listTools());expect(listed.tools.some(t=>t.name==='codex_screen_observe')).toBe(false);
  });
},30000);

test.skipIf(process.platform!=='win32')('explicit local observer is listed but guessed leases cannot reach the provider',async()=>{
  await fixture(['--contract','native','--screen-observer-pipe',pipe(),'--screen-observer-grant-tool',grantWire],async(client,turnToken)=>{
    const listed=await bounded(client.listTools());expect(listed.tools.some(t=>t.name==='codex_screen_observe')).toBe(true);
    const result=await bounded(client.callTool({name:'codex_screen_observe',arguments:{turn_token:turnToken,reader_lease:'reader_'+'a'.repeat(64)}},undefined,{timeout:10000,maxTotalTimeout:10000}));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('SCREEN_READER_NOT_AUTHORIZED');
  });
},30000);

test.skipIf(process.platform!=='win32')('observer configuration is rejected before safe-contract startup',async()=>{
  await expect(fixture(['--contract','safe','--screen-observer-pipe',pipe(),'--screen-observer-grant-tool',grantWire],async()=>{throw Error('Unexpected safe observer startup');}))
    .rejects.toThrow('Private MCP startup rejected');
},30000);

test.skipIf(process.platform!=='win32')('configured observer rejects a current inventory without its native grant tool',async()=>{
  await fixture(['--contract','native','--screen-observer-pipe',pipe(),'--screen-observer-grant-tool',grantWire],async(client,turnToken)=>{
    const result=await bounded(client.callTool({name:'codex_screen_observe',arguments:{turn_token:turnToken,reader_lease:'reader_'+'b'.repeat(64)}},undefined,{timeout:10000,maxTotalTimeout:10000}));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('SCREEN_READER_NOT_AVAILABLE');
  },false);
},30000);

for(const readerPipe of ['\\\\.\\pipe\\bad name_observer_v1',pipe()+' ']){
  test.skipIf(process.platform!=='win32')('malformed local pipe is rejected before observer registration',async()=>{
    await expect(fixture(['--contract','native','--screen-observer-pipe',readerPipe,'--screen-observer-grant-tool',grantWire],async()=>{}))
      .rejects.toThrow('Private MCP startup rejected');
  },30000);
}
