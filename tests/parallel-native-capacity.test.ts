import {expect,test} from 'bun:test';
import {NativeCommandCapacity,isIndependentLiteralRead,runParallelNativeCommands} from '../src/adapters/chatgpt-web/parallel-native-commands';
import type {BrokerToolResult} from '../src/adapters/chatgpt-web/turn-broker';

const receipt=(structuredContent:Record<string,unknown>):BrokerToolResult=>({content:[],structuredContent});
const reads=(count:number)=>Array.from({length:count},(_,index)=>({cmd:`Get-Content -LiteralPath 'fixture-${index}.txt' -Raw`}));
function live(capacity:NativeCommandCapacity,owner:string,count=8,mode:'read'|'exclusive'='read'){
 const release=capacity.acquire(owner,count,mode);
 for(let index=0;index<count;index++)capacity.observeResult(owner,receipt({session_id:100+index}));
 release();
}

test('parallel runner itself retains eight ongoing session receipts after the batch finishes',async()=>{
 const capacity=new NativeCommandCapacity();
 await runParallelNativeCommands({owner:'stable-owner',commands:reads(8),capacity,
  invoke:async(_command,index)=>receipt({session_id:100+index})});
 expect(()=>capacity.acquire('stable-owner',2)).toThrow();
});

test('each live session releases exactly one slot only after its numeric exit_code poll, including zero',()=>{
 const capacity=new NativeCommandCapacity();live(capacity,'owner');
 expect(()=>capacity.acquire('owner',2)).toThrow();
 for(let index=0;index<8;index++){
  capacity.observeResult('owner',receipt({exit_code:index===0?0:7}),100+index);
  const release=capacity.acquire('owner',index+1);release();
  if(index<7)expect(()=>capacity.acquire('owner',index+2)).toThrow();
 }
 const release=capacity.acquire('owner',8);release();
});

test.each([undefined,null,'0',false,NaN,Infinity,-Infinity])('unknown or non-finite poll exit_code %s retains its session lease',exit_code=>{
 const capacity=new NativeCommandCapacity();live(capacity,'owner');
 capacity.observeResult('owner',receipt({exit_code}),100);
 expect(()=>capacity.acquire('owner',1)).toThrow();
 capacity.observeResult('owner',receipt({exit_code:0}),100);
 const release=capacity.acquire('owner',1);release();
});

test('a terminal receipt for a different session cannot settle the polled session',()=>{
 const capacity=new NativeCommandCapacity();live(capacity,'owner');
 capacity.observeResult('owner',receipt({session_id:999,exit_code:0}),100);
 expect(()=>capacity.acquire('owner',1)).toThrow();
});

test('duplicate ongoing receipts and repeated terminal polls neither double count nor free unrelated sessions',()=>{
 const capacity=new NativeCommandCapacity();live(capacity,'owner');
 capacity.observeResult('owner',receipt({session_id:100}));
 capacity.observeResult('owner',receipt({exit_code:0}),100);
 capacity.observeResult('owner',receipt({exit_code:0}),100);
 const release=capacity.acquire('owner',1);
 expect(()=>capacity.acquire('owner',1)).toThrow();release();
});

test('numeric terminal text receipts settle sessions while non-JSON stdout retains them',()=>{
 const capacity=new NativeCommandCapacity();live(capacity,'owner');
 capacity.observeResult('owner',{content:[{type:'text',text:'exit_code: 0'}]},100);
 expect(()=>capacity.acquire('owner',1)).toThrow();
 capacity.observeResult('owner',{content:[{type:'text',text:'{"exit_code":0}'}]},100);
 const release=capacity.acquire('owner',1);release();
});

test('mutable or opaque reservations are exclusive and cannot admit multiple commands',()=>{
 const capacity=new NativeCommandCapacity();
 expect(()=>capacity.acquire('owner',2,'exclusive')).toThrow();
 const exclusive=capacity.acquire('owner',1,'exclusive');
 expect(()=>capacity.acquire('owner',1,'read')).toThrow();
 expect(()=>capacity.acquire('owner',1,'exclusive')).toThrow();exclusive();
 const read=capacity.acquire('owner',1);
 expect(()=>capacity.acquire('owner',1,'exclusive')).toThrow();read();
});

