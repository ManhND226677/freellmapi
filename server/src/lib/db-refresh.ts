import { refreshDbFromPersistentSnapshot } from '../db/index.js';

const REFRESH_DEBOUNCE_MS = 500;

let lastStartedAt = 0;
let pendingRefresh: Promise<boolean> | null = null;

export function throttledRefresh(): Promise<boolean> {
  const now = Date.now();
  if (pendingRefresh) return pendingRefresh;
  if (now - lastStartedAt < REFRESH_DEBOUNCE_MS) return Promise.resolve(false);

  lastStartedAt = now;
  pendingRefresh = refreshDbFromPersistentSnapshot()
    .finally(() => {
      pendingRefresh = null;
    });
  return pendingRefresh;
}
