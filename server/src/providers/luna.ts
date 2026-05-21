import { OpenAICompatProvider } from './openai-compat.js';

const DEFAULT_LUNA_PROXY_BASE_URL = 'http://127.0.0.1:8080/v1';
const DEFAULT_LUNA_TIMEOUT_MS = 300_000;

function normalizeLunaBaseUrl(value?: string): string {
  const raw = (value ?? DEFAULT_LUNA_PROXY_BASE_URL).trim() || DEFAULT_LUNA_PROXY_BASE_URL;
  const noSlash = raw.replace(/\/+$/, '');
  return noSlash.endsWith('/v1') ? noSlash : `${noSlash}/v1`;
}

function parseTimeout(value?: string): number {
  if (!value) return DEFAULT_LUNA_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LUNA_TIMEOUT_MS;
}

/**
 * Luna Proxy sidecar provider.
 *
 * FreeLLM routes to Luna through Luna's OpenAI-compatible facade while Luna
 * owns Qwen web-chat credentials, account routing, session storage, overflow,
 * and tool-call protocol bridging.
 */
export class LunaProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'luna',
      name: 'Luna Proxy',
      baseUrl: normalizeLunaBaseUrl(process.env.LUNA_PROXY_BASE_URL),
      timeoutMs: parseTimeout(process.env.LUNA_PROXY_TIMEOUT_MS),
      extraHeaders: {
        'x-luna-source': 'freellmapi',
      },
    });
  }
}

export const LUNA_PROXY_DEFAULT_BASE_URL = DEFAULT_LUNA_PROXY_BASE_URL;
