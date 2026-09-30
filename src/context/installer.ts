/**
 * Agent context installer.
 *
 * Copies the context files to a global well-known location (~/.antigravity/) so the
 * agent and the user always have a stable path to the operating manual regardless of
 * where the proxy is running from.
 *
 * Once-only via content hash: a `.context-installed` marker stores the SHA-256 digest of
 * the full source file. A proxy upgrade that changes the context re-installs it, while
 * repeated restarts of the same build cost nothing.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import {
  ContextVariant,
  getBundledPath,
  getGlobalContextDir,
  getInstalledPath,
  getMarkerPath,
} from './paths';

function hashFile(filePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function installVariant(variant: ContextVariant): string | null {
  const source = getBundledPath(variant);
  if (!fs.existsSync(source)) {
    log.warn(`[ContextInstall] Bundled ${variant} context not found at "${source}"`);
    return null;
  }

  const dest = getInstalledPath(variant);
  const sourceHash = hashFile(source);
  if (!sourceHash) {
    log.warn(`[ContextInstall] Cannot read source "${source}"`);
    return null;
  }

  const marker = getMarkerPath();
  try {
    if (fs.existsSync(dest) && fs.existsSync(marker)) {
      const variantsKey = variant === 'full' ? '' : `:${variant}`;
      const recorded = JSON.parse(fs.readFileSync(marker, 'utf-8')) as Record<string, string>;
      if (recorded[variantsKey] === sourceHash) return dest;
    }
  } catch {
    // Unreadable marker: fall through and reinstall.
  }

  try {
    fs.mkdirSync(getGlobalContextDir(), { recursive: true });
    const tmpPath = `${dest}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, fs.readFileSync(source));
    fs.renameSync(tmpPath, dest);
    return dest;
  } catch (e) {
    log.warn(`[ContextInstall] Failed to install ${variant} context to "${dest}": ${(e as Error).message}`);
    return null;
  }
}

function writeMarker(): void {
  try {
    const variants: Array<[string, ContextVariant]> = [
      ['', 'full'],
      [':lite', 'lite'],
    ];
    const recorded: Record<string, string> = {};
    for (const [key, variant] of variants) {
      const source = getBundledPath(variant);
      if (!fs.existsSync(source)) continue;
      const hash = hashFile(source);
      const dest = getInstalledPath(variant);
      if (hash && fs.existsSync(dest)) recorded[key] = hash;
    }
    if (Object.keys(recorded).length === 0) return;
    fs.writeFileSync(getMarkerPath(), JSON.stringify(recorded, null, 2), 'utf-8');
  } catch (e) {
    log.debug(`[ContextInstall] Marker write skipped: ${(e as Error).message}`);
  }
}

/** Installs both context variants. Returns the installed paths, or null entries on failure. */
export function installAgentContext(): { full: string | null; lite: string | null } {
  const full = installVariant('full');
  const lite = installVariant('lite');
  writeMarker();
  if (full) log.info(`[ContextInstall] agent-context.md available at "${full}"`);
  if (lite) log.info(`[ContextInstall] agent-context-lite.md available at "${lite}"`);
  return { full, lite };
}

export function removeInstalledContext(): void {
  for (const variant of ['full', 'lite'] as ContextVariant[]) {
    const dest = getInstalledPath(variant);
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
      log.info(`[ContextInstall] Removed "${dest}"`);
    }
  }
  const marker = getMarkerPath();
  if (fs.existsSync(marker)) {
    fs.unlinkSync(marker);
    log.info(`[ContextInstall] Removed "${marker}"`);
  }
}

export function getGlobalContextRoot(): string {
  return path.resolve(getGlobalContextDir());
}
