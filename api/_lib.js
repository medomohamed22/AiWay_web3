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
  if (missing.length) throw appError('MISSING_CONFIGURATION', { missing });
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
  const locale = requestLocale(req);
  json(res, 405, {
    error: localize(locale, 'طريقة الطلب غير مسموح بها.', 'This request method is not allowed.'),
    code: 'METHOD_NOT_ALLOWED'
  });
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
  if (!token) throw appError('UNAUTHORIZED');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret));
    if (!payload.sub) throw appError('UNAUTHORIZED');
    return { id: payload.sub, username: payload.username, pi_uid: payload.pi_uid, role: payload.role || 'user' };
  } catch (error) {
    if (error?.code === 'UNAUTHORIZED') throw error;
    throw appError('UNAUTHORIZED', {}, error);
  }
}

export async function requireAdmin(user) {
  if (!user?.id) throw appError('FORBIDDEN');
  const { data, error } = await db().from('users').select('role').eq('id', user.id).single();
  if (error || data?.role !== 'admin') throw appError('FORBIDDEN');
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
  if (!token) throw appError('UNAUTHORIZED');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret));
    if (!payload.sub || payload.role !== 'admin' || !payload.admin) throw appError('FORBIDDEN');
    return payload;
  } catch (error) {
    if (error?.code === 'FORBIDDEN') throw error;
    throw appError('UNAUTHORIZED', {}, error);
  }
}


export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) throw appError('REQUEST_TIMEOUT', {}, error);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', abortFromExternal);
  }
}

export function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

export function requestLocale(req) {
  const value = req?.body?.locale || req?.query?.locale || req?.headers?.['x-ui-language'] || req?.headers?.['accept-language'] || 'ar';
  return String(value).toLowerCase().startsWith('en') ? 'en' : 'ar';
}

export function localize(locale, ar, en) {
  return String(locale).toLowerCase().startsWith('en') ? en : ar;
}

export function appError(code, meta = {}, cause = null) {
  const error = new Error(String(code || 'SERVER_ERROR'));
  error.code = String(code || 'SERVER_ERROR');
  error.meta = meta && typeof meta === 'object' ? meta : {};
  if (cause) error.cause = cause;
  return error;
}

function safeInteger(value) {
  const number = Math.max(0, Math.ceil(Number(value) || 0));
  return Number.isFinite(number) ? number : 0;
}

function formatTokens(value, language) {
  return safeInteger(value).toLocaleString(language === 'ar' ? 'ar-EG' : 'en-US');
}

function normalizedErrorCode(error) {
  const raw = String(error?.code || error?.message || error || '').trim();
  if (raw.startsWith('MODEL_ROUTE_MISMATCH:')) return 'MODEL_ROUTE_MISMATCH';
  if (/missing environment variables/i.test(raw)) return 'MISSING_CONFIGURATION';
  if (/aborterror|aborted|timed?\s*out|timeout/i.test(`${error?.name || ''} ${raw}`)) return 'REQUEST_TIMEOUT';
  if (/fetch failed|networkerror|econnreset|econnrefused|enotfound|socket hang up/i.test(raw)) return 'NETWORK_ERROR';
  if (/pgrst|postgres|supabase|relation .* does not exist|database/i.test(raw)) return 'DATABASE_ERROR';
  return raw;
}

