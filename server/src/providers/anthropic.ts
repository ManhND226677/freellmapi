import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolChoice,
  ChatToolDefinition,
  ChatToolCall,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

const API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const OPUS_OFFICIAL_MODEL = 'claude-opus-4-1-20250805';

export const ANTHROPIC_OPUS_FACADE_MODEL = 'claude-opus-4.7';

const MODEL_ALIASES: Record<string, string> = {
  [ANTHROPIC_OPUS_FACADE_MODEL]: OPUS_OFFICIAL_MODEL,
  'claude-opus-4-7': OPUS_OFFICIAL_MODEL,
  'claude-opus-4.1': OPUS_OFFICIAL_MODEL,
  'claude-opus-4-1': OPUS_OFFICIAL_MODEL,
};

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export function toAnthropicModelId(modelId: string): string {
  return MODEL_ALIASES[modelId] ?? modelId;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toAnthropicTools(tools?: ChatToolDefinition[]) {
  return tools?.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }));
}

function toAnthropicToolChoice(toolChoice?: ChatToolChoice) {
  if (!toolChoice || toolChoice === 'auto') return undefined;
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return undefined;
  return { type: 'tool', name: toolChoice.function.name };
}

function textContent(content: string | null): string {
  return typeof content === 'string' ? content : '';
}

function toAnthropicMessages(messages: ChatMessage[]) {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => textContent(m.content))
    .filter(Boolean)
    .join('\n\n');

  const converted = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: textContent(m.content),
          }],
        };
      }

      if (m.role === 'assistant' && m.tool_calls?.length) {
        const content: Array<Record<string, unknown>> = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const call of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: safeJsonParse(call.function.arguments),
          });
        }
        return { role: 'assistant' as const, content };
      }

      return {
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: textContent(m.content),
      };
    });

  return { system: system || undefined, messages: converted };
}

function fromAnthropicStopReason(stopReason: string | null | undefined, hasToolCalls: boolean): string | null {
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop';
  return stopReason ?? null;
}

function extractText(blocks: AnthropicContentBlock[]): string | null {
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('');
  return text.length > 0 ? text : null;
}

function extractToolCalls(blocks: AnthropicContentBlock[]): ChatToolCall[] {
  return blocks
    .filter(block => block.type === 'tool_use')
    .map(block => {
      const tool = block as { id: string; name: string; input: unknown };
      return {
        id: tool.id,
        type: 'function',
        function: {
          name: tool.name,
          arguments: JSON.stringify(tool.input ?? {}),
        },
      };
    });
}

function toOpenAIResponse(data: AnthropicMessage, requestedModel: string): ChatCompletionResponse {
  const toolCalls = extractToolCalls(data.content ?? []);
  const text = extractText(data.content ?? []);
  const usage: TokenUsage = {
    prompt_tokens: data.usage?.input_tokens ?? 0,
    completion_tokens: data.usage?.output_tokens ?? 0,
    total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
  };

  return {
    id: data.id.replace(/^msg_/, 'chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 ? (text ?? null) : (text ?? ''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: fromAnthropicStopReason(data.stop_reason, toolCalls.length > 0),
    }],
    usage,
    _routed_via: { platform: 'anthropic', model: requestedModel },
  };
}

function buildBody(messages: ChatMessage[], modelId: string, options?: CompletionOptions, stream = false): Record<string, unknown> {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: toAnthropicModelId(modelId),
    max_tokens: options?.max_tokens ?? 1024,
    messages: anthropicMessages,
    temperature: options?.temperature,
    top_p: options?.top_p,
    tools: toAnthropicTools(options?.tools),
    tool_choice: toAnthropicToolChoice(options?.tool_choice),
    stream,
  };

  if (system) body.system = system;
  if (options?.tool_choice === 'none') delete body.tools;

  if (body.tools === undefined) delete body.tools;
  if (body.tool_choice === undefined) delete body.tool_choice;

  // Opus 4.1 rejects requests that include both temperature and top_p.
  if (toAnthropicModelId(modelId) === OPUS_OFFICIAL_MODEL && body.temperature !== undefined && body.top_p !== undefined) {
    delete body.top_p;
  }

  return body;
}

export class AnthropicProvider extends BaseProvider {
  readonly platform = 'anthropic' as const;
  readonly name = 'Anthropic';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const requestedModel = toAnthropicModelId(modelId);
    const res = await this.fetchWithTimeout(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildBody(messages, modelId, options, false)),
    }, 120000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Anthropic API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as AnthropicMessage;
    return toOpenAIResponse(data, requestedModel);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const requestedModel = toAnthropicModelId(modelId);
    const res = await this.fetchWithTimeout(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildBody(messages, modelId, options, true)),
    }, 120000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Anthropic API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    let eventType = '';
    let finishReason: string | null = null;
    const activeToolBlocks = new Map<number, { id: string; name: string; input: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            eventType = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;

          let data: any;
          try {
            data = JSON.parse(trimmed.slice(6));
          } catch {
            continue;
          }

          if (eventType === 'content_block_start' && data.content_block?.type === 'tool_use') {
            activeToolBlocks.set(data.index, {
              id: data.content_block.id,
              name: data.content_block.name,
              input: '',
            });
          }

          if (eventType === 'content_block_delta') {
            if (data.delta?.type === 'text_delta' && data.delta.text) {
              yield {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }],
              };
            }
            if (data.delta?.type === 'input_json_delta') {
              const block = activeToolBlocks.get(data.index);
              if (block) block.input += data.delta.partial_json ?? '';
            }
          }

          if (eventType === 'content_block_stop') {
            const block = activeToolBlocks.get(data.index);
            if (block) {
              activeToolBlocks.delete(data.index);
              yield {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      id: block.id,
                      type: 'function',
                      function: {
                        name: block.name,
                        arguments: block.input || '{}',
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              };
            }
          }

          if (eventType === 'message_delta') {
            finishReason = fromAnthropicStopReason(data.delta?.stop_reason, false);
          }

          if (eventType === 'message_stop') {
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? 'stop' }],
            };
            return;
          }
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }
}
