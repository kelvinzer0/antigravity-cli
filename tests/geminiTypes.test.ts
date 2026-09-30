import {
  GeminiRequestBody,
  getSystemInstruction,
  readSystemText,
  setSystemInstruction,
} from '../src/context/geminiTypes';

describe('Gemini type helpers', () => {
  test('readSystemText joins all text parts', () => {
    const body: GeminiRequestBody = {
      systemInstruction: { parts: [{ text: 'alpha' }, { text: 'beta' }, { functionCall: { name: 'x' } }] },
    };
    expect(readSystemText(body)).toBe('alphabeta');
  });

  test('readSystemText handles missing instruction', () => {
    expect(readSystemText({})).toBe('');
  });

  test('readSystemText reads camelCase and snake_case', () => {
    expect(readSystemText({ system_instruction: { parts: [{ text: 'snake' }] } })).toBe('snake');
  });

  test('setSystemInstruction writes a single text part and clears the snake_case alias', () => {
    const body: GeminiRequestBody = { system_instruction: { parts: [{ text: 'old' }] } };
    setSystemInstruction(body, 'fresh');
    expect(readSystemText(body)).toBe('fresh');
    expect(body.system_instruction).toBeUndefined();
    expect(getSystemInstruction(body)?.parts).toEqual([{ text: 'fresh' }]);
  });

  test('nested request wrapper is still a valid body', () => {
    const body: GeminiRequestBody = { request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } };
    expect(readSystemText(body)).toBe('');
  });
});
