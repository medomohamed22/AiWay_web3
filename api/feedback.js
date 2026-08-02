import { createClient } from '@supabase/supabase-js';

const allowedChoices = new Set(['all_models', 'simple_tools']);

function json(response, status, payload) {
  response.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  return response.json(payload);
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !secretKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default async function handler(request, response) {
  try {
    const supabase = getSupabase();

    if (request.method === 'POST') {
      const body = request.body && typeof request.body === 'object' ? request.body : {};

      if (body.action === 'translate') {
        const configuredAdminKey = process.env.ADMIN_API_KEY;
        const suppliedAdminKey = request.headers['x-admin-key'];
        if (!configuredAdminKey || suppliedAdminKey !== configuredAdminKey) {
          return json(response, 401, { error: 'Unauthorized' });
        }

        const target = body.target === 'ar' ? 'ar' : null;
        const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
        if (!target || !items.length) {
          return json(response, 400, { error: 'Invalid translation request' });
        }

        const translations = [];
        for (const item of items) {
          const id = String(item?.id || '').slice(0, 100);
          const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 1200) : '';
          if (!id || !text) continue;

          const url = new URL('https://translate.googleapis.com/translate_a/single');
          url.searchParams.set('client', 'gtx');
          url.searchParams.set('sl', 'auto');
          url.searchParams.set('tl', target);
          url.searchParams.set('dt', 't');
          url.searchParams.set('q', text);

          try {
            const translateResponse = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(10000),
            });
            if (!translateResponse.ok) throw new Error('Translation provider failed');
            const translated = await translateResponse.json();
            const translatedText = Array.isArray(translated?.[0])
              ? translated[0].map(part => part?.[0] || '').join('').trim()
              : '';
            translations.push({ id, text: translatedText || text });
          } catch (translationError) {
            console.error('Translation item error:', translationError);
            translations.push({ id, text });
          }
        }

        return json(response, 200, { translations });
      }

      const choice = typeof body.choice === 'string' && allowedChoices.has(body.choice)
        ? body.choice
        : null;
      const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
      const language = typeof body.language === 'string'
        ? body.language.trim().slice(0, 20) || 'en'
        : 'en';

      if (!choice && !idea) {
        return json(response, 400, { error: 'Select an option or write an idea.' });
      }
      if (idea.length > 1200) {
        return json(response, 400, { error: 'The idea is too long.' });
      }

      const { error } = await supabase.from('feedback').insert({
        choice,
        idea: idea || null,
        language,
        user_agent: String(request.headers['user-agent'] || '').slice(0, 500) || null,
      });

      if (error) throw error;
      return json(response, 201, { success: true });
    }

    if (request.method === 'GET') {
      const configuredAdminKey = process.env.ADMIN_API_KEY;
      const suppliedAdminKey = request.headers['x-admin-key'];

      if (!configuredAdminKey || suppliedAdminKey !== configuredAdminKey) {
        return json(response, 401, { error: 'Unauthorized' });
      }

      const { data, error } = await supabase
        .from('feedback')
        .select('id,choice,idea,language,created_at')
        .order('created_at', { ascending: false })
        .limit(5000);

      if (error) throw error;
      return json(response, 200, data || []);
    }

    response.setHeader('Allow', 'GET, POST');
    return json(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Feedback API error:', error);
    return json(response, 500, { error: 'Internal server error' });
  }
}
