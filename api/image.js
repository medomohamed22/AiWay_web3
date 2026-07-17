import { allowMethods, appError, chargeTokens, classifyTokenChargeFailure, cleanText, db, errorDetails, fetchWithTimeout, handleError, isLowBalance, json, localize, openRouterError, requestLocale, requireUser, ensureConversationOwner, normalizeRequestId, reserveAiTokens, finalizeAiTokens, releaseAiTokens, claimFreeDailyUse } from './_lib.js';

function safeFilename(value, extension) {
  const base = String(value || `AiWay-${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'AiWay-image';
  return `${base.replace(/\.(png|jpe?g|webp)$/i, '')}.${extension}`;
}

async function downloadImage(req, res) {
  const imageId = String(req.body?.imageId || req.query?.imageId || '');
  if (!imageId) throw new Error('UNAUTHORIZED');

  const user = await requireUser(req);

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
  if (!imageId || !imageData) throw appError('INVALID_IMAGE_REQUEST');

  const match = imageData.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw appError('INVALID_IMAGE_REQUEST');
  const mediaType = String(match[1] || 'image/jpeg').toLowerCase();
  const extension = mediaType.includes('png') ? 'png' : mediaType.includes('webp') ? 'webp' : 'jpg';
  const file = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!file.length || file.length > 25 * 1024 * 1024) throw appError('ATTACHMENT_TOO_LARGE');

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
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/images/models', {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
  }, 20000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw openRouterError(response.status, payload, { kind: 'image' });
  const models = (payload.data || []).filter(model => model.architecture?.output_modalities?.includes('image'));
  const requested = requestedModelId ? models.find(model => model.id === requestedModelId) : null;
  if (requestedModelId && !requested) throw appError('IMAGE_MODEL_UNAVAILABLE');
  const preferred = requested || models.find(model => /gpt-image/i.test(model.id)) || models.find(model => /gemini.*image/i.test(model.id)) || models[0];
  if (!preferred) throw appError('IMAGE_MODEL_UNAVAILABLE');
  if (!requestedModelId) imageModelCache = { at: Date.now(), model: preferred };
  return preferred;
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  const uiLocale = requestLocale(req);
  let reservationUserId=null,reservationRequestId=null,reservationSupabase=null,reservationActive=false;
  try {
    const action = String(req.body?.action || req.query?.action || '');
    if (action === 'download') return await downloadImage(req, res);
    if (req.method === 'GET') throw appError('INVALID_IMAGE_REQUEST');
    if (action === 'persist') return await persistImage(req, res);

    const user = await requireUser(req);
    const { conversationId, prompt, referenceImage, modelId, aspectRatio = '1:1', resolution = '', requestId: rawRequestId } = req.body || {};
    const requestId=normalizeRequestId(rawRequestId); reservationUserId=user.id; reservationRequestId=requestId;
    const cleanPrompt = cleanText(prompt, 4000);
    const requestedAspectRatio = cleanText(aspectRatio, 20);
    if (!conversationId || !cleanPrompt) throw appError('INVALID_IMAGE_REQUEST');

    const supabase = db(); reservationSupabase=supabase;
    await ensureConversationOwner(supabase, conversationId, user.id);
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('ai_tokens,has_purchased')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) throw appError('DATABASE_ERROR', {}, profileError);
    // Free image endpoints remain available before purchase, subject to a strict daily limit.

    const availableTokens = Math.max(0, Number(profile.ai_tokens || 0));
    if (availableTokens < 1) throw appError('INSUFFICIENT_TOKENS', { availableTokens });
    if (!process.env.OPENROUTER_API_KEY) throw appError('MISSING_CONFIGURATION');
    const model = await getImageModel(cleanText(modelId, 160));
    const freeImageModel = String(model.id || '').endsWith(':free') || /grok-imagine-image-quality:free/i.test(model.id);
    if (!profile.has_purchased && !freeImageModel) throw appError('MODEL_LOCKED');
    if (freeImageModel) await claimFreeDailyUse(supabase, user.id, 'image');
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

    const body = { model: model.id, prompt: cleanPrompt };
    const selectedResolution = chooseEnum('resolution', resolution, ['1K', '1024x1024']);
    const selectedAspectRatio = chooseEnum('aspect_ratio', requestedAspectRatio, ['1:1']);
    if (selectedResolution) body.resolution = selectedResolution;
    if (selectedAspectRatio) body.aspect_ratio = selectedAspectRatio;
    if (supports('n')) body.n = 1;

    const hasReferenceImage = typeof referenceImage === 'string' && referenceImage.startsWith('data:image/');
    if (referenceImage && !hasReferenceImage) throw appError('INVALID_ATTACHMENT');
    if (hasReferenceImage && referenceImage.length > 4_300_000) throw appError('ATTACHMENT_TOO_LARGE');
    if (hasReferenceImage) {
      const acceptsImageInput = model.architecture?.input_modalities?.includes('image');
      if (!acceptsImageInput) throw appError('REFERENCE_IMAGE_UNSUPPORTED');
      body.input_references = [{ type: 'image_url', image_url: { url: referenceImage } }];
    }

    const estimatedCharge = estimateImageCharge(model, selectedResolution, hasReferenceImage);
    if (availableTokens < estimatedCharge.chargedTokens) {
      throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
        availableTokens,
        requiredTokens: estimatedCharge.chargedTokens,
        shortfall: estimatedCharge.chargedTokens - availableTokens
      });
    }

    await reserveAiTokens(supabase,user.id,requestId,'image',availableTokens);
    reservationActive=true;

    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'AiWay',
        'X-OpenRouter-Metadata': 'enabled'
      },
      body: JSON.stringify(body)
    }, 90000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw openRouterError(response.status, payload, { kind: 'image' });

    const item = payload.data?.[0];
    if (!item?.b64_json) throw appError('EMPTY_RESPONSE');
    const mediaType = item.media_type || 'image/jpeg';
    const thumbnailData = `data:${mediaType};base64,${item.b64_json}`;
    const imageUsage = payload.usage?.cost ? payload.usage : { ...(payload.usage || {}), cost: estimatedCharge.providerUsd };
    const charge = chargeTokens({}, imageUsage, false);
    if (charge.chargedTokens > availableTokens) {
      throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
        availableTokens,
        requiredTokens: charge.chargedTokens,
        shortfall: charge.chargedTokens - availableTokens
      });
    }

    let savedUser = null;
    let savedAssistant = null;
    let savedImage = null;
    try {
      const userInsert = await supabase.from('messages').insert({
        conversation_id: conversationId,
        user_id: user.id,
        role: 'user',
        content: cleanPrompt,
        token_usage: { image_request: true, reference_image: hasReferenceImage }
      }).select('id').single();
      if (userInsert.error || !userInsert.data) throw appError('DATABASE_ERROR', {}, userInsert.error);
      savedUser = userInsert.data;

      const assistantInsert = await supabase.from('messages').insert({
        conversation_id: conversationId,
        user_id: user.id,
        role: 'assistant',
        content: localize(uiLocale, 'تم إنشاء الصورة المطلوبة.', 'The requested image has been generated.'),
        model_id: model.id,
        token_usage: { ...payload.usage, ...charge, type: 'image' }
      }).select('id').single();
      if (assistantInsert.error || !assistantInsert.data) throw appError('DATABASE_ERROR', {}, assistantInsert.error);
      savedAssistant = assistantInsert.data;

      const imageInsert = await supabase.from('generated_images').insert({
        message_id: savedAssistant.id,
        conversation_id: conversationId,
        user_id: user.id,
        model_id: model.id,
        prompt: cleanPrompt,
        media_type: mediaType,
        thumbnail_data: thumbnailData,
        storage_status: 'pending',
        width: Number(item.width) || null,
        height: Number(item.height) || null,
        token_usage: {
          ...payload.usage,
          ...charge,
          aspectRatio: selectedAspectRatio || null,
          resolution: selectedResolution || null
        }
      }).select('*').single();
      if (imageInsert.error || !imageInsert.data) throw appError('DATABASE_ERROR', {}, imageInsert.error);
      savedImage = imageInsert.data;
    } catch (saveError) {
      if (savedImage?.id) await supabase.from('generated_images').delete().eq('id', savedImage.id).eq('user_id', user.id);
      if (savedAssistant?.id) await supabase.from('messages').delete().eq('id', savedAssistant.id).eq('user_id', user.id);
      if (savedUser?.id) await supabase.from('messages').delete().eq('id', savedUser.id).eq('user_id', user.id);
      throw saveError;
    }

    const remainingTokens=await finalizeAiTokens(supabase,user.id,requestId,charge.chargedTokens,{imageId:savedImage.id,modelId:model.id});
    reservationActive=false;
    const conversationUpdate = await supabase.from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('user_id', user.id);
    if (conversationUpdate.error) console.warn('Conversation timestamp update failed:', conversationUpdate.error.message);

    return json(res, 200, {
      image: savedImage,
      chargedTokens: charge.chargedTokens,
      providerUsd: charge.providerUsd,
      selectedModelName: model.name || model.id,
      remainingTokens,
      lowBalance: isLowBalance(remainingTokens, charge.chargedTokens)
    });
  } catch (error) {
    if(reservationActive&&reservationSupabase&&reservationUserId&&reservationRequestId){await releaseAiTokens(reservationSupabase,reservationUserId,reservationRequestId,{code:String(error?.code||'SERVER_ERROR')});reservationActive=false;}
    const action = String(req.body?.action || req.query?.action || '');
    if (action === 'download' && error?.message === 'IMAGE_NOT_FOUND') {
      const details = errorDetails(error, uiLocale);
      res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(details?.message || localize(uiLocale, 'الصورة غير موجودة.', 'Image not found.'));
    }
    return handleError(
      error,
      res,
      action === 'download'
        ? localize(uiLocale, 'تعذر تنزيل الصورة. حاول مرة أخرى.', 'Could not download the image. Try again.')
        : localize(uiLocale, 'حدث عطل مؤقت أثناء إنشاء الصورة. حاول مرة أخرى؛ لم يتم خصم رصيدك.', 'A temporary error occurred while generating the image. Try again; your balance was not charged.'),
      uiLocale
    );
  }
}
