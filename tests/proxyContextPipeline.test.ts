/**
 * Regression coverage for the per-request proxy pipeline.
 *
 * These exercise wiring the unit tests cannot reach on their own:
 *   - context window registration survives the plaintext-key migration path
 *   - compaction reduces a conversation that crosses the threshold
 *   - summarization reads the translator's bare Gemini response shape
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => process.env.AG_TEST_HOME || actual.homedir() };
});

import { loadCustomModels, startProxy, stopProxy, generateModelPlaceholderId, CustomModel } from '../src/proxy';
import { getContextWindow } from '../src/context/contextWindows';
import { stopCleanupInterval } from '../src/proxy/shared';

const UPSTREAM_PORT = 19_995;

function modelsPath(): string {
  return path.join(process.env.AG_TEST_HOME as string, '.free-antigravity', 'models.json');
}

function writeModels(models: unknown[]): void {
  fs.mkdirSync(path.dirname(modelsPath()), { recursive: true });
  fs.writeFileSync(modelsPath(), JSON.stringify({ models }), 'utf-8');
}

function readModels(): { models: Record<string, unknown>[] } {
  return JSON.parse(fs.readFileSync(modelsPath(), 'utf-8'));
}

async function postToProxy(port: number, payload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1internal:generateContent',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve(res.statusCode || 0));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('Proxy context pipeline', () => {
  let upstream: http.Server;
  let summaryRequests = 0;
  let forwardedMessageCounts: number[] = [];

  beforeAll((done) => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const messages: { content?: string }[] = parsed.messages || [];
        forwardedMessageCounts.push(messages.length);
        const isSummary = messages.some((m) => typeof m.content === 'string' && m.content.includes('conversation summarizer'));
        if (isSummary) summaryRequests++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: isSummary ? '## Objective\n- compacted' : 'ok' } }] }));
      });
    });
    upstream.listen(UPSTREAM_PORT, '127.0.0.1', done);
  });

  afterAll((done) => {
    stopCleanupInterval();
    upstream.close(() => done());
  });

  beforeEach(() => {
    process.env.AG_TEST_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agpipe-'));
    summaryRequests = 0;
    forwardedMessageCounts = [];
  });

  afterEach(() => {
    fs.rmSync(process.env.AG_TEST_HOME as string, { recursive: true, force: true });
  });

  test('registers context windows even when the api key migration path runs', () => {
    // Plaintext key forces the migration branch in loadCustomModels().
    writeModels([
      {
        name: 'models/migrate-model',
        displayName: 'Migrate Model',
        provider: 'openai',
        apiKey: 'sk-plaintext',
        apiUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1/chat/completions`,
        externalModelName: 'migrate-4o',
        contextWindow: 4000,
      },
    ]);

    const models = loadCustomModels();
    expect(getContextWindow('migrate-4o')).toBe(4000);

    // Migration must have re-encrypted the key on disk while preserving the window.
    const stored = readModels().models[0];
    expect(stored).toMatchObject({ encrypted: true, externalModelName: 'migrate-4o' });
    expect((models as CustomModel[])[0].contextWindow).toBe(4000);
  });

  test('compacts a conversation that crosses the threshold', async () => {
    // Already encrypted so no migration runs and the window is declared on first load.
    writeModels([
      {
        name: 'models/compact-model',
        displayName: 'Compact Model',
        provider: 'openai',
        apiKey: 'enc:c2VjcmV0',
        encrypted: true,
        apiUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1/chat/completions`,
        externalModelName: 'compact-4o',
        contextWindow: 4000,
      },
    ]);

    const models = loadCustomModels();
    const port = await startProxy(0);
    const placeholder = generateModelPlaceholderId((models as CustomModel[])[0]);

    const contents = [];
    for (let i = 0; i < 30; i++) {
      contents.push({ role: 'user', parts: [{ text: `Turn ${i}: ${'lorem ipsum dolor sit amet '.repeat(40)}` }] });
      contents.push({ role: 'model', parts: [{ text: 'ok' }] });
    }

    const payload = JSON.stringify({
      model: placeholder,
      systemInstruction: { parts: [{ text: 'You are Antigravity.' }] },
      contents,
    });

    expect(await postToProxy(port, payload)).toBe(200);
    await stopProxy();

    expect(summaryRequests).toBe(1);
    // 30 turns = 60 messages plus the injected system instruction; compaction must shrink
    // the forwarded request well below that.
    expect(Math.max(...forwardedMessageCounts)).toBeLessThan(20);
  });
});