export function errorDetails(error, locale = 'ar') {
  const language = String(locale).toLowerCase().startsWith('en') ? 'en' : 'ar';
  const code = normalizedErrorCode(error);
  const meta = error?.meta && typeof error.meta === 'object' ? error.meta : {};
  const available = safeInteger(meta.availableTokens);
  const required = safeInteger(meta.requiredTokens || meta.estimatedTokens);
  const shortfall = safeInteger(meta.shortfall || Math.max(0, required - available));

  const balanceFinished = {
    ar: 'رصيدك انتهى. اشحن رصيدًا جديدًا ثم أعد إرسال الرسالة.',
    en: 'Your balance has run out. Add more balance, then send the message again.'
  };
  const insufficientForRequest = {
    ar: `رصيدك الحالي ${formatTokens(available, language)} توكن، بينما التكلفة التقديرية لهذا الطلب نحو ${formatTokens(required, language)} توكن. اشحن ${formatTokens(shortfall, language)} توكن إضافي على الأقل ثم حاول مرة أخرى.`,
    en: `Your current balance is ${formatTokens(available, language)} tokens, while this request is estimated to need about ${formatTokens(required, language)} tokens. Add at least ${formatTokens(shortfall, language)} more tokens and try again.`
  };

  const messages = {
    METHOD_NOT_ALLOWED: [405, { ar: 'طريقة الطلب غير مسموح بها.', en: 'This request method is not allowed.' }],
    INVALID_REQUEST: [400, { ar: 'بيانات الطلب غير مكتملة أو غير صحيحة. راجع المدخلات وحاول مرة أخرى.', en: 'The request data is incomplete or invalid. Check the inputs and try again.' }],
    INVALID_CHAT_REQUEST: [400, { ar: 'تعذر إرسال الرسالة لأن بيانات المحادثة غير مكتملة. حدّث الصفحة وحاول مرة أخرى.', en: 'The message could not be sent because the chat data is incomplete. Refresh the page and try again.' }],
    INVALID_IMAGE_REQUEST: [400, { ar: 'بيانات طلب الصورة غير مكتملة. اكتب وصفًا واضحًا ثم حاول مرة أخرى.', en: 'The image request is incomplete. Enter a clear description and try again.' }],
    UNAUTHORIZED: [401, { ar: 'انتهت جلسة تسجيل الدخول أو لم تبدأ بعد. سجّل الدخول بحساب Pi ثم حاول مرة أخرى.', en: 'Your sign-in session is missing or expired. Sign in with Pi and try again.' }],
    FORBIDDEN: [403, { ar: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.', en: 'You do not have permission to perform this action.' }],
    INSUFFICIENT_TOKENS: [402, available <= 0 ? balanceFinished : {
      ar: 'رصيدك غير كافٍ لإتمام الطلب. اشحن رصيدًا إضافيًا ثم حاول مرة أخرى.',
      en: 'Your balance is insufficient to complete the request. Add more balance and try again.'
    }],
    INSUFFICIENT_TOKENS_FOR_REQUEST: [402, insufficientForRequest],
    LOW_BALANCE: [200, {
      ar: `رصيدك أوشك على النفاد: متبقٍ ${formatTokens(available, language)} توكن. اشحن رصيدًا لتجنب توقف الرسائل.`,
      en: `Your balance is running low: ${formatTokens(available, language)} tokens remain. Add balance to avoid interruptions.`
    }],
    PROVIDER_CREDITS_EXHAUSTED: [503, {
      ar: 'رصيد مزود الذكاء الاصطناعي انتهى مؤقتًا. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay لإعادة شحن الخدمة.',
      en: 'The AI provider balance is temporarily exhausted. Your balance was not charged; contact AiWay support so the service can be topped up.'
    }],
    OPENROUTER_CREDITS_EXHAUSTED: [503, {
      ar: 'رصيد مزود الذكاء الاصطناعي انتهى مؤقتًا. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay لإعادة شحن الخدمة.',
      en: 'The AI provider balance is temporarily exhausted. Your balance was not charged; contact AiWay support so the service can be topped up.'
    }],
    PROVIDER_AUTH_ERROR: [503, {
      ar: 'إعداد الاتصال بمزود الذكاء الاصطناعي غير صالح حاليًا. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay.',
      en: 'The AI provider connection is not configured correctly right now. Your balance was not charged; contact AiWay support.'
    }],
    PROVIDER_PERMISSION_DENIED: [503, {
      ar: 'مزود الذكاء الاصطناعي رفض تشغيل هذه الخدمة بالحساب الحالي. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay.',
      en: 'The AI provider rejected this service for the current account. Your balance was not charged; contact AiWay support.'
    }],
    RATE_LIMITED: [429, {
      ar: 'هناك ضغط مرتفع أو تم بلوغ حد الطلبات مؤقتًا. انتظر قليلًا ثم حاول مرة أخرى؛ لم يتم خصم رصيدك.',
      en: 'The service is busy or its request limit was reached temporarily. Wait a moment and try again; your balance was not charged.'
    }],
    REQUEST_TIMEOUT: [504, {
      ar: 'استغرق الطلب وقتًا أطول من المسموح. حاول مرة أخرى برسالة أقصر أو اختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The request took too long. Try a shorter message or choose another model; your balance was not charged.'
    }],
    NETWORK_ERROR: [503, {
      ar: 'تعذر الاتصال بالخدمة. تحقق من الإنترنت ثم حاول مرة أخرى؛ لم يتم خصم رصيدك.',
      en: 'Could not connect to the service. Check your internet connection and try again; your balance was not charged.'
    }],
    MODEL_LOCKED: [403, {
      ar: 'هذا النموذج متاح بعد أول عملية شراء. استخدم نموذج التجربة المجانية أو اشحن رصيدًا لفتح جميع النماذج.',
      en: 'This model unlocks after your first purchase. Use the free-trial model or add balance to unlock all models.'
    }],
    MODEL_UNAVAILABLE: [503, {
      ar: 'النموذج المختار غير متاح حاليًا. حدّث قائمة النماذج واختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The selected model is currently unavailable. Refresh the model list and choose another model; your balance was not charged.'
    }],
    IMAGE_MODEL_UNAVAILABLE: [503, {
      ar: 'نموذج الصور المختار غير متاح حاليًا. حدّث قائمة النماذج واختر نموذج صور آخر؛ لم يتم خصم رصيدك.',
      en: 'The selected image model is currently unavailable. Refresh the model list and choose another image model; your balance was not charged.'
    }],
    NO_PROVIDER_AVAILABLE: [503, {
      ar: 'لا يوجد مزود متاح لهذا النموذج حاليًا. اختر نموذجًا آخر أو حاول بعد قليل؛ لم يتم خصم رصيدك.',
      en: 'No provider is currently available for this model. Choose another model or try again shortly; your balance was not charged.'
    }],
    PROVIDER_ERROR: [502, {
      ar: 'حدث عطل مؤقت لدى مزود الذكاء الاصطناعي. حاول مرة أخرى أو اختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The AI provider had a temporary failure. Try again or choose another model; your balance was not charged.'
    }],
    STREAM_INTERRUPTED: [502, {
      ar: 'انقطع الاتصال أثناء كتابة الإجابة. أعد المحاولة؛ لن يُخصم رصيد عن الرد غير المكتمل.',
      en: 'The connection was interrupted while the answer was being written. Try again; an incomplete response will not be charged.'
    }],
    EMPTY_RESPONSE: [502, {
      ar: 'لم يُرجع النموذج إجابة صالحة. حاول مرة أخرى أو اختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The model did not return a valid answer. Try again or choose another model; your balance was not charged.'
    }],
    CONTENT_BLOCKED: [400, {
      ar: 'رفض مزود الذكاء هذا الطلب بسبب سياسات المحتوى. عدّل صياغة الرسالة أو المرفق ثم حاول مرة أخرى؛ لم يتم خصم رصيدك.',
      en: 'The AI provider blocked this request under its content policies. Revise the message or attachment and try again; your balance was not charged.'
    }],
    CONTEXT_TOO_LONG: [413, {
      ar: 'المحادثة أو المرفقات أكبر من سعة النموذج. اختصر الرسالة، ابدأ محادثة جديدة، أو استخدم مرفقًا أصغر.',
      en: 'The conversation or attachments exceed the model capacity. Shorten the message, start a new chat, or use a smaller attachment.'
    }],
    ATTACHMENT_TOO_LARGE: [413, {
      ar: 'حجم المرفق أكبر من المسموح. قلّل الحجم أو أرسل عددًا أقل من الملفات ثم حاول مرة أخرى.',
      en: 'The attachment is larger than allowed. Reduce its size or send fewer files and try again.'
    }],
    INVALID_ATTACHMENT: [400, {
      ar: 'صيغة أحد المرفقات غير مدعومة أو بياناته غير صالحة. احذف المرفق وأعد رفعه بصيغة أخرى.',
      en: 'An attachment has an unsupported format or invalid data. Remove it and upload it again in another format.'
    }],
    REFERENCE_IMAGE_UNSUPPORTED: [400, {
      ar: 'النموذج المختار لا يدعم الصور المرجعية. اختر نموذج صور يدعم إدخال الصور.',
      en: 'The selected model does not support reference images. Choose an image model that accepts image input.'
    }],
    TRIAL_WEB_LOCKED: [403, { ar: 'بحث الويب متاح بعد أول عملية شراء.', en: 'Web search unlocks after your first purchase.' }],
    TRIAL_ENDED: [402, {
      ar: 'انتهت رسائلك التجريبية. اشحن رصيدًا لفتح جميع النماذج ومتابعة الاستخدام.',
      en: 'Your free-trial messages have ended. Add balance to unlock all models and continue.'
    }],
    MODEL_ROUTE_MISMATCH: [502, {
      ar: 'أعاد المزود نموذجًا مختلفًا عن النموذج المختار، لذلك أُوقف الطلب ولم يتم خصم رصيدك.',
      en: 'The provider returned a different model than the one selected, so the request was stopped and your balance was not charged.'
    }],
    FILE_NOT_FOUND: [404, { ar: 'الملف غير موجود أو لم يعد متاحًا.', en: 'The file was not found or is no longer available.' }],
    IMAGE_NOT_FOUND: [404, { ar: 'الصورة غير موجودة أو لم تعد متاحة.', en: 'The image was not found or is no longer available.' }],
    DATABASE_ERROR: [503, {
      ar: 'تعذر حفظ البيانات حاليًا. حاول مرة أخرى بعد قليل؛ لن يتم خصم رصيدك عن طلب لم يُحفظ.',
      en: 'The data could not be saved right now. Try again shortly; a request that was not saved will not be charged.'
    }],
    MISSING_CONFIGURATION: [503, {
      ar: 'إعدادات الخدمة على الخادم غير مكتملة. تواصل مع إدارة AiWay.',
      en: 'The server configuration is incomplete. Contact AiWay support.'
    }],
    OKX_PRICE_UNAVAILABLE: [503, {
      ar: 'تعذر جلب سعر Pi حاليًا. انتظر قليلًا ثم أعد فتح نافذة الشحن.',
      en: 'The Pi price is currently unavailable. Wait a moment, then reopen the top-up window.'
    }],
    PAYMENT_INVALID: [400, { ar: 'بيانات الدفعة أو الباقة غير صحيحة.', en: 'The payment or package details are invalid.' }],
    PAYMENT_PENDING: [409, {
      ar: 'الدفعة لم تصل إلى الشبكة بعد. أكملها من المحفظة ثم أعد إنهاء الدفعات المعلقة.',
      en: 'The payment has not reached the network yet. Complete it in your wallet, then finish pending payments again.'
    }],
    PI_LOGIN_FAILED: [401, {
      ar: 'تعذر التحقق من حساب Pi. افتح الموقع داخل Pi Browser وسجّل الدخول من جديد.',
      en: 'Could not verify your Pi account. Open the site in Pi Browser and sign in again.'
    }],
    PI_SERVICE_UNAVAILABLE: [503, {
      ar: 'خدمة Pi غير متاحة مؤقتًا. لم يتغير رصيدك؛ حاول مرة أخرى بعد قليل.',
      en: 'The Pi service is temporarily unavailable. Your balance was not changed; try again shortly.'
    }],
    PAYMENT_PROVIDER_AUTH_ERROR: [503, {
      ar: 'إعدادات الدفع عبر Pi على الخادم غير صالحة حاليًا. لم يتغير رصيدك؛ تواصل مع إدارة AiWay.',
      en: 'The server-side Pi payment settings are currently invalid. Your balance was not changed; contact AiWay support.'
    }],
    REQUEST_IN_PROGRESS: [409, { ar: 'يوجد طلب ذكاء قيد التنفيذ بالفعل. انتظر اكتماله ثم أرسل طلبًا جديدًا.', en: 'An AI request is already in progress. Let it finish before sending another.' }],
    REQUEST_ALREADY_PROCESSED: [409, { ar: 'تمت معالجة هذا الطلب من قبل. حدّث المحادثة لعرض النتيجة.', en: 'This request was already processed. Refresh the conversation to view the result.' }],
    PAYMENT_MISMATCH: [400, { ar: 'بيانات عملية الدفع لا تطابق الباقة أو الحساب الحالي، لذلك لم تتم إضافة الرصيد.', en: 'The payment does not match the selected package or current account, so no balance was added.' }],
    PAYMENT_FAILED: [502, {
      ar: 'تعذر إتمام الدفع عبر Pi حاليًا. لم تتم إضافة أو خصم رصيد؛ حاول مرة أخرى.',
      en: 'The Pi payment could not be completed right now. No balance was added or deducted; try again.'
    }]
  };

  const entry = messages[code];
  if (!entry) return null;
  return {
    status: entry[0],
    message: entry[1][language],
    code,
    meta: {
      ...(required ? { requiredTokens: required } : {}),
      ...(available || code === 'INSUFFICIENT_TOKENS' || code === 'INSUFFICIENT_TOKENS_FOR_REQUEST' ? { availableTokens: available } : {}),
      ...(shortfall ? { shortfall } : {})
    }
  };
}

function providerPayloadText(payload) {
  if (typeof payload === 'string') return payload.slice(0, 1000);
  return String(payload?.error?.message || payload?.message || payload?.error_description || payload?.error || '').slice(0, 1000);
}

export function openRouterError(status, payload, options = {}) {
  const message = providerPayloadText(payload);
  const lower = message.toLowerCase();
  const kind = options.kind === 'image' ? 'image' : 'chat';
  let code = 'PROVIDER_ERROR';

  if (status === 401) code = 'PROVIDER_AUTH_ERROR';
  else if (status === 402 || /insufficient credits|credit balance|add more credits|payment required/.test(lower)) code = 'PROVIDER_CREDITS_EXHAUSTED';
  else if (status === 403 && /moderation|policy|content|guardrail|safety|flagged|blocked/.test(lower)) code = 'CONTENT_BLOCKED';
  else if (status === 403) code = 'PROVIDER_PERMISSION_DENIED';
  else if (status === 404) code = kind === 'image' ? 'IMAGE_MODEL_UNAVAILABLE' : 'MODEL_UNAVAILABLE';
  else if (status === 408 || status === 504 || /timed? out|timeout/.test(lower)) code = 'REQUEST_TIMEOUT';
  else if (status === 413 || /payload too large|file too large|attachment too large/.test(lower)) code = 'ATTACHMENT_TOO_LARGE';
  else if (status === 429 || /rate limit|too many requests|requests per minute|requests per day/.test(lower)) code = 'RATE_LIMITED';
  else if (/context length|maximum context|too many tokens|prompt is too long|token limit/.test(lower)) code = 'CONTEXT_TOO_LONG';
  else if (/moderation|content policy|safety|guardrail|flagged|blocked/.test(lower)) code = 'CONTENT_BLOCKED';
  else if (/model .*not found|unknown model|model unavailable|model is unavailable|model.*down/.test(lower)) code = kind === 'image' ? 'IMAGE_MODEL_UNAVAILABLE' : 'MODEL_UNAVAILABLE';
  else if (status === 503 || /no providers available|no available providers|provider unavailable/.test(lower)) code = 'NO_PROVIDER_AVAILABLE';
  else if (status === 400) code = 'INVALID_REQUEST';
  else if (status >= 500) code = 'PROVIDER_ERROR';

  return appError(code, { providerStatus: Number(status) || 0, kind, internalMessage: message });
}

export function piApiError(status, payload, options = {}) {
  const message = providerPayloadText(payload).toLowerCase();
  const operation = options.operation === 'login' ? 'login' : 'payment';
  let code = operation === 'login' ? 'PI_LOGIN_FAILED' : 'PAYMENT_FAILED';
  if (status === 401 || status === 403) code = operation === 'login' ? 'UNAUTHORIZED' : 'PAYMENT_PROVIDER_AUTH_ERROR';
  else if (status === 404) code = operation === 'login' ? 'PI_LOGIN_FAILED' : 'PAYMENT_INVALID';
  else if (status === 408 || status === 504 || /timed? out|timeout/.test(message)) code = 'REQUEST_TIMEOUT';
  else if (operation === 'payment' && (status === 409 || /pending|not completed|not approved|transaction.*missing/.test(message))) code = 'PAYMENT_PENDING';
  else if (status === 429 || /rate limit|too many requests/.test(message)) code = 'RATE_LIMITED';
  else if (status >= 500) code = 'PI_SERVICE_UNAVAILABLE';
  return appError(code, { providerStatus: Number(status) || 0, internalMessage: providerPayloadText(payload) });
}

export function shouldTryModelFallback(error) {
  const code = normalizedErrorCode(error);
  return ['MODEL_UNAVAILABLE', 'NO_PROVIDER_AVAILABLE', 'PROVIDER_ERROR', 'REQUEST_TIMEOUT'].includes(code);
}

export function handleError(error, res, fallback = 'Server error', locale = 'ar') {
  const details = errorDetails(error, locale);
  if (details) {
    const internal = error?.cause?.message || error?.meta?.internalMessage || '';
    console.warn(`[${details.code}]${internal ? ` ${internal}` : ''}`);
    return json(res, details.status, { error: details.message, code: details.code, ...details.meta });
  }
  console.error(error);
  return json(res, 500, { error: fallback, code: 'SERVER_ERROR' });
}

// كل AiWay Token يمثل 0.00001 دولار من تكلفة المزود الفعلية.
// سعر البيع يضيف 35% فوق تكلفة OpenRouter عند إنشاء الباقة، وليس وقت الاستهلاك.
export const TOKEN_USD = 0.00001;
export const MARKUP = 1.35;
export const TRIAL_MESSAGE_LIMIT = 5;
export const TRIAL_TOKENS = 1500;
export const TRIAL_MODEL_FALLBACK = 'google/gemma-4-26b-a4b-it:free';
const tokensForUsd = usd => Math.floor(Number(usd) / MARKUP / TOKEN_USD);
export const PACKAGES = {
  starter: { usd: 1, tokens: tokensForUsd(1) },
  plus: { usd: 5, tokens: tokensForUsd(5) },
  pro: { usd: 10, tokens: tokensForUsd(10) }
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
  { id: TRIAL_MODEL_FALLBACK, name: 'Gemma 4 26B A4B (free)', created: 1780000000, family: 'gemini', tag: 'Google', pricing: { prompt: 0, completion: 0 } },
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
  const promptPrice = Number(model.pricing?.prompt || 0);
  const completionPrice = Number(model.pricing?.completion || 0);
  return {
    id: model.id,
    name: model.name || model.id.split('/').pop(),
    description: model.description || '',
    created: Number(model.created || 0),
    contextLength: Number(model.context_length || 0),
    family: family.key,
    familyLabel: family.label,
    tag: family.tag,
    isFree: promptPrice === 0 && completionPrice === 0,
    pricing: {
      prompt: promptPrice,
      completion: completionPrice,
      webSearch: Number(model.pricing?.web_search || 0)
    }
  };
}

export async function getAvailableModels() {
  if (Date.now() - catalogCache.at < 60 * 60 * 1000 && catalogCache.models.length >= 20) return catalogCache.models;
  try {
    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
      headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}
    }, 15000);
    if (!response.ok) throw new Error(`OpenRouter models ${response.status}`);
    const payload = await response.json();
    const selected = [];
    for (const family of FAMILY_CONFIG) {
      const familyModels = (payload.data || [])
        .filter(model => String(model.id || '').startsWith(family.prefix) && isTextChatModel(model))
        .map(model => normalizeModel(model, family))
        .sort((a, b) => b.created - a.created || a.name.localeCompare(b.name))
        .slice(0, 5);
      selected.push(...familyModels);
    }
    if (selected.length < FAMILY_CONFIG.length * 5) throw new Error('Incomplete OpenRouter catalog');
    const trialFromPayload = (payload.data || []).find(model => model.id === TRIAL_MODEL_FALLBACK);
    const trialModel = trialFromPayload
      ? normalizeModel(trialFromPayload, FAMILY_CONFIG.find(family => family.key === 'gemini'))
      : FALLBACK_MODELS.find(model => model.id === TRIAL_MODEL_FALLBACK);
    if (trialModel && !selected.some(model => model.id === TRIAL_MODEL_FALLBACK)) {
      const googleIndex = selected.findIndex(model => model.family === 'gemini');
      selected.splice(googleIndex >= 0 ? googleIndex : 0, 0, trialModel);
    }
    // Keep a curated, live set of 11 free chat models (Gemma plus ten more).
    // The list is discovered from OpenRouter so discontinued free endpoints disappear automatically.
    const freeCandidates = (payload.data || [])
      .filter(model => isTextChatModel(model) && Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0)
      .map(model => {
        const family = FAMILY_CONFIG.find(f => String(model.id || '').startsWith(f.prefix)) || { key: String(model.id || '').split('/')[0], label: String(model.id || '').split('/')[0], tag: 'Free' };
        return normalizeModel(model, family);
      })
      .sort((a,b) => (/gemma/i.test(b.id)-/gemma/i.test(a.id)) || b.created-a.created);
    for (const freeModel of freeCandidates.slice(0, 11)) {
      const at = selected.findIndex(m => m.id === freeModel.id);
      if (at >= 0) selected[at] = freeModel; else selected.unshift(freeModel);
    }
    catalogCache = { at: Date.now(), models: selected };
    return selected;
  } catch (error) {
    console.warn('Using fallback model catalog:', error.message);
    return catalogCache.models;
  }
}

