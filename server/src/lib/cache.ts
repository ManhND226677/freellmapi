import crypto from 'crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

export function hashMessages(messages: ChatMessage[]): string {
  return sha256(stableStringify(messages));
}

export function generateCacheKey(
  modelId: string,
  messagesHash: string,
  options: Record<string, unknown>,
): string {
  return sha256(stableStringify({ modelId, messagesHash, options }));
}

export function getCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCache<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
  pruneExpired();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });

  if (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) cache.delete(oldestKey);
  }
}

export function clearCache(): void {
  cache.clear();
}
