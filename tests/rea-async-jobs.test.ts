import {expect,test} from "bun:test";
import {ReaAsyncJobs,REA_ASYNC_MAX_POLL_CHARS} from "../src/rea-async-jobs";

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const tools=new Set(["procedure_info","binary_overview","open_binary"]);

test("slow REA call yields one immediate job, polling does not dispatch twice",async()=>{
 let finish!:(value:unknown)=>void;
 let calls=0;
 const queue=new ReaAsyncJobs(tools,async()=>{
  calls++;
  return new Promise(resolve=>{finish=resolve;});
 });
 const receipt=queue.start("procedure_info",{address:"0x1000"});
 expect(receipt.job_id).toMatch(/^rea_job_[a-f0-9]{48}$/);
 expect(queue.poll(receipt.job_id).status).toBe("running");
 expect(()=>queue.start("binary_overview",{})).toThrow("REA_ASYNC_BUSY");
 await tick();
 expect(calls).toBe(1);
 finish({content:[{type:"text",text:"analysis complete"}]});
 await tick();
 const done=queue.poll(receipt.job_id);
 expect(done.status).toBe("completed");
 expect(JSON.parse(done.chunk as string).content[0].text).toBe("analysis complete");
 expect(done.next_offset).toBeNull();
 expect(calls).toBe(1);
});

test("completed REA result is chunked with exact next_offset",async()=>{
 const queue=new ReaAsyncJobs(tools,async()=>({content:[{type:"text",text:"x".repeat(20000)}]}));
 const receipt=queue.start("binary_overview",{});
 await tick();
 const first=queue.poll(receipt.job_id,0,4000);
 expect(first.status).toBe("completed");
 expect((first.chunk as string).length).toBe(4000);
 expect(first.next_offset).toBe(4000);
 const second=queue.poll(receipt.job_id,4000,REA_ASYNC_MAX_POLL_CHARS);
 expect(second.next_offset).toBe(16000);
 const third=queue.poll(receipt.job_id,16000,REA_ASYNC_MAX_POLL_CHARS);
 expect(third.next_offset).toBeNull();
 expect((first.chunk as string)+(second.chunk as string)+(third.chunk as string))
  .toHaveLength(third.total_chars as number);
});

test("unknown native outcome does not free capacity or rerun REA",async()=>{
 let calls=0;
 const queue=new ReaAsyncJobs(tools,async()=>{calls++;throw Error("MCP transport timeout");});
 const receipt=queue.start("procedure_info",{});
 await tick();
 expect(queue.poll(receipt.job_id)).toMatchObject({
  status:"unknown",error:expect.stringContaining("REA_OUTCOME_UNVERIFIED"),
 });
 expect(queue.active()).toBe(true);
 expect(()=>queue.start("binary_overview",{})).toThrow("REA_ASYNC_BUSY");
 expect(calls).toBe(1);
});

test("only exact discovered read-only REA tools are accepted",()=>{
 const queue=new ReaAsyncJobs(tools,async()=>({content:[]}));
 expect(()=>queue.start("open_binary",{})).toThrow("REA_ASYNC_UNSUPPORTED");
 expect(()=>queue.start("unknown_tool",{})).toThrow("REA_ASYNC_UNSUPPORTED");
 expect(queue.poll("rea_job_"+"0".repeat(48)).status).toBe("unknown");
 expect(()=>queue.poll("wrong-id")).toThrow("Invalid REA job ID");
});
