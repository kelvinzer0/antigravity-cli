import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => process.env.AG_TEST_HOME || actual.homedir() };
});

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: unknown) => {
      if (typeof p === 'string' && p.includes('agent-context') && process.env.AG_FORCE_MISSING_CONTEXT === '1') {
        return false;
      }
      return actual.existsSync(p);
    }),
  };
});

import { injectAgentContext, InjectOptions } from '../src/context/injector';
import { GeminiRequestBody, readSystemText } from '../src/context/geminiTypes';
import { getBundledPath, getInstalledPath } from '../src/context/paths';

const LITE_MARKER = 'Quick Reference — Tool Cheat Sheet';

const ORIGINAL_ENV = { ...process.env };

function isolated<T>(fn: () => T): T {
  const previous = process.env;
  process.env = { ...previous };
  delete process.env.AGENT_CONTEXT_PATH;
  delete process.env.AGENT_CONTEXT_LITE_PATH;
  delete process.env.ANTIGRAVITY_CONTEXT_PATH;
  delete process.env.AG_FORCE_MISSING_CONTEXT;
  try {
    return fn();
  } finally {
    process.env = previous;
  }
}

function sampleBody(): GeminiRequestBody {
  return {
    model: 'models/MODEL_PLACEHOLDER_M400',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    systemInstruction: { parts: [{ text: 'You are Antigravity.' }] },
    tools: [{ functionDeclarations: [{ name: 'view_file', parameters: { type: 'OBJECT' } }] }],
  };
}

function liteOptions(overrides: Partial<InjectOptions> = {}): InjectOptions {
  return { mode: 'lite', envelope: 'strict', keepNativeSystemInstruction: false, ...overrides };
}

describe('Agent context injection', () => {
  test('passthrough mode leaves the body untouched', () => {
    isolated(() => {
      const body = sampleBody();
      const before = JSON.stringify(body);
      const result = injectAgentContext(body, liteOptions({ mode: 'passthrough' }));
      expect(result.injected).toBe(false);
      expect(JSON.stringify(body)).toBe(before);
    });
  });

  test('lite mode replaces the native system instruction with the manual', () => {
    isolated(() => {
      const body = sampleBody();
      const result = injectAgentContext(body, liteOptions());
      expect(result.injected).toBe(true);
      expect(result.variant).toBe('lite');

      const system = readSystemText(body);
      expect(system).toContain(LITE_MARKER);
      expect(system).toContain('<context_envelope');
      expect(system).not.toContain('You are Antigravity.');
    });
  });

  test('strip mode injects the full manual', () => {
    isolated(() => {
      const body = sampleBody();
      const result = injectAgentContext(body, liteOptions({ mode: 'strip' }));
      expect(result.injected).toBe(true);
      expect(result.variant).toBe('full');
      expect(readSystemText(body)).toContain('External Agent Runtime Context');
    });
  });

  test('keepNativeSystemInstruction appends the original instruction after the manual', () => {
    isolated(() => {
      const body = sampleBody();
      const result = injectAgentContext(body, liteOptions({ keepNativeSystemInstruction: true }));
      expect(result.injected).toBe(true);

      const system = readSystemText(body);
      const envelopeIndex = system.indexOf('<context_envelope');
      const nativeIndex = system.indexOf('You are Antigravity.');
      expect(envelopeIndex).toBeGreaterThan(-1);
      expect(nativeIndex).toBeGreaterThan(envelopeIndex);
    });
  });

  test('injection is idempotent', () => {
    isolated(() => {
      const body = sampleBody();
      injectAgentContext(body, liteOptions());
      const system = readSystemText(body);
      const second = injectAgentContext(body, liteOptions());
      expect(second.injected).toBe(false);
      expect(second.reason).toBe('already injected');
      expect(readSystemText(body)).toBe(system);
    });
  });

  test('contents and tools survive injection', () => {
    isolated(() => {
      const body = sampleBody();
      injectAgentContext(body, liteOptions());
      expect(body.contents).toHaveLength(1);
      expect(body.contents![0].parts![0].text).toBe('hello');
      expect(body.tools).toHaveLength(1);
    });
  });

  test('reports an estimated token count', () => {
    isolated(() => {
      const body = sampleBody();
      const result = injectAgentContext(body, liteOptions());
      expect(result.systemTokens).toBeGreaterThan(0);
      expect(result.source).toContain('agent-context-lite.md');
    });
  });

  test('installed copy takes precedence over the bundled copy', () => {
    isolated(() => {
      const tempHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aginj-'));
      process.env.AG_TEST_HOME = tempHome;
      const installed = getInstalledPath('lite');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.writeFileSync(installed, '# Installed manual override\n', 'utf-8');
      try {
        const body = sampleBody();
        const result = injectAgentContext(body, liteOptions());
        expect(result.injected).toBe(true);
        expect(readSystemText(body)).toContain('# Installed manual override');
      } finally {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    });
  });

  test('missing context file yields no injection', () => {
    isolated(() => {
      // Pretend no bundled file and nothing installed: nothing to inject, body stays untouched.
      process.env.AG_FORCE_MISSING_CONTEXT = '1';
      const body = sampleBody();
      const result = injectAgentContext(body, liteOptions());
      expect(result.injected).toBe(false);
      expect(result.reason).toBe('context file not found');
      expect(readSystemText(body)).toBe('You are Antigravity.');
    });
  });

  test('warns and falls back to the bundled copy when an env override is missing', () => {
    isolated(() => {
      process.env.AGENT_CONTEXT_LITE_PATH = path.join(fs.realpathSync(os.tmpdir()), 'nonexistent-agent-context.md');
      const body = sampleBody();
      const result = injectAgentContext(body, liteOptions());
      expect(result.injected).toBe(true);
      expect(readSystemText(body)).toContain(LITE_MARKER);
    });
  });

  test('bundled manual is present in the package', () => {
    expect(fs.existsSync(getBundledPath('lite'))).toBe(true);
    expect(fs.existsSync(getBundledPath('full'))).toBe(true);
  });
});
