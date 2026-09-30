import * as fs from 'fs';
import * as path from 'path';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => process.env.AG_TEST_HOME || actual.homedir() };
});

import { maybeWrapContextToolResult } from '../src/context/toolResult';
import { getInstalledPath, getBundledPath } from '../src/context/paths';

const ORIGINAL_ENV = { ...process.env };

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'agtool-'));
  process.env.AG_TEST_HOME = home;
  return home;
}

describe('Context tool result wrapping', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AGENT_CONTEXT_LITE_PATH;
    delete process.env.ANTIGRAVITY_CONTEXT_PATH;
    delete process.env.AGENT_CONTEXT_PATH;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('wraps a view_file result that points at the installed context file', () => {
    const home = freshHome();
    try {
      const target = getInstalledPath('lite');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '# manual\n', 'utf-8');

      const wrapped = maybeWrapContextToolResult('view_file', { AbsolutePath: target }, '# manual\n');
      expect(wrapped).toContain('<documentation_tool_result');
      expect(wrapped).toContain('FILE INTEGRITY');
      expect(wrapped).toContain('# manual');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('wraps when the path is declared via the env override', () => {
    const temp = path.join(fs.realpathSync(require('os').tmpdir()), 'ag-override-context.md');
    fs.writeFileSync(temp, '# override manual\n', 'utf-8');
    process.env.AGENT_CONTEXT_LITE_PATH = temp;
    const wrapped = maybeWrapContextToolResult('view_file', { path: temp }, 'x');
    expect(wrapped).toContain('<documentation_tool_result');
    fs.unlinkSync(temp);
  });

  test('leaves unrelated file reads alone', () => {
    const unrelated = path.join(fs.realpathSync(require('os').tmpdir()), 'some-file.ts');
    const result = maybeWrapContextToolResult('view_file', { AbsolutePath: unrelated }, 'export const x = 1;');
    expect(result).toBe('export const x = 1;');
  });

  test('ignores write tools even when the path matches', () => {
    process.env.AGENT_CONTEXT_LITE_PATH = getBundledPath('lite');
    const target = getBundledPath('lite');
    const result = maybeWrapContextToolResult('write_to_file', { TargetFile: target }, 'content');
    expect(result).toBe('content');
  });

  test('ignores read tools with no path argument', () => {
    expect(maybeWrapContextToolResult('view_file', {}, 'plain')).toBe('plain');
    expect(maybeWrapContextToolResult('view_file', null, 'plain')).toBe('plain');
  });

  test('accepts common path key spellings', () => {
    process.env.AGENT_CONTEXT_LITE_PATH = getBundledPath('lite');
    const target = getBundledPath('lite');
    for (const key of ['AbsolutePath', 'absolute_path', 'absolutePath', 'path', 'file_path', 'filePath', 'file']) {
      const wrapped = maybeWrapContextToolResult('view_file', { [key]: target }, 'a');
      expect(wrapped).toContain('<documentation_tool_result');
    }
  });
});
