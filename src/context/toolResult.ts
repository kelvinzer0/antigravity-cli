/**
 * Context-aware tool result wrapping.
 *
 * When the agent decides to read the operating manual through view_file, the raw file
 * content goes back as an ordinary tool result. Left alone, a model can read the
 * manual's example paths and sample listings as statements about its own machine.
 * Re-framing the result keeps the manual useful while blocking that misread.
 */
import { log } from '../logger';
import { isContextFile, wrapContextToolResult } from './envelope';
import { resolveContextPath } from './paths';
import { loadContextSettings } from './settings';

const READ_TOOLS = new Set(['view_file', 'read_file', 'view', 'read', 'cat_file', 'open_file']);

const PATH_KEYS = ['AbsolutePath', 'absolute_path', 'absolutePath', 'path', 'file_path', 'filePath', 'file', 'filename', 'FilePath'];

function extractRequestedPaths(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const record = args as Record<string, unknown>;
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) found.push(value);
  }
  return found;
}

/** Returns the wrapped result when this tool call read the context file, otherwise the original text. */
export function maybeWrapContextToolResult(funcName: string, args: unknown, content: string): string {
  if (!READ_TOOLS.has(funcName)) return content;

  const requested = extractRequestedPaths(args);
  if (requested.length === 0) return content;

  const settings = loadContextSettings();
  if (!settings.enabled || settings.envelope === 'off') return content;

  const contextPath = resolveContextPath(settings.mode === 'strip' ? 'full' : 'lite');
  if (!contextPath) return content;

  const matched = requested.find((candidate) => isContextFile(candidate, contextPath));
  if (!matched) return content;

  log.info(`[Context] Wrapping ${funcName} result for "${matched}" as documentation`);
  return wrapContextToolResult(contextPath, content, settings.envelope);
}
