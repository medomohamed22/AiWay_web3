import { allowMethods, chargeTokens, cleanText, db, handleError, json, requireUser } from './_lib.js';

function safeFilename(value, extension) {
  const base = String(value || `AiWay-${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'AiWay-image';
  return `${base.replace(/\.(png|jpe?g|webp)$/i, '')}.${extension}`;
}

async function downloadImage(req, res) {
  const token = String(req.body?.token || '');
  const imageId = String(req.body?.imageId || '');
  if (!imageId) throw new Error('UNAUTHORIZED');

  const originalAuthorization = req.headers.authorization;
  if (token) req.headers.authorization = `Bearer ${token}`;
  const user = await requireUser(req);
  req.headers.authorization = originalAuthorization;

  const { data: image, error } = await db()
    .from('generated_images')
    .select('id,media_type,thumbnail_data,storage_path,created_at')
    .eq('id', imageId)
    .eq('user_id', user.id)
    .single();
  if (error || !image) throw new Error('IMAGE_NOT_FOUND');

  let file;
  let mediaType = String(image.media_type || 'image/jpeg').toLowerCase();
  if (image.storage_path) {
    const { data, error: storageError } = await db().storage.from('generated-images').download(image.storage_path);
    if (storageError || !data) throw new Error('IMAGE_NOT_FOUND');
    file = Buffer.from(await data.arrayBuffer());
    mediaType = String(data.type || mediaType);
  } else {
    const match = String(image.thumbnail_data || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) throw new Error('IMAGE_NOT_FOUND');
    mediaType = String(image.media_type || match[1] || 'image/jpeg').toLowerCase();
    file = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  }
  const extension = mediaType.includes('png') ? 'png' : mediaType.includes('webp') ? 'webp' : 'jpg';
  const filename = safeFilename(`AiWay-${image.id}`, extension);

  res.status(200);
  res.setHeader('Content-Type', mediaType);
  res.setHeader('Content-Length', String(file.length));
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(file);
}



async function persistImage(req, res) {
  const user = await requireUser(req);
  const imageId = String(req.body?.imageId || '');
  const imageData = String(req.body?.imageData || '');
  if (!imageId || !imageData) return json(res, 400, { error: 'Image data required' });

  const match = imageData.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return json(res, 400, { error: 'Invalid image data' });
  const mediaType = String(match[1] || 'image/jpeg').toLowerCase();
  const extension = mediaType.includes('png') ? 'png' : mediaType.includes('webp') ? 'webp' : 'jpg';
  const file = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!file.length || file.length > 25 * 1024 * 1024) return json(res, 413, { error: 'Image is too large' });

  const supabase = db();
  const { data: image, error } = await supabase.from('generated_images')
    .select('id,user_id,storage_path')
    .eq('id', imageId).eq('user_id', user.id).single();
  if (error || !image) throw new Error('IMAGE_NOT_FOUND');
  if (image.storage_path) return json(res, 200, { saved: true, storagePath: image.storage_path });

  const storagePath = `${user.id}/${imageId}.${extension}`;
  const { error: uploadError } = await supabase.storage.from('generated-images').upload(storagePath, file, {
    contentType: mediaType,
    cacheControl: '31536000',
    upsert: false
  });
  if (uploadError && !/already exists|duplicate/i.test(String(uploadError.message || ''))) throw uploadError;

  const { error: updateError } = await supabase.from('generated_images').update({
    storage_path: storagePath,
    storage_status: 'ready',
    file_size: file.length,
    stored_at: new Date().toISOString(),
    thumbnail_data: null
  }).eq('id', imageId).eq('user_id', user.id);
  if (updateError) throw updateError;
  return json(res, 200, { saved: true, storagePath });
}

let imageModelCache = { at: 0, model: null };
async function getImageModel(requestedModelId = '') {
  if (!requestedModelId && imageModelCache.model && Date.now() - imageModelCache.at < 3600000) return imageModelCache.model;
  const r = await fetch('https://openrouter.ai/api/v1/images/models', { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
  if (!r.ok) throw new Error('IMAGE_MODEL_UNAVAILABLE');
  const p = await r.json();
  const models = (p.data || []).filter(m => m.architecture?.output_modalities?.includes('image'));
  const requested = requestedModelId ? models.find(m => m.id === requestedModelId) : null;
  if (requestedModelId && !requested) throw new Error('IMAGE_MODEL_UNAVAILABLE');
  const preferred = requested || models.find(m => /gpt-image/i.test(m.id)) || models.find(m => /gemini.*image/i.test(m.id)) || models[0];
  if (!preferred) throw new Error('IMAGE_MODEL_UNAVAILABLE');
  if (!requestedModelId) imageModelCache = { at: Date.now(), model: preferred };
  return preferred;
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    if (req.body?.action === 'download') return await downloadImage(req, res);
    if (req.body?.action === 'persist') return await persistImage(req, res);
    const user = await requireUser(req);
    const { conversationId, prompt, referenceImage, modelId, aspectRatio = '1:1' } = req.body || {};
    const allowedRatios = new Set(['1:1','16:9','9:16','4:3','3:4','3:2','2:3']);
    const safeAspectRatio = allowedRatios.has(aspectRatio) ? aspectRatio : '1:1';
    if (!conversationId || !cleanText(prompt, 4000)) return json(res, 400, { error: 'اكتب وصف الصورة' });
    const supabase = db();
    const { data: profile, error: pe } = await supabase.from('users').select('ai_tokens,has_purchased').eq('id', user.id).single();
    if (pe) throw pe;
    if (!profile?.has_purchased) throw new Error('MODEL_LOCKED');
    const model = await getImageModel(cleanText(modelId, 160));
    const body = { model: model.id, prompt: cleanText(prompt, 4000), n: 1, resolution: '512', aspect_ratio: safeAspectRatio, quality: 'low', output_format: 'jpeg', output_compression: 65 };
    if (typeof referenceImage === 'string' && referenceImage.startsWith('data:image/')) body.input_references = [{ type: 'image_url', image_url: { url: referenceImage } }];
    const r = await fetch('https://openrouter.ai/api/v1/images', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'AiWay' }, body: JSON.stringify(body) });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(payload?.error?.message || 'IMAGE_GENERATION_FAILED');
    const item = payload.data?.[0];
    if (!item?.b64_json) throw new Error('IMAGE_GENERATION_FAILED');
    const mediaType = item.media_type || 'image/jpeg';
    const thumbnailData = `data:${mediaType};base64,${item.b64_json}`;
    const imageUsage = payload.usage?.cost ? payload.usage : { ...(payload.usage || {}), cost: 0.04 };
    const charge = chargeTokens({}, imageUsage, false);
    const { providerUsd, chargedTokens } = charge;
    const { error: ce } = await supabase.rpc('consume_ai_tokens', { p_user_id: user.id, p_amount: chargedTokens });
    if (ce) throw new Error('INSUFFICIENT_TOKENS');
    const { error: ue } = await supabase.from('messages').insert({ conversation_id: conversationId, user_id: user.id, role: 'user', content: cleanText(prompt, 4000), token_usage: { image_request: true, reference_image: Boolean(referenceImage) } });
    if (ue) throw ue;
    const { data: message, error: me } = await supabase.from('messages').insert({ conversation_id: conversationId, user_id: user.id, role: 'assistant', content: 'تم إنشاء الصورة المطلوبة.', model_id: model.id, token_usage: { ...payload.usage, ...charge, type: 'image' } }).select('id').single();
    if (me) throw me;
    const { data: image, error: ie } = await supabase.from('generated_images').insert({ message_id: message.id, conversation_id: conversationId, user_id: user.id, model_id: model.id, prompt: cleanText(prompt, 4000), media_type: mediaType, thumbnail_data: thumbnailData, storage_status: 'pending', width: safeAspectRatio === '9:16' ? 512 : safeAspectRatio === '3:4' ? 768 : safeAspectRatio === '2:3' ? 768 : safeAspectRatio === '16:9' ? 1024 : safeAspectRatio === '4:3' ? 1024 : safeAspectRatio === '3:2' ? 1024 : 512, height: safeAspectRatio === '16:9' ? 576 : safeAspectRatio === '4:3' ? 768 : safeAspectRatio === '3:2' ? 683 : safeAspectRatio === '9:16' ? 910 : safeAspectRatio === '3:4' ? 1024 : safeAspectRatio === '2:3' ? 1152 : 512, token_usage: { ...payload.usage, ...charge, aspectRatio: safeAspectRatio } }).select('*').single();
    if (ie) throw ie;
    await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId).eq('user_id', user.id);
    return json(res, 200, { image, chargedTokens });
  } catch (e) {
    if (e.message === 'IMAGE_NOT_FOUND') {
      res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Image not found');
    }
    return handleError(e, res, req.body?.action === 'download' ? 'تعذر تنزيل الصورة' : 'تعذر إنشاء الصورة');
  }
}
