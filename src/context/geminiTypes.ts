/**
 * Shared Gemini wire-format types used by the proxy and the context subsystem.
 */
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: unknown;
  functionResponse?: unknown;
  inlineData?: { mimeType?: string; data?: string };
  [key: string]: unknown;
}

export interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
  [key: string]: unknown;
}

export interface GeminiRequestBody {
  model?: string;
  modelId?: string;
  model_id?: string;
  request?: GeminiRequestBody;
  systemInstruction?: { parts?: GeminiPart[] };
  system_instruction?: { parts?: GeminiPart[] };
  contents?: GeminiContent[];
  tools?: unknown[];
  generationConfig?: { temperature?: number; maxOutputTokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export function getSystemInstruction(body: GeminiRequestBody): { parts?: GeminiPart[] } | undefined {
  return body.systemInstruction || body.system_instruction;
}

export function setSystemInstruction(body: GeminiRequestBody, text: string): void {
  body.systemInstruction = { parts: [{ text }] };
  delete body.system_instruction;
}

export function readSystemText(body: GeminiRequestBody): string {
  const parts = getSystemInstruction(body)?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
}
