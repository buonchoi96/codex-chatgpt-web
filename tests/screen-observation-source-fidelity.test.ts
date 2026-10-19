import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {ScreenObservationRegistry,type NativeScreenProvider,type ScreenReaderGrant} from '../src/adapters/chatgpt-web/screen-observation';

type NativeNode=Record<string,unknown>;
function setup(mutate:(receipt:Record<string,any>)=>void=()=>{}) {
  const grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'d'.repeat(64),
    session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),
    owner_epoch:1,expires_in_ms:30000,region:{x:0,y:0,width:100,height:100},
    observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
  const ocr:NativeNode={source:'ocr',name:'Ready',id:'ocr:8',role:'text',confidence:null,
    confidence_status:'unavailable',frame_id:8,target_generation:4,
    bounds:{x:10,y:10,width:40,height:10}};
  const cv:NativeNode={source:'cv',name:'',id:'cv:8',role:'visual_region',
    frame_id:8,target_generation:4,bounds:{x:10,y:30,width:30,height:10}};
  const provider:NativeScreenProvider={observe:async(g,args)=>{
    const receipt:Record<string,any>={observer_protocol:1,operation_id:args.operation_id,
      session:g.session,hwnd:g.hwnd,pid:g.pid,owner_epoch:g.owner_epoch,region:g.region,
      status:'PARTIAL',image_encoded:false,image_delivery_status:'UNAVAILABLE',
      frame_id:8,target_generation:4,nodes:[ocr,cv],
      sources:{cv:{status:'completed',source_count:1,truncated:false},
        uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',
          pixel_correspondence:'unverified',sample_start_ms:1,sample_end_ms:2},
        ocr:{status:'completed',confidence_available:false,frame_id:8,target_generation:4}}};
    mutate(receipt);
    return receipt;
  }};
  const registry=new ScreenObservationRegistry(provider,()=>1000);
  registry.remember('binding','owner',{content:[],structuredContent:{ok:true,data:grant}});
  return ()=>registry.observe('binding','owner',
    {reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:20,tree_format:'json'},async()=>{});
}

test('rejects a CV source count smaller than the published CV node count',async()=>{
  const observe=setup(receipt=>{receipt.sources.cv.source_count=0;});
  await expect(observe()).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
});

test('a projected semantic tree requires native source receipts for its nodes',async()=>{
  const observe=setup(receipt=>{delete receipt.sources;});
  await expect(observe()).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
});

test('rejects OCR nodes when native OCR reports empty',async()=>{
  const observe=setup(receipt=>{receipt.sources.ocr.status='empty';});
  await expect(observe()).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
});

test('rejects OCR nodes when native OCR reports unavailable',async()=>{
  const observe=setup(receipt=>{receipt.sources.ocr.status='UNAVAILABLE';
    delete receipt.sources.ocr.frame_id;delete receipt.sources.ocr.target_generation;});
  await expect(observe()).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
});

test('rejects OCR nodes without an authenticated source frame identity',async()=>{
  const observe=setup(receipt=>{delete receipt.sources.ocr.frame_id;
    delete receipt.sources.ocr.target_generation;});
  await expect(observe()).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
});

test('rejects completed CV nodes when the CV provider reports deadline',async()=>{
  const observe=setup(receipt=>{receipt.sources.cv.status='deadline';});
  await expect(observe()).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
});

for(const status of ['unsupported','provider_error','not_attempted']) {
  test(`rejects published UIA nodes when the native UIA provider reports ${status}`,async()=>{
    const observe=setup(receipt=>{
      receipt.nodes.push({source:'uia',id:'uia:8',role:'button',name:'Apply',
        confidence:1,pixel_correspondence:'unverified',
        bounds:{x:5,y:5,width:20,height:10}});
      receipt.sources.uia.status=status;
      receipt.sources.uia.partial=true;
    });
    await expect(observe()).rejects.toThrow('SCREEN_OBSERVATION_PROTOCOL');
  });
}

test('accepts partial UIA nodes from a provider that timed out during traversal',async()=>{
  const observe=setup(receipt=>{
    receipt.nodes.push({source:'uia',id:'uia:8',role:'button',name:'Apply',
      confidence:1,pixel_correspondence:'unverified',
      bounds:{x:5,y:5,width:20,height:10}});
    receipt.sources.uia.status='timeout';
    receipt.sources.uia.partial=true;
  });
  const result=await observe();
  expect((result.tree as {returned_count:number}).returned_count).toBe(3);
});

test('accepts a complete but truncated CV provider receipt when its source count exceeds returned nodes',async()=>{
  const observe=setup(receipt=>{receipt.sources.cv.source_count=3;receipt.sources.cv.truncated=true;});
  const result=await observe();
  expect((result.tree as {returned_count:number}).returned_count).toBe(2);
});
