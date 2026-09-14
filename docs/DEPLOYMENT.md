# Deploying AH2D Studio

این راهنما برای پوستهٔ Next.js، Editor local-first و سرویس اختیاری Collaboration است. UI اصلی فایل پروژه را با permission مرورگر مستقیماً روی دستگاه کاربر باز می‌کند و داده را در سرور نگه نمی‌دارد. API اختیاری Collaboration همچنان **no-auth/open local-trusted** است و در صورت expose شدن باید با شبکه یا reverse proxy مستقل محدود شود.

## نیازمندی‌ها

- Node.js `24` یا جدیدتر
- dependencyهای lockشده با npm
- Chromium جدید و HTTPS (یا localhost) برای دسترسی مستقیم به پوشهٔ کاربر
- یک volume محلی پایدار فقط در صورت استفاده از API اختیاری Collaboration
- محدودسازی دسترسی شبکه به hostهای مورداعتماد
- HTTPS در صورت عبور traffic از شبکه

HTTPS محتوا را در مسیر محافظت می‌کند، اما عمومی‌بودن API را تغییر نمی‌دهد.

## Development

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

تنظیمات محلی نمونه:

```dotenv
AH2D_COLLAB_DATA_DIR=.ah2d-data/collaboration
AH2D_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

تنظیمات اختیاری:

| متغیر | پیش‌فرض | کاربرد |
| --- | ---: | --- |
| `AH2D_MAX_PROJECT_BYTES` | 16777216 | سقف Universal document ذخیره‌شده |
| `AH2D_MAX_API_BODY_BYTES` | 18874368 | سقف body ورودی پیش از parse |

`AH2D_ALLOWED_ORIGINS` فقط originهای اضافهٔ مجاز برای mutation مرورگر را مشخص می‌کند. این allowlist هویت client را ثابت نمی‌کند و request مستقیم بدون `Origin` را مسدود نمی‌کند.

Editor را در `http://localhost:3000` باز کنید؛ صفحهٔ شروع `Open Project` و `New Project` را نمایش می‌دهد. فایل‌های انتخاب‌شده روی دستگاه مرورگر می‌مانند. مسیر `/projects` فقط برای سازگاری به `/` redirect می‌شود.

## Build و اجرای production

```powershell
npm ci
npm run check
npm test
npm run build
npm run start
```

حداقل تنظیم برای container تک-process:

```dotenv
NODE_ENV=production
AH2D_COLLAB_DATA_DIR=/var/lib/ah2d/collaboration
AH2D_ALLOWED_ORIGINS=https://studio.internal.example
```

متغیرهای environment را خارج repository نگه دارید. فایل `Dockerfile` سرویس را با user غیر-root و volume برابر `/var/lib/ah2d` اجرا می‌کند.

نمونهٔ اجرا:

```bash
docker build -t ah2d-studio:latest .
docker volume create ah2d-data
docker run -d --name ah2d-studio --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file .env.production \
  -v ah2d-data:/var/lib/ah2d \
  ah2d-studio:latest
```

bind کردن port به `127.0.0.1` مانع exposure مستقیم روی interfaceهای دیگر می‌شود. برای دسترسی تیمی، ورودی را از یک reverse proxy محدودشده، VPN یا شبکهٔ خصوصی عبور دهید. صرف تنظیم `AH2D_ALLOWED_ORIGINS` برای حفاظت از API کافی نیست.

## Reverse proxy و SSE

Proxy باید requestهای طولانی `/api/projects/*/events` را باز نگه دارد و buffering را برای `text/event-stream` غیرفعال کند. Route پاسخ `X-Accel-Buffering: no` می‌دهد، اما تنظیم proxy نیز باید سازگار باشد.

- idle timeout بیشتر از heartbeat پانزده‌ثانیه‌ای؛ پیشنهاد حداقل ۶۰ ثانیه
- عدم cache و buffering اجباری روی SSE
- عبور `Last-Event-ID` و query string کامل
- محدودسازی source network یا کنترل دسترسی مستقل در لبه
- origin عمومی دقیق داخل `AH2D_ALLOWED_ORIGINS`
- HTTPS و redirect دائمی HTTP به HTTPS در صورت استفاده از شبکه

نمونهٔ مفهومی Nginx:

```nginx
location /api/projects/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

این fragment هیچ access policy تعریف نمی‌کند؛ ACL شبکه یا policy لبه را جداگانه اضافه کنید.

## Actor label و ریسک exposure

headerهای `x-ah2d-actor-id` و `x-ah2d-actor-name` و queryهای `actorId`/`actorName` در SSE فقط label نمایشی هستند. fallback برابر `Local User` است. این مقادیر قابل‌جعل‌اند و نباید برای مجوز، audit معتبر یا تفکیک tenant استفاده شوند.

در نتیجه client قابل‌دسترسی می‌تواند:

- همهٔ پروژه‌ها را فهرست و محتوای کامل آن‌ها را دریافت کند؛
- پروژه بسازد یا نام و document هر پروژه را تغییر دهد؛
- هر comment را ایجاد، ویرایش، resolve یا حذف کند؛
- history، SSE و presence را بخواند یا attribution دلخواه بفرستد.

Same-Origin check فقط mutation مرورگر دارای `Origin` نامعتبر را رد می‌کند. ابزار CLI، script یا client شبکه‌ای می‌تواند request بدون `Origin` بفرستد.

## Data، schema و backup

مسیر پیش‌فرض:

```text
.ah2d-data/
└── collaboration/
    └── project-<uuid>.json
