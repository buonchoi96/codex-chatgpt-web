import { expect, test } from 'bun:test';
import { ChatGptRecoveryWatchdog, freshRecoveryStall, CHATGPT_FRONTEND_ERROR_STALL_MS, CHATGPT_SOFT_RECOVERY_STALL_MS } from '../src/adapters/chatgpt-web/recovery-watchdog';
import { SameTabRecovery, type RecoveryObservation } from '../src/adapters/chatgpt-web/same-tab-recovery';

const silent = { visibleText: '', traceBlocks: [], nativeToolCallsInFlight: false, approvalPending: false };
test.each([['red', 60000], ['interrupted', 180000]] as const)('%s watchdog waits the full %d milliseconds of semantic silence', (errorKind, boundary) => {
  const tracker = new ChatGptRecoveryWatchdog();
  expect(tracker.update({ ...silent, errorKind }, 0).expired).toBe(false);
  expect(tracker.update({ ...silent, errorKind }, boundary - 1).expired).toBe(false);
  expect(tracker.update({ ...silent, errorKind }, boundary).expired).toBe(true);
  expect([CHATGPT_FRONTEND_ERROR_STALL_MS, CHATGPT_SOFT_RECOVERY_STALL_MS]).toEqual([60000, 180000]);
});
test('meaningful answer, reasoning and native progress reset; spinner repaint does not', () => {
  const tracker = new ChatGptRecoveryWatchdog();
  tracker.update({ ...silent, errorKind: 'red' }, 0);
  const reasoning = { ...silent, errorKind: 'red' as const, traceBlocks: [{ kind: 'reasoning', text: 'Checking the canonical receipts.' }] };
  expect(tracker.update(reasoning, 59999).expired).toBe(false);
  expect(tracker.update(reasoning, 119998).expired).toBe(false);
  expect(tracker.update(reasoning, 119999).expired).toBe(true);
  expect(tracker.update({ ...reasoning, nativeLastProgressAt: 500 }, 120000).expired).toBe(false);
  expect(tracker.update({ ...reasoning, nativeLastProgressAt: 500 }, 179999).expired).toBe(false);
  expect(tracker.update({ ...reasoning, nativeLastProgressAt: 500 }, 180000).expired).toBe(true);
  const spinner = new ChatGptRecoveryWatchdog();
  spinner.update({ ...silent, errorKind: 'red', traceBlocks: [{ kind: 'status', text: 'Reconnecting...' }] }, 0);
  expect(spinner.update({ ...silent, errorKind: 'red', traceBlocks: [{ kind: 'status', text: 'Reconnecting.' }] }, 60000).expired).toBe(true);
});
test('tools and approvals suspend the interval without counting their busy time', () => {
  for (const busy of [{ nativeToolCallsInFlight: true }, { approvalPending: true }]) {
    const tracker = new ChatGptRecoveryWatchdog();
    tracker.update({ ...silent, errorKind: 'interrupted' }, 0);
    tracker.update({ ...silent, errorKind: 'interrupted' }, 100000);
    expect(tracker.update({ ...silent, errorKind: 'interrupted', ...busy }, 100000).expired).toBe(false);
    expect(tracker.update({ ...silent, errorKind: 'interrupted', ...busy }, 500000).expired).toBe(false);
    expect(tracker.update({ ...silent, errorKind: 'interrupted' }, 500001).elapsedAwakeMs).toBe(100000);
    expect(tracker.update({ ...silent, errorKind: 'interrupted' }, 580000).expired).toBe(false);
    expect(tracker.update({ ...silent, errorKind: 'interrupted' }, 580001).expired).toBe(true);
  }
});
test('healthy reasoning and disappeared banners cannot trigger recovery; clock rollback resets', () => {
  const tracker = new ChatGptRecoveryWatchdog();
  expect(tracker.update({ ...silent, errorKind: null }, 1000000).expired).toBe(false);
  tracker.update({ ...silent, errorKind: 'red' }, 1000000);
  expect(tracker.update({ ...silent, errorKind: 'red' }, 0).expired).toBe(false);
  expect(tracker.update({ ...silent, errorKind: null }, 60000).expired).toBe(false);
  expect(tracker.update({ ...silent, errorKind: 'red' }, 120000).expired).toBe(false);
});

test.each([
  ['resumed answer', { visibleText: 'New assistant tokens arrived.' }],
  ['resumed native activity', { nativeRevision: 9, nativeLastProgressAt: 60001 }],
  ['disappeared error', { errorKind: null }],
] as const)('fresh recovery recheck rejects Stop after %s', async (_reason, changed) => {
  const tracker = new ChatGptRecoveryWatchdog();
  const stalled = { ...silent, errorKind: 'red' as const, visibleText: 'Original answer.' };
  tracker.update(stalled, 0);
  expect(tracker.update(stalled, 60000).expired).toBe(true);
  let reads = 0, stops = 0, sends = 0;
  const baseline: RecoveryObservation = {owned:true, revision:1, activeTools:0, approvalPending:false,
    safetyBlocked:false, sendAcknowledged:true, generationActive:true, composerReady:true,
    historyStable:true, verifiedStall:true};
  const result = await new SameTabRecovery().recover({
    observe: async () => ({...baseline, verifiedStall: freshRecoveryStall(tracker,
      ++reads===1?stalled:{...stalled,...changed},60000+reads,false)}),
    stop: async () => {stops++;},
    submit: async () => {sends++; return 'accepted';},
  });
  expect(result).toBe('waiting');
  expect({reads, stops, sends}).toEqual({reads:2,stops:0,sends:0});
});

test('explicit steering may request Stop even when the recovery watchdog has not expired', async () => {
  const tracker = new ChatGptRecoveryWatchdog();
  let active = true, stops = 0, sends = 0;
  const result = await new SameTabRecovery().recover({
    observe: async () => ({owned:true,revision:1,activeTools:0,approvalPending:false,safetyBlocked:false,
      sendAcknowledged:true,generationActive:active,composerReady:true,historyStable:true,
      verifiedStall:freshRecoveryStall(tracker,{...silent,errorKind:null},500,true)}),
    stop: async () => {stops++; active=false;},
    submit: async () => {sends++;return 'accepted';},
  });
  expect(result).toBe('resumed');
  expect([stops,sends]).toEqual([1,1]);
});

test.each([['red',60000],['interrupted',180000]] as const)(
  '%s recovery still submits once after a freshly verified %dms stall', async (kind,deadline) => {
    const tracker = new ChatGptRecoveryWatchdog();
    const stalled = {...silent,errorKind:kind};
    tracker.update(stalled,0);
    expect(tracker.update(stalled,deadline-1).expired).toBe(false);
    let now=deadline,active=true,stops=0,sends=0;
    const result=await new SameTabRecovery().recover({
      observe:async()=>({owned:true,revision:1,activeTools:0,approvalPending:false,safetyBlocked:false,
        sendAcknowledged:true,generationActive:active,composerReady:true,historyStable:true,
        verifiedStall:freshRecoveryStall(tracker,stalled,now++,false)}),
      stop:async()=>{stops++;active=false;},
      submit:async()=>{sends++;return 'accepted';},
    });
    expect(result).toBe('resumed');
    expect([stops,sends]).toEqual([1,1]);
  });