export function isFreeModel(model) {
  return Boolean(model && Number(model?.pricing?.prompt) === 0 && Number(model?.pricing?.completion) === 0);
}

export async function chooseAutoModel(text = '', { webSearch = false, hasAttachments = false } = {}) {
  const models = await getAvailableModels();
  const available = models.filter(m => isTextChatModel(m));
  const free = available.filter(isFreeModel);
  const q = String(text || '').toLowerCase();
  const complex = q.length > 1400 || /(?:حلل|تحليل عميق|برمجة|كود|debug|architecture|security|رياضيات|reason|research|compare)/i.test(q);
  const coding = /(?:كود|برمجة|خطأ|بايثون|جافاسكربت|sql|code|debug|function|api)/i.test(q);
  let pool = free.length ? free : available;
  if (webSearch || hasAttachments || complex) {
    const capable = available.filter(m => Number(m.contextLength || 0) >= 64000);
    if (capable.length) pool = capable;
  }
  const score = m => {
    const p = Number(m.pricing?.prompt || 0), c = Number(m.pricing?.completion || 0);
    let value = (p + c * 2) * 1e6;
    if (isFreeModel(m)) value -= 1000;
    if (coding && /qwen|deepseek|coder|gemma/i.test(`${m.id} ${m.name}`)) value -= 50;
    if (complex && /reason|r1|pro|large|70b|31b|27b/i.test(`${m.id} ${m.name}`)) value -= 20;
    return value;
  };
  return [...pool].sort((a,b)=>score(a)-score(b))[0] || available[0] || null;
}