test('an exclusive live session blocks reads until terminal proof and its parent reservation is released',()=>{
 const capacity=new NativeCommandCapacity(),release=capacity.acquire('owner',1,'exclusive');
 capacity.observeResult('owner',receipt({session_id:100}));
 capacity.observeResult('owner',receipt({exit_code:0}),100);
 expect(()=>capacity.acquire('owner',1,'read')).toThrow();release();
 const next=capacity.acquire('owner',1);next();
});

test('an exclusive session remains exclusive after release and unknown poll',()=>{
 const capacity=new NativeCommandCapacity();live(capacity,'owner',1,'exclusive');
 capacity.observeResult('owner',receipt({status:'unknown'}),100);
 expect(()=>capacity.acquire('owner',1,'read')).toThrow();
 capacity.observeResult('owner',receipt({exit_code:0}),100);
 const next=capacity.acquire('owner',8);next();
});

test('stable owner IDs keep the eight-session cap across capability rotation',()=>{
 const capacity=new NativeCommandCapacity();live(capacity,'stable-owner');
 // Both rotated request generations supply the same stable owner ID.
 expect(()=>capacity.acquire('stable-owner',2)).toThrow();
 const other=capacity.acquire('other-owner',8);other();
 capacity.observeResult('stable-owner',receipt({exit_code:0}),100);
 expect(()=>capacity.acquire('stable-owner',2)).toThrow();
});

test('storage refuses new owners at its bound without evicting uncertain live sessions',()=>{
 const capacity=new NativeCommandCapacity({maxOwners:2});
 live(capacity,'first');live(capacity,'second');
 expect(()=>capacity.acquire('third',1)).toThrow();
 expect(()=>capacity.acquire('first',1)).toThrow();
 for(let session=100;session<108;session++)capacity.observeResult('first',receipt({exit_code:0}),session);
 const third=capacity.acquire('third',1);third();
 expect(()=>capacity.acquire('second',1)).toThrow();
});

test('unreserved session receipts cannot grow an owner beyond eight or release an existing lease',()=>{
 const capacity=new NativeCommandCapacity();live(capacity,'owner');
 expect(()=>capacity.observeResult('owner',receipt({session_id:999}))).toThrow();
 expect(()=>capacity.acquire('owner',1)).toThrow();
});

test('dispatch exceptions retain uncertain capacity instead of automatically forgetting native execution',async()=>{
 const capacity=new NativeCommandCapacity();
 const result=await runParallelNativeCommands({owner:'owner',commands:reads(8),capacity,
  invoke:async()=>{throw new Error('Receipt lost after dispatch');}});
 expect(result.isError).toBe(true);
 expect((result.structuredContent as any).commands.every((item:any)=>item.execution==='unknown')).toBe(true);
 expect(()=>capacity.acquire('owner',1)).toThrow();
});

test('a completed sibling cannot reconcile another command whose dispatch receipt was lost',async()=>{
 const capacity=new NativeCommandCapacity();
 await runParallelNativeCommands({owner:'owner',commands:reads(2),capacity,invoke:async(_command,index)=>{
  if(index===0)throw new Error('Unknown dispatch');return receipt({exit_code:0});
 }});
 const rest=capacity.acquire('owner',7);
 expect(()=>capacity.acquire('owner',1)).toThrow();rest();
});

test('new live reads cannot consume a previously released uncertain lease',()=>{
 const capacity=new NativeCommandCapacity(),unknown=capacity.acquire('owner',1);
 unknown.retainUncertain();unknown();
 const fresh=capacity.acquire('owner',1);
 capacity.observeResult('owner',receipt({session_id:200}));fresh();
 const rest=capacity.acquire('owner',6);
 expect(()=>capacity.acquire('owner',1)).toThrow();rest();
 unknown.observeResult(receipt({exit_code:0}));
 const seven=capacity.acquire('owner',7);seven();
});

test('a released uncertain lease can transfer to a live session and settles only via positive poll',()=>{
 const capacity=new NativeCommandCapacity(),unknown=capacity.acquire('owner',1,'exclusive');
 unknown.retainUncertain();unknown();
 unknown.observeResult(receipt({status:'unknown'}));
 expect(()=>capacity.acquire('owner',1)).toThrow();
 unknown.observeResult(receipt({session_id:200}));
 expect(()=>capacity.acquire('owner',1)).toThrow();
 capacity.observeResult('owner',receipt({exit_code:0}),200);
 const next=capacity.acquire('owner',8);next();unknown();
 expect(()=>unknown.observeResult(receipt({session_id:201}))).toThrow();
});

