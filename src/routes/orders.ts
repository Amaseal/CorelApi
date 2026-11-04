import { Router } from 'express';
import { PDFParse } from 'pdf-parse';
import { AiError, generateOrders } from '../ai/gemini';
import { publicAiSettings, readAiSettings } from '../ai/settings';

const router = Router();
const PARSE_PROMPT = `Extract a jersey/garment order list. Return a JSON array with raw, name, size and number fields.
Use the original text for raw; preserve player names and size labels exactly. Missing fields are null.
Number must be a string, preserving leading zeros such as "007". Do not invent missing information.`;

router.post('/parse', async (req, res) => {
  const { ext, text, imageBase64 } = req.body ?? {};
  if (typeof ext !== 'string' || !['txt', 'csv', 'tsv', 'xlsx', 'docx', 'png', 'jpg', 'jpeg', 'pdf'].includes(ext.toLowerCase())
      || (text !== undefined && typeof text !== 'string') || (imageBase64 !== undefined && typeof imageBase64 !== 'string')
      || (!text && !imageBase64)) {
    res.status(400).json({ error: 'Provide a supported ext and text or imageBase64 strings.' }); return;
  }
  try {
    const config = await readAiSettings();
    if (!publicAiSettings(config).ready) throw new AiError(503, 'Configure Gemini in Settings: save a Gemini key, then select a model and use Test & save.');
    const extension = ext.toLowerCase();
    let prompt = PARSE_PROMPT;
    let image: string | undefined;
    let mime: string | undefined;
    if (extension === 'pdf' || ['png', 'jpg', 'jpeg'].includes(extension)) {
      if (!imageBase64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64))
        throw new AiError(400, 'This file requires valid base64 image/PDF bytes.');
      if (extension === 'pdf') {
        const parser = new PDFParse({ data: Buffer.from(imageBase64, 'base64') });
        try {
          const result = await parser.getText({ pageJoiner: '\n' });
          if (!result.text?.trim()) throw new AiError(400, 'This PDF has no extractable text. Export scanned pages as PNG/JPG and try again.');
          prompt += '\n\n' + result.text;
        } finally { await parser.destroy(); }
      } else {
        image = imageBase64;
        mime = extension === 'png' ? 'image/png' : 'image/jpeg';
      }
    } else {
      if (!text?.trim()) throw new AiError(400, 'Text input is required for this file type.');
      prompt += '\n\n' + text;
    }
    const rows = await generateOrders(config.key, config.model, prompt, image, mime);
    res.json(rows.map(row => {
      const number = row.number?.trim() ?? '';
      return { ...row, numberText: row.number,
        number: /^-?\d+$/.test(number) && Number.isSafeInteger(Number(number)) ? Number(number) : null };
    })); // Keep the legacy integer field for older clients; updated clients use exact numberText.
  } catch (error) {
    res.status(error instanceof AiError ? error.status : 500)
      .json({ error: error instanceof AiError ? error.message : 'Order parsing failed. Check the input file and retry.' });
  }
});
export default router;