export async function claimFreeDailyUse(supabase, userId, kind = 'chat') {
  const limit = kind === 'image' ? 2 : 20;
  const { data, error } = await supabase.rpc('claim_free_model_request', { p_user_id:userId, p_kind:kind, p_daily_limit:limit });
  if (error) {
    if (String(error.message || '').toLowerCase().includes('daily free limit')) throw appError('RATE_LIMITED', { freeDailyLimit: limit });
    throw appError('DATABASE_ERROR', {}, error);
  }
  return data || {};
}

export async function getTrialModelId() {
  // Keep the free trial pinned to one exact OpenRouter model.
  return TRIAL_MODEL_FALLBACK;
}

export async function getModel(modelId) {
  return (await getAvailableModels()).find(model => model.id === modelId) || null;
}

export function chargeTokens(price, usage = {}, webSearch = false) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const reportedCost = Number(usage.cost || 0);
  const webSearchFallbackUsd = webSearch ? Number(price?.webSearch || 0.01) : 0;
  const fallbackCost = input * Number(price?.prompt || 0) + output * Number(price?.completion || 0) + webSearchFallbackUsd;
  const hasReportedCost = Number.isFinite(reportedCost) && reportedCost > 0;
  const providerUsd = hasReportedCost ? reportedCost : fallbackCost;
  return {
    input,
    output,
    providerUsd,
    costSource: hasReportedCost ? 'openrouter_usage' : 'catalog_estimate',
    tokenUsd: TOKEN_USD,
    markup: MARKUP,
    chargedTokens: Math.max(1, Math.ceil(providerUsd / TOKEN_USD))
  };
}


