/**
 * Reasoning effort configuration.
 *
 * Some models (DeepSeek R-series, OpenAI o-series, NVIDIA stepfun, QwQ) accept a
 * `reasoning_effort` parameter controlling how much they "think" before answering.
 * Stored in ~/.free-antigravity/reasoning-effort.json, keyed by model name.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../config';
import { log } from '../logger';

export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'max';

export const VALID_REASONING_EFFORTS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'max'];

export interface ReasoningEffortConfig {
  models: Record<string, ReasoningEffort>;
}

/** Patterns ordered most-specific first so the most accurate label wins. */
export const REASONING_EFFORT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /deepseek[-/.]?r1/i, label: 'DeepSeek R1' },
  { pattern: /deepseek[-/.]?r2/i, label: 'DeepSeek R2' },
  { pattern: /deepseek[-/.]?r[0-9]/i, label: 'DeepSeek R-series' },
  { pattern: /deepseek[-/.]?reasoner/i, label: 'DeepSeek Reasoner' },
  { pattern: /openai\/o[1-9]/i, label: 'OpenAI o-series (gateway)' },
  { pattern: /^o[1-9][-\s]/i, label: 'OpenAI o-series' },
  { pattern: /^o[1-9]$/i, label: 'OpenAI o-series' },
  { pattern: /o4-mini/i, label: 'OpenAI o4-mini' },
  { pattern: /o3-mini/i, label: 'OpenAI o3-mini' },
  { pattern: /o1-mini/i, label: 'OpenAI o1-mini' },
  { pattern: /stepfun/i, label: 'NVIDIA stepfun' },
  { pattern: /step-[0-9]/i, label: 'NVIDIA stepfun' },
  { pattern: /qwen.*think/i, label: 'Qwen Thinking' },
  { pattern: /qwq/i, label: 'QwQ (Qwen reasoning)' },
  { pattern: /glm.*think/i, label: 'GLM Thinking' },
  { pattern: /kimi.*think/i, label: 'Kimi Thinking' },
  { pattern: /-thinking$/i, label: 'Thinking model' },
  { pattern: /[-/]thinking[-/]/i, label: 'Thinking model' },
  { pattern: /[-/]reasoner/i, label: 'Reasoning model' },
];

export function getReasoningEffortConfigPath(): string {
  return path.join(getConfigDir(), 'reasoning-effort.json');
}

let cache: ReasoningEffortConfig | null = null;

function load(): ReasoningEffortConfig {
  if (cache) return cache;
  const filePath = getReasoningEffortConfigPath();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ReasoningEffortConfig>;
      cache = { models: parsed.models || {} };
      return cache;
    } catch (e) {
      log.warn(`[ReasoningEffort] Failed to load config: ${(e as Error).message}`);
    }
  }
  cache = { models: {} };
  return cache;
}

function save(): boolean {
  try {
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getReasoningEffortConfigPath(), JSON.stringify(load(), null, 2), 'utf-8');
    return true;
  } catch (e) {
    log.error(`[ReasoningEffort] Failed to save config: ${(e as Error).message}`);
    return false;
  }
}

export function supportsReasoningEffort(modelName: string): boolean {
  const lower = (modelName || '').toLowerCase();
  return REASONING_EFFORT_PATTERNS.some((p) => p.pattern.test(lower));
}

export function getReasoningLabel(modelName: string): string | null {
  const lower = (modelName || '').toLowerCase();
  const match = REASONING_EFFORT_PATTERNS.find((p) => p.pattern.test(lower));
  return match ? match.label : null;
}

/** Explicit setting first, then a model-name heuristic, then nothing. */
export function getEffortForModel(modelName: string): ReasoningEffort | null {
  const explicit = load().models[modelName];
  if (explicit && explicit !== 'default') return explicit;

  if (supportsReasoningEffort(modelName)) {
    return process.env.ANTIGRAVITY_REASONING_EFFORT_DEFAULT === 'high' ? 'high' : null;
  }
  return null;
}

export function setModelReasoningEffort(modelName: string, effort: ReasoningEffort | null): boolean {
  const config = load();
  if (!effort || effort === 'default') delete config.models[modelName];
  else config.models[modelName] = effort;
  return save();
}

export function getReasoningEffortConfig(): ReasoningEffortConfig {
  return load();
}

export function reloadReasoningEffort(): void {
  cache = null;
  load();
}
