import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
} from "./prompt";

/**
 * Luna uses its model context contract for preflight. Historical browser measurements around 28K
 * were account/surface-specific and are not a stable transport ceiling; current GPT-5.6 Luna has a
 * 1.05M-token model window. Real browser/server rejections remain authoritative at submission time.
 */

const TOKEN_ESTIMATE_TRANSACTION = `ctx_${"0".repeat(32)}`;

export function compiledChatGptWebMessages(compiled: CompiledChatGptWebPrompt): string[] {
  if (!compiled.multipart) return [compiled.text];
  return [
    ...compiled.multipart.parts.slice(0, -1).map((payload, index) => (
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).text
    )),
    formatChatGptWebMultipartCommit(compiled.multipart, TOKEN_ESTIMATE_TRANSACTION),
  ];
}

export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => message.length));
}

/** Tokens present in the one visible browser message, excluding hidden product/tool reserves. */
export function estimateCompiledChatGptWebMessageTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const messages = compiledChatGptWebMessages(compiled);
  return Math.max(...messages.map((message, index) => estimateTokens(message, modelId)
    + (index === messages.length - 1 ? skillFileTokens(compiled.skillFiles, modelId) : 0)));
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const messageTokens = compiledChatGptWebMessages(compiled)
    .reduce((total, message) => total + estimateTokens(message, modelId), 0);
  const acknowledgementTokens = compiled.multipart
    ? compiled.multipart.parts.slice(0, -1).reduce((total, payload, index) => total + estimateTokens(
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).acknowledgement,
      modelId,
    ), 0)
    : 0;
  return CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + messageTokens + acknowledgementTokens + imageTokens + skillFileTokens(compiled.skillFiles, modelId);
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce(
    (total, image) => total + chatGptWebImageTokenReserve(image.detail),
    0,
  );
}
