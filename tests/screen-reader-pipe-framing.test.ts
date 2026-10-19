import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {NativeReaderPipeProvider,type ScreenReaderGrant} from '../src/adapters/chatgpt-web/screen-observation';

const windowsTest=process.platform==='win32'?test:test.skip;

windowsTest('a native observer pipe preserves OCR UTF-8 across split stream chunks',async()=>{
  const pipe='\\\\.\\pipe\\cgw-ocr-split-'+randomUUID()+'_observer_v1';
  const server=createServer(socket=>{
    let request='';
    socket.on('data',data=>{
      request+=data.toString('utf8');
      const end=request.indexOf('\n');
      if(end<0)return;
      socket.removeAllListeners('data');
      const id=(JSON.parse(request.slice(0,end)) as {id:string}).id;
      const reply=Buffer.from(JSON.stringify({id,ok:true,data:{ocr_name:'Chào 世界'}})+'\n','utf8');
      const utf8=Buffer.from('à','utf8');
      const boundary=reply.indexOf(utf8)+1;
      if(boundary<1)throw Error('fixture UTF-8 split point unavailable');
      socket.write(reply.subarray(0,boundary));
      setTimeout(()=>socket.end(reply.subarray(boundary)),25);
    });
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(pipe,()=>{server.off('error',reject);resolve();});
  });
  try {
    const grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'a'.repeat(64),
      session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),
      owner_epoch:1,expires_in_ms:30000,region:{x:10,y:20,width:100,height:100},
      observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
    const provider=new NativeReaderPipeProvider(pipe);
    const result=await provider.observe(grant,{operation_id:randomUUID(),timeout_ms:1000,max_nodes:1});
    expect(result.ocr_name).toBe('Chào 世界');
  }finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

windowsTest('abort closes its read and native cancellation still issues only once',async()=>{
  const pipe='\\\\.\\pipe\\cgw-observer-cancel-'+randomUUID()+'_observer_v1';
  const controller=new AbortController();
  let cancelled=0,readSocket:import('node:net').Socket|undefined,readId:string|undefined;
  const server=createServer(socket=>{
    let text='';
    socket.on('data',bytes=>{
      text+=bytes.toString('utf8');
      const end=text.indexOf('\n');if(end<0)return;
      socket.removeAllListeners('data');
      const message=JSON.parse(text.slice(0,end)) as {id:string;cmd:string};
      if(message.cmd==='observer_read') {
        readSocket=socket;readId=message.id;
        setTimeout(()=>controller.abort(new Error('private fixture abort')),10);
      } else if(message.cmd==='observer_cancel') {
        cancelled++;
        socket.end(JSON.stringify({id:message.id,ok:true,data:{cancelled:true}})+'\n');
        if(cancelled===1&&readSocket&&readId)
          readSocket.end(JSON.stringify({id:readId,ok:false,error:{code:'SCREEN_OBSERVER_CANCELLED'}})+'\n');
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(pipe,()=>{server.off('error',reject);resolve();});
  });
  try {
    const grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'b'.repeat(64),
      session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),
      owner_epoch:1,expires_in_ms:30000,region:{x:10,y:20,width:100,height:100},
      observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
    const provider=new NativeReaderPipeProvider(pipe);
    await expect(provider.observe(grant,{operation_id:randomUUID(),timeout_ms:1000,max_nodes:1},controller.signal))
      .rejects.toThrow('private fixture abort');
    await new Promise(resolve=>setTimeout(resolve,70));
    expect(cancelled).toBe(1);
  }finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

windowsTest('abort settles a hung reader promptly while preserving one native cancel',async()=>{
  const pipe='\\\\.\\pipe\\cgw-observer-hung-'+randomUUID()+'_observer_v1';
  const controller=new AbortController();
  let notifyRead=()=>{},notifyCancel=()=>{},cancels=0;
  const readStarted=new Promise<void>(resolve=>{notifyRead=resolve;});
  const cancelSeen=new Promise<void>(resolve=>{notifyCancel=resolve;});
  const server=createServer(socket=>{
    let request='';
    socket.on('data',bytes=>{
      request+=bytes.toString('utf8');
      const end=request.indexOf('\n');if(end<0)return;
      socket.removeAllListeners('data');
      const message=JSON.parse(request.slice(0,end)) as {id:string;cmd:string};
      if(message.cmd==='observer_read')notifyRead(); // Deliberately never replies.
      else if(message.cmd==='observer_cancel'){
        cancels++;
        socket.end(JSON.stringify({id:message.id,ok:true,data:{cancelled:true}})+'\n');
        notifyCancel();
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(pipe,()=>{server.off('error',reject);resolve();});
  });
  try {
    const grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'c'.repeat(64),
      session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),
      owner_epoch:1,expires_in_ms:30000,region:{x:10,y:20,width:100,height:100},
      observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
    const pending=new NativeReaderPipeProvider(pipe).observe(grant,
      {operation_id:randomUUID(),timeout_ms:800,max_nodes:1},controller.signal);
    await readStarted;
    const abortAt=performance.now();
    controller.abort(new Error('fixture stopped a hung observation'));
    await expect(pending).rejects.toThrow('fixture stopped a hung observation');
    expect(performance.now()-abortAt).toBeLessThan(350);
    await cancelSeen;
    expect(cancels).toBe(1);
  }finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

windowsTest('reader transport timeout cancels once and permits a subsequent observation',async()=>{
  const pipe='\\\\.\\pipe\\cgw-observer-timeout-'+randomUUID()+'_observer_v1';
  let reads=0,cancels=0,notifyCancel=()=>{};
  const cancelSeen=new Promise<void>(resolve=>{notifyCancel=resolve;});
  const sockets=new Set<import('node:net').Socket>();
  const server=createServer(socket=>{
    sockets.add(socket);
    socket.once('close',()=>sockets.delete(socket));
    let request='';
    socket.on('data',bytes=>{
      request+=bytes.toString('utf8');
      const end=request.indexOf('\n');if(end<0)return;
      socket.removeAllListeners('data');
      const message=JSON.parse(request.slice(0,end)) as {id:string;cmd:string};
      if(message.cmd==='observer_read') {
        reads++;
        if(reads===2)socket.end(JSON.stringify({id:message.id,ok:true,data:{recovered:true}})+'\n');
        // First read deliberately remains open until the client's transport timer.
      } else if(message.cmd==='observer_cancel') {
        cancels++;
        socket.end(JSON.stringify({id:message.id,ok:true,data:{cancelled:true}})+'\n');
        notifyCancel();
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(pipe,()=>{server.off('error',reject);resolve();});
  });
  try {
    const grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'d'.repeat(64),
      session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),
      owner_epoch:1,expires_in_ms:30000,region:{x:10,y:20,width:100,height:100},
      observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
    const provider=new NativeReaderPipeProvider(pipe);
    await expect(provider.observe(grant,{operation_id:randomUUID(),timeout_ms:50,max_nodes:1}))
      .rejects.toThrow('SCREEN_OBSERVER_TIMEOUT');
    await cancelSeen;
    const result=await provider.observe(grant,{operation_id:randomUUID(),timeout_ms:1000,max_nodes:1});
    expect(result.recovered).toBe(true);
    expect(reads).toBe(2);
    expect(cancels).toBe(1);
  }finally {
    for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
