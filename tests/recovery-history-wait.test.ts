import {expect,test} from 'bun:test';
import {RecoveryHistoryWait} from '../src/adapters/chatgpt-web/recovery-history-wait';

test('proof-pending observations share an awake deadline rather than granting a fresh budget on each retry',()=>{
  let awake=0;
  const waiting=new RecoveryHistoryWait(()=>awake);
  expect(waiting.pending()).toBe('waiting');
  // Repeated recovery-coordinator attempts cannot extend this browser-owner deadline.
  awake=90000;expect(waiting.pending()).toBe('waiting');
  awake=179999;expect(waiting.pending()).toBe('waiting');
  awake=180000;expect(waiting.pending()).toBe('expired');
  awake=190000;expect(waiting.pending()).toBe('expired');
});

test('only positive history proof ends a pending wait; system sleep does not consume its injected awake budget',()=>{
  let awake=10;
  const waiting=new RecoveryHistoryWait(()=>awake);
  expect(waiting.pending()).toBe('waiting');
  // Wall time is irrelevant; the browser suspension clock still reports the same awake time.
  expect(waiting.pending()).toBe('waiting');
  awake=180009;expect(waiting.pending()).toBe('waiting');
  waiting.ready();
  awake=180010;expect(waiting.pending()).toBe('waiting');
  awake=360010;expect(waiting.pending()).toBe('expired');
});
