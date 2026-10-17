import { defaultBrokerEndpoint, resolveBrokerEndpoint } from "../../config";
import { runChatGptMcpServer, type ChatGptMcpContract } from "./mcp-server";
import {NativeReaderPipeProvider} from './screen-observation';

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

export async function runChatGptMcpMain(args: string[]): Promise<void> {
  const remaining = [...args];
  const brokerSocketPath = resolveBrokerEndpoint(option(remaining, "--broker-socket", defaultBrokerEndpoint()));
  const requestedContract = option(remaining, "--contract", "native");
  const readerPipe=option(remaining,'--screen-observer-pipe','');
  const grantWireName=option(remaining,'--screen-observer-grant-tool','');
  if(Boolean(readerPipe)!==Boolean(grantWireName))throw new Error('Screen observer requires both an explicit reader pipe and native grant tool');
  if(readerPipe&&(requestedContract!=='native'||!/^mcp__[A-Za-z0-9_]+__swift_observer_reader_grant$/.test(grantWireName)))
    throw new Error('Screen observer requires Native2 contract and a configured Swift grant tool');
  if (requestedContract !== "native" && requestedContract !== "safe") {
    throw new Error(`--contract must be native or safe, received ${requestedContract}`);
  }
  if (remaining.length > 0) throw new Error(`Unknown MCP arguments: ${remaining.join(" ")}`);
  await runChatGptMcpServer({
    brokerSocketPath,
    contract: requestedContract as ChatGptMcpContract,
    ...(readerPipe?{screenObserver:{provider:new NativeReaderPipeProvider(readerPipe),grantWireName}}:{}),
  });
}
