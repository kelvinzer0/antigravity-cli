import {
  needsCompaction,
  selectContentsToCompact,
  buildSummarizationPrompt,
  DEFAULT_THRESHOLD,
} from '../src/context/compaction';
import { GeminiContent } from '../src/context/geminiTypes';
import { estimateTextTokens } from '../src/context/tokenEstimator';

function longConversation(turns: number): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (let i = 0; i < turns; i++) {
    contents.push({ role: 'user', parts: [{ text: `Turn ${i}: ${'x'.repeat(4000)}` }] });
    contents.push({ role: 'model', parts: [{ text: `Reply ${i}: ${'y'.repeat(4000)}` }] });
  }
  return contents;
}

describe('Compaction selection', () => {
  test('selects the oldest turns and preserves the tail', () => {
    const contents = longConversation(5);
    const { toCompact, toPreserve } = selectContentsToCompact(contents, 2);
    expect(toCompact).toHaveLength(6);
    expect(toPreserve).toHaveLength(4);
    expect(toPreserve[0]).toBe(contents[6]);
    expect(toPreserve[toPreserve.length - 1]).toBe(contents[contents.length - 1]);
  });

  test('preserves everything when the conversation is shorter than the tail', () => {
    const contents = longConversation(1);
    const { toCompact, toPreserve } = selectContentsToCompact(contents, 2);
    expect(toCompact).toHaveLength(0);
    expect(toPreserve).toHaveLength(2);
  });

  test('zero tail turns preserve nothing', () => {
    const contents = longConversation(3);
    const { toPreserve } = selectContentsToCompact(contents, 0);
    expect(toPreserve).toHaveLength(0);
  });

  test('undefined contents produce empty selections', () => {
    expect(selectContentsToCompact(undefined, 2)).toEqual({ toCompact: [], toPreserve: [] });
  });

  test('needsCompaction triggers only past the threshold', () => {
    const window = 100_000;
    const small = 'a'.repeat(1000);
    expect(needsCompaction(small, [], undefined, window, DEFAULT_THRESHOLD)).toBe(false);
  });

  test('needsCompaction triggers when the estimate crosses the threshold', () => {
    const window = 10_000;
    const contents = longConversation(10);
    expect(needsCompaction('', contents, undefined, window, 0.8)).toBe(true);
  });

  test('needsCompaction is disabled outside the (0,1) range', () => {
    const contents = longConversation(10);
    expect(needsCompaction('', contents, undefined, 10_000, 0)).toBe(false);
    expect(needsCompaction('', contents, undefined, 10_000, 1.5)).toBe(false);
  });

  test('summarization prompt labels roles and preserves text', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'fix the bug' }] },
      { role: 'model', parts: [{ text: 'done' }] },
    ];
    const prompt = buildSummarizationPrompt(contents);
    expect(prompt).toContain('[User]: fix the bug');
    expect(prompt).toContain('[Assistant]: done');
    expect(prompt).toContain('## Objective');
  });

  test('summarization prompt includes tool calls and results', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'view_file', args: { AbsolutePath: 'a.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'view_file', response: 'file content' } }] },
    ];
    const prompt = buildSummarizationPrompt(contents);
    expect(prompt).toContain('[tool_call]');
    expect(prompt).toContain('[tool_result]');
  });

  test('estimateTextTokens scales with text length', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('a'.repeat(8))).toBe(2);
    expect(estimateTextTokens('a'.repeat(100))).toBe(25);
  });
});
