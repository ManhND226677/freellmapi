import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../providers/anthropic.js';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider();
    vi.restoreAllMocks();
  });

  it('calls Messages API with Anthropic headers and official model alias', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-1-20250805',
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'anthropic-key',
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      'claude-opus-4.7',
      { max_tokens: 256, temperature: 0.2, top_p: 0.9 },
    );

    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(capturedHeaders['x-api-key']).toBe('anthropic-key');
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(capturedBody.model).toBe('claude-opus-4-1-20250805');
    expect(capturedBody.top_p).toBeUndefined();
    expect(capturedBody.system).toBe('be brief');
    expect(result.choices[0].message.content).toBe('hello');
    expect(result.usage.total_tokens).toBe(7);
  });

  it('translates Anthropic tool_use blocks to OpenAI tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'get_weather',
          input: { city: 'Saigon' },
        }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 3 },
      }),
    } as any);

    const result = await provider.chatCompletion(
      'key',
      [{ role: 'user', content: 'weather' }],
      'claude-sonnet-4-20250514',
    );

    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Saigon"}');
  });

  it('validates key through the Anthropic models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await provider.validateKey('valid')).toBe(true);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('bad')).toBe(false);
  });
});