test('a legacy observer can record a session before invoke subsequently loses its receipt',async()=>{
 const capacity=new NativeCommandCapacity();
 const result=await runParallelNativeCommands({owner:'owner',commands:reads(8),capacity,invoke:async(_command,index)=>{
  const output=receipt({session_id:100+index});capacity.observeResult('owner',output);
  if(index===7)throw new Error('Known session but callback receipt lost');return output;
 }});
 expect(result.isError).toBe(true);
 expect(()=>capacity.acquire('owner',1)).toThrow();
});

test('unreleased parent leases cannot grow owner storage without bound after child terminal polls',()=>{
 const capacity=new NativeCommandCapacity(),leases=[];
 for(let index=0;index<8;index++){
  leases.push(capacity.acquire('owner',1));
  capacity.observeResult('owner',receipt({session_id:100+index}));
  capacity.observeResult('owner',receipt({exit_code:0}),100+index);
 }
 expect(()=>capacity.acquire('owner',1)).toThrow();
 leases.forEach(release=>release());
 const next=capacity.acquire('owner',8);next();
});

test('new session observations require a matching outstanding reservation',()=>{
 const capacity=new NativeCommandCapacity();
 expect(()=>capacity.observeResult('owner',receipt({session_id:100}))).toThrow();
 const next=capacity.acquire('owner',8);next();
});

test('a terminal proof without session identity cannot settle one of several uncertain batch children',()=>{
 const capacity=new NativeCommandCapacity(),batch=capacity.acquire('owner',2);
 batch.retainUncertain(2);batch();
 expect(()=>batch.observeResult(receipt({exit_code:0}))).toThrow();
 const rest=capacity.acquire('owner',6);
 expect(()=>capacity.acquire('owner',1)).toThrow();rest();
});

test('a repeated identified terminal proof settles an uncertain batch child only once',()=>{
 const capacity=new NativeCommandCapacity(),batch=capacity.acquire('owner',2);
 batch.retainUncertain(2);batch();
 batch.observeResult(receipt({session_id:200,exit_code:0}));
 batch.observeResult(receipt({session_id:200,exit_code:0}));
 const rest=capacity.acquire('owner',7);
 expect(()=>capacity.acquire('owner',1)).toThrow();rest();
 batch.observeResult(receipt({session_id:201,exit_code:0}));
 const next=capacity.acquire('owner',8);next();
});

test.each([
 'Get-Content -LiteralPath \'fixture with spaces.txt\' -Raw',
 'Get-FileHash -LiteralPath fixture.txt -Algorithm SHA256',
 'cat fixture.txt', 'sha256sum fixture.txt',
 'rg -n -F needle src', 'rg --files src',
 'git --no-optional-locks status --short',
 'git --no-optional-locks rev-parse HEAD',
 'git --no-optional-locks diff --stat',
])('pins admitted literal read: %s',cmd=>expect(isIndependentLiteralRead({cmd})).toBe(true));

test.each([
 'cmd.exe /c type fixture.txt','cmd /c dir','type fixture.txt','dir .','gc fixture.txt','gci .',
 'powershell -Command Get-Content fixture.txt','Get-Content -Path fixture.txt','cat -n fixture.txt',
 'rg --pre evil needle src','rg --pre=evil needle src','rg -exec evil needle src','find . -exec evil {} +',
 'rg needle .; Set-Content x y','cat a && cat b','cat a | cat b','cat a > b','cat a < b',
 'cat $FILE','cat $(command)','cat `command`','cat %FILE%','cat !FILE!','cat a^&evil',
 'cat @paths','cat ~/file','cat *.txt','cat file?.txt','cat [ab].txt','cat a,b',
 'rg needle . # comment','cat \'a\'\'b\'','cat \'a\'b',
])('excludes aliases, shell metadata, preprocessors and dynamic operands: %s',cmd=>expect(isIndependentLiteralRead({cmd})).toBe(false));
