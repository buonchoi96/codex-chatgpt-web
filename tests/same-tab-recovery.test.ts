import { expect,test } from 'bun:test';
import { SameTabRecovery, type RecoveryObservation } from '../src/adapters/chatgpt-web/same-tab-recovery';

const idle:RecoveryObservation={owned:true,revision:1,activeTools:0,approvalPending:false,safetyBlocked:false,
  sendAcknowledged:true,generationActive:false,composerReady:true,historyStable:true,verifiedStall:true};
test('a resumed deadline timer charges only awake time while Stop acknowledgement remains pending',async()=>{
  let awake=0,fire=()=>{},finished=false,sends=0,signal:AbortSignal|undefined;
  const recovery=new SameTabRecovery(()=>{},()=>awake,async()=>{},(callback,delay)=>{
    expect(delay).toBeGreaterThan(0);fire=callback;return()=>{};
  });
  const outcome=recovery.recover({observe:async()=>({...idle,generationActive:true}),
    stop:async stopSignal=>{signal=stopSignal;await new Promise<void>(()=>{});},
    submit:async()=>{sends++;return 'accepted';}}).then(value=>{finished=true;return value;});
  await Bun.sleep(0);
  // The OS resumes the overdue wall timer after sleep; awake budget is still unused.
  fire();await Bun.sleep(0);
  expect(signal!.aborted).toBe(false);expect(finished).toBe(false);
  awake=29999;fire();await Bun.sleep(0);
  expect(signal!.aborted).toBe(false);expect(finished).toBe(false);
  awake=30000;fire();
  expect(await outcome).toBe('unsafe');expect(recovery.fallbackReason).toBe('stop_confirmation_timeout');
  expect(sends).toBe(0);
});
test('already committed answer reconciles without Stop or Send',async()=>{
  let sends=0,stops=0;
  const recovery=new SameTabRecovery();
  expect(await recovery.recover({observe:async()=>({...idle,completed:true}),stop:async()=>{stops++;},submit:async()=>{sends++;return 'accepted';}})).toBe('completed');
  expect([stops,sends]).toEqual([0,0]);
});
test('fresh semantic progress during pre-Stop recheck cancels recovery without mutation',async()=>{
  let reads=0,stops=0,sends=0,fallbacks=0;
  const recovery=new SameTabRecovery();
  const outcome=await recovery.recover({
    observe:async()=>({...idle,generationActive:true,verifiedStall:++reads===1}),
    stop:async()=>{stops++;},
    submit:async()=>{sends++;return 'accepted';},
    reconcileFallback:async()=>({oldGenerationStopped:true,toolReceiptsSettled:true,
      sendAcknowledged:true,ownershipMatched:true,revisionUnchanged:true,
      approvalPending:false,safetyBlocked:false}),
    fallback:async()=>{fallbacks++;return 'accepted';}
  });
  expect(outcome).toBe('waiting');
  expect(recovery.state).toBe('ACTIVE');
  expect(reads).toBe(2);
  expect({stops,sends,fallbacks}).toEqual({stops:0,sends:0,fallbacks:0});
});

test('fresh semantic progress before an idle-generation Send cancels stale recovery',async()=>{
  let reads=0,sends=0,stops=0;
  const recovery=new SameTabRecovery();
  const actions={observe:async()=>({...idle,generationActive:false,verifiedStall:++reads===1}),
    stop:async()=>{stops++;},submit:async()=>{sends++;return 'accepted' as const}};
  expect(await recovery.recover(actions)).toBe('waiting');
  expect(recovery.state).toBe('ACTIVE');
  expect([reads,stops,sends]).toEqual([2,0,0]);
  // The recovered frontend's fresh progress must not consume either send attempt.
  expect(await recovery.recover({...actions,observe:async()=>({...idle,verifiedStall:true})})).toBe('resumed');
  expect(sends).toBe(1);
});