function estimatedContentTokens(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return 0;
    return Math.ceil(value.length / 3);
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimatedContentTokens(item), 0);
  if (!value || typeof value !== 'object') return 0;
  if (value.type === 'image_url') return 1000;
  if (value.type === 'file') return 1500;
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (key === 'file_data' || key === 'url') return sum;
    return sum + estimatedContentTokens(item);
  }, 0);
}

export function estimateChatCharge(price, messages = [], webSearch = false, outputReserve = 512) {
  const inputTokens = Math.max(1, estimatedContentTokens(messages) + 32 * Math.max(1, messages.length));
  const reservedOutputTokens = Math.max(128, Math.ceil(Number(outputReserve) || 512));
  const inputUsd = inputTokens * Number(price?.prompt || 0);
  const outputUsd = reservedOutputTokens * Number(price?.completion || 0);
  const webUsd = webSearch ? Number(price?.webSearch || 0.01) : 0;
  const providerUsd = inputUsd + outputUsd + webUsd;
  return {
    inputTokens,
    reservedOutputTokens,
    inputUsd,
    outputUsd,
    webUsd,
    providerUsd,
    chargedTokens: Math.max(1, Math.ceil(providerUsd / TOKEN_USD))
  };
}

export function affordableOutputLimit(price, availableTokens, estimate, cap = 8192) {
  const completionPrice = Number(price?.completion || 0);
  if (!(completionPrice > 0)) return Math.max(128, cap);
  const availableUsd = Math.max(0, Number(availableTokens || 0) * TOKEN_USD * 0.9);
  const fixedUsd = Math.max(0, Number(estimate?.inputUsd || 0) + Number(estimate?.webUsd || 0));
  const affordable = Math.floor((availableUsd - fixedUsd) / completionPrice);
  return Math.max(0, Math.min(cap, affordable));
}