```

رکورد جاری `ah2d.collaboration/project-v2` شامل metadata پروژه، Universal document، commentها و Action History است و دادهٔ membership ندارد. فایل‌های v1 هنگام read پذیرفته و در اولین write عادی همان پروژه به v2 بدون membership فعال ذخیره می‌شوند؛ read تنها migration را روی disk commit نمی‌کند.

برای backup سازگار:

1. write traffic را متوقف کنید یا snapshot اتمیک volume بگیرید.
2. کل پوشهٔ collaboration را backup کنید.
3. restore را در محیط ایزوله آزمایش کنید.
4. سطح دسترسی filesystem و backup را فقط به operatorهای لازم محدود کنید.

فایل پروژه با temporary file و rename اتمیک نوشته می‌شود، اما copy معمولی هم‌زمان با write تضمین snapshot چندفایلی نمی‌دهد. `.ah2d-data/collaboration/*.json` را دستی تغییر ندهید.

## محدودیت مهم: فقط یک process

storage و realtime فعلی adapter چند-instance نیست:

- lock مربوط به mutation فقط in-process است.
- Projectها فایل JSON هستند و compare-and-swap دیتابیسی ندارند.
- SSE listener، replay buffer و presence در RAM قرار دارند.

بنابراین چند worker، چند container، cluster Node، serverless function یا autoscaling امن نیست. حتی با volume مشترک، lock و event hub میان processها مشترک نمی‌شود. تا زمان جایگزینی adapterها یک instance و یک process اجرا کنید.

## مسیر چند-instance

### Project document و optimistic concurrency

- `projectId` و `revision` را row-level نگه دارید.
- write را با شرط `WHERE revision = expectedRevision` انجام دهید.
- document، revision و Action را در یک transaction بنویسید.
- در صورت update count صفر، `409 REVISION_CONFLICT` با revision واقعی برگردانید.
- `clientMutationId + actorLabel` را فقط برای deduplication در نظر بگیرید؛ actor label هویت معتبر نیست.

### Realtime و presence

- Action منتشرشده را از transactional outbox به Redis Streams، NATS، Kafka یا سرویس realtime بفرستید.
- Presence را ephemeral و TTLدار ذخیره کنید.
- resume cursor را durable کنید یا client را ملزم به reconciliation با document revision و activity sequence نگه دارید.

### Asset storage

Universal JSON می‌تواند Data URL داشته باشد. در مقیاس واقعی binary را در object storage قرار دهید و داخل document فقط asset ID، content hash، MIME type، dimensions و URL منطقی نگه دارید. upload size، MIME sniffing، image decoding و malware policy را enforce کنید.

### Audit

Action History داخلی فقط ۲۰۰۰ Action آخر را نگه می‌دارد و actor label آن قابل‌جعل است. برای audit رسمی از store append-only جدا، timestamp معتبر، correlation ID، tamper evidence، retention policy و هویت تأییدشده در یک لایهٔ مستقل استفاده کنید.

## چک‌لیست ایمنی

- Studio فقط روی loopback یا شبکهٔ خصوصی مورداعتماد reachable است.
- exposure تیمی پشت VPN، ACL یا reverse proxy دارای access policy مستقل قرار دارد.
- `AH2D_ALLOWED_ORIGINS` wildcard ندارد و فقط originهای لازم را شامل می‌شود.
- actor header/query فقط attribution نمایشی تلقی می‌شود.
- mutationها optimistic revision و Same-Origin check مرورگر را حفظ می‌کنند.
- `/api/editor/frame` عمومی است، اما iframe بدون `allow-same-origin`، CSP محدود و validation کامل `postMessage` را حفظ می‌کند.
- `.ah2d-data` از public/static serve نمی‌شود و backupها محافظت می‌شوند.
- logها شامل project document کامل یا metadata حساس عملیاتی نیستند.
- dependency، test، typecheck و build در CI اجرا می‌شوند.
- برای چند instance ابتدا adapterهای file/in-memory جایگزین شده‌اند.

## Health verification

پس از deploy:

```powershell
npm run check
npm test
```

سپس این مسیر را آزمایش کنید:

1. بازشدن مستقیم `/` و نمایش فقط جریان Open/New.
2. ساخت پروژه و ایجاد `<Project>/project.ah2d.json` روی سیستم کاربر.
3. Open همان پوشه، تغییر Scene و ذخیرهٔ مستقیم با `Ctrl/Cmd + S`.
4. تغییر فایل با CLI و مشاهدهٔ conflict به‌جای overwrite خاموش.
5. بازشدن تمام‌صفحهٔ Editor و باقی‌ماندن iframe بدون `allow-same-origin`.
6. در صورت استفاده از API اختیاری: revision، comment، SSE/presence و ردشدن mutation مرورگر با Origin غیرمجاز.

قرارداد routeها و نمونه‌های client در [`COLLABORATION.md`](./COLLABORATION.md) قرار دارد.
