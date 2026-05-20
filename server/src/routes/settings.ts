import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, isUnifiedApiKeyPinned, regenerateUnifiedKey } from '../db/index.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey(), pinned: isUnifiedApiKeyPinned() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  if (isUnifiedApiKeyPinned()) {
    res.status(409).json({
      error: { message: 'Unified API key is pinned by environment variable FREEAPI_UNIFIED_API_KEY.' },
    });
    return;
  }

  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey, pinned: false });
});
