# AH2D Studio authentication and collaboration

این سند قرارداد سمت سرور Studio مبتنی بر Next.js را توضیح می‌دهد: Auth، دو سطح RBAC، پروژهٔ versioned، comment، action history، presence و Server-Sent Events. قرارداد فایل Universal AH2D و CLI در [`../README.md`](../README.md) و [`../engine/CLI.md`](../engine/CLI.md) قرار دارد.

## تصویر کلی

```text
Browser
├── Next.js App Router UI
├── embedded AH2D Editor
└── same-origin API client
    ├── /api/auth/*                    signed session
    └── /api/projects/*                project membership RBAC
        ├── document + revision
        ├── comments + history
        ├── members
        └── SSE events + presence
                 │
                 ├── local JSON project store
                 └── in-process event/presence hub
```

Studio سند Universal نسخهٔ ۴ را داخل record مشارکت نگه می‌دارد. `revision` فقط با تغییر document افزایش پیدا می‌کند؛ `activitySequence` با هر Action ذخیره‌شده، از جمله comment یا member، افزایش پیدا می‌کند.

## Editor bridge و Autosave

صفحهٔ `/projects/:projectId` Editor موجود را از Route احرازشدهٔ `/api/editor/frame` بارگذاری می‌کند. iframe عمداً `allow-same-origin` ندارد و با `sandbox="allow-scripts allow-downloads allow-modals"` اجرا می‌شود؛ بنابراین document داخل Frame یک origin ایزوله و مبهم (`null`) دارد و به cookie، storage یا DOM صفحهٔ والد دسترسی مستقیم ندارد. form، popup، navigation سطح بالا و اجرای object/plugin نیز مجاز نیستند.

Frame فقط بعد از session معتبر HTML را تحویل می‌دهد. Engine داخل همان پاسخ inline می‌شود و CSP آن را به `default-src 'none'`، script/style inline، تصویر `data:`/`blob:`، font از `data:` و `connect-src 'none'` محدود می‌کند؛ `object-src`، `base-uri` و `form-action` نیز `none` هستند و `frame-ancestors 'self'` embedding خارجی را رد می‌کند. پاسخ همچنین `Referrer-Policy: no-referrer` و `X-Content-Type-Options: nosniff` دارد. Route مستقیم `/api/editor/engine` نیز Auth می‌خواهد.

ارتباط فقط از bridge محدود `postMessage` انجام می‌شود. چون target origin Frame مبهم است، ارسال به `*` لازم است. Receiver والد، `event.source === iframe.contentWindow`، origin موردانتظار (`null` برای sandbox و origin صفحه برای fallback) و marker `source: "ah2d-editor"` را باهم بررسی می‌کند. Receiver داخل Frame فقط پیام همان `window.parent` با marker `source: "ah2d-studio"` را می‌پذیرد؛ CSP `frame-ancestors 'self'` والد را به همین Site محدود می‌کند. این کنترل‌ها را هنگام تغییر bridge حذف یا شل نکنید و payload را صرفاً بر اساس marker متنی معتبر فرض نکنید.

Workspace سند versioned سرور را با `AH2D_LOAD_PROJECT` داخل Editor می‌فرستد و snapshotهای تغییرکرده را با `AH2D_PROJECT_CHANGED` دریافت می‌کند. وقتی هم نقش حساب (`OWNER/ADMIN/EDITOR`) و هم نقش پروژه (`owner/admin/editor`) نوشتن document را اجازه دهند، تغییرها به‌صورت debounce و با `PUT document` ذخیره می‌شوند؛ در غیر این صورت روی Editor سپر read-only قرار می‌گیرد. کامنت‌گذاری با تقاطع مستقل `project:comment` حساب و `comment:create` پروژه کنترل می‌شود.

