import { Router } from 'express';
import { AiError } from '../ai/gemini';
import { inspectPart, validateInspection } from '../ai/inspection';
import { publicAiSettings, readAiSettings } from '../ai/settings';

const router = Router();
router.post('/inspect', async (req, res) => {
  try {
    const input = validateInspection(req.body);
    const config = await readAiSettings();
    if (!publicAiSettings(config).ready) throw new AiError(503, 'Configure Gemini in Settings and use Test & save first.');
    if (input.modelId !== config.model) throw new AiError(409, 'The selected model changed. Refresh the review settings and confirm again.');
    res.json(await inspectPart(config.key, input));
  } catch (error) {
    res.status(error instanceof AiError ? error.status : 500).json({ error: error instanceof AiError ? error.message : 'Visual review unavailable. Generated artwork is unchanged.' });
  }
});
export default router;
