import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { db } from '../db';
import { requireApiKey } from '../middleware/auth';
import settingsRouter from '../routes/settings';
import ordersRouter from '../routes/orders';
import { generateOrders, listGeminiModels, parseOrderRows, requireModelId, testGeminiModel } from './gemini';

const realFetch = globalThis.fetch;
const originalApiKey = process.env.API_KEY;
afterEach(() => { mock.restoreAll(); if (originalApiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = originalApiKey; });
const model = (id: string, methods = ['generateContent']) => ({ name: 'models/' + id, displayName: id, description: 'Model description', supportedGenerationMethods: methods });
const order = { raw: 'test', name: 'TEST', size: 'XL', number: '007' };
const generated = (rows: unknown = [order]) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(rows) }] } }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function pdf(text: string): string {
  const stream = text ? `BT /F1 12 Tf 30 100 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(data.length); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = data.length;
  data += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(data + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`, 'ascii').toString('base64');
}

test('discovery paginates, filters specializations, deduplicates and keeps future IDs', async () => {
  const requests: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url));
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'secret');
    assert.ok(!String(url).includes('secret'));
    return requests.length === 1 ? json({ models: [model('gemini-future-flash'), model('gemini-future-tts'), model('gemini-future-image'),
      model('gemini-future-native-audio'), model('gemini-future-live'), model('gemini-embedding', ['embedContent']), model('gemma-3')], nextPageToken: 'next & page' })
      : json({ models: [model('gemini-future-pro'), model('gemini-future-flash')] });
  });
  assert.deepEqual((await listGeminiModels('secret')).map(m => m.id), ['gemini-future-flash', 'gemini-future-pro']);
  assert.equal(new URL(requests[1]).searchParams.get('pageToken'), 'next & page');
});

test('discovery rejects malformed pagination and never exposes upstream secrets', async () => {
  mock.method(globalThis, 'fetch', async () => json({ models: [], nextPageToken: 'same' }));
  await assert.rejects(listGeminiModels('secret'), /pagination/);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => json({ error: 'secret key and customer data' }, 403));
  await assert.rejects(listGeminiModels('secret'), error => String(error).includes('HTTP 403') && !String(error).includes('secret key'));
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => { throw new Error('secret'); });
  await assert.rejects(listGeminiModels('secret'), error => String(error).includes('unreachable') && !String(error).includes('secret'));
});

test('selected-model test requires discovery, image acceptance and complete string JSON output', async () => {
  let generations = 0;
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('generateContent')) {
      generations++;
      const body = JSON.parse(init?.body as string);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.equal(body.generationConfig.responseSchema.items.properties.number.type, 'STRING');
      assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png');
      const bytes = Buffer.from(body.contents[0].parts[1].inlineData.data, 'base64');
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      return json(generated());
    }
    return json({ models: [model('gemini-future-flash')] });
  });
  await testGeminiModel('secret', 'gemini-future-flash');
  assert.equal(generations, 1);
  await assert.rejects(testGeminiModel('secret', 'gemini-retired'), /no longer available/);
  assert.equal(generations, 1);
  assert.throws(() => requireModelId('../escape'), /Select a Gemini/);
  assert.throws(() => requireModelId('gemini-future-image'), /Select a Gemini/);
});

test('order responses preserve zeros/Unicode and reject partial, blocked, truncated or malformed results', async () => {
  assert.equal(parseOrderRows(JSON.stringify([{ ...order, name: 'Āboliņa' }]))[0].number, '007');
  assert.equal(parseOrderRows(JSON.stringify([{ ...order, number: 7 }]))[0].number, '7');
  for (const value of ['{}', '[null]', JSON.stringify([order, { ...order, size: {} }]), JSON.stringify([{ ...order, number: 1.5 }])])
    assert.throws(() => parseOrderRows(value));
  mock.method(globalThis, 'fetch', async () => json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '[{}]' }] } }] }));
  await assert.rejects(generateOrders('secret', 'gemini-future-flash', 'orders'), /did not complete/);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => json({ candidates: [] }));
  await assert.rejects(generateOrders('secret', 'gemini-future-flash', 'orders'), /no order content/);
});