Autosave نیز optimistic است. اگر همکار دیگری زودتر ذخیره کند، client باید حالت conflict را نشان دهد، snapshot جدید را از سرور بخواند و از overwrite خاموش خودداری کند. `localStorage` داخل Editor جایگزین revisioned storage Studio نیست؛ در Workspace منبع حقیقت همان Project API است.

## راه‌اندازی

حداقل Node.js برابر `20.9` است:

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

در `http://localhost:3000` وارد شوید. وقتی auth store هنوز هیچ User ندارد، اولین تلاش Login تابع bootstrap را اجرا می‌کند و حساب Owner را از متغیرهای `AH2D_BOOTSTRAP_OWNER_*` می‌سازد.

متغیرهای موجود در `.env.example`:

| متغیر | کاربرد |
| --- | --- |
| `AH2D_AUTH_SECRET` | کلید HMAC session؛ حداقل ۳۲ بایت و در Production اجباری |
| `AH2D_BOOTSTRAP_OWNER_EMAIL` | Email حساب اولیه |
| `AH2D_BOOTSTRAP_OWNER_PASSWORD` | Password حساب اولیه؛ حداقل ۱۲ کاراکتر |
| `AH2D_BOOTSTRAP_OWNER_NAME` | نام نمایشی حساب اولیه |
| `AH2D_AUTH_STORE_PATH` | مسیر JSON مربوط به Userها و sessionها |
| `AH2D_COLLAB_DATA_DIR` | پوشهٔ فایل‌های JSON پروژه‌ها |
| `AH2D_AUTH_SECURE_COOKIE` | اجبار cookie امن در Development؛ در Production خودکار فعال است |
| `AH2D_ALLOWED_ORIGINS` | originهای مجاز POST/PATCH/PUT/DELETE، جداشده با comma؛ نمونهٔ محلی شامل هر دو `http://localhost:3000` و `http://127.0.0.1:3000` است |

تنظیمات اختیاری کد:

| متغیر | پیش‌فرض | کاربرد |
| --- | ---: | --- |
| `AH2D_AUTH_SESSION_TTL_SECONDS` | 604800 | عمر session؛ بین ۵ دقیقه و ۳۰ روز clamp می‌شود |
| `AH2D_AUTH_SECRET_PATH` | کنار auth store | فایل secret خودکار فقط برای Development و زمانی که `AH2D_AUTH_SECRET` تنظیم نشده است |
| `AH2D_MAX_PROJECT_BYTES` | 16777216 | حداکثر اندازهٔ JSON document هر پروژه |
| `AH2D_MAX_API_BODY_BYTES` | 18874368 | حداکثر body JSON که collaboration route پیش از parse می‌پذیرد |

Secret یا bootstrap password واقعی را commit نکنید. پس از ساخته‌شدن اولین حساب، تغییر bootstrap env حساب موجود را تغییر نمی‌دهد.

## Authentication

Passwordها با `scrypt` و salt تصادفی hash می‌شوند. پس از Login، سرور یک شناسهٔ تصادفی session را با HMAC-SHA256 امضا می‌کند، cookie را روی `HttpOnly` و `SameSite=Strict` می‌گذارد و فقط SHA-256 شناسهٔ session را در auth store ذخیره می‌کند. cookie در Production همیشه `Secure` است.

POSTهای same-origin بررسی می‌شوند. Login ناموفق بر اساس Email و IP به‌صورت in-process محدود می‌شود: پنج failure در پنجرهٔ ۱۵ دقیقه. این rate limiter برای deployment چند-process کافی نیست؛ بخش Production را ببینید.

### Auth routes

| Method | Route | Body | نتیجه |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | `{ "email": string, "password": string }` | ایجاد session و تنظیم cookie |
| `POST` | `/api/auth/logout` | ندارد | revoke session و پاک‌کردن cookie؛ پاسخ `204` |
| `GET` | `/api/auth/me` | ندارد | User، session expiry و permissionهای سراسری |
| `GET` | `/api/auth/users` | ندارد | فهرست حساب‌ها؛ نیازمند `members:manage` سراسری |
| `POST` | `/api/auth/users` | `{ "email", "displayName", "password", "role" }` | ساخت حساب؛ نیازمند `roles:manage` سراسری |