export function isLowBalance(remainingTokens, lastCharge = 0) {
  const remaining = Math.max(0, Number(remainingTokens || 0));
  return remaining > 0 && remaining < Math.max(1000, Math.ceil(Number(lastCharge || 0) * 2));
}


export async function classifyTokenChargeFailure(supabase, userId, requiredTokens, cause = null) {
  const required = Math.max(1, Math.ceil(Number(requiredTokens) || 1));
  const { data: profile, error } = await supabase.from('users')
    .select('ai_tokens,trial_messages_remaining,has_purchased')
    .eq('id', userId)
    .single();
  if (error || !profile) return appError('DATABASE_ERROR', {}, error || cause);
  const availableTokens = Math.max(0, Number(profile.ai_tokens || 0));
  if (!profile.has_purchased && Number(profile.trial_messages_remaining || 0) <= 0) {
    return appError('TRIAL_ENDED', { availableTokens }, cause);
  }
  if (availableTokens < required) {
    return appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
      availableTokens,
      requiredTokens: required,
      shortfall: required - availableTokens
    }, cause);
  }
  return appError('DATABASE_ERROR', {}, cause);
}

export async function getPiUsd() {
  const response = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=PI-USDT', { headers: { 'User-Agent': 'AiWay/1.0' } }, 10000);
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


export async function ensureConversationOwner(supabase, conversationId, userId) {
  const { data, error } = await supabase.from('conversations').select('id,user_id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
  if (error) throw appError('DATABASE_ERROR', {}, error);
  if (!data) throw appError('FORBIDDEN');
  return data;
}

export function normalizeRequestId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(id)) throw appError('INVALID_REQUEST');
  return id;
}

