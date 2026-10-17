import { expect, test } from 'bun:test';
import { ChatGptRecoveryWatchdog, CHATGPT_FRONTEND_ERROR_STALL_MS, CHATGPT_SOFT_RECOVERY_STALL_MS } from '../src/adapters/chatgpt-web/recovery-watchdog';

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
