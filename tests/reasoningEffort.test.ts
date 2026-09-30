import {
  supportsReasoningEffort,
  getReasoningLabel,
  getEffortForModel,
  setModelReasoningEffort,
  getReasoningEffortConfig,
  reloadReasoningEffort,
  ReasoningEffort,
} from '../src/context/reasoningEffort';

const realHomedir = require('os').homedir;
const tempHomes: string[] = [];

function isolatedHome(): void {
  const tempHome = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'agre-'));
  tempHomes.push(tempHome);
  require('os').homedir = () => tempHome;
}

describe('Reasoning effort', () => {
  beforeEach(() => {
    isolatedHome();
    reloadReasoningEffort();
  });

  afterEach(() => {
    require('os').homedir = realHomedir;
    reloadReasoningEffort();
  });

  afterAll(() => {
    for (const home of tempHomes) {
      require('fs').rmSync(home, { recursive: true, force: true });
    }
  });

  test('detects DeepSeek R-series', () => {
    expect(supportsReasoningEffort('deepseek-r1')).toBe(true);
    expect(getReasoningLabel('deepseek-r2')).toBe('DeepSeek R2');
    expect(getReasoningLabel('deepseek-reasoner')).toBe('DeepSeek Reasoner');
  });

  test('detects OpenAI o-series', () => {
    expect(supportsReasoningEffort('o3')).toBe(true);
    expect(supportsReasoningEffort('o4-mini')).toBe(true);
    expect(getReasoningLabel('openai/o3-mini')).toBe('OpenAI o-series (gateway)');
  });

  test('detects NVIDIA stepfun, Qwen and generic thinking models', () => {
    expect(supportsReasoningEffort('stepfun-1')).toBe(true);
    expect(supportsReasoningEffort('qwq-32b')).toBe(true);
    expect(supportsReasoningEffort('qwen3-thinking')).toBe(true);
    expect(supportsReasoningEffort('glm-4-thinking')).toBe(true);
    expect(supportsReasoningEffort('kimi-k2-thinking')).toBe(true);
    expect(supportsReasoningEffort('some-model-thinking')).toBe(true);
  });

  test('returns no label for ordinary chat models', () => {
    expect(supportsReasoningEffort('gpt-4o')).toBe(false);
    expect(supportsReasoningEffort('claude-opus-4-7')).toBe(false);
    expect(getReasoningLabel('llama-3.1-70b')).toBeNull();
  });

  test('returns null when nothing is configured', () => {
    expect(getEffortForModel('deepseek-r1')).toBeNull();
  });

  test('persists and retrieves a per-model override', () => {
    expect(setModelReasoningEffort('deepseek-r1', 'high' as ReasoningEffort)).toBe(true);
    expect(getEffortForModel('deepseek-r1')).toBe('high');
    expect(getReasoningEffortConfig().models['deepseek-r1']).toBe('high');
  });

  test('default clears the override', () => {
    setModelReasoningEffort('o3', 'max' as ReasoningEffort);
    expect(setModelReasoningEffort('o3', 'default' as ReasoningEffort)).toBe(true);
    expect(getEffortForModel('o3')).toBeNull();
    expect(getReasoningEffortConfig().models['o3']).toBeUndefined();
  });

  test('survives a config reload', () => {
    setModelReasoningEffort('o3', 'medium' as ReasoningEffort);
    reloadReasoningEffort();
    expect(getEffortForModel('o3')).toBe('medium');
  });
});
