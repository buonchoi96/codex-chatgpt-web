import { get_encoding, type Tiktoken } from "tiktoken";
import { BoundedCache } from "./bounded-cache";

/**
 * Token accounting for ChatGPT Web prompts.
 *
 * A character ratio is not safe here: dense JSON/base64 can contain far more tokens than prose
 * of the same length. Count with the tokenizer used by the GPT-5 generation instead.
 */

const TOKENIZER_CHUNK_CHARS = 4_096;
let tokenizer: Tiktoken | undefined;

function chatGptTokenizer(): Tiktoken {
  tokenizer ??= get_encoding("o200k_base");
  return tokenizer;
}

/**
 * Count ordinary text conservatively without handing pathological multi-megabyte runs to one
 * tokenizer call. Independent chunks can only lose cross-boundary merges, so their sum may
 * over-count slightly but cannot under-count because of a missed boundary token.
 */
export function estimateTokens(text: string, modelId?: string): number {
  void modelId;
  return ordinaryTextEstimator.estimate(text);
}

/** Cache exact chunk counts within one tokenizer; never substitute approximate token ratios. */
export class ChunkTokenEstimator {
  // At most 512 immutable chunks / 4 MiB of UTF-16 text, retained for at most five minutes.
  private readonly cache = new BoundedCache<string, number>(512, 4 * 1024 * 1024, 5 * 60_000);

  constructor(private readonly countChunk: (text: string) => number) {}

  estimate(text: string): number {
    let count = 0;
    let chunkIndex = 0;
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + TOKENIZER_CHUNK_CHARS, text.length);
      if (end < text.length) {
        const previous = text.charCodeAt(end - 1);
        const next = text.charCodeAt(end);
        if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
      }
      const chunk = text.slice(start, end);
      // Oversized sequential contexts must not evict their own immutable prefix on
      // every pass. Admit only the first 512 chunks; count the remaining suffix exactly.
      const cacheable = chunkIndex++ < 512;
      let tokens = cacheable ? this.cache.get(chunk) : undefined;
      if (tokens === undefined) {
        tokens = this.countChunk(chunk);
        if (cacheable) this.cache.set(chunk, tokens, chunk.length * 2);
      }
      count += tokens;
      start = end;
    }
    return count;
  }
}

// The model argument remains informational: every existing route uses this same o200k tokenizer.
const ordinaryTextEstimator = new ChunkTokenEstimator(text => chatGptTokenizer().encode_ordinary(text).length);
