import { expect, test } from 'bun:test';
import { BackendPerfTrace } from '../src/lib/backend-perf';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('backend profiling records monotonic durations without copying arbitrary payload fields', () => {
  const events: unknown[] = [];
  let clock = 10;
  const trace = new BackendPerfTrace('private trace', event => events.push(event), () => clock);
  const finish = trace.start('archive_build');
  clock = 42;
  finish('ok', { bytes: 256, cache_hit: false, prompt: 'secret', image: 'base64', duration_ms: Infinity } as never);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: 'perf.stage', stage: 'archive_build', duration_ms: 32, outcome: 'ok', bytes: 256, cache_hit: false });
  expect(JSON.stringify(events)).not.toContain('private trace');
  expect(JSON.stringify(events)).not.toContain('secret');
  expect(JSON.stringify(events)).not.toContain('base64');
  expect(JSON.stringify(events)).not.toContain('Infinity');
  finish();
  expect(events).toHaveLength(1);
});

test('profiling cannot change work outcomes when its sink fails', () => {
  const trace = new BackendPerfTrace('trace', () => { throw Error('disk full'); });
  expect(() => trace.start('prompt_compilation')('error')).not.toThrow();
});

test('profiling rejects unknown stages and fields at its runtime boundary', () => {
  const events: unknown[] = [];
  const trace = new BackendPerfTrace('trace', event => events.push(event));
  trace.start('user prompt text' as never)('ok', { tool: 'private tool', bytes: NaN } as never);
  expect(events).toEqual([]);
});

test('disabled profiling never reads the clock or emits events', () => {
  const trace = new BackendPerfTrace('trace', null, () => { throw Error('clock should not be used'); });
  expect(() => trace.start('archive_build')()).not.toThrow();
});

test.each([
  'turn_start', 'turn_complete', 'runtime_start', 'runtime_attach', 'runtime_reconnect',
  'helper_reconnect', 'page_rebind', 'response_rebind', 'assistant_rebind',
  'compaction_prepare', 'compaction_request', 'compaction_summary', 'compaction_apply', 'compaction_resume',
  'response_observation', 'tool_boundary_observation', 'structured_observation',
  'screenshot_capture', 'screenshot_encoding', 'model_decision', 'broker_result_ready', 'mcp_call', 'mcp_reply',
])('profiling accepts the content-free %s integration stage', stage => {
  const events: unknown[] = [];
  let clock = 1;
  const trace = new BackendPerfTrace('private lifecycle identity', event => events.push(event), () => clock);
  const finish = trace.start(stage);
  clock = 3;
  finish('ok', { tokens: 128, full_scan: false, delta_scan: true, model_decision_ms: 0.5 } as never);
  expect(events).toEqual([{
    event: 'perf.stage', trace: expect.stringMatching(/^[a-f0-9]{16}$/), stage,
    duration_ms: 2, outcome: 'ok', tokens: 128, full_scan: false, delta_scan: true, model_decision_ms: 0.5,
  }]);
});

test('new profiling fields reject secrets and invalid numeric or boolean values', () => {
  const events: unknown[] = [];
  const trace = new BackendPerfTrace('private trace', event => events.push(event), () => 10);
  for (const tokens of ['secret token', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, { secret: true }]) {
    trace.start('archive_build')('ok', {
      tokens, model_decision_ms: 'private decision text', full_scan: 'private DOM', delta_scan: 1,
      arguments: { cmd: 'private command' }, input: 'private code', paths: ['private path'],
      turn_token: 'private capability', request_id: 'private request', binding_id: 'private binding',
      image: 'private base64', summary: 'private summary', error: 'private error',
    } as never);
  }
  expect(events).toHaveLength(7);
  for (const event of events) {
    expect(Object.keys(event as object).sort()).toEqual(['duration_ms', 'event', 'outcome', 'stage', 'trace']);
  }
  expect(JSON.stringify(events)).not.toContain('private');
  for (const value of [NaN, Infinity, -0.5, 'secret']) {
    trace.start('archive_build')('ok', { model_decision_ms: value } as never);
    expect(events.at(-1)).not.toHaveProperty('model_decision_ms');
  }
});

test('malformed profiling metrics cannot fail work or copy getter payloads', () => {
  const events: unknown[] = [];
  const trace = new BackendPerfTrace('trace', event => events.push(event));
  const metrics = { tokens: 2, get bytes(): number { throw Error('private getter failure'); } };
  expect(() => trace.start('archive_build')('ok', metrics as never)).not.toThrow();
  expect(() => trace.start('archive_build')('ok', null as never)).not.toThrow();
  expect(() => trace.start('archive_build')('ok', new Proxy({}, {
    getOwnPropertyDescriptor() { throw Error('private proxy failure'); },
  }))).not.toThrow();
  expect(JSON.stringify(events)).not.toContain('private getter failure');
});

test('removing a profiling marker stops writes from an already initialized trace', () => {
  const home = mkdtempSync(join(tmpdir(), 'cgw-perf-marker-'));
  const oldHome = process.env.CODEX_CHATGPT_WEB_HOME, oldFlag = process.env.CODEX_CHATGPT_WEB_PERF;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  delete process.env.CODEX_CHATGPT_WEB_PERF;
  try {
    const runtime = join(home, 'runtime');
    mkdirSync(runtime);
    const marker = join(runtime, 'backend-perf.enabled');
    writeFileSync(marker, '1');
    const trace = new BackendPerfTrace('marker-test');
    trace.start('send')();
    const before = readFileSync(join(runtime, 'backend-perf.jsonl'), 'utf8');
    rmSync(marker);
    trace.start('send')();
    expect(readFileSync(join(runtime, 'backend-perf.jsonl'), 'utf8')).toBe(before);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
    if (oldFlag === undefined) delete process.env.CODEX_CHATGPT_WEB_PERF; else process.env.CODEX_CHATGPT_WEB_PERF = oldFlag;
    rmSync(home, {recursive: true, force: true});
  }
});
