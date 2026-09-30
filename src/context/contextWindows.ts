/**
 * Per-model context window lookup.
 *
 * The injected agent context plus a long conversation can exceed a smaller model's
 * window. Compaction needs an accurate number to decide when to compact, so each custom
 * model may declare its own `contextWindow` in models.json. Anything undeclared falls
 * back to a conservative default.
 */
import { log } from '../logger';

export const DEFAULT_CONTEXT_WINDOW = 128000;

const declared = new Map<string, number>();
const manualOverrides = new Map<string, number>();

export function declareContextWindow(model: string, tokens: number): void {
  if (!model || !Number.isFinite(tokens) || tokens <= 0) return;
  declared.set(model, Math.floor(tokens));
}

export function setContextWindowOverride(model: string, tokens: number): void {
  manualOverrides.set(model, Math.floor(tokens));
}

export function getContextWindow(model: string): number {
  if (manualOverrides.has(model)) return manualOverrides.get(model)!;
  if (declared.has(model)) return declared.get(model)!;

  const normalized = (model || '').toLowerCase();
  for (const [key, value] of declared) {
    if (normalized.startsWith(key.toLowerCase())) return value;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function clearContextWindows(): void {
  declared.clear();
  manualOverrides.clear();
}

export function getDeclaredContextWindows(): Record<string, number> {
  return Object.fromEntries(declared);
}

export function logContextWindows(): void {
  if (declared.size > 0) {
    log.info(`[ContextWindows] ${declared.size} model window(s) declared: ${JSON.stringify(getDeclaredContextWindows())}`);
  }
}
