# AH2D Studio collaboration

این سند قرارداد سمت سرور Studio مبتنی بر Next.js را توضیح می‌دهد: پروژهٔ versioned، comment، Action History، presence و Server-Sent Events. قرارداد Universal AH2D و CLI در [`../README.md`](../README.md) و [`../engine/CLI.md`](../engine/CLI.md) قرار دارد.

## مدل اعتماد: Studio عمومی و محلی

Studio در حالت **no-auth/open local-trusted** اجرا می‌شود. هیچ ورود، حساب، نشست، نقش یا عضویت پروژه‌ای وجود ندارد. هر client شبکه‌ای که بتواند به Studio برسد می‌تواند همهٔ پروژه‌ها را فهرست کند، بخواند، بسازد و تغییر دهد؛ همچنین می‌تواند هر comment را تغییر دهد یا حذف کند و به streamهای realtime متصل شود.

این مدل فقط برای دستگاه محلی یا شبکهٔ کاملاً قابل‌اعتماد مناسب است. Same-Origin check درخواست‌های mutation مرورگر، sandbox مربوط به Editor و CSP همچنان برقرارند، اما هیچ‌کدام مجوز دسترسی به API نیستند. درخواست مستقیم بدون header `Origin` نیز قابل‌پذیرش است. اگر سرویس از شبکهٔ قابل‌اعتماد بیرون می‌رود، آن را پشت محدودسازی شبکه، VPN یا reverse proxy دارای کنترل دسترسی مستقل قرار دهید.

```text
Browser or API client
├── Next.js App Router UI
├── public sandboxed AH2D Editor
└── /api/projects/*
    ├── document + optimistic revision
    ├── comments + Action History
    └── SSE events + presence
             │
             ├── local JSON project store
             └── in-process event/presence hub
```

## Actor label غیرقابل‌اعتماد

API برای نمایش نام عامل تغییر، دو label اختیاری می‌پذیرد:

- `x-ah2d-actor-id`: شناسهٔ نمایشی با ۱ تا ۱۶۰ کاراکتر امن.
- `x-ah2d-actor-name`: نام نمایشی با حداکثر ۱۶۰ کاراکتر و بدون control character.

اگر label فرستاده نشود، fallback برابر `id: "local"` و `name: "Local User"` است. UI یک label محلی را در `localStorage` نگه می‌دارد و آن را به requestها اضافه می‌کند. این مقدار credential نیست، امضا نمی‌شود و هر client می‌تواند آن را جعل یا تکرار کند. از actor ID یا name برای permission، مالکیت، moderation، audit امنیتی یا تصمیم دیگری دربارهٔ دسترسی استفاده نکنید.

برای `fetch` می‌توان headerها را مستقیم فرستاد:

```js
const actorHeaders = {
  'x-ah2d-actor-id': 'local-tab-7f3a',
  'x-ah2d-actor-name': 'Local User'
};

await fetch('/api/projects', {
  headers: actorHeaders,
  cache: 'no-store'
});
```

`EventSource` امکان header سفارشی ندارد؛ بنابراین endpoint رویدادها همان labelها را از query string نیز می‌پذیرد:

```js
const params = new URLSearchParams({
  clientId: crypto.randomUUID(),
  actorId: 'local-tab-7f3a',
  actorName: 'Local User'
});
const events = new EventSource(`/api/projects/${projectId}/events?${params}`);
```

`clientMutationId` با actor ID ارسالی برای deduplication استفاده می‌شود. چون actor ID قابل‌جعل است، این رفتار فقط idempotency عملیاتی است و مرز امنیتی یا هویت معتبر ایجاد نمی‌کند.

## رکورد Collaboration نسخهٔ ۲

Studio سند Universal نسخهٔ ۴ را داخل رکورد `ah2d.collaboration/project-v2` نگه می‌دارد:

```text
schema, id, name, createdAt, updatedAt,
revision, activitySequence, document, comments, history
```

رکورد v2 فیلد مالک، member یا permission ندارد. `revision` فقط با تغییر document افزایش پیدا می‌کند؛ `activitySequence` با هر Action ذخیره‌شده افزایش پیدا می‌کند.

رکوردهای قدیمی `ah2d.collaboration/project-v1` قابل‌خواندن‌اند. Store آن‌ها را هنگام load به مدل v2 تبدیل می‌کند و در **اولین write عادی همان پروژه** به v2 ذخیره می‌کند؛ صرف read فایل را بازنویسی نمی‌کند. داده‌های فعال membership و ownership در خروجی v2 نگه‌داری نمی‌شوند. Actionهای قدیمی member ممکن است فقط به‌عنوان history تاریخی باقی بمانند و هیچ اثر دسترسی ندارند. فایل‌های `.ah2d-data/collaboration/*.json` را برای migration دستی ویرایش نکنید.

