import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { appSettings } from '../db/schema';

const router = Router();

// GET /settings — returns [{key, hasValue, value?}]
// value is included for non-sensitive keys (ai_provider, ai_model); omitted for ai_key
router.get('/', async (_req, res) => {
  try {
    const rows = await db.select().from(appSettings);
    res.json(rows.map(r => ({
      key:      r.key,
      hasValue: r.value.length > 0,
      ...(r.key !== 'ai_key' ? { value: r.value } : {}),
    })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /settings/:key — upsert a setting value
router.put('/:key', async (req, res) => {
  const { value } = req.body as { value?: string };
  if (typeof value !== 'string') { res.status(400).json({ error: 'value (string) required' }); return; }
  try {
    await db
      .insert(appSettings)
      .values({ key: req.params.key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } });
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
