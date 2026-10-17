import { existsSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "../../config";
import { getCodexHome } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironmentClaim,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptSteeringEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  type ChatGptRootThreadMetadata,
  hasCurrentChatGptEnvironmentContext,
  extractChatGptCalendarEnvironmentDelta,
  hasRawChatGptEnvironmentContext,
  unattributedChatGptEnvironmentMessages,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  type ChatGptEnvironmentClaim,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
} from "./environment";
import { resolveCurrentCodexRolloutEnvironment } from "./codex-rollout-environment";
import { ChatGptWebAdapterError } from "./adapter-error";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
}

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  const unique = new Map<string, string>();
  for (const path of value.map(path => resolve(path as string))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (writableRoots.length !== roots.length || writableRoots.some(path => !rootIdentities.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    const policyRoots = absolutePaths(parsed.writableRoots, "workspace-write policy writable roots");
    const declared = new Set(policyRoots.map(pathIdentity));
    // Project membership is not the grant boundary: native Codex also authorizes
    // external output directories. Both persisted grant sets must agree exactly.
    if (typeof parsed.networkAccess !== "boolean" || policyRoots.length !== writableRoots.length
      || writableRoots.some(path => !declared.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: parsed.networkAccess };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: parsed.networkAccess };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots");
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  if (!roots.some(root => contains(root, cwd))) throw new Error("Persisted ChatGPT cwd is outside its roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
  };
}

function conflictingAuthorityFields(claim: ChatGptEnvironmentClaim, right: ChatGptTurnEnvironment): string[] {
  const left = claim.environment;
  const claimedRoots = new Set(left.roots.map(pathIdentity));
  const nativeRoots = new Set(right.roots.map(pathIdentity));
  const nativeGrants = new Set([...right.roots, ...right.writableRoots].map(pathIdentity));
  const fields: string[] = [];
  if (pathIdentity(left.cwd) !== pathIdentity(right.cwd)) fields.push("cwd");
  // Codex 0.163 omits workspace_roots in some rollouts while its envelope still
  // lists output directories. Every extra claimed root must be an exact native
  // grant, and no native workspace may disappear. Return only native authority.
  if ([...nativeRoots].some(root => !claimedRoots.has(root))
    || [...claimedRoots].some(root => !nativeGrants.has(root))) fields.push("workspace_roots");
  // Filesystem envelopes omit Codex's extra output directories, including after
  // compaction. Only the current native rollout supplies the returned grants.
  if (!left.writableRoots.every(path => right.writableRoots.some(root => pathIdentity(root) === pathIdentity(path)))) {
    fields.push("writable_roots");
  }
  if (left.sandboxPolicy.type !== right.sandboxPolicy.type) fields.push("sandbox_policy");
  // An envelope that does not state its network policy cannot contradict the rollout on it.
  if (left.sandboxPolicy.type !== "dangerFullAccess" && right.sandboxPolicy.type !== "dangerFullAccess"
    && claim.statesNetworkAccess && left.sandboxPolicy.networkAccess !== right.sandboxPolicy.networkAccess) {
    fields.push("network_access");
  }
  return fields;
}

function assertMetadataMatchesAuthority(
  metadata: Pick<ChatGptRootThreadMetadata, "sandboxType" | "workspaceRoots">,
  environment: StoredThreadEnvironment,
): void {
  if (metadata.sandboxType === "platform"
    ? environment.sandboxPolicy.type === "dangerFullAccess"
    : environment.sandboxPolicy.type !== metadata.sandboxType) {
    throw new Error("Cached ChatGPT thread environment conflicts with current Codex sandbox metadata");
  }
  if (metadata.workspaceRoots.length > 0
    && !metadata.workspaceRoots.some(root => contains(root, environment.cwd))) {
    throw new Error("Cached ChatGPT thread environment conflicts with current Codex workspace metadata");
  }
  if (metadata.workspaceRoots.some(root => !environment.roots.some(knownRoot => (
    contains(knownRoot, root) || contains(root, knownRoot)
  )))) {
    throw new Error("Cached ChatGPT thread environment conflicts with current Codex workspace metadata");
  }
}

function currentMetadataConstraints(
  parsed: CodexParsedRequest,
  threadId: string,
): ChatGptRootThreadMetadata | undefined {
  // Follow-up metadata often omits request_kind even though its sandbox/workspaces still
  // constrain the current turn. Parse it only to narrow same-thread authority; it grants none.
  const body = record(parsed._rawBody);
  const clientMetadata = record(body?.client_metadata);
  const encoded = clientMetadata?.["x-codex-turn-metadata"];
  if (typeof encoded !== "string") return undefined;
  let metadata: Record<string, unknown> | undefined;
  try { metadata = record(JSON.parse(encoded)); } catch { return undefined; }
  if (metadata?.thread_id !== threadId) return undefined;
  if(metadata.workspaces!==undefined&&!record(metadata.workspaces))
    throw new ChatGptWebAdapterError('Current Codex workspace metadata is malformed; supply an authentic Codex environment before retrying.',
      {status:400,errorType:'invalid_request_error',code:'TRUSTED_CWD_MISSING_OR_UNVERIFIED',retryable:false});
  const current = extractChatGptRootThreadMetadata(parsed);
  if (current) return current;
  const hasConstraints = metadata.sandbox_mode !== undefined || metadata.sandbox !== undefined
    || metadata.workspaces !== undefined;
  if (!hasConstraints) return undefined;

  const constrainedBody = {
    ...body,
    client_metadata: {
      ...clientMetadata,
      "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: metadata.request_kind ?? "turn" }),
    },
  };
  const constrainedRequest = { ...parsed, _rawBody: constrainedBody };
  const constraints = extractChatGptRootThreadMetadata(constrainedRequest);
  if (!constraints) {
    throw new Error("Current Codex workspace or sandbox metadata cannot be validated against cached ChatGPT thread authority");
  }
  return constraints;
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. Verified authority may carry across turns in this process; persisted
 * records are diagnostic only. Tool declarations always come from the current request.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();
  // Persisted entries aid diagnosis and recovery inspection, but only a current verified
  // environment in this process can mark a thread as an authority source.
  private readonly verifiedThreads = new Map<string, number>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    private readonly codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
  ) {}

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    let initialClaim: ChatGptEnvironmentClaim | undefined;
    try {
      const claim = extractChatGptTurnEnvironmentClaim(parsed);
      const environment = claim.environment;
      if (environment.sandboxPolicy.type !== "dangerFullAccess" && !claim.statesNetworkAccess) {
        // Modern envelopes state filesystem access only. Resolve the current native policy on
        // the first round too: absence of a network statement is not a disabled-network grant.
        initialClaim = claim;
        throw new MissingTrustedCodexEnvironmentError("network access");
      }
      if (identity.threadId) this.set(identity.threadId, environment);
      return environment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError) || !identity.threadId) throw error;
      const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
      // Root tasks also retain unattributed environment fragments after compaction.
      // They are historical only when the exact native record predates this task;
      // neither the fragment nor the cache supplies the current authority.
      // A recognized current claim may omit only its network statement. Resolve
      // that field from the current turn_context; do not authenticate the newly
      // generated envelope as if it were an older historical response_item.
      const historicalMessages = hasCurrentContext && !currentCompaction && !initialClaim
        ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
      const steeringClaim = hasCurrentContext && !currentCompaction
        ? extractChatGptSteeringEnvironmentClaim(parsed) : undefined;
      const calendarDelta = hasCurrentContext && !currentCompaction
        ? extractChatGptCalendarEnvironmentDelta(parsed) : undefined;
      if (hasCurrentContext && !currentCompaction && !initialClaim && !historicalMessages && !steeringClaim && !calendarDelta) throw error;
      const currentClaim = initialClaim ?? (currentCompaction ? extractChatGptContinuationEnvironmentClaim(parsed) : steeringClaim);
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      // Automatic compaction has a current turn_context; standalone compaction has only its
      // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
      const compactionSourceRevision = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed) : undefined;
      const compactionSourceTurnId = compactionSourceRevision?.turnId;
      const compactionSource = compactionSourceRevision?.turnId && compactionSourceRevision.itemId
        ? {
          id: compactionSourceRevision.itemId,
          turnId: compactionSourceRevision.turnId,
          content: compactionSourceRevision.content,
        } : undefined;
      if (rolloutIdentity && identity.turnId) {
        const rolloutEnvironment = resolveCurrentCodexRolloutEnvironment({
          codexHome: this.codexHome,
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage: rolloutIdentity,
          turnId: identity.turnId,
          ...(compactionSourceTurnId ? { compactionSourceTurnId } : {}),
          ...(compactionSource ? { compactionSource } : {}),
          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
          tools: parsed.context.tools,
        });
        if (rolloutEnvironment) {
          if (calendarDelta) {
            const nativeRoots = new Set(rolloutEnvironment.roots.map(pathIdentity));
            if (rolloutEnvironment.sandboxPolicy.type !== "dangerFullAccess"
              || calendarDelta.workspaceRoots.some(roots => roots.length !== nativeRoots.size
                || roots.some(root => !nativeRoots.has(root)))) {
              throw new Error("Calendar environment delta conflicts with its current Codex rollout");
            }
          }
          const conflicts = currentClaim ? conflictingAuthorityFields(currentClaim, rolloutEnvironment) : [];
          if (conflicts.length > 0) {
            const source = currentCompaction ? "Compaction continuation" : initialClaim ? "Current" : "Steering";
            // Field names are safe to export; paths, request text and permission
            // contents are deliberately excluded from both the log and UI error.
            console.warn(`[chatgpt-web] trusted environment conflict (source=${source}, fields=${conflicts.join(",")})`);
            throw new Error(`${source} environment conflicts with its current Codex rollout (fields: ${conflicts.join(", ")})`);
          }
          this.set(rolloutIdentity.threadId, rolloutEnvironment);
          return rolloutEnvironment;
        }
      }
      // Only a current native rollout can supersede an unrecognized historical envelope. Without
      // that proof, do not turn arbitrary history or an invalid update into cached authority.
      if (hasRawChatGptEnvironmentContext(parsed)) throw error;
      const sameThread = this.get(identity.threadId);
      if (sameThread) {
        if (lineage) assertMetadataMatchesAuthority(lineage, sameThread);
        else if (identity.threadId) {
          const currentConstraints = currentMetadataConstraints(parsed, identity.threadId);
          if (currentConstraints) assertMetadataMatchesAuthority(currentConstraints, sameThread);
        }
        return {
          cwd: sameThread.cwd,
          roots: sameThread.roots,
          writableRoots: sameThread.writableRoots,
          sandboxPolicy: sameThread.sandboxPolicy,
          tools: parsed.context.tools ?? [],
        };
      }

      if (!lineage) throw error;
      const parent = this.get(lineage.parentThreadId);
      if (!parent) throw error;
      if (lineage.sandboxType !== parent.sandboxPolicy.type) {
        throw new Error("ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread");
      }
      if (lineage.workspaceRoots.length > 0 && !lineage.workspaceRoots.some(root => contains(root, parent.cwd))) {
        throw new Error("ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd");
      }
      if (lineage.workspaceRoots.some(root => !parent.roots.some(parentRoot => (
        contains(parentRoot, root) || contains(root, parentRoot)
      )))) {
        throw new Error("ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots");
      }
      const inherited: ChatGptTurnEnvironment = {
        cwd: parent.cwd,
        roots: parent.roots,
        writableRoots: parent.writableRoots,
        sandboxPolicy: parent.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };
      this.set(lineage.threadId, inherited);
      return inherited;
    }
  }

  private get(threadId: string): StoredThreadEnvironment | undefined {
    this.load();
    const verifiedAt = this.verifiedThreads.get(threadId);
    if (verifiedAt === undefined) return undefined;
    if (this.now() - verifiedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.verifiedThreads.delete(threadId);
      return undefined;
    }
    const stored = this.threads.get(threadId);
    if (!stored) return undefined;
    this.threads.delete(threadId);
    this.threads.set(threadId, stored);
    this.verifiedThreads.delete(threadId);
    // Reading previously verified authority is not a fresh verification event.
    this.verifiedThreads.set(threadId, verifiedAt);
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment): void {
    // Only this path has already verified authority from the current request, native
    // rollout, or a successfully loaded parent. A cache read alone may never recover it.
    this.load(true);
    this.threads.delete(threadId);
    this.threads.set(threadId, authority(environment, this.now()));
    this.verifiedThreads.delete(threadId);
    this.verifiedThreads.set(threadId, this.now());
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
      this.verifiedThreads.delete(oldest);
    }
    while (this.verifiedThreads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.verifiedThreads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.verifiedThreads.delete(oldest);
    }
    this.persist();
  }

  private load(verifiedEnvironment = false): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const invalidState = (reason: string) => new ChatGptWebAdapterError(
      `The saved Codex task environment file (thread-environments.json) ${reason}. `
      + "Its contents have not been overwritten. Start a fresh Codex task to supply its current workspace and permissions. "
      + "If that also fails, export Activity > Export safe log; do not delete your launcher settings.",
      { status: 409, errorType: "invalid_request_error", code: "thread_environment_state_invalid", retryable: false },
    );
    const source = readFileSync(this.path, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      if (!verifiedEnvironment) throw invalidState("contains invalid JSON");
      // Preserve the original for diagnosis. Never infer permissions from a damaged cache,
      // discard an unfamiliar schema, or turn a read/rename permission error into recovery.
      if (readFileSync(this.path, "utf8") !== source) throw invalidState("changed during recovery");
      const backup = `${this.path}.corrupt-${crypto.randomUUID()}`;
      renameSync(this.path, backup);
      console.warn("[chatgpt-web] preserved corrupt thread-environments.json beside the original; rebuilding from a verified current Codex environment");
      this.loaded = true;
      return;
    }
    const parsed = record(decoded);
    const rawThreads = record(parsed?.threads);
    if (parsed?.version !== 1 || !rawThreads) throw invalidState("has an unsupported or invalid format");
    let entries: Array<readonly [string, StoredThreadEnvironment]>;
    try {
      const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
      entries = Object.entries(rawThreads)
        .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
        .filter(([, environment]) => environment.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_THREAD_ENVIRONMENTS);
    } catch {
      throw invalidState("contains invalid workspace or permission records");
    }
    for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
    this.loaded = true;
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, { durable: true });
  }
}
