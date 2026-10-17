// Read-only CDP diagnostics for one owned DEV submission. Never logs bodies or pixels.
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { CDPSession, Page } from "playwright-core";

type Receipt = {
  request_id: string; exact_draft: boolean; user_message_ids: string[]; http_status?: number;
  server_echoed_user_id: boolean; server_parent_matches_user: boolean;
  response_keys: string[]; stream_available: boolean;
};
type Candidate = {
  ready: Promise<void>; activation?: Promise<void>; finishing?: Promise<void>;
  receipt?: Receipt; decoder: StringDecoder; firstText: boolean; line: string;
  dataLines: string[]; eventName: string; queued: string[]; active: boolean;
  failed: boolean; terminal: boolean;
};
type ObservedEvent = "Network.requestWillBeSent" | "Network.responseReceived"
  | "Network.dataReceived" | "Network.loadingFinished" | "Network.loadingFailed";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENCODED = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_REQUESTS = 8;
const MAX_QUEUED_CHUNKS = 256;
const MAX_EVENT_LINES = 256;
const READ_TIMEOUT_MS = 2_000;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const normalize = (value: string) => value.replace(/\r\n/g, "\n");
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const safeKeys = (value: Record<string, unknown>) =>
  Object.keys(value).filter(key => /^[a-z_]{1,40}$/.test(key)).slice(0, 30);

function errorFrame(value: Record<string, unknown>, eventName = ""): boolean {
  if (value.isError === true) return true;
  if (["error", "error_code", "code"].some(key =>
    value[key] !== undefined && value[key] !== null && value[key] !== false && value[key] !== "")) return true;
  return [eventName, value.type, value.event, value.status].some(tag =>
    typeof tag === "string" && /^(?:error|failed|cancelled|blocked)$/.test(tag));
}

export class DevSubmissionWireObserver {
  private session?: CDPSession;
  private attached = false;
  private closed = false;
  private generation = 0;
  private readonly receipts = new Map<string, Receipt>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Map<ObservedEvent, (event: any) => void>();
  private bytes = 0;
  private queuedChunks = 0;
  private resolveClosed!: () => void;
  private readonly whenClosed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  private readonly diagnostic = {
    conversation_posts: 0, main_frame_posts: 0, with_body: 0,
    body_keys: [] as string[], user_counts: [] as number[], text_lengths: [] as number[],
    known_connector_prefix: false, draft_suffix_match: false,
    draft_prefix_char_count: 0, draft_prefix_shape: "", draft_prefix_shape_truncated: false,
    candidate_limit_reached: false, capture_limit_reached: false,
    ambiguous_submission: false, flush_timed_out: false,
  };

  constructor(private readonly prompt: string, private readonly connectorName?: string) {}

