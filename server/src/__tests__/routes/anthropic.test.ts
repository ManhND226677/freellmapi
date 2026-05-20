import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, headers?: Record<string, string>) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: text };
}

describe('Anthropic-compatible routes', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists Anthropic-shaped facade models when Anthropic headers are present', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, {
      'anthropic-version': '2023-06-01',
      'x-api-key': 'freellmapi-test',
    });

    expect(status).toBe(200);
    expect(body.data[0].id).toBe('claude-opus-4.7');
    expect(body.data[0].type).toBe('model');
  });

  it('accepts /v1/messages and falls back through normal providers', async () => {
    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_anthropic_route_test',
      label: 'anthropic-route',
    });
    expect(addKey.status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const body = JSON.parse((init as any).body);
        expect(body.messages[0].role).toBe('user');
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-anthropic-fallback',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'hello from fallback' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/messages', {
      model: 'claude-opus-4.7',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      'anthropic-version': '2023-06-01',
      'x-api-key': 'freellmapi-test',
    });

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toContain('groq/');
    expect(body.type).toBe('message');
    expect(body.model).toBe('claude-opus-4.7');
    expect(body.content[0]).toEqual({ type: 'text', text: 'hello from fallback' });
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(4);
  });
});
