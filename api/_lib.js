import { createClient } from '@supabase/supabase-js';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const jwtSecret = process.env.APP_JWT_SECRET;

export function requireEnv() {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!jwtSecret || jwtSecret.length < 32) missing.push('APP_JWT_SECRET');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

export function db() {
  requireEnv();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(body));
}

export function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  json(res, 405, { error: 'Method not allowed' });
  return false;
}

export async function signAppToken(user) {
  requireEnv();
  return new SignJWT({ username: user.username, pi_uid: user.pi_uid, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(jwtSecret));
}

export async function requireUser(req) {
  requireEnv();
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) throw new Error('UNAUTHORIZED');
  const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret));
  if (!payload.sub) throw new Error('UNAUTHORIZED');
  return { id: payload.sub, username: payload.username, pi_uid: payload.pi_uid, role: payload.role || 'user' };
}

export function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new Error('FORBIDDEN');
}


export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [type, salt, hash] = String(stored || '').split(':');
    if (type !== 'scrypt' || !salt || !hash) return false;
    const actual = scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export async function signAdminToken(admin) {
  requireEnv();
  return new SignJWT({ role: 'admin', email: admin.email, admin: true })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(admin.id).setIssuedAt().setExpirationTime('12h')
    .sign(new TextEncoder().encode(jwtSecret));
}

export async function requireAdminToken(req) {
  requireEnv();
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) throw new Error('UNAUTHORIZED');
  const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret));
  if (!payload.sub || payload.role !== 'admin' || !payload.admin) throw new Error('FORBIDDEN');
  return payload;
}

export function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

export function handleError(error, res, fallback = 'Server error') {
  console.error(error);
  const messages = {
    UNAUTHORIZED: [401, 'Sign in with Pi first'],
    INSUFFICIENT_TOKENS: [402, 'رصيد AiWay Tokens غير كافٍ'],
    MODEL_LOCKED: [403, 'هذا النموذج يُفتح بعد أول عملية شراء'],
    MODEL_UNAVAILABLE: [400, 'النموذج لم يعد متاحًا. حدّث قائمة النماذج واختر نموذجًا آخر'],
    TRIAL_WEB_LOCKED: [403, 'بحث الويب يُفتح بعد أول عملية شراء'],
    TRIAL_ENDED: [402, 'انتهت رسائلك التجريبية. اشترِ رصيدًا لفتح جميع النماذج'],
    FORBIDDEN: [403, 'Admin access required']
  };
  if (messages[error.message]) return json(res, ...messages[error.message]);
  return json(res, 500, { error: fallback });
}

export const TOKEN_USD = 0.00001;
export const MARKUP = 1.35;
export const TRIAL_MESSAGE_LIMIT = 5;
export const TRIAL_TOKENS = 1500;
export const TRIAL_MODEL_FALLBACK = 'deepseek/deepseek-chat-v3-0324';
export const PACKAGES = {
  starter: { usd: 1, tokens: 100000 },
  plus: { usd: 5, tokens: 550000 },
  pro: { usd: 10, tokens: 1200000 }
};

const FAMILY_CONFIG = [
  { key: 'chatgpt', label: 'ChatGPT', prefix: 'openai/', tag: 'OpenAI' },
  { key: 'gemini', label: 'Gemini', prefix: 'google/', tag: 'Google' },
  { key: 'deepseek', label: 'DeepSeek', prefix: 'deepseek/', tag: 'DeepSeek' },
  { key: 'claude', label: 'Claude', prefix: 'anthropic/', tag: 'Anthropic' }
];

