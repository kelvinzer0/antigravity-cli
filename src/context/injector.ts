/**
 * Agent context injection.
 *
 * Antigravity's native system instruction is written for Gemini and assumes the model
 * already knows Antigravity's tool vocabulary. Forwarding it unchanged to a custom
 * provider leaves models like GPT, Claude, Llama or Mistral without any of that
 * discipline — they fall back to `run_command ls`, forget that `manage_task` requires
 * an `Action`, and stall on trivial edits. The agent-context files are the operating
 * manual that closes that gap.
 *
 * Injection happens on the Gemini body BEFORE provider translation, so every translator
 * gets the same system prompt for free.
 */
import { log } from '../logger';
import { buildContextEnvelope } from './envelope';
import { GeminiRequestBody, readSystemText, setSystemInstruction } from './geminiTypes';
import { ContextVariant, describeContextSource, readContextFile, resolveContextPath } from './paths';
import { ContextMode, EnvelopeMode } from './settings';
import { estimateSystemTokens } from './tokenEstimator';

const MARKER = '<context_envelope';

export interface InjectOptions {
  mode: ContextMode;
  envelope: EnvelopeMode;
  keepNativeSystemInstruction: boolean;
}

export interface InjectResult {
  injected: boolean;
  variant?: ContextVariant;
  source?: string;
  systemTokens?: number;
  reason?: string;
}

function variantForMode(mode: ContextMode): ContextVariant {
  return mode === 'strip' ? 'full' : 'lite';
}

function renderContext(contextContent: string, contextPath: string, options: InjectOptions): string {
  return [buildContextEnvelope(contextPath, options.envelope), contextContent.trim()].join('\n\n');
}

/**
 * Prepends the agent context to the request's system instruction.
 * Mutates and returns the same body object.
 */
export function injectAgentContext(body: GeminiRequestBody, options: InjectOptions): InjectResult {
  if (options.mode === 'passthrough') {
    return { injected: false, reason: 'mode=passthrough' };
  }

  const variant = variantForMode(options.mode);
  const contextPath = resolveContextPath(variant);
  if (!contextPath) {
    log.warn(`[Context] No ${variant} context file found — run "antigravity context install"`);
    return { injected: false, reason: 'context file not found' };
  }

  const contextContent = readContextFile(variant);
  if (!contextContent) {
    log.warn(`[Context] Failed to read ${variant} context from "${contextPath}"`);
    return { injected: false, reason: 'context file unreadable' };
  }

  const existing = readSystemText(body);
  if (existing.includes(MARKER) || existing.includes(contextContent.trim().slice(0, 200))) {
    return { injected: false, variant, reason: 'already injected' };
  }

  const nativeTail = options.keepNativeSystemInstruction && existing.trim() ? `\n\n---\n\n${existing.trim()}` : '';
  const rendered = renderContext(contextContent, contextPath, options) + nativeTail;

  setSystemInstruction(body, rendered);

  const systemTokens = estimateSystemTokens(rendered);
  log.info(`[Context] Injected ${variant} context (${contextContent.length} chars, ~${systemTokens} tokens) from ${describeContextSource(variant)}`);

  return {
    injected: true,
    variant,
    source: describeContextSource(variant),
    systemTokens,
  };
}
