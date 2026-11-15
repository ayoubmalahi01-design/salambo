# The Trainers — تدرّب

تطبيق ويب تقدّمي (PWA) مستقل ومصمم للهاتف Android وiPhone لإدارة المؤسسات والمدربين. هذا المشروع منفصل كلياً عن Sport Performance.

## التقنية
- React + TypeScript + Vite
- Supabase Auth / PostgreSQL / Row Level Security / Realtime / Storage
- Supabase Edge Function للدعوات الآمنة (من دون وضع `service_role` في المتصفح)
- Cloudflare Pages
- العربية والفرنسية والإنجليزية، مع RTL للعربية

## الأدوار
1. **مالك المنصة**: البريد `ayoubmalleh772@gmail.com`، حساب مركزي لا ينتمي إلى مؤسسة. ينشئ المؤسسات ويعيّن مديريها.
2. **مدير المؤسسة (manager)**: يدير فريق المؤسسة ويعيّن الإداريين والمدربين.
3. **الإدارة (admin)**: تدير التلاميذ والملفات الطبية والتعاميم والتقارير وسجل النشاط.
4. **المدرب (coach)**: يسجل الحصص والحضور والتقارير ويستعمل كراسه الخاص. لا يقرأ تقارير أو كراسات المدربين الآخرين.

## الإعداد الأول — Supabase
أنشئ مشروع Supabase جديداً مخصصاً لـ The Trainers. لا تستخدم مشروع Sport Performance.

1. افتح **SQL Editor** وشغّل الملف `supabase/THE_TRAINERS_SETUP.sql` مرة واحدة على قاعدة فارغة.
2. من **Authentication → Users** أرسل دعوة إلى `ayoubmalleh772@gmail.com`.
3. عند إنشاء حساب هذا البريد، ينشئ trigger ملف المالك تلقائياً بدور `owner`.
4. سجّل الدخول إلى التطبيق بعد نشر الواجهة. من لوحة المالك أنشئ المؤسسة ثم أرسل دعوة إلى مدير المؤسسة.
5. يجب تشغيل ترحيل الدعوات ونشر Edge Functions الأربع قبل استخدام دعوات المديرين والمدربين والإداريين؛ التعليمات أدناه.

> لا تُنشئ صف المالك يدوياً إذا أنشأه trigger. لا تشارك مفتاح `service_role` ولا تضعه في `.env` أو GitHub أو Cloudflare Pages.

## تثبيت قاعدة الدعوات وOTP
بعد `THE_TRAINERS_SETUP.sql` شغّل ملف الترحيل الإضافي مرة واحدة في SQL Editor:

```text
supabase/INVITATIONS_OTP_INCREMENTAL.sql
```

الملف لا يحذف جداول أو بيانات، ويصلح الجداول التي أنشأها الإصدار المعطوب السابق. راجع `supabase/INVITATIONS_OTP_SUMMARY.md` قبل التشغيل.

## نشر Edge Functions للدعوات
يلزم Node.js وSupabase CLI. من مجلد المشروع:

```bash
npx supabase login
npx supabase link --project-ref YOUR_SUPABASE_PROJECT_REF
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
npx supabase secrets set OTP_DELIVERY_SECRET=YOUR_RANDOM_SECRET_AT_LEAST_16_CHARS
npx supabase secrets set APP_URL=https://YOUR_DOMAIN
npx supabase secrets set ALLOWED_ORIGINS=https://YOUR_DOMAIN
npx supabase secrets set SUPABASE_WHATSAPP_API_URL=YOUR_PROVIDER_URL
npx supabase secrets set SUPABASE_WHATSAPP_API_KEY=YOUR_PROVIDER_KEY
npx supabase secrets set SUPABASE_WHATSAPP_FROM_NUMBER=YOUR_WHATSAPP_NUMBER
npx supabase secrets set SUPABASE_SMS_API_URL=YOUR_PROVIDER_URL
npx supabase secrets set SUPABASE_SMS_API_KEY=YOUR_PROVIDER_KEY
npx supabase secrets set SUPABASE_SMS_FROM_NUMBER=YOUR_SMS_SENDER
npx supabase functions deploy invite-user
npx supabase functions deploy verify-otp
npx supabase functions deploy send-whatsapp
npx supabase functions deploy send-sms
```

`SUPABASE_URL` و`SUPABASE_ANON_KEY` متاحان تلقائياً في بيئة Edge Functions. مفتاح `service_role` و`OTP_DELIVERY_SECRET` يبقيان كـ Secrets داخل Supabase فقط، ولا يوضعان في `.env` أو Cloudflare Pages أو GitHub.

في **Authentication → Providers → Email** أبقِ خيار **Confirm email** مغلقاً (OFF). لا تغيّره: التطبيق ينشئ الحسابات عبر الدعوات، وتأكيد البريد قد يمنع الدخول قبل إتمام الإعداد.

### مسار الدعوة
- **Email**: يُرسل رابط إعداد الحساب المعتاد، ويبقى الحساب `pending` حتى موافقة إدارة المؤسسة. يظل متوافقاً مع `use_otp=false`.
- **WhatsApp / SMS**: يُنشأ الحساب (أو يُستخدم حساب موجود)، ثم يُرسل رمز من 6 أرقام إلى الهاتف. **المدعو** يسجل الدخول بالبريد المدعو ويدخل الرمز من شاشة الانتظار أو من صفحة «قبول دعوة». المتصفح لا يرسل معرّف الدعوة، والخادم يشتقها من الحساب المسجل.

