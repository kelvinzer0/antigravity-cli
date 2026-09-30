import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => process.env.AG_TEST_HOME || actual.homedir() };
});

import {
  getBundledPath,
  getGlobalContextDir,
  getInstalledPath,
  getMarkerPath,
  readContextFile,
  resolveContextPath,
  describeContextSource,
} from '../src/context/paths';

const ORIGINAL_ENV = { ...process.env };

describe('Context paths', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AGENT_CONTEXT_PATH;
    delete process.env.AGENT_CONTEXT_LITE_PATH;
    delete process.env.ANTIGRAVITY_CONTEXT_PATH;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('global dir lives under the mocked home directory', () => {
    process.env.AG_TEST_HOME = '/tmp/test-home';
    expect(getGlobalContextDir()).toBe(path.join('/tmp/test-home', '.antigravity'));
  });

  test('installed paths use the conventional filenames', () => {
    expect(path.basename(getInstalledPath('full'))).toBe('agent-context.md');
    expect(path.basename(getInstalledPath('lite'))).toBe('agent-context-lite.md');
    expect(path.basename(getMarkerPath())).toBe('.context-installed');
  });

  test('bundled paths point at the package root and exist on disk', () => {
    expect(fs.existsSync(getBundledPath('full'))).toBe(true);
    expect(fs.existsSync(getBundledPath('lite'))).toBe(true);
  });

  test('bundled lite file is substantially smaller than the full manual', () => {
    const full = fs.readFileSync(getBundledPath('full'), 'utf-8');
    const lite = fs.readFileSync(getBundledPath('lite'), 'utf-8');
    expect(lite.length).toBeLessThan(full.length);
  });

  test('env override wins over installed and bundled', () => {
    const override = path.join(fs.realpathSync(os.tmpdir()), 'override-context.md');
    fs.writeFileSync(override, '# override\n', 'utf-8');
    process.env.AGENT_CONTEXT_LITE_PATH = override;
    expect(resolveContextPath('lite')).toBe(override);
    expect(describeContextSource('lite')).toContain('env override');
    fs.unlinkSync(override);
  });

  test('falls back to installed copy over bundled', () => {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agpath-'));
    process.env.AG_TEST_HOME = home;
    const installed = getInstalledPath('lite');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '# installed lite\n', 'utf-8');
    try {
      expect(resolveContextPath('lite')).toBe(installed);
      expect(readContextFile('lite')).toBe('# installed lite\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('bundled copy is used when nothing is installed', () => {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agpath-'));
    process.env.AG_TEST_HOME = home;
    expect(resolveContextPath('lite')).toBe(getBundledPath('lite'));
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('a missing env override falls back to the bundled copy rather than failing', () => {
    process.env.AGENT_CONTEXT_PATH = path.join(fs.realpathSync(os.tmpdir()), 'definitely-missing.md');
    expect(readContextFile('full')).not.toBeNull();
  });

  test('a missing env override still reports resolution through the bundled copy', () => {
    process.env.AGENT_CONTEXT_LITE_PATH = path.join(fs.realpathSync(os.tmpdir()), 'definitely-missing.md');
    expect(resolveContextPath('lite')).toBe(getBundledPath('lite'));
  });

  test('installed full copy is resolvable over bundled', () => {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agpath-'));
    process.env.AG_TEST_HOME = home;
    const installed = getInstalledPath('full');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '# installed full\n', 'utf-8');
    try {
      expect(resolveContextPath('full')).toBe(installed);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
