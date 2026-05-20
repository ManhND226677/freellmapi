// Stub for cache - actual implementation may vary
export function getCache<T>(key: string): T | null {
  return null;
}

export function setCache<T>(key: string, value: T): void {
  // no-op
}

export function generateCacheKey(modelId: string, messagesHash: string, options?: any): string {
  return `${modelId}:${messagesHash}`;
}

export function hashMessages(messages: any[]): string {
  return 'stub';
}