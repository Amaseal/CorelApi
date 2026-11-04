export class AiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface GeminiModel { id: string; displayName: string; description: string }
export interface ParsedOrder { raw: string | null; name: string | null; size: string | null; number: string | null }
const API = 'https://generativelanguage.googleapis.com/v1beta/';
const MODEL_ID = /^gemini-[a-z0-9][a-z0-9._-]*$/;
// shortcut: until discovery exposes modality flags, exclude known specializations by name and require an image/JSON test before saving.
const SPECIALIZED = /(?:^|-)(?:embed(?:ding)?|image|tts|audio|live|robotics|computer-use)(?:-|$)/i;

async function request(path: string, key: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new AiError(502, 'Gemini is unreachable or the request timed out. Please retry.');
  }
  if (!response.ok) {
    const advice = response.status === 401 || response.status === 403 ? 'Check the Gemini key, project permissions and billing.'
      : response.status === 429 ? 'Quota or rate limit reached; check your Gemini project.'
      : response.status === 404 ? 'The selected model is unavailable. Refresh models and choose another.'
      : 'The model may not support this image/JSON request. Choose another model or retry.';
    // Never relay upstream bodies: they may contain keys or order data.
    throw new AiError(502, `Gemini request failed (HTTP ${response.status}). ${advice}`);
  }
  try { return await response.json(); }
  catch { throw new AiError(502, 'Gemini returned an invalid response.'); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiError(502, 'Gemini returned an invalid response.');
  return value as Record<string, unknown>;
}

export async function listGeminiModels(key: string): Promise<GeminiModel[]> {
  const models = new Map<string, GeminiModel>();
  const tokens = new Set<string>();
  const signal = AbortSignal.timeout(20000);
  let token = '';
  do {
    const query = new URLSearchParams({ pageSize: '1000', ...(token ? { pageToken: token } : {}) });
    const data = object(await request('models?' + query, key, signal));
    if (!Array.isArray(data.models)) throw new AiError(502, 'Gemini returned an invalid model list.');
    for (const value of data.models) {
      const model = object(value);
      if (typeof model.name !== 'string' || !model.name.startsWith('models/')) continue;
      const id = model.name.slice(7);
      if (!MODEL_ID.test(id) || SPECIALIZED.test(id) || !Array.isArray(model.supportedGenerationMethods)
          || !model.supportedGenerationMethods.includes('generateContent')) continue;
      models.set(id, { id, displayName: typeof model.displayName === 'string' ? model.displayName.slice(0, 128) : id,
        description: typeof model.description === 'string' ? model.description.slice(0, 2000) : '' });
    }
    if (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 4096))
      throw new AiError(502, 'Gemini returned an invalid model page token.');
    token = (data.nextPageToken as string) || '';
    if (token && (tokens.has(token) || tokens.size >= 100)) throw new AiError(502, 'Gemini model pagination did not complete.');
    if (token) tokens.add(token);
  } while (token);
  return [...models.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
}

export function requireModelId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !MODEL_ID.test(value) || SPECIALIZED.test(value))
    throw new AiError(400, 'Select a Gemini order-parsing model from Refresh models.');
  return value;
}

const ORDER_SCHEMA = {
  type: 'ARRAY', items: { type: 'OBJECT', required: ['raw', 'name', 'size', 'number'],
    properties: Object.fromEntries(['raw', 'name', 'size', 'number'].map(field => [field, { type: 'STRING', nullable: true }])) },
};

export function parseOrderRows(text: string): ParsedOrder[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new AiError(502, 'Gemini returned invalid order JSON. No rows were imported.'); }
  if (!Array.isArray(data) || data.length > 10000) throw new AiError(502, 'Gemini returned an invalid order array.');
  return data.map(value => {
    const row = object(value);
    const result: ParsedOrder = { raw: null, name: null, size: null, number: null };
    for (const [field, limit] of [['raw', 10000], ['name', 1000], ['size', 100], ['number', 100]] as const) {
      let item = row[field];
      if (field === 'number' && typeof item === 'number' && Number.isSafeInteger(item)) item = String(item);
      if (item !== null && (typeof item !== 'string' || item.length > limit))
        throw new AiError(502, `Gemini returned an invalid ${field} field. No rows were imported.`);
      result[field] = item as string | null;
    }
    return result;
  });
}

export async function generateOrders(key: string, model: string, prompt: string, imageBase64?: string, mime?: string): Promise<ParsedOrder[]> {
  requireModelId(model);
  const parts: unknown[] = [{ text: prompt }];
  if (imageBase64) parts.push({ inlineData: { mimeType: mime, data: imageBase64 } });
  return parseOrderRows(await generateStructured(key, model, parts, ORDER_SCHEMA, 'order'));
}

export async function generateStructured(key: string, model: string, parts: unknown[], schema: unknown, context: string, timeout = 60000): Promise<string> {
  requireModelId(model);
  const data = object(await request(`models/${model}:generateContent`, key, AbortSignal.timeout(timeout), {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 8192 },
  }));
  const candidates = data.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) throw new AiError(502, `Gemini returned no ${context} content (possibly blocked).`);
  const candidate = object(candidates[0]);
  if (candidate.finishReason !== 'STOP') throw new AiError(502, `Gemini did not complete the ${context} response. No result was accepted.`);
  const content = object(candidate.content);
  if (!Array.isArray(content.parts)) throw new AiError(502, 'Gemini returned no text content.');
  const text = content.parts.map(object).filter(p => p.thought !== true && typeof p.text === 'string').map(p => p.text).join('');
  return text;
}

export async function testGeminiModel(key: string, model: string): Promise<void> {
  if (!(await listGeminiModels(key)).some(m => m.id === requireModelId(model)))
    throw new AiError(400, 'This model is no longer available. Refresh models and select another.');
  // A tiny blank image tests accepted image input, not OCR accuracy on real orders.
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAXklEQVR4nO3PMQ0AMAzAsPInvYLYYVWKESTzjhsd8KsBrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BbQHKU9LC7/CP1AAAAABJRU5ErkJggg==';
  const rows = await generateOrders(key, model,
    'Compatibility test: the supplied image is a blank test image. Return exactly one order with raw="test", name="TEST", size="XL", number="007". Preserve the leading zeros.', image, 'image/png');
  if (rows.length !== 1 || rows[0].raw !== 'test' || rows[0].name !== 'TEST' || rows[0].size !== 'XL' || rows[0].number !== '007')
    throw new AiError(400, 'The selected model failed the image/JSON compatibility test. Select another model or retry.');
}
