import { allowMethods, appError, db, handleError, json, localize, piApiError, requestLocale, signAppToken, requestIp, enforceRateLimit } from './_lib.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  const locale = requestLocale(req);
  try {
    const limiterDb=db(); await enforceRateLimit(limiterDb,`login:${requestIp(req)}`,10,60);
    const accessToken = String(req.body?.accessToken || '').trim();
    if (!accessToken) return json(res, 400, {
      error: localize(locale, 'رمز تسجيل الدخول من Pi غير موجود. أعد فتح الموقع داخل Pi Browser وحاول مرة أخرى.', 'The Pi sign-in token is missing. Reopen the site in Pi Browser and try again.'),
      code: 'PI_LOGIN_FAILED'
    });

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
      throw piApiError(response.status, payload, { operation: 'login' });
    }

    const piUid = String(payload.uid || req.body?.user?.uid || '').trim();
    const username = String(payload.username || req.body?.user?.username || '').trim();
    if (!piUid || !username) return json(res, 401, {
      error: localize(locale, 'لم ترسل Pi بيانات الحساب كاملة. سجّل الخروج من Pi Browser ثم سجّل الدخول مرة أخرى.', 'Pi did not return complete account details. Sign out of Pi Browser, then sign in again.'),
      code: 'PI_LOGIN_FAILED'
    });

    const supabase = db();
    const { data: user, error } = await supabase
      .from('users')
      .upsert({ pi_uid: piUid, username, last_login_at: new Date().toISOString() }, { onConflict: 'pi_uid' })
      .select('id, pi_uid, username, role, ai_tokens, trial_messages_remaining, has_purchased, created_at')
      .single();
    if (error || !user) throw appError('DATABASE_ERROR', {}, error);

    const token = await signAppToken(user);
    return json(res, 200, { token, user });
  } catch (error) {
    if (error?.name === 'AbortError') return handleError(appError('REQUEST_TIMEOUT', {}, error), res, localize(locale, 'انتهت مهلة تسجيل الدخول. حاول مرة أخرى.', 'Sign-in timed out. Try again.'), locale);
    return handleError(
      error,
      res,
      localize(locale, 'تعذر إكمال تسجيل الدخول حاليًا. حاول مرة أخرى بعد قليل.', 'Could not complete sign-in right now. Try again shortly.'),
      locale
    );
  }
}
