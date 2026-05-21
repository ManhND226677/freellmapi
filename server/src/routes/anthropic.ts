import crypto from 'crypto';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import { getDb, getUnifiedApiKey, persistDbSnapshot } from '../db/index.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../services/ratelimit.js';
import { ANTHROPIC_OPUS_DOT_ALIAS, ANTHROPIC_OPUS_FACADE_MODEL } from '../providers/anthropic.js';

export const anthropicRouter = Router();

const MAX_RETRIES = 20;
const SHIELD_MODEL_IDS = [
  ANTHROPIC_OPUS_FACADE_MODEL,
  ANTHROPIC_OPUS_DOT_ALIAS,
  'claude-opus-4-1-20250805',
  'claude-opus-4.1',
  'claude-opus-4-1',
];

function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

function authenticate(req: Request, res: Response): boolean {
  const allowLocalBypass = process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1';
  const isLocal = allowLocalBypass && (
    req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
  );
  if (isLocal) return true;

  const token = req.headers['x-api-key']?.toString()
    ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid API key' },
    });
    return false;
  }

  return true;
}

function wantsAnthropic(req: Request): boolean {
  return Boolean(req.headers['anthropic-version'] || req.headers['x-api-key']);
}

const contentBlockSchema = z.object({
  type: z.string(),
}).passthrough();

const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

const anthropicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const anthropicToolChoiceSchema = z.object({
  type: z.enum(['auto', 'any', 'tool', 'none']),
  name: z.string().optional(),
}).passthrough();

const messagesSchema = z.object({
  model: z.string().min(1),
  messages: z.array(anthropicMessageSchema).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
});

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    const item = block as Record<string, unknown>;
    if (item.type === 'text') return typeof item.text === 'string' ? item.text : '';
    if (item.type === 'tool_result') {
      const value = item.content;
      return typeof value === 'string' ? value : JSON.stringify(value ?? '');
    }
    return '';
  }).join('');
}