export async function reserveAiTokens(supabase, userId, requestId, kind, amount) {
  const { data, error } = await supabase.rpc('reserve_ai_tokens', { p_user_id:userId, p_request_id:requestId, p_kind:kind, p_amount:Math.max(1,Math.ceil(Number(amount)||1)) });
  if (error) {
    const m=String(error.message||'').toLowerCase();
    if (m.includes('already in progress')) throw appError('REQUEST_IN_PROGRESS');
    if (m.includes('insufficient')) throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST');
    if (m.includes('trial ended')) throw appError('TRIAL_ENDED');
    throw appError('DATABASE_ERROR',{},error);
  }
  if (data?.status === 'completed' || data?.status === 'released') throw appError('REQUEST_ALREADY_PROCESSED');
  return data || {};
}

export async function finalizeAiTokens(supabase,userId,requestId,actual,meta={}) {
  const { data,error }=await supabase.rpc('finalize_ai_tokens',{p_user_id:userId,p_request_id:requestId,p_actual:Math.max(1,Math.ceil(Number(actual)||1)),p_meta:meta});
  if(error) throw appError('DATABASE_ERROR',{},error);
  return Math.max(0,Number(data||0));
}

export async function releaseAiTokens(supabase,userId,requestId,meta={}) {
  if(!requestId) return;
  const { error }=await supabase.rpc('release_ai_tokens',{p_user_id:userId,p_request_id:requestId,p_meta:meta});
  if(error) console.error('Token reservation release failed:',error.message);
}


export function requestIp(req) {
  return String(req?.headers?.['x-forwarded-for'] || req?.headers?.['x-real-ip'] || 'unknown').split(',')[0].trim().slice(0,80);
}
export async function enforceRateLimit(supabase,bucket,limit,windowSeconds) {
  const {data,error}=await supabase.rpc('check_api_rate_limit',{p_bucket:String(bucket).slice(0,180),p_limit:limit,p_window_seconds:windowSeconds});
  if(error) throw appError('DATABASE_ERROR',{},error);
  if(!data) throw appError('RATE_LIMITED');
}
