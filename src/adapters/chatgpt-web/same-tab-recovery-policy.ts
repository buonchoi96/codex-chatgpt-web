import { ChatGptWebAdapterError } from './adapter-error';

/** Once reconciliation starts, a transport fault cannot authorize an outer cold retry. */
export async function runSameTabRecoverySafely<T>(action:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();
  try { return await action(); }
  catch (error) {
    if(signal?.aborted)throw new DOMException('ChatGPT web turn aborted','AbortError');
    if(error instanceof ChatGptWebAdapterError&&!error.retryable)throw error;
    throw new ChatGptWebAdapterError('Recovery could not prove old-generation and native-receipt settlement; automatic resubmission is blocked.',
      {status:503,errorType:'server_error',code:'same_tab_recovery_blocked',retryable:false,cause:error});
  }
}

export interface SameTabRecoveryError {
  code?: string;
  retryable?: boolean;
}

export type SameTabRecoverySkipReason =
  | "user_cancelled"
  | "tool_capable_fresh_capability_required"
  | "unsupported_error"
  | "same_lease_not_proven";

export type SameTabRecoveryTrigger =
  | { eligible: true; trigger: "upstream_error" | "verified_stall" }
  | { eligible: false; reason: SameTabRecoverySkipReason };

/** Browser-only recovery never inherits tool credentials or replays a user cancellation. */
export function classifySameTabRecoveryTrigger(
  error: SameTabRecoveryError,
  userCancelled: boolean,
  toolCapable: boolean,
  freshCapabilityAvailable = false,
): SameTabRecoveryTrigger {
  if (userCancelled) return { eligible: false, reason: "user_cancelled" };
  if (toolCapable && !freshCapabilityAvailable) return { eligible: false, reason: "tool_capable_fresh_capability_required" };
  if (error.retryable !== true) return { eligible: false, reason: "unsupported_error" };
  if (error.code === "upstream_server_error") return { eligible: true, trigger: "upstream_error" };
  if (error.code === "message_delivery_stalled") return { eligible: true, trigger: "verified_stall" };
  return { eligible: false, reason: "unsupported_error" };
}

export function createSameTabRecoveryDelta(): string {
  return "Continue from the committed answer above. Finish the requested task without repeating completed work.";
}
import { buildContextArchive } from './context-archive';
import type { CompiledChatGptWebPrompt } from './prompt';

/** Called only after Stop failure/deadline eligibility AND old-generation settlement proof.
 * The canonical prompt and all attachments are preserved. Live credentials are refused. */
export function createSameTabRecoveryFallback(source: CompiledChatGptWebPrompt, committedPrefix: string): CompiledChatGptWebPrompt {
  if (source.multipart) throw new Error('Multipart recovery requires a canonical epoch checkpoint');
  // The compiler's canonical envelope excludes the current capability contract. Never ZIP the
  // complete tool prompt: that would transfer old authority along with historical data.
  const envelope = /<codex_context_json>\r?\n([^\r\n]*)\r?\n<\/codex_context_json>/.exec(source.text)?.[1];
  if (envelope) {
    const parsed = JSON.parse(envelope);
    if (parsed.version !== 3 || !Array.isArray(parsed.system) || !Array.isArray(parsed.messages))
      throw new Error('Canonical recovery envelope is invalid');
  }
  const contextText = `${source.contextArchive?.contextText ?? envelope ?? source.text}\n\n<committed_response_prefix>\n${committedPrefix}\n</committed_response_prefix>`;
  const archive = buildContextArchive(contextText, source.images, source.skillFiles ?? []);
  return { text: createSameTabRecoveryDelta(), images: source.images,
    ...(source.skillFiles ? { skillFiles: source.skillFiles } : {}),
    contextArchive: { name: archive.name, base64: Buffer.from(archive.bytes).toString('base64'), sha256: archive.sha256,
      manifestSha256: archive.manifestSha256, contextText, acknowledgement: archive.acknowledgement } };
}