const FALLBACK_MODELS = [
  { id: 'openai/gpt-4o', name: 'GPT-4o', created: 1715558400, family: 'chatgpt', tag: 'OpenAI', pricing: { prompt: 0.0000025, completion: 0.00001 } },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', created: 1721174400, family: 'chatgpt', tag: 'OpenAI', pricing: { prompt: 0.00000015, completion: 0.0000006 } },
  { id: 'openai/o3-mini', name: 'o3-mini', created: 1738281600, family: 'chatgpt', tag: 'OpenAI', pricing: { prompt: 0.0000011, completion: 0.0000044 } },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', created: 1738540800, family: 'gemini', tag: 'Google', pricing: { prompt: 0.0000001, completion: 0.0000004 } },
  { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', created: 1743379200, family: 'gemini', tag: 'Google', pricing: { prompt: 0.00000125, completion: 0.00001 } },
  { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', created: 1743379201, family: 'gemini', tag: 'Google', pricing: { prompt: 0.0000003, completion: 0.0000025 } },
  { id: TRIAL_MODEL_FALLBACK, name: 'DeepSeek V3', created: 1742774400, family: 'deepseek', tag: 'DeepSeek', pricing: { prompt: 0.00000027, completion: 0.0000011 } },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', created: 1738281600, family: 'deepseek', tag: 'DeepSeek', pricing: { prompt: 0.00000055, completion: 0.00000219 } },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', created: 1733011200, family: 'deepseek', tag: 'DeepSeek', pricing: { prompt: 0.00000027, completion: 0.0000011 } },
  { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', created: 1740355200, family: 'claude', tag: 'Anthropic', pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', created: 1718841600, family: 'claude', tag: 'Anthropic', pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku', created: 1729555200, family: 'claude', tag: 'Anthropic', pricing: { prompt: 0.0000008, completion: 0.000004 } }
];

let catalogCache = { at: 0, models: FALLBACK_MODELS };

function isTextChatModel(model) {
  const id = String(model.id || '').toLowerCase();
  if (!id || id.includes('embedding') || id.includes('moderation') || id.includes('image') || id.includes('audio') || id.includes('tts')) return false;
  const outputs = model.architecture?.output_modalities;
  if (Array.isArray(outputs) && !outputs.includes('text')) return false;
  return true;
}

function normalizeModel(model, family) {
  return {
    id: model.id,
    name: model.name || model.id.split('/').pop(),
    description: model.description || '',
    created: Number(model.created || 0),
    contextLength: Number(model.context_length || 0),
    family: family.key,
    familyLabel: family.label,
    tag: family.tag,
    pricing: {
      prompt: Number(model.pricing?.prompt || 0),
      completion: Number(model.pricing?.completion || 0),
      webSearch: Number(model.pricing?.web_search || 0)
    }
  };
}

export async function getAvailableModels() {
  if (Date.now() - catalogCache.at < 60 * 60 * 1000 && catalogCache.models.length >= 12) return catalogCache.models;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}
    });
    if (!response.ok) throw new Error(`OpenRouter models ${response.status}`);
    const payload = await response.json();
    const selected = [];
    for (const family of FAMILY_CONFIG) {
      const familyModels = (payload.data || [])
        .filter(model => String(model.id || '').startsWith(family.prefix) && isTextChatModel(model))
        .map(model => normalizeModel(model, family))
        .sort((a, b) => b.created - a.created || a.name.localeCompare(b.name))
        .slice(0, 3);
      selected.push(...familyModels);
    }
    if (selected.length < 12) throw new Error('Incomplete OpenRouter catalog');
    catalogCache = { at: Date.now(), models: selected };
    return selected;
  } catch (error) {
    console.warn('Using fallback model catalog:', error.message);
    return catalogCache.models;
  }
}

export async function getTrialModelId() {
  const models = await getAvailableModels();
  const deepSeekV3 = models
    .filter(model => model.family === 'deepseek' && /(?:deepseek[\s_-]*)?v3/i.test(`${model.id} ${model.name}`))
    .sort((a, b) => b.created - a.created)[0];
  return deepSeekV3?.id || models.find(model => model.id === TRIAL_MODEL_FALLBACK)?.id || TRIAL_MODEL_FALLBACK;
}

export async function getModel(modelId) {
  return (await getAvailableModels()).find(model => model.id === modelId) || null;
}

export function chargeTokens(price, usage = {}, webSearch = false) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const reportedCost = Number(usage.cost);
  const fallbackCost = input * Number(price?.prompt || 0) + output * Number(price?.completion || 0) + (webSearch ? Number(price?.webSearch || 0.01) : 0);
  const providerUsd = Number.isFinite(reportedCost) && reportedCost > 0 ? reportedCost : fallbackCost;
  return {
    input,
    output,
    providerUsd,
    markup: MARKUP,
    chargedTokens: Math.max(1, Math.ceil((providerUsd * MARKUP) / TOKEN_USD))
  };
}

export async function getPiUsd() {
  const response = await fetch('https://www.okx.com/api/v5/market/ticker?instId=PI-USDT', { headers: { 'User-Agent': 'AiWay/1.0' } });
  if (!response.ok) throw new Error('OKX_PRICE_UNAVAILABLE');
  const payload = await response.json();
  const price = Number(payload?.data?.[0]?.last);
  if (!price || price <= 0) throw new Error('OKX_PRICE_UNAVAILABLE');
  return price;
}

export async function packageQuote(id) {
  const pack = PACKAGES[id];
  if (!pack) return null;
  const piUsd = await getPiUsd();
  return { ...pack, piUsd, amountPi: Number((pack.usd / piUsd).toFixed(7)), quotedAt: new Date().toISOString() };
}
