import * as fs from 'fs';
import * as path from 'path';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => process.env.AG_TEST_HOME || actual.homedir() };
});

import { installAgentContext, removeInstalledContext } from '../src/context/installer';
import { getInstalledPath, getMarkerPath, getGlobalContextDir } from '../src/context/paths';

const ORIGINAL_ENV = { ...process.env };

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'aginstall-'));
  process.env.AG_TEST_HOME = home;
  return home;
}

describe('Agent context installer', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('installs both variants into ~/.antigravity', () => {
    const home = freshHome();
    const { full, lite } = installAgentContext();
    try {
      expect(full).toBe(getInstalledPath('full'));
      expect(lite).toBe(getInstalledPath('lite'));
      expect(fs.existsSync(full as string)).toBe(true);
      expect(fs.existsSync(lite as string)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('installed content matches the bundled source', () => {
    const home = freshHome();
    const { lite } = installAgentContext();
    try {
      const source = fs.readFileSync(path.resolve(__dirname, '..', 'agent-context-lite.md'), 'utf-8');
      expect(fs.readFileSync(lite as string, 'utf-8')).toBe(source);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('second install is a no-op that keeps the file stable', () => {
    const home = freshHome();
    installAgentContext();
    const liteBefore = fs.readFileSync(getInstalledPath('lite'), 'utf-8');
    const { lite } = installAgentContext();
    try {
      expect(lite).toBe(getInstalledPath('lite'));
      expect(fs.readFileSync(getInstalledPath('lite'), 'utf-8')).toBe(liteBefore);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('reinstalls when the marker hash no longer matches the source', () => {
    const home = freshHome();
    try {
      installAgentContext();
      const before = fs.readFileSync(getInstalledPath('full'), 'utf-8');

      const marker = getMarkerPath();
      const recorded = JSON.parse(fs.readFileSync(marker, 'utf-8')) as Record<string, string>;
      recorded[''] = '0'.repeat(64);
      fs.writeFileSync(marker, JSON.stringify(recorded, null, 2), 'utf-8');

      installAgentContext();
      expect(fs.readFileSync(getInstalledPath('full'), 'utf-8')).toBe(before);
      expect((JSON.parse(fs.readFileSync(getMarkerPath(), 'utf-8')) as Record<string, string>)['']).not.toBe('0'.repeat(64));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('marker file records a content hash', () => {
    const home = freshHome();
    try {
      installAgentContext();
      const recorded = JSON.parse(fs.readFileSync(getMarkerPath(), 'utf-8')) as Record<string, string>;
      expect(typeof recorded['']).toBe('string');
      expect(recorded[''].length).toBe(64);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('global dir is created when missing', () => {
    const home = freshHome();
    try {
      expect(fs.existsSync(getGlobalContextDir())).toBe(false);
      installAgentContext();
      expect(fs.existsSync(getGlobalContextDir())).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('uninstall removes files and marker', () => {
    const home = freshHome();
    try {
      installAgentContext();
      removeInstalledContext();
      expect(fs.existsSync(getInstalledPath('full'))).toBe(false);
      expect(fs.existsSync(getInstalledPath('lite'))).toBe(false);
      expect(fs.existsSync(getMarkerPath())).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