Universal Project نسخهٔ `4` منبع Authoring است. سند پیش‌فرض Studio همچنین `dataModel: { id: "ah2d.ecs", version: 1, componentSchemaVersion: 1 }` دارد؛ این descriptor با نسخهٔ container پروژه و ECS snapshot نسخهٔ `3` سه محور مستقل‌اند. API فقط سند کامل Universal را نگه می‌دارد؛ خروجی lossy مربوط به `Engine.export()` یا `ah2d ecs export` نباید جای document پروژه PUT شود.

Componentهای document با profile `authoring` و در حالت strict اعتبارسنجی می‌شوند. `components.<canonical-or-alias>` بر محل legacy/تخت precedence دارد و اختلاف دو محل conflict است. componentها و فیلدهای ناشناختهٔ JSON را در read/merge/write حفظ کنید.

## Editor bridge و Autosave

صفحهٔ `/projects/:projectId` محتوای `/api/editor/frame` را بارگذاری می‌کند. این route و `/api/editor/engine` عمومی‌اند. iframe عمداً `allow-same-origin` ندارد و با `sandbox="allow-scripts allow-downloads allow-modals"` اجرا می‌شود؛ بنابراین document داخل Frame یک origin مبهم (`null`) دارد و به storage یا DOM صفحهٔ والد دسترسی مستقیم ندارد. form، popup، top-level navigation و object/plugin نیز مجاز نیستند.

Frame، PixiJS، polyfill رسمی CSP-safe آن، Planck، DataModel و Engine را inline می‌کند. polyfill با نام packageِ `unsafe-eval` مسیرهای generated `Function` را حذف می‌کند و CSP همچنان این مجوز را نمی‌دهد. CSP به `default-src 'none'`، script/style inline، تصویر `data:`/`blob:`، font از `data:` و `connect-src 'none'` محدود است؛ `object-src`، `base-uri` و `form-action` نیز `none` هستند و `frame-ancestors 'self'` embedding خارجی را رد می‌کند. پاسخ `Referrer-Policy: no-referrer` و `X-Content-Type-Options: nosniff` نیز دارد.

bridge محدود `postMessage` را حفظ کنید. Receiver والد باید `event.source === iframe.contentWindow`، origin موردانتظار و marker `source: "ah2d-editor"` را باهم بررسی کند. Receiver داخل Frame فقط پیام همان `window.parent` با marker `source: "ah2d-studio"` را می‌پذیرد. marker به‌تنهایی کافی نیست.

Workspace سند versioned را با `AH2D_LOAD_PROJECT` داخل Editor می‌فرستد و snapshot تغییرکرده را با `AH2D_PROJECT_CHANGED` دریافت می‌کند. Autosave برای همه فعال و optimistic است. اگر client دیگری زودتر ذخیره کند، UI باید conflict را نشان دهد، snapshot جدید را بخواند و از overwrite خاموش خودداری کند. `localStorage` داخل Editor جایگزین Project API نیست.

## راه‌اندازی و تنظیمات

حداقل Node.js برابر `24` است:

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

سپس `http://localhost:3000` را باز کنید. Studio مستقیم صفحهٔ Projects را نمایش می‌دهد و setup کاربر ندارد.

| متغیر | پیش‌فرض | کاربرد |
| --- | ---: | --- |
| `AH2D_COLLAB_DATA_DIR` | `.ah2d-data/collaboration` | پوشهٔ فایل‌های JSON پروژه‌ها |
| `AH2D_ALLOWED_ORIGINS` | origin همان request | originهای اضافهٔ مجاز برای mutation مرورگر، جداشده با comma |
| `AH2D_MAX_PROJECT_BYTES` | 16777216 | حداکثر اندازهٔ JSON document هر پروژه |
| `AH2D_MAX_API_BODY_BYTES` | 18874368 | حداکثر body JSON پیش از parse |

`AH2D_ALLOWED_ORIGINS` فقط Origin check را گسترش می‌دهد و client را معتبر نمی‌کند. wildcard یا origin عمومی را برای نمونهٔ متصل به شبکه تنظیم نکنید.

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

`revision` فقط در routeهای مرتبط با document تضمین می‌شود. همیشه status HTTP و `ok` را بررسی کنید.

## API عمومی پروژه

همهٔ routeهای زیر بدون محدودیت کاربری در دسترس‌اند:

