/**
 * Agent context file resolution.
 *
 * The context files ship inside the npm package, but they are also installed to a
 * stable global path (~/.antigravity/agent-context.md) so the agent and the user
 * always have one well-known location to look at, no matter where the CLI runs from.
 *
 * Resolution order for reading a context file:
 *   1. Explicit env override (AGENT_CONTEXT_PATH / AGENT_CONTEXT_LITE_PATH)
 *   2. The installed copy in ~/.antigravity/
 *   3. The copy bundled with the package
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../logger';

export type ContextVariant = 'full' | 'lite';

export const GLOBAL_CONTEXT_DIR_NAME = '.antigravity';
export const INSTALLED_CONTEXT_FILENAME = 'agent-context.md';
export const INSTALLED_LITE_FILENAME = 'agent-context-lite.md';
export const INSTALLED_MARKER_FILENAME = '.context-installed';

const BUNDLED_FILENAMES: Record<ContextVariant, string> = {
  full: 'agent-context.md',
  lite: 'agent-context-lite.md',
};

export function getGlobalContextDir(): string {
  return path.join(os.homedir(), GLOBAL_CONTEXT_DIR_NAME);
}

export function getInstalledPath(variant: ContextVariant): string {
  return path.join(
    getGlobalContextDir(),
    variant === 'full' ? INSTALLED_CONTEXT_FILENAME : INSTALLED_LITE_FILENAME,
  );
}

export function getMarkerPath(): string {
  return path.join(getGlobalContextDir(), INSTALLED_MARKER_FILENAME);
}

/** dist/context/paths.js and src/context/paths.ts both sit two levels under the package root. */
export function getPackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function getBundledPath(variant: ContextVariant): string {
  return path.join(getPackageRoot(), BUNDLED_FILENAMES[variant]);
}

function envOverride(variant: ContextVariant): string | undefined {
  const specific = variant === 'full' ? process.env.AGENT_CONTEXT_PATH : process.env.AGENT_CONTEXT_LITE_PATH;
  if (specific) return specific;
  const shared = process.env.ANTIGRAVITY_CONTEXT_PATH;
  return shared || undefined;
}

/** Absolute path of the context file to read, or null when nothing is available. */
export function resolveContextPath(variant: ContextVariant): string | null {
  const override = envOverride(variant);
  const candidates = [override, getInstalledPath(variant), getBundledPath(variant)].filter(
    (p): p is string => Boolean(p),
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (override) {
    log.warn(`[Context] Override path "${override}" does not exist, falling back to the bundled context`);
  }
  return null;
}

export function readContextFile(variant: ContextVariant): string | null {
  const target = resolveContextPath(variant);
  if (!target) return null;
  try {
    return fs.readFileSync(target, 'utf-8');
  } catch {
    return null;
  }
}

/** Human-readable description of where the active context file comes from. */
export function describeContextSource(variant: ContextVariant): string {
  const target = resolveContextPath(variant);
  if (!target) return 'not found';
  if (envOverride(variant) && target === envOverride(variant)) return `${target} (env override)`;
  if (target === getInstalledPath(variant)) return `${target} (installed)`;
  return `${target} (bundled)`;
}
