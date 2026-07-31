import { Router } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
import { db } from '../db';
import { appSettings } from '../db/schema';

const router = Router();

// ── Prompt ────────────────────────────────────────────────────────────────────

const PARSE_PROMPT = `You are extracting a jersey/garment order list from the input.
Return ONLY a valid JSON array — no markdown, no explanation, no code fences.
Each element must have exactly these fields:
  "raw":    the original text found for this entry (string)
  "name":   player full name (string or null)
  "size":   size exactly as it appears — adult (S, M, L, XL, XXL, 2XL, 3XL),
            youth (YXS, YS, YM, YL, YXL), height in cm (110, 134, 152 etc.),
            or any other format the customer used; preserve as-is (string or null)
  "number": jersey number (integer or null)`;

// ── Provider config ───────────────────────────────────────────────────────────

interface ProviderConfig {
  endpoint:       string;
  defaultModel:   string;
  supportsVision: boolean;
  format:         'openai' | 'gemini' | 'anthropic';
}

const PROVIDERS: Record<string, ProviderConfig> = {
  openai:    { endpoint: 'https://api.openai.com/v1/chat/completions',      defaultModel: 'gpt-4o',                format: 'openai',    supportsVision: true  },
  gemini:    { endpoint: '',                                                  defaultModel: 'gemini-2.5-flash',       format: 'gemini',    supportsVision: true  },
  anthropic: { endpoint: 'https://api.anthropic.com/v1/messages',           defaultModel: 'claude-opus-4-8',        format: 'anthropic', supportsVision: true  },
  deepseek:  { endpoint: 'https://api.deepseek.com/chat/completions',       defaultModel: 'deepseek-chat',          format: 'openai',    supportsVision: false },
  kimi:      { endpoint: 'https://api.moonshot.cn/v1/chat/completions',     defaultModel: 'moonshot-v1-8k-vision',  format: 'openai',    supportsVision: true  },
  mistral:   { endpoint: 'https://api.mistral.ai/v1/chat/completions',      defaultModel: 'pixtral-large-latest',   format: 'openai',    supportsVision: true  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSettingsMap(): Promise<Record<string, string>> {
  const rows = await db.select().from(appSettings);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function mimeForExt(ext: string): string {
  return ext === 'png' ? 'image/png' : 'image/jpeg';
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

// ── Provider adapters ─────────────────────────────────────────────────────────

async function callOpenAiCompatible(
  endpoint: string, key: string, model: string,
  prompt: string, imageBase64?: string, mime?: string,
): Promise<string> {
  const userContent: unknown = imageBase64
    ? [{ type: 'text', text: prompt },
       { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }]
    : prompt;

  const resp = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body:    JSON.stringify({ model, messages: [{ role: 'user', content: userContent }], max_tokens: 4096 }),
  });
  if (!resp.ok) throw new Error(`${model} error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json() as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content;
}

async function callGemini(
  key: string, model: string,
  prompt: string, imageBase64?: string, mime?: string,
): Promise<string> {
  const parts: unknown[] = [{ text: prompt }];
  if (imageBase64) parts.push({ inlineData: { mimeType: mime, data: imageBase64 } });

  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ contents: [{ parts }] }),
  });
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  return data.candidates[0].content.parts[0].text;
}

async function callAnthropic(
  key: string, model: string,
  prompt: string, imageBase64?: string, mime?: string,
): Promise<string> {
  const content: unknown[] = [{ type: 'text', text: prompt }];
  if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json() as { content: { text: string }[] };
  return data.content[0].text;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/parse', async (req, res) => {
  const { ext, text, imageBase64 } = req.body as {
    ext?:         string;
    text?:        string;
    imageBase64?: string;
  };

  if (!ext)              { res.status(400).json({ error: 'ext required' }); return; }
  if (!text && !imageBase64) { res.status(400).json({ error: 'text or imageBase64 required' }); return; }

  try {
    const settings = await getSettingsMap();
    const provider = settings['ai_provider'] || 'openai';
    const key      = settings['ai_key'];
    if (!key) {
      res.status(503).json({ error: 'AI key not configured. Add one in the Settings tab.' });
      return;
    }
    const pCfg = PROVIDERS[provider];
    if (!pCfg) { res.status(400).json({ error: `Unknown provider: ${provider}` }); return; }
    const model = (settings['ai_model'] || '').trim() || pCfg.defaultModel;

    const extLower = ext.toLowerCase();
    let finalPrompt = PARSE_PROMPT;
    let finalImage: string | undefined;
    let mime: string | undefined;

    if (extLower === 'pdf') {
      // Extract text from PDF — handles text-based PDFs; scanned PDFs will return empty text
      if (!imageBase64) { res.status(400).json({ error: 'PDF requires imageBase64 (file bytes)' }); return; }
      const buf       = Buffer.from(imageBase64, 'base64');
      const pdfResult = await pdfParse(buf);
      if (!pdfResult.text?.trim()) {
        res.status(400).json({
          error: 'This PDF appears to be a scanned image with no extractable text. ' +
                 'Export it as a PNG or JPG and try again.',
        });
        return;
      }
      finalPrompt = PARSE_PROMPT + '\n\n' + pdfResult.text;
    } else if (extLower === 'png' || extLower === 'jpg' || extLower === 'jpeg') {
      if (!pCfg.supportsVision) {
        res.status(400).json({
          error: `${provider} does not support image input. ` +
                 'Switch to OpenAI, Gemini, Anthropic, Kimi, or Mistral.',
        });
        return;
      }
      mime        = mimeForExt(extLower);
      finalImage  = imageBase64;
    } else {
      // Text-based (txt, csv, xlsx content already extracted by plugin)
      finalPrompt = PARSE_PROMPT + '\n\n' + (text || '');
    }

    // Call the active provider
    let rawResponse: string;
    if (pCfg.format === 'gemini') {
      rawResponse = await callGemini(key, model, finalPrompt, finalImage, mime);
    } else if (pCfg.format === 'anthropic') {
      rawResponse = await callAnthropic(key, model, finalPrompt, finalImage, mime);
    } else {
      rawResponse = await callOpenAiCompatible(pCfg.endpoint, key, model, finalPrompt, finalImage, mime);
    }

    // Parse the JSON the AI returned
    const jsonStr = extractJson(rawResponse);
    let rows: unknown[];
    try {
      rows = JSON.parse(jsonStr);
    } catch {
      res.status(502).json({ error: 'AI returned invalid JSON. Response: ' + rawResponse.slice(0, 200) });
      return;
    }
    if (!Array.isArray(rows)) { res.status(502).json({ error: 'AI returned non-array JSON.' }); return; }

    const result = (rows as Record<string, unknown>[]).map(r => ({
      raw:    (r['raw']    as string  | null) ?? null,
      name:   (r['name']   as string  | null) ?? null,
      size:   (r['size']   as string  | null) ?? null,
      number: typeof r['number'] === 'number' ? r['number'] : null,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
