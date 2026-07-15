import { allowMethods, chargeTokens, cleanText, db, handleError, json, MARKUP, requireUser, TOKEN_USD } from './_lib.js';

let imageModelCache = { at: 0, model: null };
async function getImageModel() {
  if (imageModelCache.model && Date.now() - imageModelCache.at < 3600000) return imageModelCache.model;
  const r = await fetch('https://openrouter.ai/api/v1/images/models', { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
  if (!r.ok) throw new Error('IMAGE_MODEL_UNAVAILABLE');
  const p = await r.json();
  const models = (p.data || []).filter(m => m.architecture?.output_modalities?.includes('image'));
  const preferred = models.find(m => /gpt-image/i.test(m.id)) || models.find(m => /gemini.*image/i.test(m.id)) || models[0];
  if (!preferred) throw new Error('IMAGE_MODEL_UNAVAILABLE');
  imageModelCache = { at: Date.now(), model: preferred };
  return preferred;
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const user = await requireUser(req);
    const { conversationId, prompt, referenceImage } = req.body || {};
    if (!conversationId || !cleanText(prompt, 4000)) return json(res, 400, { error: 'اكتب وصف الصورة' });
    const supabase = db();
    const { data: profile, error: pe } = await supabase.from('users').select('ai_tokens,has_purchased').eq('id', user.id).single();
    if (pe) throw pe;
    if (!profile?.has_purchased) throw new Error('MODEL_LOCKED');
    const model = await getImageModel();
    const body = { model: model.id, prompt: cleanText(prompt, 4000), n: 1, resolution: '512', aspect_ratio: '1:1', quality: 'low', output_format: 'jpeg', output_compression: 65 };
    if (typeof referenceImage === 'string' && referenceImage.startsWith('data:image/')) body.input_references = [{ type: 'image_url', image_url: { url: referenceImage } }];
    const r = await fetch('https://openrouter.ai/api/v1/images', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'AiWay' }, body: JSON.stringify(body) });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(payload?.error?.message || 'IMAGE_GENERATION_FAILED');
    const item = payload.data?.[0];
    if (!item?.b64_json) throw new Error('IMAGE_GENERATION_FAILED');
    const mediaType = item.media_type || 'image/jpeg';
    const thumbnailData = `data:${mediaType};base64,${item.b64_json}`;
    const providerUsd = Number(payload.usage?.cost || 0.04);
    const chargedTokens = Math.max(1, Math.ceil((providerUsd * MARKUP) / TOKEN_USD));
    const { error: ce } = await supabase.rpc('consume_ai_tokens', { p_user_id: user.id, p_amount: chargedTokens });
    if (ce) throw new Error('INSUFFICIENT_TOKENS');
    const { error: ue } = await supabase.from('messages').insert({ conversation_id: conversationId, user_id: user.id, role: 'user', content: cleanText(prompt, 4000), token_usage: { image_request: true, reference_image: Boolean(referenceImage) } });
    if (ue) throw ue;
    const { data: message, error: me } = await supabase.from('messages').insert({ conversation_id: conversationId, user_id: user.id, role: 'assistant', content: 'تم إنشاء الصورة المطلوبة.', model_id: model.id, token_usage: { ...payload.usage, chargedTokens, type: 'image' } }).select('id').single();
    if (me) throw me;
    const { data: image, error: ie } = await supabase.from('generated_images').insert({ message_id: message.id, conversation_id: conversationId, user_id: user.id, model_id: model.id, prompt: cleanText(prompt, 4000), media_type: mediaType, thumbnail_data: thumbnailData, width: 512, height: 512, token_usage: { ...payload.usage, chargedTokens } }).select('*').single();
    if (ie) throw ie;
    await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId).eq('user_id', user.id);
    return json(res, 200, { image, chargedTokens });
  } catch (e) { return handleError(e, res, 'تعذر إنشاء الصورة'); }
}