نمونهٔ ساخت حساب:

```js
const response = await fetch('/api/auth/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'designer@example.com',
    displayName: 'Level Designer',
    password: 'use-a-real-password-manager',
    role: 'EDITOR'
  })
});
const result = await response.json();
```

این endpoint فقط provisioning محلی است؛ reset password، invite email، MFA، OAuth/OIDC و حذف/غیرفعال‌کردن حساب endpoint عمومی ندارند.

## قالب پاسخ API

پاسخ موفق:

```json
{
  "ok": true,
  "data": {},
  "revision": 4
}
```

پاسخ خطا:

```json
{
  "ok": false,
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The project document changed since it was read.",
    "details": { "expectedRevision": 3, "actualRevision": 4 }
  },
  "revision": 4
}
```

`revision` فقط در routeهایی که به نسخهٔ document مرتبط‌اند تضمین می‌شود. همیشه status HTTP و `ok` را بررسی کنید.

## RBAC سراسری حساب

نقش حساب با حروف بزرگ ذخیره می‌شود. این نقش سقف permissionهای User در تمام Studio، از جمله داخل پروژه، است و دسترسی عضویت پروژه را دور نمی‌زند.

| نقش | قابلیت اصلی |
| --- | --- |
| `OWNER` | همهٔ permissionهای سراسری؛ می‌تواند هر نقش حسابی بسازد |
| `ADMIN` | مدیریت account و role پایین‌تر از ADMIN؛ نمی‌تواند OWNER یا ADMIN بسازد/مدیریت کند |
| `EDITOR` | read/edit/comment/realtime و `members:manage`؛ می‌تواند directory حساب‌ها را بخواند و در صورت اجازهٔ نقش پروژه membership را مدیریت کند، اما حساب جدید یا role سراسری نمی‌سازد |
| `COMMENTER` | read/comment/collaboration؛ بدون edit پروژه و مدیریت حساب |
| `VIEWER` | read سراسری؛ بدون mutation |

`OWNER` و `ADMIN` دارای `roles:manage` هستند؛ Admin فقط حساب‌های `EDITOR`، `COMMENTER` و `VIEWER` را provision می‌کند، در حالی که Owner می‌تواند هر role حساب را بسازد. `GET /api/auth/users` به `members:manage` نیاز دارد و بنابراین برای `OWNER`، `ADMIN` و `EDITOR` مجاز است؛ `POST /api/auth/users` به `roles:manage` نیاز دارد.

permissionهای دقیق در `src/lib/auth/rbac.ts` تعریف شده‌اند. در Route Handler جدید از `requireRequestPermission(request, permission)` استفاده کنید؛ هیچ تصمیم authorization را فقط به پنهان‌کردن یک دکمه در UI نسپارید.

## RBAC عضویت پروژه

عضویت پروژه با حروف کوچک ذخیره می‌شود. حتی `OWNER` سراسری باید عضو پروژه باشد. سازندهٔ پروژه عضو `owner` می‌شود، اما permission مؤثر همیشه تقاطع دو لایه است:

```text
effective permission = account-role permission ∩ project-role permission
```

نگاشت دو لایه:

| permission پروژه | permission لازم در حساب |
| --- | --- |
| `project:read`, `document:read`, `comment:read` | `project:read` |
| `project:update`, `document:write` | `project:edit` |
| `comment:create`, `comment:moderate` | `project:comment` |
| `history:read` | `history:read` |
| `member:read`, `member:manage` | `members:read`, `members:manage` |
| `presence:read`, `presence:write` | `collaboration:read`, `collaboration:write` |

