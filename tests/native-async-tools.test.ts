import {expect,test} from "bun:test";
import {NativeAsyncToolJobs,nativeAsyncToolScope,NATIVE_ASYNC_AUTO_WAIT_MS} from "../src/adapters/chatgpt-web/native-async-tools";
const tick=()=>new Promise<void>(r=>setTimeout(r,0));

test("auto MCP gateway preserves direct fast response and exact single dispatch",async()=>{
 let calls=0;
 const jobs=new NativeAsyncToolJobs<{content:{type:string;text:string}[];isError?:boolean}>();
 const ticket=jobs.start("turn_one","mcp__rea","mcp__rea__procedure_info",async()=>{
  calls++;return{content:[{type:"text",text:"ready"}]};
 });
 const resolved=await jobs.quick("turn_one",ticket.job_id,NATIVE_ASYNC_AUTO_WAIT_MS);
 expect(resolved).toEqual({content:[{type:"text",text:"ready"}]});
 expect(calls).toBe(1);
 expect(jobs.poll("turn_one",ticket.job_id).status).toBe("completed");
});

test("slow REA/Ghidra tool yields a job without abort and can be polled later",async()=>{
 let complete!:(result:{content:string[]})=>void;
 let executions=0;
 const jobs=new NativeAsyncToolJobs<{content:string[]}>();
 const receipt=jobs.start("turn_root_1","mcp__rea","mcp__rea__procedure_info",async()=>{
  executions++;return new Promise(resolve=>{complete=resolve;});
 });
 await tick();
 const pending=await jobs.quick("turn_root_1",receipt.job_id,0);
 expect(pending).toEqual(receipt);
 expect(jobs.poll("turn_root_1",receipt.job_id).status).toBe("running");
 expect(()=>jobs.start("turn_root_1","mcp__rea","mcp__rea__open_binary",async()=>({content:[]}))).toThrow("NATIVE_ASYNC_BUSY");
 // Independent MCP server is unaffected, even during the slow REA query.
 const other=jobs.start("turn_root_1","mcp__git","mcp__git__status",async()=>({content:["git"]}));
 expect(await jobs.quick("turn_root_1",other.job_id,100)).toEqual({content:["git"]});
 complete({content:["procedure returned"]});
 await tick();
 const done=jobs.poll("turn_root_1",receipt.job_id);
 expect(done.status).toBe("completed");
 expect(JSON.parse(done.chunk as string)).toEqual({content:["procedure returned"]});
 expect(done.next_offset).toBeNull();
 expect(executions).toBe(1);
});

test("job ownership is the exact Codex turn capability",async()=>{
 const jobs=new NativeAsyncToolJobs<{content:string[]}>();
 const job=jobs.start("turn_subagent_A","mcp__rea","mcp__rea__binary_overview",
   async()=>({content:["private result"]}));
 await tick();
 expect(()=>jobs.poll("turn_subagent_B",job.job_id)).toThrow("NATIVE_ASYNC_NOT_FOUND");
 expect(()=>jobs.quick("turn_subagent_B",job.job_id,0)).toThrow();
 expect(jobs.poll("turn_subagent_A",job.job_id).status).toBe("completed");
});

test("unverified native exception retains namespace lock without retry",async()=>{
 let attempts=0;
 const jobs=new NativeAsyncToolJobs<{isError?:boolean}>();
 const job=jobs.start("turn_uncertain","mcp__rea","mcp__rea__procedure_info",async()=>{
  attempts++;throw Error("lost native result");
 });
 await tick();
 expect(jobs.poll("turn_uncertain",job.job_id)).toMatchObject({
  status:"unknown",retryable:false,error:expect.stringContaining("OUTCOME_UNVERIFIED"),
 });
 expect(jobs.isBusy("turn_uncertain","mcp__rea")).toBe(true);
 expect(()=>jobs.start("turn_uncertain","mcp__rea","mcp__rea__procedure_info",async()=>({}))).toThrow("BUSY");
 expect(attempts).toBe(1);
});

test("bounded output chunks retain the original structured MCP content",async()=>{
 const jobs=new NativeAsyncToolJobs<{content:Array<{type:string;text:string}>}>();
 const job=jobs.start("turn_chonk","mcp__files","mcp__files__read",async()=>
  ({content:[{type:"text",text:"🙂".repeat(10000)}]}));
 await tick();
 let offset=0,contents="",iterations=0;
 do{
  const item=jobs.poll("turn_chonk",job.job_id,offset,3000);
  expect(item.status).toBe("completed");
  contents+=item.chunk as string;
  iterations++;
  if(item.next_offset===null)break;
  offset=item.next_offset as number;
 }while(iterations<100);
 expect(iterations).toBeGreaterThan(1);
 expect(JSON.parse(contents).content[0].text).toBe("🙂".repeat(10000));
});

test("namespaces group shared backends but keep independent services isolated",()=>{
 expect(nativeAsyncToolScope("mcp__rea__procedure_info")).toBe("mcp__rea");
 expect(nativeAsyncToolScope("mcp__rea__binary_overview")).toBe("mcp__rea");
 expect(nativeAsyncToolScope("server_tool","mcp__sakura")).toBe("mcp__sakura");
});