| Method | Route | کاربرد |
| --- | --- | --- |
| `GET` | `/api/projects` | فهرست همهٔ پروژه‌ها |
| `POST` | `/api/projects` | ساخت پروژه با `{ name, document? }` |
| `GET` | `/api/projects/:projectId` | summary پروژه |
| `PATCH` | `/api/projects/:projectId` | تغییر نام با `{ name, clientMutationId? }` |
| `GET` | `/api/projects/:projectId/document` | دریافت Universal document و revision |
| `PUT` | `/api/projects/:projectId/document` | جایگزینی کامل document |
| `PATCH` | `/api/projects/:projectId/document` | اعمال JSON Patch |
| `GET` | `/api/projects/:projectId/comments` | فهرست commentها با filter اختیاری |
| `POST` | `/api/projects/:projectId/comments` | ساخت comment یا reply |
| `PATCH` | `/api/projects/:projectId/comments/:commentId` | تغییر body یا status |
| `DELETE` | `/api/projects/:projectId/comments/:commentId` | حذف comment |
| `GET` | `/api/projects/:projectId/history` | Action History ترتیبی |
| `GET` | `/api/projects/:projectId/events` | stream رویدادهای SSE و اتصال presence |
| `POST` | `/api/projects/:projectId/presence` | به‌روزرسانی presence اتصال باز |

endpoint مربوط به account یا member وجود ندارد و Workspace پنل People/مدیریت همکاران ندارد.

ساخت و خواندن پروژه:

```js
const created = await fetch('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...actorHeaders },
  body: JSON.stringify({ name: 'Forest Adventure' })
}).then(response => response.json());

const projectId = created.data.project.id;
const snapshot = await fetch(`/api/projects/${projectId}/document`, {
  headers: actorHeaders,
  cache: 'no-store'
}).then(response => response.json());

const { document, revision } = snapshot.data;
```

`GET document` همچنین `ETag: "<revision>"` می‌فرستد. write contract مقدار `expectedRevision` را در JSON body می‌گیرد و از `If-Match` استفاده نمی‌کند.

## Same-Origin برای mutation مرورگر

`POST`، `PATCH`، `PUT` و `DELETE` وقتی header `Origin` دارند فقط از origin خود request، Host متناظر یا `AH2D_ALLOWED_ORIGINS` پذیرفته می‌شوند. این کنترل برای کاهش mutation ناخواسته از یک صفحهٔ cross-origin است، نه تعیین اینکه چه کسی اجازهٔ تغییر دارد. client غیرمرورگری که به شبکه دسترسی دارد می‌تواند بدون `Origin` mutation بفرستد.

## Optimistic document revision

هر `PUT` یا `PATCH` document باید `expectedRevision` مثبت داشته باشد:

```js
const result = await fetch(`/api/projects/${projectId}/document`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', ...actorHeaders },
  body: JSON.stringify({
    expectedRevision: revision,
    clientMutationId: crypto.randomUUID(),
    operations: [
      { op: 'replace', path: '/postProcess/effects/0/enabled', value: true }
    ]
  })
}).then(response => response.json());
```

JSON Patch از `add`، `remove`، `replace` و `test` پشتیبانی می‌کند؛ `move` و `copy` پیاده نشده‌اند.

- نبودن revision معتبر: `428 REVISION_REQUIRED`.
- قدیمی‌بودن revision: `409 REVISION_CONFLICT` همراه `actualRevision`.
- موفقیت: document اتمیک ذخیره و revision یک واحد زیاد می‌شود.
- `clientMutationId` تا ۱۶۰ کاراکتر برای deduplication همان actor label استفاده می‌شود.

در conflict سند جدید را بگیرید، تغییر محلی و remote را آگاهانه merge کنید و mutation تازه بفرستید. `PUT` فقط برای snapshot کامل و تازه‌مبنا مناسب است. حد پیش‌فرض document برابر ۱۶ MiB است و assetهای Base64 نیز در همین اندازه حساب می‌شوند.

هر `PUT` و نتیجهٔ هر `PATCH` پیش از commit با قرارداد مشترک CLI در حالت strict اعتبارسنجی و mirror مربوط به `scene` با Scene فعال هماهنگ می‌شود. خطای schema/component با `422 INVALID_AH2D_PROJECT` و تعارض concurrency با `409 REVISION_CONFLICT` برمی‌گردد.

## Comments

Comment می‌تواند به Scene، Entity، مسیر داده، موقعیت صحنه یا Frame متصل شود:

```js
await fetch(`/api/projects/${projectId}/comments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...actorHeaders },
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

برای reply، `parentId` را بفرستید. filterهای GET عبارت‌اند از `status=open|resolved`، `sceneId` و `entityId`. هر client قابل‌دسترسی می‌تواند هر comment را ویرایش، resolve، reopen یا حذف کند؛ label نویسنده فقط attribution نمایشی است. حذف parent، replyهای باقی‌مانده را حذف نمی‌کند و فقط `parentId` آن‌ها را برمی‌دارد.

## Action History

