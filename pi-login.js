import { allowMethods, db, json, signAppToken } from './_lib.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const accessToken = String(req.body?.accessToken || '').trim();
    if (!accessToken) return json(res, 400, { error: 'رمز دخول Pi غير موجود' });

    const base = String(process.env.PI_API_BASE_URL || 'https://api.minepi.com').replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(`${base}/v2/me`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Pi /v2/me failed', response.status, payload);
      return json(res, 401, { error: 'جلسة Pi غير صالحة. افتح الموقع داخل Pi Browser وسجّل الدخول من جديد.' });
    }

    const piUid = String(payload.uid || req.body?.user?.uid || '').trim();
    const username = String(payload.username || req.body?.user?.username || '').trim();
    if (!piUid || !username) return json(res, 401, { error: 'لم يرسل Pi بيانات المستخدم كاملة' });

    const supabase = db();
    const { data: user, error } = await supabase
      .from('users')
      .upsert({ pi_uid: piUid, username, last_login_at: new Date().toISOString() }, { onConflict: 'pi_uid' })
      .select('id, pi_uid, username, role, ai_tokens, trial_messages_remaining, has_purchased, created_at')
      .single();
    if (error) throw error;

    const token = await signAppToken(user);
    return json(res, 200, { token, user });
  } catch (error) {
    console.error('Pi login error:', error);
    if (error?.name === 'AbortError') return json(res, 504, { error: 'انتهت مهلة الاتصال بخوادم Pi. حاول مرة أخرى.' });
    return json(res, 500, { error: 'تعذر إكمال تسجيل الدخول. راجع إعدادات Pi وSupabase.' });
  }
}
