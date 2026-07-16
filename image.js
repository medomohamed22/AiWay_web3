import { allowMethods, chargeTokens, cleanText, db, handleError, json, requireUser } from './_lib.js';

function safeFilename(value, extension) {
  const base = String(value || `AiWay-${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'AiWay-image';
  return `${base.replace(/\.(png|jpe?g|webp)$/i, '')}.${extension}`;
}

async function downloadImage(req, res) {
  const token = String(req.body?.token || req.query?.token || '');
  const imageId = String(req.body?.imageId || req.query?.imageId || '');
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


function estimateImageCharge(model, resolution = '', hasReferenceImage = false) {
  const pricing = model?.pricing || {};
  const numeric = key => {
    const value = Number(pricing?.[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  // Prefer the fixed per-request price exposed by OpenRouter. Some image-model
  // records expose a per-image value instead, so use it as a secondary signal.
  let providerUsd = numeric('request') || numeric('image') || numeric('image_output');

  // Safe fallback when the catalog does not expose a fixed image price.
  // Higher resolutions are intentionally estimated more conservatively so an
  // expensive request is rejected before the provider is called.
  if (!providerUsd) {
    const normalized = String(resolution || '').toUpperCase();
    providerUsd = normalized === '4K' ? 0.16 : normalized === '2K' ? 0.08 : 0.04;
  }

  // Reference-image jobs can cost more on some providers. Keep a small buffer,
  // and also add a general 15% guard against routing/provider price variation.
  if (hasReferenceImage) providerUsd *= 1.15;
  providerUsd *= 1.15;

  return {
    providerUsd,
    chargedTokens: Math.max(1, Math.ceil(providerUsd / 0.00001))
  };
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
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  try {
    const action = String(req.body?.action || req.query?.action || '');
    if (action === 'download') return await downloadImage(req, res);
    if (req.method === 'GET') return json(res, 400, { error: 'Invalid image action' });
    if (action === 'persist') return await persistImage(req, res);
    const user = await requireUser(req);
    const { conversationId, prompt, referenceImage, modelId, aspectRatio = '1:1', resolution = '', locale = 'ar' } = req.body || {};
    const uiLocale = String(locale).toLowerCase().startsWith('en') ? 'en' : 'ar';
    const requestedAspectRatio = cleanText(aspectRatio, 20);
    if (!conversationId || !cleanText(prompt, 4000)) return json(res, 400, { error: uiLocale === 'ar' ? 'اكتب وصف الصورة.' : 'Enter an image description.' });
    const supabase = db();
    const { data: profile, error: pe } = await supabase.from('users').select('ai_tokens,has_purchased').eq('id', user.id).single();
    if (pe) throw pe;
    if (!profile?.has_purchased) throw new Error('MODEL_LOCKED');
    const model = await getImageModel(cleanText(modelId, 160));
    const supported = model.supported_parameters || {};
    const enumValues = descriptor => Array.isArray(descriptor)
      ? descriptor.map(String)
      : descriptor?.type === 'enum' && Array.isArray(descriptor.values)
        ? descriptor.values.map(String)
        : [];
    const supports = key => Object.prototype.hasOwnProperty.call(supported, key);
    const chooseEnum = (key, requested, preferred = []) => {
      const values = enumValues(supported[key]);
      if (!values.length) return null;
      const exact = values.find(value => value.toLowerCase() === String(requested || '').toLowerCase());
      if (exact) return exact;
      for (const wanted of preferred) {
        const match = values.find(value => value.toLowerCase() === wanted.toLowerCase());
        if (match) return match;
      }
      return values[0];
    };

    // Only send parameters advertised by the selected image model. OpenRouter's
    // image providers reject unknown or unsupported fields instead of ignoring them.
    const body = { model: model.id, prompt: cleanText(prompt, 4000) };
    const selectedResolution = chooseEnum('resolution', resolution, ['1K', '1024x1024']);
    const selectedAspectRatio = chooseEnum('aspect_ratio', requestedAspectRatio, ['1:1']);
    if (selectedResolution) body.resolution = selectedResolution;
    if (selectedAspectRatio) body.aspect_ratio = selectedAspectRatio;
    if (supports('n')) body.n = 1;

    const hasReferenceImage = typeof referenceImage === 'string' && referenceImage.startsWith('data:image/');
    if (hasReferenceImage) {
      const acceptsImageInput = model.architecture?.input_modalities?.includes('image');
      if (!acceptsImageInput) return json(res, 400, { error: 'هذا النموذج لا يدعم صورة مرجعية. اختر نموذجًا يدعم إدخال الصور.' });
      body.input_references = [{ type: 'image_url', image_url: { url: referenceImage } }];
    }

    // Reject expensive requests before contacting OpenRouter. This prevents the
    // provider cost from being incurred when the user's AiWay balance cannot
    // cover the selected model/resolution.
    const estimatedCharge = estimateImageCharge(model, selectedResolution, hasReferenceImage);
    const availableTokens = Math.max(0, Number(profile?.ai_tokens || 0));
    if (availableTokens < estimatedCharge.chargedTokens) {
      return json(res, 402, {
        error: 'رصيدك لا يكفي لتنفيذ هذا الطلب. اشحن رصيدًا إضافيًا ثم حاول مرة أخرى.',
        code: 'INSUFFICIENT_TOKENS',
        availableTokens,
        estimatedTokens: estimatedCharge.chargedTokens
      });
    }

    const r = await fetch('https://openrouter.ai/api/v1/images', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'AiWay' }, body: JSON.stringify(body) });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) {
      const providerMessage = String(payload?.error?.message || '');
      // OpenRouter account credit is an infrastructure issue, not an AiWay user-token issue.
      // Keep the provider details in server logs, but return a safe, actionable app message.
      if (r.status === 402 || /insufficient credits|add more.*credits/i.test(providerMessage)) {
        // Return a controlled JSON response instead of throwing. Throwing here makes
        // Vercel print a full stack trace even though this is an expected provider-state error.
        console.warn('OpenRouter image credits unavailable:', providerMessage || `HTTP ${r.status}`);
        return json(res, 503, {
          error: uiLocale === 'ar'
            ? 'رصيد خدمة إنشاء الصور غير كافٍ حاليًا. اشحن رصيدًا إضافيًا ثم حاول مرة أخرى.'
            : 'The image provider balance is currently insufficient. Add more provider balance and try again.',
          code: 'OPENROUTER_CREDITS_EXHAUSTED'
        });
      }
      console.error('OpenRouter image generation failed:', r.status, providerMessage || payload);
      throw new Error(providerMessage || 'IMAGE_GENERATION_FAILED');
    }
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
    const { data: image, error: ie } = await supabase.from('generated_images').insert({ message_id: message.id, conversation_id: conversationId, user_id: user.id, model_id: model.id, prompt: cleanText(prompt, 4000), media_type: mediaType, thumbnail_data: thumbnailData, storage_status: 'pending', width: Number(item.width) || null, height: Number(item.height) || null, token_usage: { ...payload.usage, ...charge, aspectRatio: selectedAspectRatio || null, resolution: selectedResolution || null } }).select('*').single();
    if (ie) throw ie;
    await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId).eq('user_id', user.id);
    return json(res, 200, { image, chargedTokens });
  } catch (e) {
    if (e.message === 'IMAGE_NOT_FOUND') {
      res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Image not found');
    }
    const action = String(req.body?.action || req.query?.action || '');
    const errorLocale = String(req.body?.locale || req.query?.locale || 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar';
    const fallback = action === 'download'
      ? (errorLocale === 'ar' ? 'تعذر تنزيل الصورة.' : 'Could not download the image.')
      : (errorLocale === 'ar' ? 'تعذر إنشاء الصورة.' : 'Could not generate the image.');
    return handleError(e, res, fallback, errorLocale);
  }
}
