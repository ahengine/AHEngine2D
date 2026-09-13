# Deploying AH2D Studio

این راهنما برای پوستهٔ Next.js، Auth و Collaboration است. `AH2DEdtior.html` به‌تنهایی همچنان یک Editor محلی است، اما Login، پروژه‌های server-managed، comment، history و presence فقط از طریق Studio اجرا می‌شوند.

## نیازمندی‌ها

- Node.js `20.9` یا جدیدتر
- npm و dependencyهای قفل‌شده در `package-lock.json`
- HTTPS برای Production، چون session cookie در Production همیشه `Secure` است
- یک volume محلی پایدار و قابل‌نوشتن برای deployment تک-process فعلی

## Development

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

پیش از Login مقدارهای زیر را در `.env.local` عوض کنید:

```dotenv
AH2D_AUTH_SECRET=a-random-secret-with-at-least-32-bytes
AH2D_BOOTSTRAP_OWNER_EMAIL=owner@example.com
AH2D_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-long-unique-password
AH2D_BOOTSTRAP_OWNER_NAME=Studio Owner
AH2D_AUTH_STORE_PATH=.ah2d-data/auth-store.json
AH2D_COLLAB_DATA_DIR=.ah2d-data/collaboration
AH2D_AUTH_SECURE_COOKIE=false
AH2D_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

یک secret تصادفی مناسب را می‌توان با Node ساخت:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

خروجی را فقط در secret store یا `.env.local` قرار دهید و commit نکنید.

فایل `.env.example` دقیقاً هشت متغیر نمونهٔ بالا را دارد. تنظیمات اختیاری که فقط در صورت نیاز اضافه می‌شوند:

| متغیر | پیش‌فرض | کاربرد |
| --- | ---: | --- |
| `AH2D_AUTH_SESSION_TTL_SECONDS` | 604800 | عمر session، clampشده بین ۵ دقیقه و ۳۰ روز |
| `AH2D_AUTH_SECRET_PATH` | کنار auth store | محل fallback secret فقط در Development |
| `AH2D_MAX_PROJECT_BYTES` | 16777216 | سقف Universal document ذخیره‌شده |
| `AH2D_MAX_API_BODY_BYTES` | 18874368 | سقف body ورودی collaboration API پیش از parse |

## Build و اجرای Production

```powershell
npm ci
npm run check
npm test
npm run build
npm run start
```

`npm run start` به‌صورت پیش‌فرض روی port 3000 گوش می‌دهد. متغیرهای محیطی production را از platform/secret manager تزریق کنید، نه از فایل commit‌شده.

حداقل تنظیم Production:

```dotenv
NODE_ENV=production
AH2D_AUTH_SECRET=<at-least-32-random-bytes>
AH2D_AUTH_STORE_PATH=/var/lib/ah2d/auth-store.json
AH2D_COLLAB_DATA_DIR=/var/lib/ah2d/projects
AH2D_ALLOWED_ORIGINS=https://studio.example.com
```

در Production `AH2D_AUTH_SECRET` اجباری است. fallback secret فایل فقط در Development ساخته می‌شود. `AH2D_AUTH_SECURE_COOKIE` لازم نیست، چون `NODE_ENV=production` آن را خودکار امن می‌کند.

## Reverse proxy و SSE

Proxy باید HTTPS را terminate کند، requestهای طولانی `/api/projects/*/events` را باز نگه دارد و buffering را برای `text/event-stream` غیرفعال کند. Route پاسخ `X-Accel-Buffering: no` می‌دهد، اما تنظیم proxy نیز باید با آن سازگار باشد.

موارد لازم:

- idle timeout بیشتر از heartbeat پانزده‌ثانیه‌ای؛ پیشنهاد حداقل ۶۰ ثانیه
- عدم cache و عدم compression/buffering اجباری روی SSE
- عبور cookie و `Last-Event-ID`
- تنظیم صحیح `X-Forwarded-For` یا `X-Real-IP` برای rate limit
- origin عمومی دقیق داخل `AH2D_ALLOWED_ORIGINS`
- redirect دائمی HTTP به HTTPS

نمونهٔ مفهومی Nginx:

```nginx
location /api/projects/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

این فقط fragment مفهومی است؛ TLS، headerهای امنیتی، upload limits و policyهای سازمان خود را جداگانه تنظیم کنید.

## Data و backup در حالت فعلی

مسیرهای پیش‌فرض:

```text
.ah2d-data/
├── auth-store.json
├── auth-secret                 development fallback only
└── collaboration/
    └── project-<uuid>.json
```

فایل‌ها شامل Email، hash Password، session hash، membership، comment، action history و کل Universal Project هستند. دسترسی filesystem را فقط به process سرویس محدود کنید.

برای backup سازگار:

1. write traffic را متوقف کنید یا snapshot اتمیک volume بگیرید.
2. هر دو auth store و پوشهٔ collaboration را باهم backup کنید.
3. secret امضای session را در secret manager جداگانه نگه دارید.
4. restore را در محیط ایزوله آزمایش کنید.
5. پس از افشای احتمالی secret، secret را rotate و sessionهای موجود را revoke کنید.

فایل‌های پروژه با temporary file و rename اتمیک نوشته می‌شوند، اما کپی معمولی هم‌زمان با write تضمین snapshot چندفایلی نمی‌دهد.

## محدودیت مهم: فقط یک process

storage و realtime فعلی adapter تولیدی چند-instance نیست:

- lock مربوط به mutation فقط in-process است.
- Auth در یک فایل مشترک با queue داخل process نوشته می‌شود.
- Projectها فایل JSON هستند و compare-and-swap دیتابیسی ندارند.
- SSE listener، replay buffer و presence در RAM قرار دارند.
- Login failure counters در RAM قرار دارند.

بنابراین اجرای چند worker، چند container، cluster Node، serverless function یا autoscaling امن نیست. حتی با volume مشترک، lock و event hub میان processها مشترک نمی‌شود. تا زمان جایگزینی adapterها یک instance و یک process اجرا کنید.

## مسیر Production چند-instance

### Auth

- User/session را به PostgreSQL یا provider مبتنی بر OIDC/OAuth منتقل کنید.
- password policy، reset، Email verification، MFA و disable/revoke مدیریت‌شده اضافه کنید.
- session hash را index و expiry/revocation را transactionally enforce کنید.
- rate limit را در Redis یا gateway اجرا کنید.
- HMAC secret را در KMS/secret manager نگه دارید و rotation versioned بسازید.

### Project document و optimistic concurrency

- `projectId` و `revision` را row-level نگه دارید.
- write را با شرط `WHERE revision = expectedRevision` انجام دهید.
- document، revision و Action را در یک transaction بنویسید.
- در صورت update count صفر، `409 REVISION_CONFLICT` با revision واقعی برگردانید.
- `clientMutationId + actorId` را unique/index کنید تا idempotency به retention تاریخچه وابسته نباشد.

### Realtime و presence

- Action منتشرشده را از transactional outbox به Redis Streams، NATS، Kafka یا سرویس realtime بفرستید.
- Presence را ephemeral و TTLدار ذخیره کنید؛ disconnect ناگهانی نباید User را برای همیشه online نگه دارد.
- resume cursor را durable کنید یا client را ملزم به reconciliation با document revision و activity sequence نگه دارید.
- event authorization را در زمان اتصال و در صورت تغییر membership دوباره بررسی کنید.

### Asset storage

Universal JSON فعلی می‌تواند Data URL داشته باشد. در مقیاس واقعی:

- binary را در object storage با signed upload/download بگذارید.
- داخل document فقط asset ID، content hash، MIME type، dimensions و URL منطقی نگه دارید.
- upload size، MIME sniffing، image decoding و malware policy را enforce کنید.
- referential cleanup را asynchronous و recoverable طراحی کنید.

### Audit و compliance

Action History داخلی برای UX است و فقط ۲۰۰۰ Action آخر را نگه می‌دارد. برای audit رسمی:

- append-only store جدا با retention policy
- timestamp معتبر، request/correlation ID و source IP policy
- tamper evidence یا immutable storage
- redaction و access control برای metadata شخصی
- export/retention مطابق مقررات محیط استقرار

## Security checklist

- `AH2D_AUTH_SECRET` حداقل ۳۲ بایت تصادفی و خارج repository است.
- bootstrap Password منحصر‌به‌فرد است و پس از provisioning در deployment config رها نمی‌شود.
- HTTPS اجباری و cookie `Secure`, `HttpOnly`, `SameSite=Strict` است.
- `AH2D_ALLOWED_ORIGINS` wildcard ندارد و فقط originهای واقعی را شامل می‌شود.
- Routeهای mutation هم server-side auth و هم permission پروژه را بررسی می‌کنند.
- دسترسی مؤثر از تقاطع role حساب و role پروژه محاسبه می‌شود و Member role از سقف حساب مقصد بالاتر نمی‌رود.
- `/api/editor/frame` و `/api/editor/engine` Auth می‌خواهند؛ iframe بدون `allow-same-origin` sandbox شده و CSP محدود آن حفظ شده است.
- handler پیام‌های Frame علاوه بر marker، `event.source` و origin مبهم موردانتظار را کنترل می‌کند.
- reverse proxy headerهای IP را فقط از proxy مورداعتماد می‌پذیرد.
- `.ah2d-data` public/static serve نمی‌شود.
- backupها رمزگذاری و restore آن‌ها تست شده است.
- logs شامل cookie، Password، project document کامل یا secret نیستند.
- dependency، test، typecheck و build در CI اجرا می‌شوند.
- برای deployment چند-instance ابتدا adapterهای file/in-memory جایگزین شده‌اند.

## Health verification

پس از deploy:

```powershell
npm run check
npm test
```

سپس از طریق browser این مسیر را تست کنید:

1. Login با Owner bootstrap.
2. ساخت Project و بازشدن Workspace.
3. بازکردن همان Project در tab دوم و مشاهدهٔ presence.
4. تغییر سند و افزایش revision در هر دو tab.
5. ایجاد و resolve یک comment.
6. دیدن Actor و Action در History.
7. اضافه‌کردن یک `viewer` و تأیید read-only بودن document.
8. reconnect کردن SSE و reconciliation با آخرین revision.

قرارداد routeها و نمونه‌های client در [`COLLABORATION.md`](./COLLABORATION.md) قرار دارد.