// Exercise the real authenticated routers against an in-memory settings table, not a live DB.
async function withApi(initial: Record<string, string>, action: (request: (path: string, body?: unknown, authorized?: boolean) => Promise<Response>, values: Map<string, string>) => Promise<void>) {
  const values = new Map(Object.entries(initial));
  const rows = () => [...values].map(([key, value]) => ({ key, value }));
  mock.method(db, 'select', () => ({ from: () => Promise.resolve(rows()) }) as never);
  mock.method(db, 'transaction', (async (callback: (tx: unknown) => Promise<unknown>) => callback({
    select: () => ({ from: () => ({ for: async () => rows() }) }),
    insert: () => ({ values: (changes: { key: string; value: string }[]) => ({ onConflictDoUpdate: async () => {
      for (const change of changes) values.set(change.key, change.value);
    } }) }),
  })) as never);
  process.env.API_KEY = 'local-test-auth';
  const app = express(); app.use(express.json()); app.use(requireApiKey);
  app.use('/settings', settingsRouter); app.use('/orders', ordersRouter);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    await action((path, body, authorized = true) => realFetch(`http://127.0.0.1:${address.port}${path}`, {
      method: body === undefined ? 'GET' : path === '/orders/parse' ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json', ...(authorized ? { 'X-Api-Key': 'local-test-auth' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), values);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('real settings routes safely migrate, explicitly test/save, preserve failed selections and protect secrets', async () => {
  let googleCalls = 0;
  let lastPrompt = '';
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    googleCalls++;
    assert.ok(String(url).startsWith('https://generativelanguage.googleapis.com/'));
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'new-secret');
    if (String(url).includes(':generateContent')) {
      lastPrompt = JSON.parse(init?.body as string).contents[0].parts[0].text;
      return json(generated(String(url).includes('gemini-future-pro') ? [{ ...order, number: 'bad' }] : [order]));
    }
    return json({ models: [model('gemini-future-flash'), model('gemini-future-pro')] });
  });
  await withApi({ ai_provider: 'openai', ai_key: 'old-provider-secret', ai_model: 'old-model' }, async (request, values) => {
    assert.equal((await request('/settings/ai/models', undefined, false)).status, 401);
    assert.equal((await request('/settings/ai/models')).status, 409);
    assert.equal(googleCalls, 0, 'Must not send another provider\'s key to Google');
    assert.equal((await request('/settings/ai_key', { value: 'bypass' })).status, 400);
    assert.equal((await request('/settings/ai/key', { key: 'new-secret' })).status, 204);
    assert.equal(values.get('ai_provider'), 'gemini'); assert.equal(values.get('ai_model'), '');
    assert.equal(googleCalls, 1, 'Key save must only discover, not generate');
    assert.equal((await request('/settings/ai')).status, 200);
    assert.deepEqual(await (await request('/settings/ai')).json(), { keyConfigured: true, modelId: '', ready: false, migrationRequired: false });
    assert.ok(!(await (await request('/settings')).text()).includes('new-secret'));
    assert.equal((await request('/orders/parse', { ext: 'txt', text: 'John,XL,007' })).status, 503);
    assert.equal((await request('/settings/ai/model', { modelId: 'gemini-future-flash' })).status, 204);
    assert.equal(values.get('ai_model_validated'), 'gemini-future-flash');
    assert.equal((await request('/settings/ai/model', { modelId: 'gemini-future-pro' })).status, 400);
    assert.equal(values.get('ai_model'), 'gemini-future-flash', 'Failed test must not overwrite saved model');
    const parsed = await request('/orders/parse', { ext: 'txt', text: 'John,XL,007' });
    assert.equal(parsed.status, 200);
    const parsedRows = await parsed.json() as { number: number; numberText: string }[];
    assert.equal(parsedRows[0].numberText, '007'); assert.equal(parsedRows[0].number, 7);
    assert.equal((await request('/orders/parse', { ext: 'pdf', imageBase64: pdf('John XL 007') })).status, 200);
    assert.ok(lastPrompt.includes('John XL 007'));
    const count = googleCalls;
    assert.equal((await request('/orders/parse', { ext: 'pdf', imageBase64: pdf('') })).status, 400);
    assert.equal((await request('/orders/parse', { ext: {}, text: 'x' })).status, 400);
    assert.equal((await request('/orders/parse', { ext: 'png', imageBase64: 'not base64' })).status, 400);
    assert.equal(googleCalls, count);
    assert.equal((await request('/settings/ai/key', { key: 'new-secret' })).status, 204);
    assert.equal(values.get('ai_model'), 'gemini-future-flash', 'Key refresh preserves selection, not validation');
    assert.equal(values.get('ai_model_validated'), '');
  });
});

test('model save detects a key changed during the paid test', async () => {
  await withApi({ ai_provider: 'gemini', ai_key: 'first-secret', ai_model: 'gemini-old', ai_model_validated: 'gemini-old' }, async (request, values) => {
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      if (String(url).includes(':generateContent')) { values.set('ai_key', 'rotated-secret'); values.set('ai_model_validated', ''); return json(generated()); }
      return json({ models: [model('gemini-future-flash')] });
    });
    assert.equal((await request('/settings/ai/model', { modelId: 'gemini-future-flash' })).status, 409);
    assert.equal(values.get('ai_model'), 'gemini-old'); assert.equal(values.get('ai_model_validated'), '');
  });
});