  private live(generation: number) { return !this.closed && this.generation === generation; }
  private track(action: Promise<unknown>) {
    // One body read, activation and terminal read per candidate: at most 24 tracked actions.
    this.pending.add(action);
    void action.catch(() => {}).finally(() => this.pending.delete(action));
  }
  private async bounded<T>(action: Promise<T>, generation: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("CDP diagnostic read timed out")), READ_TIMEOUT_MS);
        }),
        this.whenClosed.then(() => { throw new Error("CDP diagnostic observer closed"); }),
      ]).then(value => {
        if (!this.live(generation)) throw new Error("CDP diagnostic observer closed");
        return value;
      });
    } finally { if (timer) clearTimeout(timer); }
  }

  async attach(page: Page) {
    if (this.attached || this.closed) throw new Error("Wire observer cannot be attached twice or after close");
    if (new URL(page.url()).origin !== "https://chatgpt.com") throw new Error("Owned ChatGPT origin required");
    this.attached = true;
    const generation = this.generation;
    try {
      const session = await this.bounded(page.context().newCDPSession(page).then(value => {
        if (!this.live(generation)) void value.detach().catch(() => {});
        return value;
      }), generation);
      this.session = session;
      const { frameTree } = await this.bounded(session.send("Page.getFrameTree"), generation);
      const listen = (name: ObservedEvent, callback: (event: any) => void) => {
        const guarded = (event: any) => { if (this.live(generation)) callback(event); };
        this.listeners.set(name, guarded);
        session.on(name, guarded);
      };
      listen("Network.requestWillBeSent", event => {
        let url: URL;
        try { url = new URL(event.request?.url); } catch { return; }
        if (event.request.method !== "POST" || url.origin !== "https://chatgpt.com"
          || !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
        this.diagnostic.conversation_posts++;
        if (event.frameId !== frameTree.frame.id) return;
        this.diagnostic.main_frame_posts++;
        if (typeof event.requestId !== "string" || event.requestId.length > 128) return;
        if (this.candidates.has(event.requestId)) return;
        if (this.candidates.size >= MAX_REQUESTS) {
          this.diagnostic.candidate_limit_reached = true;
          this.diagnostic.ambiguous_submission = true;
          this.invalidateEvidence();
          return;
        }
        const candidate: Candidate = {
          ready: Promise.resolve(), decoder: new StringDecoder("utf8"), firstText: true,
          line: "", dataLines: [], eventName: "", queued: [], active: false, failed: false, terminal: false,
        };
        this.candidates.set(event.requestId, candidate);
        candidate.ready = this.inspectRequest(event, candidate, session, generation).catch(() => {
          if (this.live(generation)) this.discard(candidate);
        });
        this.track(candidate.ready);
      });
      listen("Network.responseReceived", event => {
        const candidate = this.candidates.get(event.requestId);
        if (!candidate || candidate.activation || candidate.failed) return;
        candidate.activation = (async () => {
          await candidate.ready;
          if (!this.live(generation) || !candidate.receipt || candidate.failed) return;
          candidate.receipt.http_status = event.response.status;
          if (!(event.response.status >= 200 && event.response.status < 300)) {
            this.discard(candidate);
            return;
          }
          try {
            const result = await this.bounded(session.send("Network.streamResourceContent", { requestId: event.requestId }), generation);
            if (!this.live(generation) || candidate.failed) return;
            candidate.receipt.stream_available = true;
            this.consumeEncoded(candidate, result.bufferedData, false);
            const queued = candidate.queued;
            candidate.queued = [];
            this.queuedChunks -= queued.length;
            candidate.active = true;
            for (const encoded of queued) this.consumeEncoded(candidate, encoded, true);
          } catch {
            // A terminal getResponseBody read can still observe a short response.
          }
        })();
        this.track(candidate.activation);
      });
      listen("Network.dataReceived", event => {
        const candidate = this.candidates.get(event.requestId);
        if (!candidate || candidate.failed || candidate.terminal || typeof event.data !== "string") return;
        if (!this.reserveEncoded(candidate, event.data)) return;
        if (candidate.active) this.consumeEncoded(candidate, event.data, true);
        else {
          if (this.queuedChunks >= MAX_QUEUED_CHUNKS) { this.limit(candidate); return; }
          candidate.queued.push(event.data);
          this.queuedChunks++;
        }
      });
      const finish = (event: any, failed: boolean) => {
        const candidate = this.candidates.get(event.requestId);
        if (!candidate || candidate.finishing || candidate.failed || candidate.terminal) return;
        candidate.finishing = (async () => {
          await candidate.ready;
          await candidate.activation;
          if (!this.live(generation) || !candidate.receipt || candidate.failed) return;
          if (failed) {
            candidate.decoder.end();
            candidate.line = ""; candidate.dataLines = []; candidate.terminal = true;
            this.clearQueue(candidate);
            return;
          }
          if (candidate.active) {
            this.consumeText(candidate, candidate.decoder.end());
            this.finishText(candidate);
          } else if (!failed && candidate.receipt.http_status !== undefined
            && candidate.receipt.http_status >= 200 && candidate.receipt.http_status < 300) {
            try {
              const result = await this.bounded(session.send("Network.getResponseBody", { requestId: event.requestId }), generation);
              if (!this.live(generation) || candidate.failed) return;
              this.clearQueue(candidate);
              if (result.base64Encoded) this.consumeEncoded(candidate, result.body, false);
              else if (typeof result.body === "string" && result.body.length <= MAX_BYTES
                && Buffer.byteLength(result.body, "utf8") <= MAX_BYTES - this.bytes) {
                this.bytes += Buffer.byteLength(result.body, "utf8");
                this.consumeText(candidate, result.body);
              } else this.limit(candidate);
              this.consumeText(candidate, candidate.decoder.end());
              this.finishText(candidate);
            } catch { /* Observation unavailable; no synthetic server acceptance. */ }
          }
          if (this.live(generation)) this.clearQueue(candidate);
        })();
        this.track(candidate.finishing);
      };
      listen("Network.loadingFinished", event => finish(event, false));
      listen("Network.loadingFailed", event => finish(event, true));
      await this.bounded(session.send("Network.enable"), generation);
    } catch (error) { await this.close(); throw error; }
  }

  private async inspectRequest(event: any, candidate: Candidate, session: CDPSession, generation: number) {
    const postData = event.request.postData ?? (await this.bounded(
      session.send("Network.getRequestPostData", { requestId: event.requestId }), generation)).postData;
    if (!this.live(generation) || candidate.failed) return;
    this.diagnostic.with_body++;
    if (typeof postData !== "string" || postData.length > MAX_BYTES || Buffer.byteLength(postData, "utf8") > MAX_BYTES) {
      this.limit(candidate); return;
    }
    let body: unknown;
    try { body = JSON.parse(postData); } catch { this.discard(candidate); return; }
    if (!object(body)) { this.discard(candidate); return; }
    this.diagnostic.body_keys = safeKeys(body);
    if (!Array.isArray(body.messages) || body.messages.length > 1024) { this.discard(candidate); return; }
    const users = body.messages.filter(message => object(message) && object(message.author) && message.author.role === "user");
    if (this.diagnostic.user_counts.length < 10) this.diagnostic.user_counts.push(users.length);
    const exact: Record<string, unknown>[] = [];
    for (const message of users) {
      if (!object(message) || !object(message.content) || !Array.isArray(message.content.parts)) continue;
      const raw = message.content.parts.filter((part: unknown): part is string => typeof part === "string").join("");
      const value = normalize(raw);
      if (this.diagnostic.text_lengths.length < 10) this.diagnostic.text_lengths.push(value.length);
      if (this.prompt.length && raw.endsWith(this.prompt)) {
        const prefixChars = raw.length - this.prompt.length;
        this.diagnostic.draft_suffix_match = true;
        this.diagnostic.draft_prefix_char_count = prefixChars;
        this.diagnostic.draft_prefix_shape = raw.slice(0, Math.min(prefixChars, 128)).replace(/[^\p{P}\p{Z}\s]/gu, "x");
        this.diagnostic.draft_prefix_shape_truncated = prefixChars > 128;
      }
      const prefixes = this.connectorName ? [`@${this.connectorName} `, `@${this.connectorName}\n`] : [];
      const connectorMatch = prefixes.some(prefix => value === prefix + normalize(this.prompt));
      this.diagnostic.known_connector_prefix ||= connectorMatch;
      if (value === normalize(this.prompt) || connectorMatch) exact.push(message);
    }
    if (exact.length > 1) this.diagnostic.ambiguous_submission = true;
    if (exact.length !== 1 || !id(exact[0]!.id)) { this.discard(candidate); return; }
    const receipt: Receipt = {
      request_id: event.requestId, exact_draft: true, user_message_ids: [exact[0]!.id],
      server_echoed_user_id: false, server_parent_matches_user: false, response_keys: [], stream_available: false,
    };
    candidate.receipt = receipt;
    this.receipts.set(event.requestId, receipt);
    if (this.receipts.size > 1) this.diagnostic.ambiguous_submission = true;
  }

  private clearQueue(candidate: Candidate) {
    this.queuedChunks -= candidate.queued.length;
    candidate.queued = [];
  }
  private discard(candidate: Candidate) {
    candidate.failed = true;
    candidate.line = ""; candidate.dataLines = []; candidate.eventName = "";
    this.clearQueue(candidate);
    if (candidate.receipt) {
      candidate.receipt.server_echoed_user_id = false;
      candidate.receipt.server_parent_matches_user = false;
    }
  }
  private limit(candidate: Candidate) {
    this.diagnostic.capture_limit_reached = true;
    this.invalidateEvidence();
    this.discard(candidate);
  }
  private invalidateEvidence() {
    for (const receipt of this.receipts.values()) {
      receipt.server_echoed_user_id = false;
      receipt.server_parent_matches_user = false;
    }
  }
  private reserveEncoded(candidate: Candidate, encoded: unknown): encoded is string {
    if (typeof encoded !== "string" || encoded.length > MAX_ENCODED || encoded.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) { this.limit(candidate); return false; }
    const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (bytes > MAX_BYTES - this.bytes) { this.limit(candidate); return false; }
    this.bytes += bytes;
    return true;
  }
  private consumeEncoded(candidate: Candidate, encoded: unknown, reserved: boolean) {
    if (this.closed || candidate.failed || candidate.terminal) return;
    if (!reserved && !this.reserveEncoded(candidate, encoded)) return;
    this.consumeText(candidate, candidate.decoder.write(Buffer.from(encoded as string, "base64")));
  }
  private consumeText(candidate: Candidate, text: string) {
    if (this.closed || candidate.failed || candidate.terminal) return;
    if (candidate.firstText && text.length) {
      candidate.firstText = false;
      if (text.startsWith("\ufeff")) text = text.slice(1);
    }
    candidate.line += text;
    let newline: number;
    while (!candidate.failed && !candidate.terminal && (newline = candidate.line.indexOf("\n")) >= 0) {
      const line = candidate.line.slice(0, newline).replace(/\r$/, "");
      candidate.line = candidate.line.slice(newline + 1);
      this.sseLine(candidate, line);
    }
  }
  private sseLine(candidate: Candidate, line: string) {
    if (!line) { this.dispatch(candidate); return; }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") candidate.eventName = value;
    if (field === "data") {
      if (candidate.dataLines.length >= MAX_EVENT_LINES) { this.limit(candidate); return; }
      candidate.dataLines.push(value);
    }
  }
  private dispatch(candidate: Candidate) {
    const data = candidate.dataLines.join("\n"), eventName = candidate.eventName;
    candidate.dataLines = []; candidate.eventName = "";
    if (!data) return;
    if (data.trim() === "[DONE]") {
      candidate.terminal = true; candidate.line = ""; this.clearQueue(candidate); return;
    }
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { return; }
    const receipt = candidate.receipt;
    if (!receipt || !object(payload)) return;
    receipt.response_keys = [...new Set([...receipt.response_keys, ...safeKeys(payload)])].slice(0, 30);
    if (this.diagnostic.capture_limit_reached || this.diagnostic.candidate_limit_reached) return;
    if (errorFrame(payload, eventName)) return;
    const message = object(payload.message) ? payload.message : undefined;
    if (!message || !id(message.id) || !object(message.author) || errorFrame(message)) return;
    const exactDraftId = receipt.user_message_ids[0];
    if (message.author.role === "user" && message.id === exactDraftId) receipt.server_echoed_user_id = true;
    if (message.author.role === "assistant"
      && [message.parent_id, payload.parent_message_id, payload.parent_id].some(value => id(value) && value === exactDraftId)) {
      receipt.server_parent_matches_user = true;
    }
  }
  private finishText(candidate: Candidate) {
    if (candidate.failed || candidate.terminal) return;
    if (candidate.line) this.sseLine(candidate, candidate.line.replace(/\r$/, ""));
    candidate.line = "";
    this.dispatch(candidate);
    candidate.terminal = true;
  }

  snapshot() {
    return [...this.receipts.values()].map(({ request_id, ...receipt }) => ({
      ...receipt, user_message_ids: [...receipt.user_message_ids], response_keys: [...receipt.response_keys],
      request_id_hash: createHash("sha256").update(request_id).digest("hex").slice(0, 16),
    }));
  }
  /** Additive API: synchronous snapshot stays compatible; callers can await bounded capture. */
  async flushSnapshot(timeoutMs = 1_000) {
    const generation = this.generation;
    const deadline = Date.now() + Math.min(5_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 1_000));
    while (this.live(generation) && this.pending.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { this.diagnostic.flush_timed_out = true; break; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        Promise.allSettled([...this.pending]).then(() => true),
        this.whenClosed.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!completed) { if (this.live(generation)) this.diagnostic.flush_timed_out = true; break; }
    }
    return this.snapshot();
  }
  diagnostics() {
    return { ...this.diagnostic, body_keys: [...this.diagnostic.body_keys],
      user_counts: [...this.diagnostic.user_counts], text_lengths: [...this.diagnostic.text_lengths] };
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.resolveClosed();
    const session = this.session;
    this.session = undefined;
    if (session) for (const [name, callback] of this.listeners) session.off(name, callback);
    this.listeners.clear();
    for (const candidate of this.candidates.values()) {
      candidate.line = ""; candidate.dataLines = []; this.clearQueue(candidate);
    }
    this.candidates.clear(); this.pending.clear();
    if (session) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([session.detach().catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, READ_TIMEOUT_MS); })]);
      if (timer) clearTimeout(timer);
    }
  }
}