test('confirmed Stop may clear an error banner without cancelling its safe delta',async()=>{
  let stops=0,sends=0;
  const recovery=new SameTabRecovery();
  const outcome=await recovery.recover({
    observe:async()=>({...idle,generationActive:stops===0,verifiedStall:stops===0}),
    stop:async()=>{stops++;},
    submit:async()=>{sends++;return 'accepted' as const}
  });
  expect(outcome).toBe('resumed');
  expect([stops,sends]).toEqual([1,1]);
  expect(recovery.state).toBe('RESUMED');
});
test('progress that cancels pre-Stop recovery does not consume the bounded mutation budget',async()=>{
  let reads=0,stops=0,sends=0;
  const recovery=new SameTabRecovery();
  const progress={
    observe:async()=>({...idle,generationActive:true,verifiedStall:++reads%2===1}),
    stop:async()=>{stops++;},
    submit:async()=>{sends++;return 'accepted' as const},
  };
  for (let i=0;i<3;i++) expect(await recovery.recover(progress)).toBe('waiting');
  expect([reads,stops,sends]).toEqual([6,0,0]);
  const idleResumption={observe:async()=>({...idle,generationActive:false}),
    stop:async()=>{stops++;},submit:async()=>{sends++;return 'accepted' as const}};
  expect(await recovery.recover(idleResumption)).toBe('resumed');
  expect(await recovery.recover(idleResumption)).toBe('resumed');
  expect([stops,sends]).toEqual([0,2]);
});
test('a generation that has already stopped at the second ownership check is not stopped twice',async()=>{
  let reads=0,stops=0,sends=0;
  const recovery=new SameTabRecovery();
  expect(await recovery.recover({
    observe:async()=>({...idle,generationActive:++reads===1}),
    stop:async()=>{stops++;},
    submit:async()=>{sends++;return 'accepted';},
  })).toBe('resumed');
  expect(reads).toBe(3);
  expect([stops,sends]).toEqual([0,1]);
});
test('confirmed Stop waits for positive quiescence and submits exactly once',async()=>{
  let now=0,stops=0,sends=0;
  const recovery=new SameTabRecovery(()=>{},()=>now,async ms=>{now+=ms;});
  expect(await recovery.recover({observe:async()=>({...idle,generationActive:stops===0||now<1000}),stop:async()=>{stops++;},submit:async()=>{sends++;return 'accepted';}})).toBe('resumed');
  expect([stops,sends,now]).toEqual([1,1,1000]);
});
test('30-second Stop deadline and ambiguous Send both prohibit another submit',async()=>{
  let now=0,sends=0;
  const recovery=new SameTabRecovery(()=>{},()=>now,async ms=>{now+=ms;});
  expect(await recovery.recover({observe:async()=>({...idle,generationActive:true}),stop:async()=>{},submit:async()=>{sends++;return 'accepted';}})).toBe('unsafe');
  expect(now).toBe(30000);expect(sends).toBe(0);
  const unknown=new SameTabRecovery();
  const actions={observe:async()=>idle,stop:async()=>{},submit:async()=>{sends++;return 'unknown' as const;}};
  expect(await unknown.recover(actions)).toBe('unsafe');
  expect(await unknown.recover(actions)).toBe('unsafe');expect(sends).toBe(1);
});
test('active tool, approval, unknown ack, unsafe ownership and live network progress disqualify recovery',async()=>{
  for(const patch of [{activeTools:1},{approvalPending:true},{sendAcknowledged:false},{safetyBlocked:true},{owned:false},{verifiedStall:false}]){
    let effects=0;
    await new SameTabRecovery().recover({observe:async()=>({...idle,...patch}),stop:async()=>{effects++;},submit:async()=>{effects++;return 'accepted';}});
    expect(effects).toBe(0);
  }
});
test('cancellation and revised ownership while stopping never lose authority to stale callbacks',async()=>{
  const recovery=new SameTabRecovery();let sends=0;
  expect(await recovery.recover({observe:async()=>({...idle,generationActive:true}),stop:async()=>{recovery.cancel();},submit:async()=>{sends++;return 'accepted';}})).toBe('cancelled');
  expect(sends).toBe(0);
  let reads=0;
  expect(await new SameTabRecovery().recover({observe:async()=>({...idle,revision:++reads<3?1:2,generationActive:reads<3}),stop:async()=>{},submit:async()=>{sends++;return 'accepted';}})).toBe('queued');
  expect(sends).toBe(0);
});

test('only failed Stop activation or its 30000ms deadline makes fallback eligible', async () => {
  for (const patch of [{owned:false},{historyStable:false},{sendAcknowledged:false},{activeTools:1},{approvalPending:true},{safetyBlocked:true}]) {
    const recovery = new SameTabRecovery();
    await recovery.recover({observe:async()=>({...idle,...patch}),stop:async()=>{throw new Error('not reached');},submit:async()=> 'accepted'});
    expect(recovery.fallbackReason).toBeUndefined();
  }
  const failed = new SameTabRecovery();
  expect(await failed.recover({observe:async()=>({...idle,generationActive:true}),stop:async()=>{throw new Error('Stop control cannot activate');},submit:async()=> 'accepted'})).toBe('unsafe');
  expect(failed.fallbackReason).toBe('stop_activation_failed');
  let now=0;
  const timeout=new SameTabRecovery(()=>{},()=>now,async()=>{now=30000;});
  expect(await timeout.recover({observe:async()=>({...idle,generationActive:true}),stop:async()=>{},submit:async()=> 'accepted'})).toBe('unsafe');
  expect(timeout.fallbackReason).toBe('stop_confirmation_timeout');
});

test('Stop confirmation at 29999ms resumes; at 30000ms never sends a same-tab delta', async () => {
  for (const boundary of [29999,30000]) {
    let now=0,sends=0;
    const recovery=new SameTabRecovery(()=>{},()=>now,async()=>{now=boundary;});
    const outcome=await recovery.recover({observe:async()=>({...idle,generationActive:now===0}),stop:async()=>{},submit:async()=>{sends++;return 'accepted';}});
    expect(outcome).toBe(boundary===29999?'resumed':'unsafe');
    expect(sends).toBe(boundary===29999?1:0);
  }
});

