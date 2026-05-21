import { afterEach, describe, expect, it, vi } from 'vitest';
import { LunaProvider } from '../../providers/luna.js';

const ORIGINAL_LUNA_PROXY_BASE_URL = process.env.LUNA_PROXY_BASE_URL;

afterEach(() => {
  if (ORIGINAL_LUNA_PROXY_BASE_URL === undefined) {
    delete process.env.LUNA_PROXY_BASE_URL;
  } else {
    process.env.LUNA_PROXY_BASE_URL = ORIGINAL_LUNA_PROXY_BASE_URL;
  }
  vi.restoreAllMocks();
});

describe('LunaProvider', () => {
  it('uses the local Luna sidecar URL by default', async () => {
    delete process.env.LUNA_PROXY_BASE_URL;
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'id',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3.6-plus',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      } as any;
    });

    const provider = new LunaProvider();
    const result = await provider.chatCompletion('local-placeholder', [{ role: 'user', content: 'hi' }], 'qwen3.6-plus');

    expect(capturedUrl).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(capturedHeaders.Authorization).toBe('Bearer local-placeholder');
    expect(capturedHeaders['x-luna-source']).toBe('freellmapi');
    expect(result._routed_via).toEqual({ platform: 'luna', model: 'qwen3.6-plus' });
  });

  it('normalizes a configured Luna base URL without /v1', async () => {
    process.env.LUNA_PROXY_BASE_URL = 'https://luna.example.com/';
    let capturedUrl = '';

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      capturedUrl = url as string;
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'id',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3.6-plus',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      } as any;
    });

    const provider = new LunaProvider();
    await provider.chatCompletion('proxy-key', [{ role: 'user', content: 'hi' }], 'qwen3.6-plus');

    expect(capturedUrl).toBe('https://luna.example.com/v1/chat/completions');
  });
});