الرموز تُخزَّن كتجزئة SHA-256 فقط، وتُستهلك مرة واحدة، وتنتهي بعد 10 دقائق، مع حد للمحاولات (5) وحد لإعادة الإرسال. لا يُعاد الرمز أبداً في استجابة الدالة أو سجل الخادم.

## تشغيل الواجهة محلياً
المتطلبات: Node.js 20 أو أحدث.

```bash
npm install
cp .env.example .env
```

ضع القيمتين من Supabase → Project Settings → API:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_OR_PUBLISHABLE_KEY
```

ثم:

```bash
npm run verify
npm run build
npm run dev
```

## GitHub وCloudflare Pages
- أنشئ مستودع GitHub جديداً لهذا المشروع فقط وارفع محتويات مجلد المشروع.
- في Cloudflare Pages اختر **Connect to Git**.
- Build command: `npm run build`
- Build output directory: `dist`
- أضف `VITE_SUPABASE_URL` و`VITE_SUPABASE_ANON_KEY` في Environment Variables لبيئتي Production وPreview.
- لا تضف `SUPABASE_SERVICE_ROLE_KEY` إلى Cloudflare Pages.
- بعد النشر افتح رابط HTTPS على الهاتف.

## تثبيت الهاتف
- Android: افتح الرابط في Chrome ثم Install app / Add to Home screen.
- iPhone: افتح الرابط في Safari ثم Share → Add to Home Screen.

## الوحدات الموجودة في المشروع
- تسجيل الدخول وتوجيه المستخدم بحسب الدور وحالة الحساب.
- لوحة مالك المنصة وإنشاء المؤسسات وتعيين المديرين.
- دعوات الفريق الآمنة عبر Edge Functions: المالك يدعو مديراً/إدارياً/مدرباً، والمدير يدعو إدارياً/مدرباً، والإداري والمدرب يدعوان مدرباً فقط، ولا يمكن إنشاء مالك عبر الدعوات. البريد يبقى بانتظار الموافقة، وWhatsApp/SMS يستخدمان رمزاً يُدخله المدعو بعد تسجيل الدخول.
- قائمة التلاميذ والبحث والإضافة والتعديل والأرشفة من حسابات الإدارة، مع استيراد جماعي من Excel عبر النسخ واللصق (TSV/CSV) ومعاينة وتجاهل الأرقام المكررة.
- تسجيل الحضور والغياب والتأخير والرخص والإعفاءات، مع تحميل السجلات السابقة حسب التاريخ قبل التعديل.
- بداية الحصة ونهايتها، وتقرير يومي تُملأ أعداده تلقائياً من حضور اليوم، ثم يمكن للإدارة اعتماده بعد المراجعة.
- كراس خاص بكل مدرب مع عزل على مستوى RLS.
- التعاميم الإدارية.
- محادثات خاصة بين مدربين ومجموعات حسب المشاركين، مع تحديث فوري للرسائل وإرسال الملفات والصور والتسجيلات الصوتية داخل المحادثة فقط. يستطيع المدرب دعوة زميله من شاشة المحادثات، ثم يفعّل المدير حسابه.
- إدارة السجلات الطبية للإدارة فقط.
- سجل تدقيق للتغييرات.
- العربية والفرنسية والإنجليزية وPWA قابلة للتثبيت.

## التحقق وحدود ما يجب اختباره
`npm run verify` يفحص وجود الملفات وبعض ضوابط البنية والأمان بشكل ثابت، بما فيها الاستيراد الجماعي والمحادثات المقيدة بالأعضاء ومراجعة التقارير. لا يُعد اختبار تكامل مع قاعدة بيانات فعلية. يجب قبل الاستخدام الحقيقي اختبار الحسابات المنفصلة (مالك/مدير/إداري/مدرب)، وعزل مؤسستين، ومنع المدرب من قراءة تقارير زملائه، وسيناريوهات الدعوات والحضور والتقارير والوسائط على Android وiPhone. لا توجد في هذه النسخة خدمة Push Notifications فعلية، ولا Speech-to-Text مدمج؛ تسجيل الصوت كمرفق وإملاء صوتي عبر Web Speech API متاحان في المتصفحات التي تدعمهما؛ التوفر واللغة يختلفان حسب المتصفح والجهاز. إشعارات Push الفعلية غير مفعّلة حالياً، وإشعارات iOS على الويب لها قيود دعم تختلف حسب إصدار النظام وطريقة تثبيت PWA.


## ملفات إضافية
- `docs/STATUS.md`: ما أُنجز وما بقي وما لم يُجرَّب.
- `docs/DATABASE.md`, `docs/STORAGE.md`: توثيق قاعدة البيانات والتخزين.
- `docs/ACCEPTANCE_TESTS.md`, `docs/SECURITY_NOTES.md`: الاختبارات اليدوية والأمان.
- `docs/COACH_GUIDE.md`, `docs/ADMIN_GUIDE.md`: أدلة الاستعمال.

> اسم متغير المفتاح العام في Vite: `VITE_SUPABASE_ANON_KEY` (يقبل التطبيق أيضاً `VITE_SUPABASE_PUBLISHABLE_KEY`).
