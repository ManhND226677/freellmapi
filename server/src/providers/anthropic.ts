import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

/**
 * Anthropic provider with random API key rotation (9router-style).
 * When multiple API keys are available, randomly selects one for each request
 * instead of round-robin, distributing load unpredictably across keys.
 */
export class AnthropicProvider extends BaseProvider {
  readonly platform: Platform = 'anthropic';
  readonly name = 'Anthropic';
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiVersion = '2023-06-01';

  // Store all available keys for random rotation
  private availableKeys: string[] = [];

  /**
   * Register multiple API keys for random rotation.
   * Call this before making requests to enable 9router-style behavior.
   */
  registerKeys(keys: string[]): void {
    this.availableKeys = keys.filter(k => k && k.trim().length > 0);
  }

  /**
   * Randomly select an API key from the pool (9router-style).
   * Falls back to the provided key if no pool is registered.
   */
  private selectRandomKey(fallbackKey: string): string {
    if (this.availableKeys.length === 0) {
      return fallbackKey;
    }
    const randomIndex = Math.floor(Math.random() * this.availableKeys.length);
    return this.availableKeys[randomIndex];
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    // Random key selection (9router-style)
    const selectedKey = this.selectRandomKey(apiKey);

    // Convert OpenAI format to Anthropic Messages API format
    const anthropicMessages = this.convertMessages(messages);
    const systemPrompt = this.extractSystemPrompt(messages);

    const requestBody: any = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: options?.max_tokens ?? 4096,
    };

    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.top_p !== undefined) {
      requestBody.top_p = options.top_p;
    }
    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = this.convertTools(options.tools);
    }
    if (options?.tool_choice) {
      requestBody.tool_choice = this.convertToolChoice(options.tool_choice);
    }

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': selectedKey,
        'anthropic-version': this.apiVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    }, 60000); // Anthropic can be slow for long responses

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    const openaiResponse = this.convertToOpenAIFormat(data, modelId);
    openaiResponse._routed_via = { platform: this.platform, model: modelId };
    return openaiResponse;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    // Random key selection (9router-style)
    const selectedKey = this.selectRandomKey(apiKey);

    const anthropicMessages = this.convertMessages(messages);
    const systemPrompt = this.extractSystemPrompt(messages);

    const requestBody: any = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: options?.max_tokens ?? 4096,
      stream: true,
    };

    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.top_p !== undefined) {
      requestBody.top_p = options.top_p;
    }
    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = this.convertTools(options.tools);
    }
    if (options?.tool_choice) {
      requestBody.tool_choice = this.convertToolChoice(options.tool_choice);
    }

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': selectedKey,
        'anthropic-version': this.apiVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    }, 60000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const chunkId = this.makeId();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);

        try {
          const event = JSON.parse(data);

          // Convert Anthropic streaming events to OpenAI format
          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: { content: event.delta.text },
                finish_reason: null,
              }],
            };
          } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
            yield {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: this.mapStopReason(event.delta.stop_reason),
              }],
            };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Anthropic doesn't have a /models endpoint, so we make a minimal request
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': this.apiVersion,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20250501', // Cheapest model for validation
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 1,
        }),
      }, 10000);

      // 401/403 = invalid key, anything else (including 400 for bad request) = valid key
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }

  private extractSystemPrompt(messages: ChatMessage[]): string | undefined {
    const systemMsg = messages.find(m => m.role === 'system');
    return systemMsg?.content ?? undefined;
  }

  private convertMessages(messages: ChatMessage[]): any[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
  }

  private convertTools(tools: any[]): any[] {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  private convertToolChoice(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      if (toolChoice === 'auto') return { type: 'auto' };
      if (toolChoice === 'none') return { type: 'none' };
      if (toolChoice === 'required') return { type: 'any' };
    }
    if (typeof toolChoice === 'object' && toolChoice.function?.name) {
      return { type: 'tool', name: toolChoice.function.name };
    }
    return { type: 'auto' };
  }

  private convertToOpenAIFormat(anthropicResponse: any, modelId: string): ChatCompletionResponse {
    const content = anthropicResponse.content
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('') ?? '';

    const toolCalls = anthropicResponse.content
      ?.filter((c: any) => c.type === 'tool_use')
      .map((c: any, idx: number) => ({
        id: c.id,
        type: 'function' as const,
        function: {
          name: c.name,
          arguments: JSON.stringify(c.input),
        },
      }));

    return {
      id: anthropicResponse.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: this.mapStopReason(anthropicResponse.stop_reason),
      }],
      usage: {
        prompt_tokens: anthropicResponse.usage?.input_tokens ?? 0,
        completion_tokens: anthropicResponse.usage?.output_tokens ?? 0,
        total_tokens: (anthropicResponse.usage?.input_tokens ?? 0) + (anthropicResponse.usage?.output_tokens ?? 0),
      },
    };
  }

  private mapStopReason(anthropicReason: string): 'stop' | 'length' | 'tool_calls' | null {
    switch (anthropicReason) {
      case 'end_turn': return 'stop';
      case 'max_tokens': return 'length';
      case 'tool_use': return 'tool_calls';
      default: return null;
    }
  }
}
