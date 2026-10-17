import {expect,test} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createChatGptMcpServer} from '../src/adapters/chatgpt-web/mcp-server';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ARCHIVE_READ_CONTROL_WIRE_NAME,createArchiveReadProof} from '../src/adapters/chatgpt-web/archive-read-proof';

test('Native2 validates archive ingestion inside the current MCP response without another browser task or outer tool',async()=>{
  const broker=TurnBroker.forSocket(defaultBrokerEndpoint(join(process.platform === 'win32' ? tmpdir() : '/tmp', `cgw-ac-${crypto.randomUUID()}`)));
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,transport:serverTransport});
  const client=new Client({name:'archive-control-fixture',version:'1'});
  await client.connect(clientTransport);
  try{
    const token=await broker.register({cwd:process.cwd(),roots:[process.cwd()],writableRoots:[],
      sandboxPolicy:{type:'readOnly',networkAccess:false},tools:[{name:'fixture_read',description:'Read an inert fixture',parameters:{}}]});
    const proof=createArchiveReadProof('Historical fixture text absent from the live inline capability.',12,2);
    await broker.requireArchiveRead(token,proof);
    const invalid=await client.callTool({name:'codex_tool_call',arguments:{turn_token:token,
      wire_name:ARCHIVE_READ_CONTROL_WIRE_NAME,arguments:{...proof,image_count:4}}});
    expect(invalid.isError).toBe(true);
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    const valid=await client.callTool({name:'codex_tool_call',arguments:{turn_token:token,
      wire_name:ARCHIVE_READ_CONTROL_WIRE_NAME,arguments:{...proof}}});
    expect(valid.isError).not.toBe(true);
    expect(valid.structuredContent).toEqual({confirmed:true,duplicate:false});
    await broker.waitForArchiveRead(token);
    // The read-control receipt is handled locally by Native2, not an outer native invocation.
    expect(broker.beginCompletionFence(token)).toBeNumber();
  }finally{await client.close();await server.close();await broker.close();}
});