هر Action شامل `sequence` صعودی، `type`، actor label (`id/name`)، زمان، `documentRevision`، metadata و `clientMutationId` اختیاری است. Actionهای جدید:

- `project.created`, `project.updated`
- `document.replaced`, `document.patched`
- `comment.created`, `comment.updated`, `comment.deleted`

```text
GET /api/projects/:projectId/history?limit=100
GET /api/projects/:projectId/history?after=250&limit=100
```

`limit` بین ۱ و ۵۰۰ clamp می‌شود و store فقط ۲۰۰۰ Action آخر را نگه می‌دارد. history برای UX است، actor label آن قابل‌اعتماد نیست و log انطباقی immutable محسوب نمی‌شود. رکورد مهاجرت‌کرده ممکن است Actionهای قدیمی member را فقط به‌عنوان سابقه نگه دارد.

## SSE و Presence

برای هر tab یک `clientId` یکتا بسازید. همان actor label را در query stream و header درخواست presence بفرستید:

```js
const actorId = 'local-tab-7f3a';
const actorName = 'Local User';
const clientId = crypto.randomUUID();
const query = new URLSearchParams({ clientId, actorId, actorName });
const events = new EventSource(`/api/projects/${projectId}/events?${query}`);

events.addEventListener('connected', event => {
  const message = JSON.parse(event.data);
  console.log(message.data.revision, message.data.presence);
});

events.addEventListener('document.changed', async event => {
  const message = JSON.parse(event.data);
  if (message.actor?.id !== actorId) await reloadAndMerge(message.revision);
});

events.addEventListener('comment.changed', refreshComments);
events.addEventListener('presence.updated', drawRemoteSelection);

await fetch(`/api/projects/${projectId}/presence`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-ah2d-actor-id': actorId,
    'x-ah2d-actor-name': actorName
  },
  body: JSON.stringify({
    clientId,
    sceneId: 'boss-room',
    entityIds: ['boss', 'boss-weapon'],
    cursor: { x: 620, y: 280 },
    status: 'active'
  })
});
```

eventهای جاری عبارت‌اند از `connected`، `document.changed`، `project.changed`، `comment.changed`، `presence.joined`، `presence.updated` و `presence.left`. تطابق actor ID و `clientId` فقط اتصال presence را correlate می‌کند و دسترسی ایجاد نمی‌کند.

اگر stream قبلاً وصل نشده باشد، presence با `409 PRESENCE_CONNECTION_NOT_FOUND` رد می‌شود. بستن stream باعث `presence.left` می‌شود. سرور heartbeat پانزده‌ثانیه‌ای و `retry: 3000` می‌فرستد. replay با `Last-Event-ID` فقط در همان process و تا وقتی event در buffer حداکثر ۲۵۶ آیتم/۲ MiB موجود است انجام می‌شود. بعد از reconnect همیشه revision/history را reconcile کنید؛ SSE منبع دائمی حقیقت نیست.

## Post Process در Collaboration

`postProcess` جزئی از Universal document و همان optimistic revision است. هر پروژه stack خودش را دارد و تغییر slider/toggle در autosave بعدی ذخیره می‌شود. برای تغییر بیرون Editor نیز `PATCH document` روی JSON Pointer مناسب بفرستید و effect را در snapshot همان revision با `id` پیدا کنید.

## محدودیت store محلی و adapter تولیدی

پیاده‌سازی فعلی برای توسعه، demo و اجرای تک-process است:

- پروژه‌ها فایل JSON محلی هستند؛ write اتمیک است اما lock فقط داخل همان process است.
- SSE replay buffer و presence در RAM همان process قرار دارند.
- اجرای چند instance، serverless/edge، autoscaling یا shared filesystem می‌تواند race، presence ناقص و event گم‌شده ایجاد کند.
- Action History قابل‌ویرایش روی filesystem و retention آن محدود است.
- assetهای Base64 باعث بزرگ‌شدن document و write کامل فایل می‌شوند.

تا پیش از adapter پایدار، فقط یک process Node را روی volume پایدار اجرا کنید. برای چند instance، compare-and-swap روی `revision` را در transaction دیتابیس انجام دهید، Action و document را در همان transaction بنویسید، realtime را با transactional outbox و pub/sub پایدار کنید و presence را TTLدار نگه دارید. actor label ورودی را حتی در adapter تولیدی هویت معتبر فرض نکنید؛ اگر محیط به مجوز واقعی نیاز دارد، آن مرز باید بیرون یا جایگزین این حالت local-trusted طراحی شود.

Routeها و typeهای مرجع در `src/app/api` و `src/lib/collaboration/types.ts` هستند. تغییر schema یا event contract باید با test، migration و به‌روزرسانی این سند همراه باشد.
