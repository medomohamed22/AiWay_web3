import { allowMethods, db, getAvailableModels, getTrialModelId, json, MARKUP, PACKAGES, packageQuote, requireUser, TOKEN_USD } from './_lib.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    let unlocked = false;
    try {
      const user = await requireUser(req);
      const { data } = await db().from('users').select('has_purchased').eq('id', user.id).single();
      unlocked = Boolean(data?.has_purchased);
    } catch {}

    const [catalog, trialModelId] = await Promise.all([getAvailableModels(), getTrialModelId()]);
    const models = catalog.map(model => ({
      id: model.id,
      name: model.name,
      family: model.family,
      familyLabel: model.familyLabel,
      tag: model.tag,
      description: model.description,
      contextLength: model.contextLength,
      created: model.created,
      locked: !unlocked && model.id !== trialModelId,
      trial: model.id === trialModelId,
      pricing: {
        inputPerMillion: Math.round(model.pricing.prompt * 1e6 * MARKUP / TOKEN_USD),
        outputPerMillion: Math.round(model.pricing.completion * 1e6 * MARKUP / TOKEN_USD)
      }
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
      tokenUsd: TOKEN_USD,
      refreshedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'Unable to load pricing' });
  }
}
