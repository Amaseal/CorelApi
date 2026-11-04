import { sql } from 'drizzle-orm';
import { db } from '../db';
import { appSettings } from '../db/schema';
import { AiError } from './gemini';

export interface AiSettings { provider: string; key: string; model: string; validated: string }
function settings(rows: { key: string; value: string }[]): AiSettings {
  const values = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { provider: values.ai_provider || '', key: values.ai_key || '', model: values.ai_model || '', validated: values.ai_model_validated || '' };
}
export async function readAiSettings(): Promise<AiSettings> { return settings(await db.select().from(appSettings)); }
export function publicAiSettings(config: AiSettings) {
  const keyConfigured = config.provider === 'gemini' && !!config.key;
  return { keyConfigured, modelId: config.provider === 'gemini' ? config.model : '',
    ready: keyConfigured && !!config.model && config.validated === config.model,
    migrationRequired: config.provider !== 'gemini' && !!(config.provider || config.key || config.model) };
}
export function requireGeminiKey(config: AiSettings): string {
  if (config.provider !== 'gemini' || !config.key) throw new AiError(409, 'Save a Gemini API key in Settings first. Other providers are no longer supported.');
  return config.key;
}
export async function saveGeminiKey(key: string): Promise<void> {
  await db.transaction(async tx => {
    const current = settings(await tx.select().from(appSettings).for('update'));
    await tx.insert(appSettings).values([
      { key: 'ai_provider', value: 'gemini' }, { key: 'ai_key', value: key },
      { key: 'ai_model', value: current.provider === 'gemini' ? current.model : '' },
      { key: 'ai_model_validated', value: '' },
    ]).onConflictDoUpdate({ target: appSettings.key, set: { value: sql`excluded.value` } });
  });
}
export async function saveGeminiModel(model: string, testedKey: string): Promise<void> {
  await db.transaction(async tx => {
    const current = settings(await tx.select().from(appSettings).for('update'));
    if (current.provider !== 'gemini' || current.key !== testedKey)
      throw new AiError(409, 'The Gemini key changed during testing. Refresh settings and test again.');
    await tx.insert(appSettings).values([
      { key: 'ai_model', value: model }, { key: 'ai_model_validated', value: model },
    ]).onConflictDoUpdate({ target: appSettings.key, set: { value: sql`excluded.value` } });
  });
}
