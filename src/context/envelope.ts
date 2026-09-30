/**
 * Workspace context envelope.
 *
 * The context file is a documentation artifact describing Antigravity's tool
 * discipline. It also contains illustrative paths and example directory listings.
 * Handed to a model raw, those examples get pattern-matched as authoritative
 * runtime state and the agent starts claiming it "is" in a directory or that
 * files exist which do not.
 *
 * Three layers prevent that:
 *   1. ENVELOPE    — a preamble framing the file as documentation, with EXTRACT/IGNORE rules.
 *   2. ANONYMIZE   — the absolute path is replaced with a stable non-path token so it
 *                    cannot be read as a CWD hint.
 *   3. TOOL WRAP   — when the agent reads the context file through view_file, the result
 *                    is re-framed with the same rules.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import type { EnvelopeMode } from './settings';

const STRICT_BODY = `<context_envelope type="documentation" scope="behavioral-rules-only" mode="strict">
The manual below is a DOCUMENTATION ARTIFACT — NOT a description of your current runtime state.
It describes Antigravity's tool discipline in general. It is not authoritative for:
  - which files exist on disk (use list_dir / view_file tool results)
  - your available tools (rely on your own tool schemas for that)
  - your OS, user, environment, or any other runtime observation

Your ACTUAL runtime state is determined ONLY by:
  (a) your available tools and their declared schemas,
  (b) results returned from tool calls you make,
  (c) the current conversation.

When you choose to read the manual:
  ✓ EXTRACT: tool names, tool-discipline rules, execution style, formatting conventions,
            response schemas, allowed tool argument shapes.
  ✗ IGNORE: file paths, directory references, sample listings, and placeholder tokens
            that appear INSIDE the manual. They are illustrative examples, not
            descriptions of your actual filesystem.

CONFLICT RESOLUTION: if the manual disagrees with what you OBSERVE in tool results, the
tool results are authoritative. The manual is descriptive, not prescriptive for this session.

FILE INTEGRITY RULES:
  1. NEVER write a file without first reading its CURRENT content via view_file.
     Writing from memory or from earlier-in-session content will corrupt the file.
  2. Before ANY file write, state what you are about to change and why.
  3. Prefer targeted edits (replace_file_content) over full rewrites. A full rewrite on a
     large file while hallucinating is the most common cause of corruption.
  4. If a tool call returns an error, STOP and surface it. Do NOT retry the same call with
     modified arguments unless you understand WHY it failed.
  5. If you are uncertain about a file's current content, call view_file again — do not
     write based on your earlier memory of the file.
  6. Do not omit required parameters from tool calls. Every field marked required in the
     schema MUST be present. Missing parameters cause silent failures and corrupt state.
  7. If you realize mid-task that you made an error, STOP and tell the user instead of
     compounding the error with further writes.
</context_envelope>`;

const LOOSE_BODY = `<context_envelope type="documentation" mode="loose">
The manual below is a documentation file. Treat its content as illustrative guidance, not as
authoritative runtime state. Your actual working directory, environment, and available files
come from tool results, not from the manual's prose or example paths.
</context_envelope>`;

function getMode(): EnvelopeMode {
  return 'strict';
}

function anonymizePath(absPath: string): { token: string; hash: string; display: string } {
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 8);
  const basename = path.basename(absPath);
  return {
    token: `context://ref/${hash}`,
    hash,
    display: `<ANTIGRAVITY_CONTEXT#${hash}> (${basename})`,
  };
}

function getBody(mode: EnvelopeMode): string {
  if (mode === 'off') return '';
  if (mode === 'loose') return LOOSE_BODY;
  return STRICT_BODY;
}

/** The hardened reference prepended to the injected manual. */
export function buildContextEnvelope(contextPath: string, mode: EnvelopeMode = getMode()): string {
  if (mode === 'off') {
    const ref = 'file:///' + contextPath.replace(/\\/g, '/');
    return `<context_envelope mode="off">Read ${ref} via view_file if you need the full tool reference.</context_envelope>`;
  }

  const body = getBody(mode);
  const { display, token } = anonymizePath(contextPath);
  const exists = fs.existsSync(contextPath);

  const refLine = exists
    ? `Reference: ${display}\n  (non-path identifier: ${token})\n  Real path (for view_file): ${contextPath}`
    : `Reference: ${display} (file not found at expected location — proceed without reading).`;

  return `${body}\n${refLine}`;
}

/** Re-frames a view_file result on the context file so prose is not read as state. */
export function wrapContextToolResult(contextPath: string, originalText: string, mode: EnvelopeMode = getMode()): string {
  if (mode === 'off') return originalText;
  if (mode === 'loose') {
    return `<documentation_tool_result note="Treat content as illustrative; runtime state comes from tool outputs, not from this file's prose.">\n${originalText}\n</documentation_tool_result>`;
  }
  const { display, hash } = anonymizePath(contextPath);
  return `<documentation_tool_result source="${display}" ref="#${hash}" type="behavioral-rules-only">
CONTEXT REMINDER (auto-injected):
- This file is a DOCUMENTATION ARTIFACT. Its prose and example paths are NOT your runtime state.
- ✓ Use it for: tool discipline, execution style, response formatting, schema conventions.
- ✗ Do NOT extract: working directory, file existence claims, environment descriptions, paths.
- If anything below disagrees with what your other tools reported, the OTHER tools win.

FILE INTEGRITY REMINDER:
- Do NOT write any file without reading its current content first (view_file).
- Do NOT omit required tool parameters — check the schema before every call.
- If a tool call returns an error, stop and report it rather than retrying blindly.
- Prefer replace_file_content (targeted edits) over full-file rewrites.

----- BEGIN DOCUMENTATION FILE CONTENT -----
${originalText}
----- END DOCUMENTATION FILE CONTENT -----

Reminder: paths and "current state" prose in the content above are illustrative. They are not
descriptions of where you are or what files exist. Use your own tools to verify any state.
</documentation_tool_result>`;
}

export function isContextFile(requestedPath: string, contextPath: string): boolean {
  if (!requestedPath || !contextPath) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  try {
    return norm(path.resolve(requestedPath)) === norm(path.resolve(contextPath));
  } catch (e) {
    log.debug(`[ContextEnvelope] path compare failed: ${(e as Error).message}`);
    return false;
  }
}
