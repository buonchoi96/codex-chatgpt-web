import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config';

const stages = new Set([
  'prompt_compilation', 'token_estimation', 'archive_build', 'browser_page',
  'temporary_chat_preparation', 'effort_selection', 'submission_baseline',
  'prompt_attachment', 'file_attachment', 'send', 'submission_accepted',
  'first_reasoning', 'first_text', 'helper_queue', 'helper_ready',
  'broker_queue', 'native_dispatch', 'native_completion',
  'computer_use_cycle', 'browser_use_cycle', 'tool_cycle',
  'multipart_stage', 'multipart_acknowledgement', 'multipart_commit',
  'completion_receipt_recovery',
]);
export type BackendPerfMetrics = {
  bytes?: number; count?: number; cache_hit?: boolean; screenshot_used?: boolean;
  queue_ms?: number; dispatch_ms?: number; decision_ms?: number;
};
export type BackendPerfEvent = BackendPerfMetrics & {
  event: 'perf.stage'; trace: string; stage: string;
  duration_ms: number; outcome: 'ok' | 'error';
};
const MAX_PERF_LOG_BYTES = 8 * 1024 * 1024;
let sinkHome: string | undefined;
let sinkFlag: string | undefined;
let cachedSink: ((event: BackendPerfEvent) => void) | undefined;

// Profiling is opt-in and deliberately synchronous so reloads do not lose the final timings.
// The shared local file is bounded; a full log must be archived/removed before a new capture.
// Enabling the marker requires a reload; removing it stops marker-based writes immediately.
function defaultSink(): ((event: BackendPerfEvent) => void) | undefined {
  const runtime = join(getConfigDir(), 'runtime');
  const flag = process.env.CODEX_CHATGPT_WEB_PERF;
  if (runtime === sinkHome && flag === sinkFlag) return cachedSink;
  sinkHome = runtime;
  sinkFlag = flag;
  cachedSink = undefined;
  if (process.env.CODEX_CHATGPT_WEB_PERF !== '1'
    && !existsSync(join(runtime, 'backend-perf.enabled'))) return undefined;
  return cachedSink = event => {
    if (flag !== '1' && !existsSync(join(runtime, 'backend-perf.enabled'))) return;
    const file = join(runtime, 'backend-perf.jsonl');
    const line = `${JSON.stringify(event)}\n`;
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size + Buffer.byteLength(line) <= MAX_PERF_LOG_BYTES) {
      appendFileSync(file, line, { mode: 0o600 });
    }
  };
}

/** Only timing/count fields cross the profiling boundary. Never accept tool arguments or text. */
export class BackendPerfTrace {
  private readonly trace: string;
  constructor(
    traceId: string,
    private readonly sink: ((event: BackendPerfEvent) => void) | undefined | null = defaultSink(),
    private readonly now = () => performance.now(),
  ) {
    this.trace = sink ? createHash('sha256').update(traceId).digest('hex').slice(0, 16) : '';
  }

  start(stage: string): (outcome?: 'ok' | 'error', metrics?: BackendPerfMetrics) => void {
    if (!this.sink || !stages.has(stage)) return () => {};
    const started = this.now();
    let finished = false;
    return (outcome = 'ok', metrics = {}) => {
      if (finished) return;
      finished = true;
      const duration = this.now() - started;
      if (!Number.isFinite(duration) || duration < 0) return;
      const event: BackendPerfEvent = { event: 'perf.stage', trace: this.trace, stage,
        duration_ms: duration, outcome: outcome === 'error' ? 'error' : 'ok' };
      for (const key of ['bytes', 'count', 'queue_ms', 'dispatch_ms', 'decision_ms'] as const) {
        const value = metrics[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) event[key] = value;
      }
      for (const key of ['cache_hit', 'screenshot_used'] as const) {
        if (typeof metrics[key] === 'boolean') event[key] = metrics[key];
      }
      try { this.sink?.(event); } catch { /* Profiling cannot fail a task. */ }
    };
  }

  measure<T>(stage: string, action: () => T, metrics?: BackendPerfMetrics): T {
    const finish = this.start(stage);
    try { const value = action(); finish('ok', metrics); return value; }
    catch (error) { finish('error'); throw error; }
  }
}