برای مثال `VIEWER` سراسری حتی با membership اشتباهِ `editor` نمی‌تواند document بنویسد؛ از طرف دیگر `OWNER` سراسری با membership `viewer` نیز read-only می‌ماند. `COMMENTER` سراسری با membership `admin` به edit document دسترسی نمی‌گیرد. `EDITOR` سراسری با membership `owner/admin` می‌تواند membership را مدیریت کند چون اکنون `members:manage` سراسری دارد، اما همچنان برای ساخت حساب جدید `roles:manage` ندارد.

جدول زیر فقط permission لایهٔ پروژه را نشان می‌دهد؛ ستون نقش حساب باید همان permission را نیز اجازه دهد:

| قابلیت | owner | admin | editor | commenter | viewer |
| --- | :---: | :---: | :---: | :---: | :---: |
| دیدن پروژه/document | ✓ | ✓ | ✓ | ✓ | ✓ |
| تغییر نام پروژه | ✓ | ✓ | — | — | — |
| نوشتن document | ✓ | ✓ | ✓ | — | — |
| ساخت comment | ✓ | ✓ | ✓ | ✓ | — |
| moderation همهٔ commentها | ✓ | ✓ | — | — | — |
| دیدن history/member | ✓ | ✓ | ✓ | ✓ | ✓ |
| مدیریت member | ✓ | ✓ محدود | — | — | — |
| ارسال presence | ✓ | ✓ | ✓ | ✓ | ✓ |

در لایهٔ حساب، `presence:write` به `collaboration:write` نگاشت می‌شود؛ بنابراین حساب `VIEWER` می‌تواند presence را ببیند ولی update غنی cursor/selection را ارسال نمی‌کند، حتی اگر جدول پروژه اجازه دهد.

Owner پروژه می‌تواند همهٔ memberهای غیرOwner را مدیریت کند، اما انتقال ownership از مسیر member upsert پشتیبانی نمی‌شود و Owner را نمی‌توان حذف کرد. Admin پروژه فقط `editor`، `commenter` و `viewer` را مدیریت می‌کند و نمی‌تواند Owner/Admin را تغییر دهد. این توانایی علاوه بر نقش پروژه، `members:manage` حساب Actor را نیز لازم دارد.

### سقف نقش پروژه برای حساب مقصد

Member API حساب فعال مقصد را از auth store پیدا می‌کند و اجازه نمی‌دهد role پروژه از role حساب او بالاتر برود:

| role حساب مقصد | roleهای قابل‌اعطا در پروژه |
| --- | --- |
| `OWNER` | `admin`, `editor`, `commenter`, `viewer` |
| `ADMIN` | `admin`, `editor`, `commenter`, `viewer` |
| `EDITOR` | `editor`, `commenter`, `viewer` |
| `COMMENTER` | `commenter`, `viewer` |
| `VIEWER` | `viewer` |

`owner` از Member API قابل‌اعطا نیست؛ تنها ساخت پروژه، سازنده را Owner همان پروژه می‌کند و انتقال ownership هنوز API ندارد. تخطی از سقف با `409 ROLE_EXCEEDS_ACCOUNT` و نبودن حساب فعال با `404 ACCOUNT_NOT_FOUND` رد می‌شود. این cap مربوط به حساب **مقصد** است و جای کنترل role/permission Actor را نمی‌گیرد؛ هر دو کنترل اجرا می‌شوند.

## Project API

تمام routeهای پروژه session معتبر و permission مؤثر حاصل از تقاطع حساب/عضویت را لازم دارند. تنها فهرست پروژه‌ها عضویت‌های User را برمی‌گرداند؛ ساخت پروژه به `project:edit` حساب نیاز دارد و بنابراین برای `OWNER`، `ADMIN` و `EDITOR` سراسری ممکن است.

