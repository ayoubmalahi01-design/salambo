# ملاحظات الأمان

- مفتاح `service_role` يُحفظ كـ Secret داخل Supabase فقط (Edge Function). لا يوضع في `.env` ولا GitHub ولا Cloudflare.
- في الواجهة يُستعمل المفتاح العام (anon/publishable) فقط، والحماية الفعلية تعتمد على سياسات RLS في قاعدة البيانات (مفعّلة على كل الجداول الـ 18، ويتحقق منها `npm run verify`).
- `public/_headers` يفرض CSP صارمة (لا سكربتات خارجية، الاتصال بـ Supabase فقط).
- بعد نشر التطبيق اضبط في Supabase → Authentication → URL Configuration قيمة **Site URL** برابط Cloudflare حتى تعمل روابط الدعوة واستعادة كلمة المرور.
- وضع المعاينة المحلية (عند غياب متغيرات Supabase) يعرض واجهة بلا بيانات فعلية؛ لا تنشر الإنتاج بدون ضبط المتغيرين.
