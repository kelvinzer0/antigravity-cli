/**
 * Agent context injection settings.
 *
 * Persisted to ~/.free-antigravity/context.json. Every value can be overridden by an
 * environment variable so a one-off run never has to touch the config file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../config';
import { log } from '../logger';

/**
 * - passthrough: never inject; forward Antigravity's native system instruction untouched.
 * - lite:        replace the native system instruction with agent-context-lite.md (~3.5K tokens).
 * - strip:       replace the native system instruction with the full agent-context.md.
 */
export type ContextMode = 'passthrough' | 'lite' | 'strip';
export type EnvelopeMode = 'off' | 'loose' | 'strict';

export const VALID_CONTEXT_MODES: ContextMode[] = ['passthrough', 'lite', 'strip'];
export const VALID_ENVELOPE_MODES: EnvelopeMode[] = ['off', 'loose', 'strict'];

export interface CompactionSettings {
  enabled: boolean;
  threshold: number;
  tailTurns: number;
  model: string;
}

export interface ContextSettings {
  enabled: boolean;
  mode: ContextMode;
  envelope: EnvelopeMode;
  keepNativeSystemInstruction: boolean;
  installOnStart: boolean;
  compaction: CompactionSettings;
}

export const DEFAULT_SETTINGS: ContextSettings = {
  enabled: true,
  mode: 'lite',
  envelope: 'strict',
  keepNativeSystemInstruction: false,
  installOnStart: true,
  compaction: {
    enabled: true,
    threshold: 0.8,
    tailTurns: 2,
    model: '',
  },
};

export function getContextConfigPath(): string {
  return path.join(getConfigDir(), 'context.json');
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value !== 'false' && value !== '0';
}

function parseMode(value: string | undefined, fallback: ContextMode): ContextMode {
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if ((VALID_CONTEXT_MODES as string[]).includes(normalized)) return normalized as ContextMode;
  log.warn(`[Context] Invalid mode "${value}", using "${fallback}"`);
  return fallback;
}

function parseEnvelope(value: string | undefined, fallback: EnvelopeMode): EnvelopeMode {
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if ((VALID_ENVELOPE_MODES as string[]).includes(normalized)) return normalized as EnvelopeMode;
  log.warn(`[Context] Invalid envelope "${value}", using "${fallback}"`);
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalize(raw: Partial<ContextSettings> | null | undefined): ContextSettings {
  const compaction: Partial<CompactionSettings> = raw?.compaction || {};
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    mode: VALID_CONTEXT_MODES.includes(raw?.mode as ContextMode)
      ? (raw!.mode as ContextMode)
      : DEFAULT_SETTINGS.mode,
    envelope: VALID_ENVELOPE_MODES.includes(raw?.envelope as EnvelopeMode)
      ? (raw!.envelope as EnvelopeMode)
      : DEFAULT_SETTINGS.envelope,
    keepNativeSystemInstruction:
      typeof raw?.keepNativeSystemInstruction === 'boolean'
        ? raw.keepNativeSystemInstruction
        : DEFAULT_SETTINGS.keepNativeSystemInstruction,
    installOnStart:
      typeof raw?.installOnStart === 'boolean' ? raw.installOnStart : DEFAULT_SETTINGS.installOnStart,
    compaction: {
      enabled: typeof compaction.enabled === 'boolean' ? compaction.enabled : DEFAULT_SETTINGS.compaction.enabled,
      threshold: compaction.threshold ?? DEFAULT_SETTINGS.compaction.threshold,
      tailTurns: compaction.tailTurns ?? DEFAULT_SETTINGS.compaction.tailTurns,
      model: compaction.model ?? DEFAULT_SETTINGS.compaction.model,
    },
  };
}

export function loadContextSettings(): ContextSettings {
  const filePath = getContextConfigPath();
  let stored: Partial<ContextSettings> | null = null;

  if (fs.existsSync(filePath)) {
    try {
      stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ContextSettings>;
    } catch (e) {
      log.warn(`[Context] Failed to parse ${filePath}: ${(e as Error).message}`);
    }
  }

  const base = normalize(stored);
  const env = process.env;

  return {
    enabled: parseBoolean(env.ANTIGRAVITY_CONTEXT, base.enabled),
    mode: parseMode(env.ANTIGRAVITY_CONTEXT_MODE, base.mode),
    envelope: parseEnvelope(env.AGENT_CONTEXT_ENVELOPE, base.envelope),
    keepNativeSystemInstruction: base.keepNativeSystemInstruction,
    installOnStart: base.installOnStart,
    compaction: {
      enabled: parseBoolean(env.COMPACTION_ENABLED, base.compaction.enabled),
      threshold: parseNumber(env.COMPACTION_THRESHOLD, base.compaction.threshold),
      tailTurns: parseNumber(env.COMPACTION_TAIL_TURNS, base.compaction.tailTurns),
      model: env.COMPACTION_MODEL || base.compaction.model,
    },
  };
}

export function saveContextSettings(settings: ContextSettings): { success: boolean; error?: string } {
  try {
    if (!fs.existsSync(getConfigDir())) fs.mkdirSync(getConfigDir(), { recursive: true });
    const filePath = getContextConfigPath();
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export function updateContextSettings(patch: Partial<ContextSettings>): ContextSettings {
  const merged = { ...loadContextSettings(), ...patch };
  saveContextSettings(merged);
  return merged;
}