test('guarded legacy fallback requires reconciled old generation and receipts, and is one-shot', async () => {
  let fresh=0;
  const proof={oldGenerationStopped:true,toolReceiptsSettled:true,sendAcknowledged:true,ownershipMatched:true,revisionUnchanged:true,approvalPending:false,safetyBlocked:false};
  for(const patch of [{oldGenerationStopped:false},{toolReceiptsSettled:false},{sendAcknowledged:false},{ownershipMatched:false},{revisionUnchanged:false},{approvalPending:true},{safetyBlocked:true}]) {
    const recovery=new SameTabRecovery();
    await recovery.recover({observe:async()=>({...idle,generationActive:true}),stop:async()=>{throw new Error('Stop failed');},submit:async()=> 'accepted',
      reconcileFallback:async()=>({...proof,...patch}),fallback:async()=>{fresh++;return 'accepted';}});
    expect(fresh).toBe(0);
  }
  const recovery=new SameTabRecovery();
  const actions={observe:async()=>({...idle,generationActive:true}),stop:async()=>{throw new Error('Stop failed');},submit:async()=> 'accepted' as const,
    reconcileFallback:async()=>proof,fallback:async()=>{fresh++;return 'accepted' as const;}};
  expect(await recovery.recover(actions)).toBe('fallback');
  expect(await recovery.recover(actions)).toBe('unsafe');
  expect(fresh).toBe(1);
});

test('retry budget exhaustion is a controlled blocker, never a third fallback path', async () => {
  let fresh=0;
  const recovery=new SameTabRecovery();
  const actions={observe:async()=>idle,stop:async()=>{},submit:async()=> 'accepted' as const,fallback:async()=>{fresh++;return 'accepted' as const;}};
  expect(await recovery.recover(actions)).toBe('resumed');
  expect(await recovery.recover(actions)).toBe('resumed');
  expect(await recovery.recover(actions)).toBe('unsafe');
  expect(recovery.fallbackReason).toBeUndefined();
  expect(fresh).toBe(0);
});

test('a committed answer winning the final mutation race is reconciled without another Send',async()=>{
  const recovery=new SameTabRecovery();
  expect(await recovery.recover({observe:async()=>idle,stop:async()=>{},submit:async()=> 'completed'})).toBe('completed');
  expect(recovery.state).toBe('COMPLETED');
});

test('cancellation racing with an acknowledged same-tab Send retains the accepted receipt',async()=>{
  let accept!:()=>void,sends=0;
  const accepted=new Promise<void>(resolve=>{accept=resolve;});
  const recovery=new SameTabRecovery();
  const actions={observe:async()=>idle,stop:async()=>{},submit:async()=>{
    sends++;await accepted;return 'accepted' as const;
  }};
  const pending=recovery.recover(actions);
  for(let n=0;n<10&&sends===0;n++) await Bun.sleep(0);
  expect(sends).toBe(1);
  recovery.cancel();
  accept();
  expect(await pending).toBe('resumed');
  expect(recovery.state).toBe('RESUMED');
  expect(await recovery.recover(actions)).toBe('cancelled');
  expect(sends).toBe(1);
});

test('cancellation racing with an acknowledged fallback Send retains the accepted receipt',async()=>{
  let accept!:()=>void,fallbacks=0;
  const accepted=new Promise<void>(resolve=>{accept=resolve;});
  const recovery=new SameTabRecovery();
  const actions={observe:async()=>({...idle,generationActive:true}),
    stop:async()=>{throw new Error('Stop activation failed');},
    submit:async()=> 'unknown' as const,
    reconcileFallback:async()=>({oldGenerationStopped:true,toolReceiptsSettled:true,
      sendAcknowledged:true,ownershipMatched:true,revisionUnchanged:true,
      approvalPending:false,safetyBlocked:false}),
    fallback:async()=>{fallbacks++;await accepted;return 'accepted' as const;}};
  const pending=recovery.recover(actions);
  for(let n=0;n<10&&fallbacks===0;n++) await Bun.sleep(0);
  expect(fallbacks).toBe(1);
  recovery.cancel();
  accept();
  expect(await pending).toBe('fallback');
  expect(recovery.state).toBe('FALLBACK_SUBMITTED');
  expect(await recovery.recover(actions)).toBe('cancelled');
  expect(fallbacks).toBe(1);
});

test('cancellation racing with an unacknowledged Send never invents acceptance or retries',async()=>{
  let settle!:()=>void,sends=0;
  const pendingReceipt=new Promise<void>(resolve=>{settle=resolve;});
  const recovery=new SameTabRecovery();
  const actions={observe:async()=>idle,stop:async()=>{},submit:async()=>{
    sends++;await pendingReceipt;return 'unknown' as const;
  }};
  const pending=recovery.recover(actions);
  for(let n=0;n<10&&sends===0;n++) await Bun.sleep(0);
  expect(sends).toBe(1);
  recovery.cancel();
  settle();
  expect(await pending).toBe('unsafe');
  expect(recovery.state).toBe('UNKNOWN_STOP_OR_SEND');
  expect(await recovery.recover(actions)).toBe('cancelled');
  expect(sends).toBe(1);
});
