import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import { throttledRefresh } from '../lib/db-refresh.js';
import type { BaseProvider } from '../providers/base.js';
import { resolveModelAlias } from '../db/index.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
  platform: string;
}

interface ProviderLatencyRow {
  platform: string;
  avg_latency_ms: number;
  samples: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  isAlias?: boolean;
  rotationStrategy?: 'random' | 'round_robin';
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 */
export async function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number): Promise<RouteResult> {
  // Trigger async DB refresh (fire-and-forget, won't block)
  throttledRefresh().catch(() => {});

  const db = getDb();

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled, m.platform
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

  const recentLatencies = db.prepare(`
    SELECT platform, AVG(latency_ms) AS avg_latency_ms, COUNT(*) AS samples
    FROM requests
    WHERE status = 'success'
      AND latency_ms > 0
      AND created_at >= datetime('now', '-24 hours')
    GROUP BY platform
  `).all() as ProviderLatencyRow[];
  const latencyByPlatform = new Map(recentLatencies.map(row => [row.platform, row.avg_latency_ms]));

  // Apply dynamic penalties and recent provider latency.
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
    avgLatencyMs: latencyByPlatform.get(entry.platform),
  })).sort((a, b) => {
    const aLatency = a.avgLatencyMs;
    const bLatency = b.avgLatencyMs;
    const aHasLatency = typeof aLatency === 'number';
    const bHasLatency = typeof bLatency === 'number';
    if (aHasLatency && bHasLatency && aLatency !== bLatency) {
      return aLatency - bLatency;
    }
    if (aHasLatency !== bHasLatency) return aHasLatency ? -1 : 1;
    return a.effectivePriority - b.effectivePriority;
  });

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;

    // Get model details
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    // Get all healthy, enabled keys for this platform
    const keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(model.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) continue;

    // Special handling for Anthropic: register all keys for random rotation (9router-style)
    if (model.platform === 'anthropic' && provider.platform === 'anthropic') {
      const allDecryptedKeys = keys.map(k => decrypt(k.encrypted_key, k.iv, k.auth_tag));
      (provider as any).registerKeys?.(allDecryptedKeys);
    }

    // Get limits once for this model
    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    // Try all keys for this model before giving up on it
    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    // Check if this is a random-rotation alias
    const aliasInfo = resolveModelAlias(model.model_id);
    const useRandomRotation = aliasInfo?.isAlias && aliasInfo.rotationStrategy === 'random';

    // Select key based on rotation strategy
    let selectedKey: KeyRow;
    if (useRandomRotation && keys.length > 1) {
      // Random rotation (9router-style) for aliases
      const randomIdx = Math.floor(Math.random() * keys.length);
      selectedKey = keys[randomIdx];
    } else {
      // Round-robin for normal models
      selectedKey = keys[idx % keys.length];
      idx++;
    }

    const skipId = `${model.platform}:${model.model_id}:${selectedKey.id}`;
    if (skipKeys?.has(skipId)) continue;

    // Check cooldown (from previous 429s)
    if (isOnCooldown(model.platform, model.model_id, selectedKey.id)) continue;

    if (!canMakeRequest(model.platform, model.model_id, selectedKey.id, limits)) continue;
    if (!canUseTokens(model.platform, model.model_id, selectedKey.id, estimatedTokens, limits)) continue;

    // We found a working key for this model!
    roundRobinIndex.set(rrKey, idx);
    const decryptedKey = decrypt(selectedKey.encrypted_key, selectedKey.iv, selectedKey.auth_tag);

    return {
      provider,
      modelId: model.model_id,
      modelDbId: model.id,
      apiKey: decryptedKey,
      keyId: selectedKey.id,
      platform: model.platform,
      displayName: model.display_name,
      isAlias: aliasInfo?.isAlias ?? false,
      rotationStrategy: aliasInfo?.rotationStrategy,
    };
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}
