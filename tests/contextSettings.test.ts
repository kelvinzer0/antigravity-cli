import * as fs from 'fs';
import * as path from 'path';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => process.env.AG_TEST_HOME || actual.homedir() };
});

import { getContextConfigPath, loadContextSettings, saveContextSettings, ContextSettings } from '../src/context/settings';
import { getGlobalContextDir } from '../src/context/paths';

const ORIGINAL_ENV = { ...process.env };

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'agcfg-'));
  process.env.AG_TEST_HOME = home;
  return home;
}

describe('Context settings', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ANTIGRAVITY_CONTEXT_MODE;
    delete process.env.ANTIGRAVITY_CONTEXT;
    delete process.env.AGENT_CONTEXT_ENVELOPE;
    delete process.env.COMPACTION_ENABLED;
    delete process.env.COMPACTION_THRESHOLD;
    delete process.env.COMPACTION_TAIL_TURNS;
    delete process.env.COMPACTION_MODEL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('defaults to lite mode with strict envelope and compaction on', () => {
    freshHome();
    const settings = loadContextSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.mode).toBe('lite');
    expect(settings.envelope).toBe('strict');
    expect(settings.keepNativeSystemInstruction).toBe(false);
    expect(settings.installOnStart).toBe(true);
    expect(settings.compaction.enabled).toBe(true);
    expect(settings.compaction.threshold).toBeCloseTo(0.8);
    expect(settings.compaction.tailTurns).toBe(2);
  });

  test('round-trips through disk', () => {
    freshHome();
    const before: ContextSettings = {
      ...loadContextSettings(),
      mode: 'strip',
      envelope: 'loose',
      keepNativeSystemInstruction: true,
      compaction: { enabled: false, threshold: 0.5, tailTurns: 4, model: 'gpt-4o-mini' },
    };
    expect(saveContextSettings(before).success).toBe(true);

    const after = loadContextSettings();
    expect(after.mode).toBe('strip');
    expect(after.envelope).toBe('loose');
    expect(after.keepNativeSystemInstruction).toBe(true);
    expect(after.compaction.enabled).toBe(false);
    expect(after.compaction.threshold).toBeCloseTo(0.5);
    expect(after.compaction.tailTurns).toBe(4);
    expect(after.compaction.model).toBe('gpt-4o-mini');
  });

  test('persists to the free-antigravity config directory', () => {
    freshHome();
    saveContextSettings(loadContextSettings());
    expect(getContextConfigPath()).toBe(path.join(process.env.AG_TEST_HOME as string, '.free-antigravity', 'context.json'));
    expect(fs.existsSync(getContextConfigPath())).toBe(true);
  });

  test('corrupt config falls back to defaults without throwing', () => {
    freshHome();
    fs.mkdirSync(path.dirname(getContextConfigPath()), { recursive: true });
    fs.writeFileSync(getContextConfigPath(), '{ not json', 'utf-8');
    expect(loadContextSettings().mode).toBe('lite');
  });

  test('env overrides beat stored values', () => {
    freshHome();
    saveContextSettings({ ...loadContextSettings(), mode: 'strip' });
    process.env.ANTIGRAVITY_CONTEXT_MODE = 'lite';
    expect(loadContextSettings().mode).toBe('lite');
  });

  test('ANTIGRAVITY_CONTEXT=false disables injection', () => {
    freshHome();
    process.env.ANTIGRAVITY_CONTEXT = 'false';
    expect(loadContextSettings().enabled).toBe(false);
  });

  test('invalid mode falls back with a warning', () => {
    freshHome();
    process.env.ANTIGRAVITY_CONTEXT_MODE = 'bogus';
    expect(loadContextSettings().mode).toBe('lite');
  });

  test('invalid envelope falls back to strict', () => {
    freshHome();
    process.env.AGENT_CONTEXT_ENVELOPE = 'bogus';
    expect(loadContextSettings().envelope).toBe('strict');
  });

  test('compaction env overrides apply', () => {
    freshHome();
    process.env.COMPACTION_ENABLED = 'false';
    process.env.COMPACTION_THRESHOLD = '0.5';
    process.env.COMPACTION_TAIL_TURNS = '5';
    process.env.COMPACTION_MODEL = 'llama3';
    const settings = loadContextSettings();
    expect(settings.compaction.enabled).toBe(false);
    expect(settings.compaction.threshold).toBeCloseTo(0.5);
    expect(settings.compaction.tailTurns).toBe(5);
    expect(settings.compaction.model).toBe('llama3');
  });

  test('invalid threshold env value is ignored', () => {
    freshHome();
    process.env.COMPACTION_THRESHOLD = 'not-a-number';
    expect(loadContextSettings().compaction.threshold).toBeCloseTo(0.8);
  });

  test('partial config keeps defaults for the missing fields', () => {
    freshHome();
    fs.mkdirSync(path.dirname(getContextConfigPath()), { recursive: true });
    fs.writeFileSync(getContextConfigPath(), JSON.stringify({ mode: 'strip' }), 'utf-8');
    const settings = loadContextSettings();
    expect(settings.mode).toBe('strip');
    expect(settings.envelope).toBe('strict');
    expect(settings.compaction.tailTurns).toBe(2);
  });
});

test('global context dir is independent of the settings file', () => {
  freshHome();
  expect(getGlobalContextDir()).toBe(path.join(process.env.AG_TEST_HOME as string, '.antigravity'));
});
