export const CHATGPT_WEB_TRANSPORT_POLICY_VERSION = 1 as const;

export type ChatGptWebTransportChoice =
  | "INLINE"
  | "RETAINED_DELTA"
  | "ZIP_SINGLE_MESSAGE"
  | "VERIFIED_MULTIPART"
  | "BLOCK";

export type ChatGptWebTransportFailure = {
  transport: "INLINE" | "ZIP_SINGLE_MESSAGE";
  code: "message_length_exceeded" | "attachment_limit" | "transport_rejected";
};

export interface ChatGptWebTransportSelectionInput {
  composerChars: number;
  composerCharLimit?: number;
  messageTokens: number;
  messageTokenLimit: number;
  attachmentTokenReserve: number;
  canonicalTokens: number;
  accountCanonicalTokenLimit: number;
  attachmentCount: number;
  attachmentBytes: number;
  attachmentTypes: readonly string[];
  supportedAttachmentTypes: readonly string[];
  maxAttachmentCount: number;
  maxAttachmentBytes: number;
  retainedHistoryProven?: boolean;
  requiredMultipart?: boolean;
  archive?: {
    eligible: boolean;
    mediaType: "application/zip";
    imageCount: number;
    skillCount: number;
    promptChars: number;
    promptTokens: number;
    bytes: number;
    maxBytes: number;
  };
  multipart?: {
    verified: boolean;
    canonicalTokenLimit: number;
  };
  priorFailure?: ChatGptWebTransportFailure;
}

export interface ChatGptWebTransportDecision {
  readonly version: typeof CHATGPT_WEB_TRANSPORT_POLICY_VERSION;
  readonly choice: ChatGptWebTransportChoice;
  readonly reason: string;
  readonly measurements: Readonly<{
    composerChars: number;
    composerCharLimit: number | null;
    messageTokens: number;
    messageTokenLimit: number;
    attachmentTokenReserve: number;
    canonicalTokens: number;
    accountCanonicalTokenLimit: number;
    attachmentCount: number;
    attachmentBytes: number;
    attachmentTypes: readonly string[];
    supportedAttachmentTypes: readonly string[];
    maxAttachmentCount: number;
    maxAttachmentBytes: number;
    archive: Readonly<{ eligible: boolean; mediaType: "application/zip"; imageCount: number; skillCount: number; promptChars: number; promptTokens: number; bytes: number; maxBytes: number }> | null;
    multipart: Readonly<{ verified: boolean; canonicalTokenLimit: number }> | null;
    priorFailure: Readonly<ChatGptWebTransportFailure> | null;
  }>;
}

function decision(
  input: ChatGptWebTransportSelectionInput,
  choice: ChatGptWebTransportChoice,
  reason: string,
): ChatGptWebTransportDecision {
  const measurements = Object.freeze({
    composerChars: input.composerChars,
    composerCharLimit: input.composerCharLimit ?? null,
    messageTokens: input.messageTokens,
    messageTokenLimit: input.messageTokenLimit,
    attachmentTokenReserve: input.attachmentTokenReserve,
    canonicalTokens: input.canonicalTokens,
    accountCanonicalTokenLimit: input.accountCanonicalTokenLimit,
    attachmentCount: input.attachmentCount,
    attachmentBytes: input.attachmentBytes,
    attachmentTypes: Object.freeze([...input.attachmentTypes]),
    supportedAttachmentTypes: Object.freeze([...input.supportedAttachmentTypes]),
    maxAttachmentCount: input.maxAttachmentCount,
    maxAttachmentBytes: input.maxAttachmentBytes,
    archive: input.archive ? Object.freeze({ ...input.archive }) : null,
    multipart: input.multipart ? Object.freeze({ ...input.multipart }) : null,
    priorFailure: input.priorFailure ? Object.freeze({ ...input.priorFailure }) : null,
  });
  return Object.freeze({
    version: CHATGPT_WEB_TRANSPORT_POLICY_VERSION,
    choice,
    reason,
    measurements,
  });
}