| Method | Route | کاربرد |
| --- | --- | --- |
| `GET` | `/api/projects` | پروژه‌هایی که User عضو آن‌هاست |
| `POST` | `/api/projects` | ساخت پروژه با `{ name, document? }` |
| `GET` | `/api/projects/:projectId` | summary و memberهای پروژه |
| `PATCH` | `/api/projects/:projectId` | تغییر نام با `{ name, clientMutationId? }` |
| `GET` | `/api/projects/:projectId/document` | دریافت Universal document و revision |
| `PUT` | `/api/projects/:projectId/document` | جایگزینی کامل document |
| `PATCH` | `/api/projects/:projectId/document` | اعمال JSON Patch |
| `GET` | `/api/projects/:projectId/comments` | فهرست commentها با filter اختیاری |
| `POST` | `/api/projects/:projectId/comments` | ساخت comment یا reply |
| `PATCH` | `/api/projects/:projectId/comments/:commentId` | تغییر body یا status |
| `DELETE` | `/api/projects/:projectId/comments/:commentId` | حذف comment |
| `GET` | `/api/projects/:projectId/history` | action history ترتیبی |
| `GET` | `/api/projects/:projectId/members` | فهرست memberها |
| `POST` | `/api/projects/:projectId/members` | add/update با `{ userId, role }`؛ هویت مقصد از auth store خوانده می‌شود |
| `PATCH` | `/api/projects/:projectId/members/:userId` | تغییر role با `{ role }` |
| `DELETE` | `/api/projects/:projectId/members/:userId` | حذف member |
| `GET` | `/api/projects/:projectId/events` | stream رویدادهای SSE و اتصال presence |
| `POST` | `/api/projects/:projectId/presence` | به‌روزرسانی presence اتصال باز |

### ساخت و خواندن پروژه

```js
const created = await fetch('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Forest Adventure' })
}).then(response => response.json());

const projectId = created.data.project.id;
const snapshot = await fetch(`/api/projects/${projectId}/document`, {
  cache: 'no-store'
}).then(response => response.json());

const { document, revision } = snapshot.data;
```

`GET document` همچنین `ETag: "<revision>"` می‌فرستد. write contract فعلی `expectedRevision` را در JSON body می‌گیرد و از `If-Match` استفاده نمی‌کند.

## Optimistic document revision

هر `PUT` یا `PATCH` document باید `expectedRevision` مثبت داشته باشد:

```js
const mutationId = crypto.randomUUID();
const result = await fetch(`/api/projects/${projectId}/document`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    expectedRevision: revision,
    clientMutationId: mutationId,
    operations: [
      { op: 'replace', path: '/postProcess/effects/0/enabled', value: true },
      { op: 'replace', path: '/postProcess/effects/0/intensity', value: 0.5 }
    ]
  })
}).then(response => response.json());
```

JSON Patch از `add`، `remove`، `replace` و `test` پشتیبانی می‌کند. مسیرها JSON Pointer هستند. عملیات `move` و `copy` پیاده نشده‌اند.

- نبودن revision معتبر: `428 REVISION_REQUIRED`.
- قدیمی‌بودن revision: `409 REVISION_CONFLICT` همراه `actualRevision`.
- موفقیت: document به‌صورت atomic ذخیره می‌شود و revision یک واحد بالا می‌رود.
- `clientMutationId` تا ۱۶۰ کاراکتر، mutation را برای همان Actor idempotent می‌کند. یک کلید را برای نوع دیگری از mutation دوباره استفاده نکنید.

در conflict سند جدید را دوباره بگیرید، تغییر محلی و remote را آگاهانه merge کنید و mutation تازه را با revision و `clientMutationId` تازه بفرستید. retry کور روی نسخهٔ قدیمی مجاز نیست.

`PUT` برای autosave کامل Editor مناسب است:

```js
await fetch(`/api/projects/${projectId}/document`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    document: editorProject,
    expectedRevision: currentRevision,
    clientMutationId: crypto.randomUUID()
  })
});
```

حد پیش‌فرض document برابر ۱۶ MiB است. assetهای Base64 جزو همین اندازه‌اند.

## Comments

Comment می‌تواند به Scene، Entity، مسیر داده، موقعیت صحنه یا Frame متصل شود:

```js
await fetch(`/api/projects/${projectId}/comments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    body: 'Hitbox should start two frames earlier.',
    anchor: {
      sceneId: 'boss-room',
      entityId: 'boss',
      path: '/animations/0/tracks/hitbox',
      frame: 18,
      x: 620,
      y: 280
    },
    clientMutationId: crypto.randomUUID()
  })
});
```

برای reply، `parentId` را بفرستید. Filterهای GET عبارت‌اند از `status=open|resolved`، `sceneId` و `entityId`. Author می‌تواند comment خودش را ویرایش/حذف کند؛ Owner/Admin پروژه می‌توانند moderation انجام دهند.

تغییر status:

```js
await fetch(`/api/projects/${projectId}/comments/${commentId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'resolved', clientMutationId: crypto.randomUUID() })
});
```

حذف parent، replyهای باقی‌مانده را حذف نمی‌کند و فقط `parentId` آن‌ها را برمی‌دارد.

## Action History

هر Action شامل `sequence` صعودی، نوع، snapshot کاربر (`id/name/email`)، زمان، `documentRevision`، metadata و `clientMutationId` اختیاری است. نوع‌های فعلی:

- `project.created`, `project.updated`
- `document.replaced`, `document.patched`
- `comment.created`, `comment.updated`, `comment.deleted`
- `member.added`, `member.role_changed`, `member.removed`

آخرین Actionها:

```text
GET /api/projects/:projectId/history?limit=100
```

ادامه از sequence مشخص:

```text
GET /api/projects/:projectId/history?after=250&limit=100
```

`limit` بین ۱ و ۵۰۰ clamp می‌شود و store فقط ۲۰۰۰ Action آخر را نگه می‌دارد. این history برای UX و audit سبک است؛ log انطباقیِ immutable محسوب نمی‌شود.

## Members

ابتدا با `/api/auth/users` حساب را provision کنید و `id` آن را بگیرید، سپس همان ID را به پروژه اضافه کنید:

```js
await fetch(`/api/projects/${projectId}/members`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: user.id,
    role: 'editor'
  })
});
```

نام و Email از payload client پذیرفته نمی‌شود؛ Route حساب فعال را با `userId` پیدا می‌کند، target-role cap را بررسی می‌کند و snapshot معتبر نام/Email را خودش داخل membership می‌نویسد. authorization همچنان بر اساس `userId` session انجام می‌شود.

## SSE و Presence

برای هر tab یک `clientId` پایدار و یکتا بسازید و stream را باز نگه دارید:

```js
const clientId = crypto.randomUUID();
const events = new EventSource(
  `/api/projects/${projectId}/events?clientId=${encodeURIComponent(clientId)}`
);

events.addEventListener('connected', event => {
  const message = JSON.parse(event.data);
  console.log(message.data.revision, message.data.presence);
});

events.addEventListener('document.changed', async event => {
  const message = JSON.parse(event.data);
  if (message.actor?.id !== currentUserId) await reloadAndMerge(message.revision);
});

events.addEventListener('comment.changed', refreshComments);
events.addEventListener('member.changed', refreshMembers);
events.addEventListener('presence.updated', drawRemoteSelection);
```

EventSource با cookie همان origin احراز هویت می‌شود. eventهای موجود: `connected`، `document.changed`، `project.changed`، `comment.changed`، `member.changed`، `presence.joined`، `presence.updated` و `presence.left`.

بعد از بازشدن stream، presence همان `clientId` را ارسال کنید:

```js
await fetch(`/api/projects/${projectId}/presence`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clientId,
    sceneId: 'boss-room',
    entityIds: ['boss', 'boss-weapon'],
    cursor: { x: 620, y: 280 },
    status: 'active'
  })
});
```

اگر stream قبلاً وصل نشده باشد، presence با `409 PRESENCE_CONNECTION_NOT_FOUND` رد می‌شود. بستن stream باعث `presence.left` می‌شود. برای پاک‌کردن fieldهای اختیاری مقدار `null` بفرستید.

سرور هر ۱۵ ثانیه پیش از heartbeat، session، identity، account permission و عضویت پروژه را دوباره بررسی می‌کند و در صورت لغو دسترسی stream را می‌بندد. حذف همان User از memberها نیز stream را هنگام event مربوطه فوراً می‌بندد. سرور `retry: 3000` پیشنهاد می‌دهد. replay با `Last-Event-ID` فقط در همان process و تا وقتی event در buffer حداکثر ۲۵۶ آیتم/۲ MiB موجود است انجام می‌شود. بعد از reconnect همیشه revision/history را نیز reconcile کنید؛ SSE منبع دائمی حقیقت نیست.

## Post Process در Collaboration

`postProcess` جزئی از Universal document و در نتیجه جزئی از همان optimistic revision است. هر پروژه stack خودش را دارد و تغییر slider/toggle توسط Editor در autosave بعدی داخل document ذخیره می‌شود. پروژه‌های جدید defaultهای Bloom، Vignette، Color Adjust، Chromatic Aberration، Pixelate و CRT را دریافت می‌کنند.

برای تغییر خارج Editor نیز `PATCH document` روی JSON Pointer مناسب است. ترتیب effectها یک array contract است؛ اگر بر اساس index patch می‌کنید ابتدا سند همان revision را بخوانید. برای code پایدارتر effect موردنظر را با `id` پیدا کنید، index متناظر همان snapshot را patch کنید و conflict را merge کنید.

## محدودیت store محلی

پیاده‌سازی فعلی برای توسعه، demo و اجرای تک-process است:

- حساب‌ها و sessionها در یک فایل JSON و پروژه‌ها هرکدام در یک فایل JSON ذخیره می‌شوند.
- writeها atomic و lockها فقط داخل همان process هستند.
- listenerها، SSE replay buffer، presence و login rate limit در RAM همان process‌اند.
- اجرای چند instance، serverless/edge، autoscaling یا shared network filesystem می‌تواند race، presence ناقص و event گم‌شده ایجاد کند.
- Action History قابل‌ویرایش روی filesystem است و retention آن محدود است.
- assetهای Base64 باعث بزرگ‌شدن document و write کامل فایل می‌شوند.

تا پیش از اضافه‌شدن adapter پایدار، فقط یک process Node را روی یک volume پایدار اجرا کنید. دستورالعمل کامل در [`DEPLOYMENT.md`](./DEPLOYMENT.md) است.

## قرارداد adapter برای Production

برای Production چندکاربره، رفتار بیرونی routeها را نگه دارید اما زیرساخت را جایگزین کنید:

1. `AuthStore` را با PostgreSQL/SQL یا Identity Provider سازمانی جایگزین کنید؛ session revoke/expiry باید transactional باشد.
2. `CollaborationProjectStore` را پشت repository interface قرار دهید و compare-and-swap روی `revision` را در یک transaction انجام دهید.
3. Action و document mutation را در همان transaction بنویسید؛ برای انتشار realtime از transactional outbox استفاده کنید.
4. Event hub و presence را به Redis/NATS/pub-sub و TTL-backed presence منتقل کنید؛ reconnect باید از durable sequence یا history recover شود.
5. assetهای بزرگ را در object storage بگذارید و فقط metadata/content hash را در Universal document نگه دارید.
6. secretها را در secret manager، cookie را پشت HTTPS و origin allowlist را دقیق تنظیم کنید.
7. rate limit را distributed و مبتنی بر proxy-aware IP/User کنید.
8. برای audit رسمی، log append-only با retention، integrity control و access policy جدا بسازید.

Routeها و typeهای مرجع در `src/app/api` و `src/lib/collaboration/types.ts` هستند. تغییر schema یا event contract باید با test، migration و به‌روزرسانی این سند همراه باشد.
