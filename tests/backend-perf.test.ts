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
