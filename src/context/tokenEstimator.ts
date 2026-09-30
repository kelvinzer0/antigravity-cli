/**
 * Token estimation.
 *
 * Deliberately dependency-free: a chars/4 heuristic that is close enough to decide
 * when a request is approaching the model's context window. Compaction only needs to
 * know "am I near the limit", not the exact billing number.
 */
import { GeminiContent } from './geminiTypes';

const CHARS_PER_TOKEN = 4;
const TOOL_SCHEMA_TOKENS_PER_CHAR = 0.25;

export function estimateTextTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateSystemTokens(system: string | undefined | null): number {
  return estimateTextTokens(system);
}

export function estimateContentTokens(contents: GeminiContent[] | undefined): number {
  if (!Array.isArray(contents)) return 0;
  let chars = 0;
  for (const content of contents) {
    for (const part of content?.parts || []) {
      if (typeof part?.text === 'string') chars += part.text.length;
      else if (part) chars += JSON.stringify(part).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateToolTokens(tools: unknown): number {
  if (!tools) return 0;
  let serialized: string;
  try {
    serialized = JSON.stringify(tools);
  } catch {
    return 0;
  }
  if (!serialized) return 0;
  return Math.ceil(serialized.length * TOOL_SCHEMA_TOKENS_PER_CHAR);
}

export function estimateRequestTokens(input: {
  system?: string;
  contents?: GeminiContent[];
  tools?: unknown;
}): number {
  return (
    estimateSystemTokens(input.system) +
    estimateContentTokens(input.contents) +
    estimateToolTokens(input.tools)
  );
}
