# AiWay

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


## Free trial and model unlocking

New accounts receive 1,500 AiWay Tokens and up to 5 trial messages. Before the first completed Pi purchase, only DeepSeek V3 is available and web search is disabled. The first successful purchase sets `has_purchased=true`, unlocks all models, and keeps normal usage based on each model's OpenRouter cost.

For an existing database, run `sql/free-trial-model-lock.sql` once in Supabase SQL Editor. Existing users with a completed payment are automatically marked as purchased.

## Latest model families
`/api/models` fetches the OpenRouter catalog once per hour and automatically selects the newest three text-chat models from each family: OpenAI/ChatGPT, Google/Gemini, DeepSeek, and Anthropic/Claude. The trial model is the newest available DeepSeek V3 variant; all other models remain server-locked until the first completed Pi purchase.

## Complete database
For a new installation or to upgrade an existing AiWay database, run only:

```text
sql/aiway-full-database.sql
```

The file is idempotent and contains the users, conversations, messages, payments, trial, token charging, first-purchase unlock, RLS, grants, indexes, and transactional payment functions.


## Attachments and generated images
Run `sql/generated-images-migration.sql` once. User uploads remain only in the browser IndexedDB and are sent to the selected AI only with the current request. Generated 512px compressed images are saved in `generated_images`.

## Admin dashboard setup

1. Run `sql/schema.sql` in Supabase SQL Editor.
2. Generate a secure password hash locally:
   `node scripts/create-admin-hash.js "YourStrongPassword"`
3. Insert the returned hash into Supabase:
   `insert into public.admin_accounts(email,password_hash,display_name) values ('admin@example.com','PASTE_HASH','Main Admin');`
4. Open `/admin.html` and sign in.

The dashboard calculates estimated OpenRouter recharge as collected USD divided by the configured `MARKUP`, and shows the remaining estimated profit in USD and Pi.
