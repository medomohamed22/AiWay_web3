import { allowMethods, db, getAvailableModels, getTrialModelId, json, MARKUP, PACKAGES, packageQuote, requireUser, TOKEN_USD } from './_lib.js';

const IMAGE_PROVIDER_ORDER = ['openai', 'google', 'bytedance-seed', 'black-forest-labs', 'stability-ai', 'recraft', 'ideogram'];
const IMAGE_PROVIDER_LABELS = {
  openai: 'OpenAI · GPT Image',
  google: 'Google · Gemini / Imagen',
  'bytedance-seed': 'ByteDance · Seedream',
  'black-forest-labs': 'Black Forest Labs · FLUX',
  'stability-ai': 'Stability AI',
  recraft: 'Recraft',
  ideogram: 'Ideogram'
};
let imageCatalogCache = { at: 0, models: [] };

function imageProvider(id = '') {
  const prefix = String(id).split('/')[0].toLowerCase();
  if (prefix === 'openai') return 'openai';
  if (prefix === 'google') return 'google';
  if (['bytedance-seed', 'bytedance'].includes(prefix) || /seedream/i.test(id)) return 'bytedance-seed';
  if (['black-forest-labs', 'black-forest'].includes(prefix) || /flux/i.test(id)) return 'black-forest-labs';
  if (prefix.includes('stability')) return 'stability-ai';
  if (prefix === 'recraft') return 'recraft';
  if (prefix === 'ideogram') return 'ideogram';
  return prefix || 'other';
}

function shortImageName(model) {
  return String(model.name || model.id || '')
    .replace(/^(OpenAI|Google|ByteDance|Black Forest Labs|Stability AI|Recraft|Ideogram)[:\\s-]+/i, '')
    .replace(/\\s+(Preview|Experimental)$/i, '')
    .trim();
}

async function getImageModels() {
  if (imageCatalogCache.models.length && Date.now() - imageCatalogCache.at < 60 * 60 * 1000) return imageCatalogCache.models;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/images/models', {
      headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}
    });
    if (!r.ok) throw new Error(`OpenRouter image models ${r.status}`);
    const payload = await r.json();
    const groups = new Map();
    for (const model of payload.data || []) {
      if (!model?.id || !model.architecture?.output_modalities?.includes('image')) continue;
      const provider = imageProvider(model.id);
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(model);
    }
    const providers = [...IMAGE_PROVIDER_ORDER, ...[...groups.keys()].filter(x => !IMAGE_PROVIDER_ORDER.includes(x)).sort()];
    const selected = [];
    const selectedIds = new Set();
    const addModel = (model, provider) => {
      if (!model?.id || selectedIds.has(model.id)) return;
      selectedIds.add(model.id);
      selected.push({
        id: model.id,
        name: model.name || model.id,
        shortName: shortImageName(model),
        type: 'image',
        provider,
        providerLabel: IMAGE_PROVIDER_LABELS[provider] || provider,
        created: Number(model.created || 0),
        description: model.description || '',
        supportedAspectRatios: model.supported_parameters?.aspect_ratio || null
      });
    };

    for (const provider of providers) {
      const providerModels = (groups.get(provider) || [])
        .sort((a, b) => Number(b.created || 0) - Number(a.created || 0) || String(a.name || a.id).localeCompare(String(b.name || b.id)));

      // Keep the newest three Seedream image models explicitly in the image list.
      // This prevents them from being displaced by other ByteDance image models.
      if (provider === 'bytedance-seed') {
        providerModels.filter(model => /seedream/i.test(`${model.id} ${model.name || ''}`)).slice(0, 3)
          .forEach(model => addModel(model, provider));
        providerModels.filter(model => !/seedream/i.test(`${model.id} ${model.name || ''}`)).slice(0, 3)
          .forEach(model => addModel(model, provider));
        continue;
      }

      providerModels.slice(0, 3).forEach(model => addModel(model, provider));
    }
    imageCatalogCache = { at: Date.now(), models: selected };
    return selected;
  } catch (error) {
    console.warn('Unable to load image model catalog:', error.message);
    return imageCatalogCache.models;
  }
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    let unlocked = false;
    try {
      const user = await requireUser(req);
      const { data } = await db().from('users').select('has_purchased').eq('id', user.id).single();
      unlocked = Boolean(data?.has_purchased);
    } catch {}

    const [catalog, imageCatalog, trialModelId] = await Promise.all([getAvailableModels(), getImageModels(), getTrialModelId()]);
    const models = catalog.map(model => ({
      id: model.id,
      name: model.name,
      family: model.family,
      familyLabel: model.familyLabel,
      tag: model.tag,
      description: model.description,
      contextLength: model.contextLength,
      created: model.created,
      type: 'chat',
      shortName: model.name,
      provider: model.family,
      providerLabel: model.familyLabel,
      locked: !unlocked && model.id !== trialModelId,
      trial: model.id === trialModelId
    }));

    const packages = {};
    try {
      for (const id of Object.keys(PACKAGES)) packages[id] = await packageQuote(id);
    } catch {
      for (const [id, pack] of Object.entries(PACKAGES)) packages[id] = { ...pack, amountPi: null };
    }

    return json(res, 200, {
      name: 'AiWay',
      models,
      trialModelId,
      packages,
      imageModels: imageCatalog.map(model => ({ ...model, locked: !unlocked })),
      tokenUsd: TOKEN_USD,
      refreshedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'Unable to load pricing' });
  }
}