function anthropicMessagesToChatMessages(system: unknown, messages: z.infer<typeof anthropicMessageSchema>[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const systemText = contentToText(system);
  if (systemText) result.push({ role: 'system', content: systemText });

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const text = contentToText(message.content);
      const toolCalls = message.content
        .filter(block => block.type === 'tool_use')
        .map(block => {
          const item = block as Record<string, unknown>;
          return {
            id: String(item.id ?? crypto.randomUUID()),
            type: 'function' as const,
            function: {
              name: String(item.name ?? 'tool'),
              arguments: JSON.stringify(item.input ?? {}),
            },
          };
        });
      result.push({
        role: 'assistant',
        content: text || (toolCalls.length ? null : ''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    result.push({
      role: message.role,
      content: contentToText(message.content),
    });
  }

  return result;
}

function anthropicToolsToOpenAI(tools?: z.infer<typeof anthropicToolSchema>[]): ChatToolDefinition[] | undefined {
  return tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

function anthropicToolChoiceToOpenAI(toolChoice?: z.infer<typeof anthropicToolChoiceSchema>): ChatToolChoice | undefined {
  if (!toolChoice || toolChoice.type === 'auto') return undefined;
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'none') return 'none';
  return {
    type: 'function',
    function: { name: toolChoice.name ?? '' },
  };
}

function getShieldModelDbId(): number | undefined {
  const db = getDb();
  const placeholders = SHIELD_MODEL_IDS.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT id FROM models
    WHERE platform = 'anthropic' AND enabled = 1 AND model_id IN (${placeholders})
    ORDER BY CASE model_id
      WHEN ? THEN 0
      WHEN 'claude-opus-4-1-20250805' THEN 1
      ELSE 2
    END
    LIMIT 1
  `).get(...SHIELD_MODEL_IDS, ANTHROPIC_OPUS_FACADE_MODEL) as { id: number } | undefined;
  return row?.id;
}

function estimateTokens(messages: ChatMessage[], maxTokens?: number): { input: number; total: number } {
  const input = messages.reduce((sum, m) => {
    if (typeof m.content !== 'string') return sum;
    return sum + Math.ceil(m.content.length / 4);
  }, 0);
  return { input, total: input + (maxTokens ?? 1024) };
}

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('unsupported model') || msg.includes('invalid model') || msg.includes('model not found')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error');
}

function toAnthropicStopReason(finishReason: string | null | undefined): string {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

function parseToolInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function toAnthropicMessage(result: ChatCompletionResponse, facadeModel: string) {
  const choice = result.choices[0];
  const message = choice?.message;
  const content: Array<Record<string, unknown>> = [];

  if (typeof message?.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  }

  for (const call of message?.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments),
    });
  }

  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: result.id.replace(/^chatcmpl-/, 'msg_'),
    type: 'message',
    role: 'assistant',
    model: facadeModel,
    content,
    stop_reason: toAnthropicStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.prompt_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens ?? 0,
    },
  };
}

async function logRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error);
    await persistDbSnapshot('request-log');
  } catch (e) {
    console.error('Failed to log Anthropic-compatible request:', e);
  }
}

async function routeOnce(
  estimatedTotal: number,
  preferredModel: number | undefined,
  skipKeys: Set<string>,
): Promise<RouteResult> {
  return routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel);
}

anthropicRouter.get('/models', (req: Request, res: Response, next: NextFunction) => {
  if (!wantsAnthropic(req)) {
    next();
    return;
  }
  if (!authenticate(req, res)) return;

  res.json({
    data: [
      {
        id: ANTHROPIC_OPUS_FACADE_MODEL,
        type: 'model',
        display_name: 'Claude Opus 4.7',
        created_at: '2026-04-16T00:00:00Z',
      },
      {
        id: 'claude-opus-4-1-20250805',
        type: 'model',
        display_name: 'Claude Opus 4.1',
        created_at: '2025-08-05T00:00:00Z',
      },
    ],
    has_more: false,
    first_id: ANTHROPIC_OPUS_FACADE_MODEL,
    last_id: 'claude-opus-4-1-20250805',
  });
});

anthropicRouter.get('/models/:modelId', (req: Request, res: Response, next: NextFunction) => {
  if (!wantsAnthropic(req)) {
    next();
    return;
  }
  if (!authenticate(req, res)) return;

  const modelId = String(req.params.modelId ?? '');
  if (!modelId || !SHIELD_MODEL_IDS.includes(modelId)) {
    res.status(404).json({
      type: 'error',
      error: { type: 'not_found_error', message: `Model not found: ${modelId}` },
    });
    return;
  }

  res.json({
    id: modelId,
    type: 'model',
    display_name: [ANTHROPIC_OPUS_FACADE_MODEL, ANTHROPIC_OPUS_DOT_ALIAS].includes(modelId)
      ? 'Claude Opus 4.7'
      : 'Claude Opus 4.1',
    created_at: [ANTHROPIC_OPUS_FACADE_MODEL, ANTHROPIC_OPUS_DOT_ALIAS].includes(modelId)
      ? '2026-04-16T00:00:00Z'
      : '2025-08-05T00:00:00Z',
  });
});

anthropicRouter.get('/messages', (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  res.json({
    type: 'messages_endpoint',
    status: 'ok',
  });
});

anthropicRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();
  if (!authenticate(req, res)) return;

  const parsed = messagesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
      },
    });
    return;
  }

  const data = parsed.data;
  const messages = anthropicMessagesToChatMessages(data.system, data.messages);
  const tools = anthropicToolsToOpenAI(data.tools);
  const tool_choice = anthropicToolChoiceToOpenAI(data.tool_choice);
  const { input: estimatedInputTokens, total: estimatedTotal } = estimateTokens(messages, data.max_tokens);
  const preferredModel = getShieldModelDbId();
  const skipKeys = new Set<string>();
  let lastError: any = null;
  const facadeModel = data.model || ANTHROPIC_OPUS_FACADE_MODEL;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = await routeOnce(estimatedTotal, preferredModel, skipKeys);
    } catch (err: any) {
      const message = lastError ? `All models rate-limited. Last error: ${lastError.message}` : err.message;
      res.status(err.status ?? 503).json({
        type: 'error',
        error: { type: lastError ? 'rate_limit_error' : 'routing_error', message },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (data.stream) {
        let streamStarted = false;
        let contentStarted = false;
        let totalOutputTokens = 0;
        const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;

        const gen = route.provider.streamChatCompletion(
          route.apiKey,
          messages,
          route.modelId,
          {
            temperature: data.temperature,
            max_tokens: data.max_tokens,
            top_p: data.top_p,
            tools,
            tool_choice,
          },
        );

        for await (const chunk of gen) {
          if (!streamStarted) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
            res.write(`event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: facadeModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
              },
            })}\n\n`);
            streamStarted = true;
          }

          const choice = chunk.choices[0];
          const text = choice?.delta?.content ?? '';
          if (text) {
            if (!contentStarted) {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              })}\n\n`);
              contentStarted = true;
            }
            totalOutputTokens += Math.ceil(text.length / 4);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            })}\n\n`);
          }

          for (const call of choice?.delta?.tool_calls ?? []) {
            const index = contentStarted ? 1 : 0;
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: parseToolInput(call.function.arguments),
              },
            })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
          }

          if (choice?.finish_reason) {
            if (contentStarted) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
            }
            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: toAnthropicStopReason(choice.finish_reason), stop_sequence: null },
              usage: { output_tokens: totalOutputTokens },
            })}\n\n`);
          }
        }

        if (!streamStarted) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: facadeModel,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
            },
          })}\n\n`);
        }

        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();

        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
        recordSuccess(route.modelDbId);
        await logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
        return;
      }

      const result = await route.provider.chatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        {
          temperature: data.temperature,
          max_tokens: data.max_tokens,
          top_p: data.top_p,
          tools,
          tool_choice,
        },
      );

      const totalTokens = result.usage?.total_tokens ?? 0;
      recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
      recordSuccess(route.modelDbId);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json(toAnthropicMessage(result, facadeModel));

      await logRequest(
        route.platform,
        route.modelId,
        'success',
        result.usage?.prompt_tokens ?? 0,
        result.usage?.completion_tokens ?? 0,
        Date.now() - start,
        null,
      );
      return;
    } catch (err: any) {
      await logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, Date.now() - start, err.message);

      if (isRetryableError(err)) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(route.platform, route.modelId, route.keyId, 120_000);
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        continue;
      }

      res.status(502).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Provider error (${route.displayName}): ${err.message}`,
        },
      });
      return;
    }
  }

  res.status(429).json({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
    },
  });
});