export function selectChatGptWebTransport(
  input: ChatGptWebTransportSelectionInput,
): ChatGptWebTransportDecision {
  const canonicalFits = input.canonicalTokens <= input.accountCanonicalTokenLimit;
  const inlineFits = input.composerChars <= (input.composerCharLimit ?? Number.POSITIVE_INFINITY)
    && input.messageTokens <= input.messageTokenLimit
    && input.attachmentCount <= input.maxAttachmentCount
    && input.attachmentBytes <= input.maxAttachmentBytes
    && input.attachmentTypes.every(type => input.supportedAttachmentTypes.includes(type));
  const priorInlineFailure = input.priorFailure?.transport === "INLINE";

  if (input.requiredMultipart) {
    if (canonicalFits && input.multipart?.verified
      && input.canonicalTokens <= input.multipart.canonicalTokenLimit) {
      return decision(input, "VERIFIED_MULTIPART", "multipart is required for this history compaction request and was verified");
    }
    return decision(input, "BLOCK", "history compaction requires multipart, but no verified multipart transport fits");
  }

  if (input.retainedHistoryProven) {
    if (!canonicalFits) {
      return decision(input, "BLOCK", `retained delta requires ${input.canonicalTokens} tokens, exceeding the measured account budget of ${input.accountCanonicalTokenLimit}; archive or multipart cannot increase model recall`);
    }
    if (inlineFits && !priorInlineFailure) {
      return decision(input, "RETAINED_DELTA", "retained history is proven and this delta fits the current message limits");
    }
    if (canonicalFits && input.multipart?.verified
      && input.canonicalTokens <= input.multipart.canonicalTokenLimit) {
      return decision(input, "VERIFIED_MULTIPART", "retained delta exceeded one message and verified multipart is available");
    }
    return decision(input, "BLOCK", "retained history is proven but this delta cannot be transported safely without rebootstrap");
  }

  if (canonicalFits && inlineFits && !priorInlineFailure) {
    return decision(input, "INLINE", input.priorFailure?.transport === "ZIP_SINGLE_MESSAGE"
      ? `prior ZIP failure (${input.priorFailure.code}); inline context still fits the measured one-message limits`
      : "canonical context and all attachments fit the measured one-message limits");
  }

  const archiveFits = canonicalFits
    && input.archive?.eligible === true
    && input.archive.mediaType === "application/zip"
    && input.archive.promptChars <= (input.composerCharLimit ?? Number.POSITIVE_INFINITY)
    && input.archive.promptTokens <= input.messageTokenLimit
    && input.archive.bytes <= input.archive.maxBytes;
  if (archiveFits && input.priorFailure?.transport !== "ZIP_SINGLE_MESSAGE") {
    return decision(input, "ZIP_SINGLE_MESSAGE", priorInlineFailure
      ? `prior inline failure (${input.priorFailure!.code}) requires a single-message archive`
      : "inline text or attachments exceed measured limits; the complete archive fits one message and the account budget");
  }

  if (canonicalFits && input.multipart?.verified
    && input.canonicalTokens <= input.multipart.canonicalTokenLimit) {
    return decision(input, "VERIFIED_MULTIPART", "single-message inline and archive transports do not fit; multipart was verified for this request");
  }

  const reasons: string[] = [];
  if (!canonicalFits) reasons.push(`canonical context requires ${input.canonicalTokens} tokens, exceeding the measured account budget of ${input.accountCanonicalTokenLimit}; ZIP and multipart cannot increase model recall`);
  if (input.attachmentCount > input.maxAttachmentCount) reasons.push(`more images or skills than the ${input.maxAttachmentCount} attachments per message limit (${input.attachmentCount} required)`);
  const unsupportedTypes = [...new Set(input.attachmentTypes.filter(type => !input.supportedAttachmentTypes.includes(type)))];
  if (unsupportedTypes.length) reasons.push(`unsupported attachment type or data: ${unsupportedTypes.join(", ")}; images must be supported inline base64 data URLs and each image must fit the 20 MB limit`);
  if (input.attachmentBytes > input.maxAttachmentBytes) reasons.push(`attachments require ${input.attachmentBytes} bytes, exceeding the ${input.maxAttachmentBytes} byte limit`);
  if (input.composerChars > (input.composerCharLimit ?? Infinity)) reasons.push(`composer requires ${input.composerChars} characters, exceeding the ${input.composerCharLimit} character limit`);
  if (input.messageTokens > input.messageTokenLimit) reasons.push(`message requires ${input.messageTokens} tokens plus ${input.attachmentTokenReserve} reserved attachment tokens, exceeding its ${input.messageTokenLimit} text-token budget`);
  if (input.priorFailure) reasons.push(`prior ${input.priorFailure.transport} failure: ${input.priorFailure.code}`);
  return decision(input, "BLOCK", reasons.join("; ") || "no verified transport is available for this request");
}
