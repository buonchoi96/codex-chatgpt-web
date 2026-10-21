import {expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {callTurnBroker,TurnBroker,type BrokerToolResult} from "../src/adapters/chatgpt-web/turn-broker";
import {defaultBrokerEndpoint} from "../src/config";

test("a second native command cannot time out in an undeliverable queue behind an active REA call",async()=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,"cgw-mcp-queue-"));
 const broker=TurnBroker.forSocket(defaultBrokerEndpoint(root));
 try{
  const token=await broker.register({
   cwd:root,roots:[root],writableRoots:[root],
   sandboxPolicy:{type:"dangerFullAccess"},
   tools:[{namespace:"mcp__rea",name:"binary_overview",description:"Slow REA fixture",parameters:{}}],
  },undefined,"mcp-queue-guard");
  const {bindingId}=await callTurnBroker<{bindingId:string}>(broker.socketPath,{
   method:"claim",token,contract:"native",
  });
  // Deliver the original REA job exactly once and leave its result unresolved.
  const delivery=broker.nextToolBatch(token);
  const first=callTurnBroker<BrokerToolResult>(broker.socketPath,{
   method:"invoke",bindingId,wireName:"mcp__rea__binary_overview",arguments:{},
  },null);
  const [rea]=await delivery;
  expect(rea?.wireName).toBe("mcp__rea__binary_overview");

  // No browser waiter exists until the REA round settles. The 90-second
  // transport watchdog must never begin for this undispatchable exec.
  const second=await callTurnBroker<BrokerToolResult>(broker.socketPath,{
   method:"invoke",bindingId,wireName:"exec_command",arguments:{cmd:"echo should-not-run"},
  },1_000);
  expect(second.isError).toBe(true);
  expect(second.structuredContent).toMatchObject({
   code:"native_tool_not_dispatched",
   tool:"exec_command",execution_state:"not_started",retryable:false,
  });
  // The previous REA operation remains pending and can be completed normally.
  broker.completeTool(token,rea!.callId,{
   content:[{type:"text",text:"Ghidra finished"}],
   structuredContent:{finished:true},
  });
  expect((await first).structuredContent).toEqual({finished:true});

  // After the REA call settles, a fresh native request can still be delivered.
  const resumedDelivery=broker.nextToolBatch(token);
  const resumed=callTurnBroker<BrokerToolResult>(broker.socketPath,{
   method:"invoke",bindingId,wireName:"exec_command",arguments:{cmd:"echo permitted"},
  },null);
  const [command]=await resumedDelivery;
  expect(command?.wireName).toBe("exec_command");
  expect(command?.arguments).toEqual({cmd:"echo permitted"});
  broker.completeTool(token,command!.callId,{
   content:[{type:"text",text:"permitted"}],
  });
  expect((await resumed).isError).not.toBe(true);
 }finally{
  await broker.close();
  const actual=realpathSync(root);
  if(actual!==resolve(root)||dirname(actual)!==parent||!basename(actual).startsWith("cgw-mcp-queue-"))
   throw Error("Refusing non-owned test directory cleanup");
  rmSync(actual,{recursive:true,force:true});
 }
});
