import { Router, Response } from 'express';
import { AiError, listGeminiModels, requireModelId, testGeminiModel } from '../ai/gemini';
import { publicAiSettings, readAiSettings, requireGeminiKey, saveGeminiKey, saveGeminiModel } from '../ai/settings';

const router = Router();
function fail(res: Response, error: unknown) {
  res.status(error instanceof AiError ? error.status : 500).json({ error: error instanceof AiError ? error.message : 'Gemini settings request failed.' });
}
router.get('/', async (_req, res) => {
  try { res.json(publicAiSettings(await readAiSettings())); } catch (error) { fail(res, error); }
});
router.get('/models', async (_req, res) => {
  try { res.json(await listGeminiModels(requireGeminiKey(await readAiSettings()))); } catch (error) { fail(res, error); }
});
router.put('/key', async (req, res) => {
  const key: unknown = req.body?.key;
  if (typeof key !== 'string' || !key.trim() || key.length > 512 || /\s/.test(key.trim())) {
    res.status(400).json({ error: 'A valid Gemini API key is required.' }); return;
  }
  try {
    await listGeminiModels(key.trim()); // Verify discovery access without making paid generation calls.
    await saveGeminiKey(key.trim());
    res.sendStatus(204);
  } catch (error) { fail(res, error); }
});
// Explicit user action: this compatibility test makes a small billable generation request.
router.put('/model', async (req, res) => {
  try {
    const model = requireModelId(req.body?.modelId);
    const key = requireGeminiKey(await readAiSettings());
    await testGeminiModel(key, model);
    await saveGeminiModel(model, key);
    res.sendStatus(204);
  } catch (error) { fail(res, error); }
});
export default router;
