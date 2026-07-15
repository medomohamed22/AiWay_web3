# Pi AI Hub

منصة شات ذكاء اصطناعي داخل Pi Browser، مبنية على مشروع AppHub الأصلي وتستخدم:
- Pi SDK لتسجيل الدخول والدفع.
- Pi Platform API للموافقة على الدفع وإكماله من الخادم.
- OpenRouter لتشغيل عدة نماذج، ومنها DeepSeek V3.
- Supabase لحفظ المستخدمين والمحادثات والرسائل والمدفوعات.
- Vercel للاستضافة وServerless API.

## التشغيل
1. أنشئ مشروع Supabase ونفّذ `sql/schema.sql` من SQL Editor.
2. انسخ `.env.example` إلى إعدادات Environment Variables في Vercel وأضف القيم الحقيقية.
3. اربط مستودع GitHub بـ Vercel أو نفّذ `vercel --prod`.
4. أضف رابط Vercel في Pi Developer Portal، واضبط الشبكة والمحفظة ومفتاح Pi.
5. اختبر الدفع في Sandbox أولًا بتغيير `sandbox:false` إلى `sandbox:true` في `index.html` عند الحاجة.

## متغيرات البيئة
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (خادم فقط)
- `APP_JWT_SECRET` (32 حرفًا أو أكثر)
- `PI_SECRET_KEY` (خادم فقط)
- `OPENROUTER_API_KEY` (خادم فقط)
- `SITE_URL`
- `SITE_NAME`

## المزايا
- تسجيل دخول Pi.
- شراء باقات رصيد بعملة Pi.
- بث الردود لحظيًا SSE.
- اختيار النموذج، DeepSeek V3، R1، GPT، Claude، Gemini، Llama وQwen.
- حفظ المحادثات، إعادة توليد، نسخ، تصدير، Markdown وكود.
- بحث ويب اختياري عبر OpenRouter plugin.
- تصميم عربي متجاوب شبيه بتطبيقات الشات الحديثة.

> ملاحظة: معرّفات النماذج تتغير أحيانًا في OpenRouter. راجع صفحة Models وعدّل `MODELS` في `api/_lib.js` قبل الإطلاق التجاري.

## Vercel Hobby API function limit

The deployable `/api` directory contains 11 JavaScript files, including the shared `_lib.js`, so it stays below a 12-file serverless-function limit.

Older AppHub management endpoints that are not used by the AI chat are preserved under `/legacy-api`. Vercel does not deploy that directory as API functions. Move an endpoint back only if you also consolidate or remove another function first.
