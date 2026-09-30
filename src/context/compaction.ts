/**
 * Automatic context compaction.
 *
 * The injected agent context costs a few thousand tokens before the conversation even
 * starts. On a long session with a small model that is enough to blow the context
 * window and get the request rejected upstream. When the estimate crosses the
 * threshold, the oldest turns are summarized and replaced with a compact state
 * summary, while the most recent turns are preserved verbatim so the model keeps its
 * immediate train of thought.
 *
 * Summarization is done with an LLM call through the same provider. If that fails the
 * oldest turns are dropped instead, which is worse for quality but still produces a
 * request the provider will accept.
 */
import * as http from 'http';
import * as https from 'https';
import { log } from '../logger';
import { getProviderHeaders, getProviderUrl, getTranslator, supportsStreaming, translateRequest, translateResponse } from '../proxy/registry';
import { getContextWindow } from './contextWindows';
import { GeminiContent, GeminiRequestBody, getSystemInstruction, readSystemText } from './geminiTypes';
import { CompactionSettings } from './settings';
import { estimateRequestTokens } from './tokenEstimator';

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_TAIL_TURNS = 2;
const SUMMARY_MAX_OUTPUT_TOKENS = 2048;
const SUMMARY_REQUEST_TIMEOUT_MS = 60_000;

export interface CompactionTargetModel {
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  timeout?: number;
}

const SUMMARIZATION_TEMPLATE = `You are a conversation summarizer. Summarize the conversation below into a structured handoff format. Preserve every decision, constraint, file path, and piece of state that later work depends on.

Output format:
## Objective
- [what the user is trying to accomplish]

## Important Details
- [constraints, decisions, facts, assumptions, file paths already discovered]

## Work State
- Completed: [finished work, verified facts]
- Active: [current work, partial changes]
- Blocked: [blockers, failing commands]

## Next Move
1. [immediate concrete action]
2. [next action if known]

Conversation to summarize:
`;

export function needsCompaction(
  system: string,
  contents: GeminiContent[] | undefined,
  tools: unknown,
  contextWindow: number,
  threshold: number,
): boolean {
  if (!(threshold > 0) || threshold >= 1) return false;
  const maxTokens = Math.floor(contextWindow * threshold);
  return estimateRequestTokens({ system, contents, tools }) > maxTokens;
}

/** A "turn" is a user + model pair, so N turns is 2N messages. */
export function selectContentsToCompact(
  contents: GeminiContent[] | undefined,
  tailTurns: number = DEFAULT_TAIL_TURNS,
): { toCompact: GeminiContent[]; toPreserve: GeminiContent[] } {
  const all = Array.isArray(contents) ? contents : [];
  // slice(0, -0) would silently drop everything, so handle the zero-tail case explicitly.
  if (tailTurns <= 0) return { toCompact: all, toPreserve: [] };

  const preserveCount = Math.floor(tailTurns) * 2;
  if (all.length <= preserveCount) return { toCompact: [], toPreserve: all };
  return { toCompact: all.slice(0, -preserveCount), toPreserve: all.slice(-preserveCount) };
}

export function buildSummarizationPrompt(contents: GeminiContent[]): string {
  const serialized = contents
    .map((content) => {
      const label = content?.role === 'user' ? '[User]' : '[Assistant]';
      const text = (content?.parts || [])
        .map((part) => {
          if (typeof part?.text === 'string') return part.text;
          if (part?.functionCall) return `[tool_call] ${JSON.stringify(part.functionCall)}`;
          if (part?.functionResponse) return `[tool_result] ${JSON.stringify(part.functionResponse)}`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
      return `${label}: ${text}`;
    })
    .filter((entry) => entry.length > '[User]: '.length)
    .join('\n\n');

  return SUMMARIZATION_TEMPLATE + serialized;
}

function normalizeProvider(provider: string): string {
  return provider === 'custom' || provider === 'openrouter' ? 'openai' : provider;
}

function buildSummaryUrl(model: CompactionTargetModel, provider: string): string {
  let url = model.apiUrl;
  const translator = getTranslator(provider);
  if (provider === 'google' || provider === 'ollama') {
    url = getProviderUrl(url, model.externalModelName, false, translator);
  } else if (!/\/chat\/completions|\/completions|\/messages/.test(url.toLowerCase())) {
    if (url.endsWith('/v1')) url += '/chat/completions';
    else if (!url.endsWith('/')) url += '/v1/chat/completions';
    else url += 'v1/chat/completions';
  }
  return url;
}

interface GeminiResponseCandidate {
  content?: { parts?: { text?: string }[] };
}

interface GeminiResponseShape {
  candidates?: GeminiResponseCandidate[];
  response?: { candidates?: GeminiResponseCandidate[] };
}

function extractTextFromGeminiResponse(response: unknown): string {
  const root = response as GeminiResponseShape;
  const candidates = root?.candidates || root?.response?.candidates;
  if (!Array.isArray(candidates)) return '';
  return candidates
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/** Single non-streaming provider call used only for summarization. */
async function summarizeWithProvider(model: CompactionTargetModel, prompt: string): Promise<string> {
  const provider = normalizeProvider(model.provider);
  const summaryBody: GeminiRequestBody = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS },
  };

  const payload = translateRequest(provider, summaryBody, model.externalModelName) as Record<string, unknown>;
  if (supportsStreaming(provider)) payload.stream = false;

  const headers = getProviderHeaders(provider, model.apiKey);
  const url = new URL(buildSummaryUrl(model, provider));
  const client = url.protocol === 'https:' ? https : http;

  const bodyText = await new Promise<string>((resolve, reject) => {
    const request = client.request(url, { method: 'POST', headers: headers as Record<string, string> }, (apiRes) => {
      let body = '';
      apiRes.on('data', (chunk: Buffer) => (body += chunk.toString('utf-8')));
      apiRes.on('end', () => {
        if ((apiRes.statusCode || 200) >= 400) {
          reject(new Error(`${provider} returned ${apiRes.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(body);
      });
      apiRes.on('error', reject);
    });
    request.setTimeout(model.timeout || SUMMARY_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('summarization timed out')));
    request.on('error', reject);
    request.write(JSON.stringify(payload));
    request.end();
  });

  const mapped = translateResponse(provider, JSON.parse(bodyText), model.externalModelName);
  const text = extractTextFromGeminiResponse(mapped);
  if (!text) throw new Error('empty summary from provider');
  return text;
}

export interface CompactionResult {
  compacted: boolean;
  reason?: string;
  estimatedTokens?: number;
  contextWindow?: number;
  summarizedTurns?: number;
}

/**
 * Compacts the request in place when it exceeds the threshold.
 * The injected system instruction is never compacted — it is a fixed cost by design.
 */
export async function compactIfNeeded(
  body: GeminiRequestBody,
  model: CompactionTargetModel,
  settings: CompactionSettings,
): Promise<CompactionResult> {
  const contextWindow = getContextWindow(model.externalModelName);
  const system = readSystemText(body);
  const contents = body.contents;
  const estimatedTokens = estimateRequestTokens({ system, contents, tools: body.tools });

  if (!settings.enabled) return { compacted: false, reason: 'compaction disabled', estimatedTokens, contextWindow };

  if (!needsCompaction(system, contents, body.tools, contextWindow, settings.threshold)) {
    return { compacted: false, reason: 'within threshold', estimatedTokens, contextWindow };
  }

  const { toCompact, toPreserve } = selectContentsToCompact(contents, settings.tailTurns);
  if (toCompact.length === 0) {
    return { compacted: false, reason: 'nothing older than tail to compact', estimatedTokens, contextWindow };
  }

  log.info(`[Compaction] ~${estimatedTokens} tokens vs window ${contextWindow} — compacting ${toCompact.length} message(s), preserving ${toPreserve.length}`);

  const prompt = buildSummarizationPrompt(toCompact);
  let summary: string;

  try {
    summary = await summarizeWithProvider(model, prompt);
    log.info(`[Compaction] Summary obtained (${summary.length} chars)`);
  } catch (e) {
    log.warn(`[Compaction] Summarization failed, falling back to truncation: ${(e as Error).message}`);
    summary = '[Earlier conversation was truncated to fit the context window. Ask the user to restate any details you need.]';
  }

  body.contents = [
    { role: 'user', parts: [{ text: `[Context compacted]\n${summary}` }] },
    ...toPreserve,
  ];

  // Keep the instruction in the shape the translators expect after rewriting contents.
  if (!getSystemInstruction(body) && system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const postTokens = estimateRequestTokens({ system, contents: body.contents, tools: body.tools });
  log.info(`[Compaction] Request reduced from ~${estimatedTokens} to ~${postTokens} tokens`);

  return { compacted: true, estimatedTokens, contextWindow, summarizedTurns: toCompact.length };
}
