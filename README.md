# AH2D Editor & Engine

AH2D یک محیط Authoring دوبعدی، یک Studio مشارکتی مبتنی بر Next.js و یک هستهٔ Runtime مستقل از Framework است. صحنه، hierarchy، componentها، فیزیک، prefab، animation، particle و Post Process در قالب JSON نگه‌داری می‌شوند و همان داده می‌تواند توسط Canvas سفارشی، PixiJS، PhaserJS یا یک Runtime اختصاصی مصرف شود.

نسخهٔ فعلی Engine و CLI برابر `0.3.0` و نسخهٔ Universal Project برابر `4` است.

## معماری

```text
AH2D Studio (Next.js)
├── Signed HttpOnly Authentication
├── Effective global ∩ per-project RBAC
├── Collaborative Project API
├── Comments + Action History
├── SSE Events + Presence
└── Auth-gated sandboxed Spatial Editor
    └── AH2D Engine
        ├── Scene Graph + ECS
        ├── Transform / Camera / Lighting / Shadow
        ├── Animation / Post Process / Tilemap
        ├── Box2D adapter + deterministic fallback
        ├── PixiJS / PhaserJS / Custom adapters
        └── Agent-friendly CLI
```

فایل‌های اصلی:

- `AH2DEdtior.html`: خود Editor و Preview.
- `src/app`: پوستهٔ Next.js، صفحه‌های Login/Projects/Workspace و Route Handlerها.
- `src/lib/auth`: session، password hashing و RBAC سراسری.
- `src/lib/collaboration`: ذخیرهٔ پروژه، RBAC پروژه، comment، history، presence و event stream.
- `engine/AH2DEngine.js`: هستهٔ Runtime، ECS، Scene Graph و Physics.
- `engine/AH2DDataModel.js`: قرارداد واحد Entity/Component، رجیستری schema، validation، migration و codec سازگار با داده‌های قدیمی.
- `engine/cli/ah2d.js`: CLI بدون dependency برای Agent و CI.
- `engine/CLI.md`: مرجع کامل فرمان‌های CLI.
- `docs/COLLABORATION.md`: قرارداد کامل Auth، RBAC و API مشارکت.
- `docs/DEPLOYMENT.md`: اجرای Production و محدودیت storage محلی.
- `Agent.md`: راهنمای توسعهٔ بازی توسط Agent.
- `AGENTS.md`: دستورالعمل کوتاه و استاندارد Agentهای کدنویسی.

## شروع سریع

برای Studio به Node.js `20.9` یا جدیدتر نیاز دارید. ابتدا dependencyها و تنظیمات محلی را آماده کنید:

```powershell
Copy-Item .env.example .env.local
# مقادیر AH2D_AUTH_SECRET و حساب Owner را در .env.local تغییر دهید.
npm install
npm run dev
```

سپس `http://localhost:3000` را باز کنید. اگر auth store خالی باشد، حساب Owner هنگام نخستین Login از `AH2D_BOOTSTRAP_OWNER_*` ساخته می‌شود. رمز باید حداقل ۱۲ کاراکتر و `AH2D_AUTH_SECRET` حداقل ۳۲ بایت باشد.

Build و اجرای Production:

```powershell
npm run build
npm run start
```

### Docker

فایل `Dockerfile` یک image چندمرحله‌ای مبتنی بر خروجی standalone می‌سازد و سرویس را با User غیر root اجرا می‌کند. داده‌های Auth و Collaboration باید روی volume پایدار `/var/lib/ah2d` قرار بگیرند:

```bash
docker build -t ah2d-studio:latest .
docker volume create ah2d-data
docker run -d --name ah2d-studio --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env.production \
  -v ah2d-data:/var/lib/ah2d \
  ah2d-studio:latest
```

حداقل `.env.production` باید `AH2D_AUTH_SECRET` تصادفی با حداقل ۳۲ بایت، مشخصات Owner اولیه و origin دقیق HTTPS را داشته باشد:

```dotenv
AH2D_AUTH_SECRET=<at-least-32-random-bytes>
AH2D_BOOTSTRAP_OWNER_EMAIL=owner@example.com
AH2D_BOOTSTRAP_OWNER_PASSWORD=<long-unique-password>
AH2D_BOOTSTRAP_OWNER_NAME=Studio Owner
AH2D_ALLOWED_ORIGINS=https://studio.example.com
```

فایل env را commit نکنید و container را پشت reverse proxy دارای HTTPS اجرا کنید. مسیرهای storage داخل image به‌صورت پیش‌فرض روی `/var/lib/ah2d` تنظیم شده‌اند. deployment فعلی فقط یک container و یک Node process را پشتیبانی می‌کند؛ جزئیات backup، SSE و محدودیت scale در [راهنمای Deployment](./docs/DEPLOYMENT.md) آمده است.

Validation و تست کل Studio، Engine و CLI:

```powershell
npm run ah2d -- doctor --pretty
npm run ah2d -- capabilities --pretty
npm run check
npm test
```

برای استفادهٔ standalone و بدون Login/Collaboration هنوز می‌توانید `AH2DEdtior.html` را با یک static HTTP server باز کنید:

```powershell
python -m http.server 4173
```

سپس آدرس `http://127.0.0.1:4173/AH2DEdtior.html` را باز کنید.

## Studio مشارکتی، Auth و RBAC

Studio از session امضاشده در cookie با نام `ah2d_session` استفاده می‌کند. cookie از نوع `HttpOnly` و `SameSite=Strict` است و در Production فقط روی HTTPS ارسال می‌شود. Passwordها با `scrypt` و salt تصادفی hash می‌شوند؛ خود token در storage ذخیره نمی‌شود و فقط SHA-256 آن نگه‌داری می‌شود.

این Auth مربوط به کاربران و پروژه‌های hosted Studio است و به‌صورت خودکار وارد Runtime بازی exportشده نمی‌شود؛ بازی نهایی می‌تواند Identity Provider و backend متناسب با محصول خودش را انتخاب کند.

دو سطح نقش جداگانه وجود دارد:

- نقش سراسری حساب: `OWNER`، `ADMIN`، `EDITOR`، `COMMENTER` و `VIEWER`؛ برای provisioning حساب‌ها و مجوزهای سراسری.
- نقش عضویت پروژه: `owner`، `admin`، `editor`، `commenter` و `viewer`؛ برای document، comment، history، member و presence همان پروژه.

مجوز مؤثر، تقاطع permission نقش حساب و permission عضویت پروژه است؛ قوی‌بودن یکی، محدودیت دیگری را دور نمی‌زند. نقش سراسری به‌تنهایی دسترسی به همهٔ پروژه‌ها نمی‌دهد و کاربر باید عضو پروژه نیز باشد. سازندهٔ پروژه به‌طور خودکار `owner` آن پروژه می‌شود، ولی توان عملی او همچنان با نقش حساب محدود است.

نقش پروژه‌ای که به یک User داده می‌شود نیز نمی‌تواند از سقف نقش حساب آن User بالاتر باشد؛ برای نمونه حساب `COMMENTER` فقط می‌تواند `commenter` یا `viewer` پروژه باشد. ownership از Member API قابل‌اعطا نیست. جزئیات permission matrix، target-role cap، تمام Routeها، قرارداد optimistic revision، SSE و مثال‌های request در [`docs/COLLABORATION.md`](./docs/COLLABORATION.md) آمده است. تنظیم Production و جایگزینی file store محلی در [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) توضیح داده شده است.

Editor تعبیه‌شده فقط پس از Login تحویل داده می‌شود و در iframe با origin ایزوله (`opaque`)، sandbox محدود، CSP سخت‌گیرانه و bridge کنترل‌شده اجرا می‌شود. جزئیات این مرز امنیتی در سند Collaboration آمده است.

## خروجی‌های Editor

### Save، Load و Export

- `Save` و `Ctrl/Cmd + S` کل پروژه را در `localStorage` با کلید `AH2D.Project.v4` ذخیره می‌کنند.
- `Recent Project` ابتدا دادهٔ نسخهٔ ۴ و سپس کلید قدیمی `AH2D.Project.v3` را بررسی می‌کند.
- `Save Scene` صحنهٔ فعال را داخل پروژه commit می‌کند و سپس کل پروژه را در `localStorage` ذخیره می‌کند؛ فایل Scene جدا تولید نمی‌شود.
- `Export Universal JSON` فایل `AH2D_Project.json` را دانلود می‌کند. این فایل منبع اصلی و قابل‌حمل پروژه است.
- `Export Animation JSON` فایل `<clip>.animation.json` می‌سازد.
- `Export Particle JSON` فایل `<effect>.particle.json` می‌سازد.
- تصاویر Importشده به شکل Data URL/Base64 داخل JSON قرار می‌گیرند. این خروجی self-contained است، اما تصاویر بزرگ می‌توانند حجم فایل و مصرف `localStorage` را زیاد کنند.
- اگر هنگام Play ذخیره یا Export انجام شود، Editor وضعیت Authoring قبل از Play را می‌نویسد، نه Transformهای موقت حاصل از simulation.

### Universal Project در برابر ECS Snapshot

این دو خروجی هدف یکسانی ندارند:

| خروجی | نسخه | محتوا | کاربرد |
| --- | ---: | --- | --- |
| Editor Universal JSON | 4 | تمام Sceneها، assets، prefab workspace، animationها، particleها، Post Process و تنظیمات Engine | منبع اصلی پروژه، Save/Load و ادامهٔ ویرایش |
| `Engine.export()` یا `ah2d ecs export` | 3 | فقط Entity/Componentهای Scene فعال در Runtime | Debug، تست یا انتقال snapshot فعال |
| Animation asset | 1 | مشخصات clip و eventها | مصرف توسط سیستم animation بازی |
| Particle asset | 1 | پارامترهای emitter | مصرف توسط renderer/particle system بازی |

هیچ‌وقت فایل Universal نسخهٔ ۴ را با نتیجهٔ `Engine.export()` جایگزین نکنید؛ snapshot نسخهٔ ۳ Sceneها و resourceهای پروژه را ندارد.

### قرارداد واحد ECS و Component Schema

Universal Project نسخهٔ ۴ منبع حقیقت **Authoring** است. پروژه‌های جدید descriptor زیر را حمل می‌کنند تا مصرف‌کننده بتواند قرارداد ECS را مستقل از نسخهٔ فایل پروژه تشخیص دهد:

```json
{
  "dataModel": {
    "id": "ah2d.ecs",
    "version": 1,
    "componentSchemaVersion": 1
  }
}
```

`version: 4` نسخهٔ container پروژه و `componentSchemaVersion: 1` نسخهٔ schema مربوط به componentها است؛ این دو را با snapshot نسخهٔ `3` یکی نگیرید. descriptor در پروژه‌های جدید و ECS snapshotها صادر می‌شود. پروژهٔ قدیمیِ معتبر که `dataModel` ندارد همچنان در حالت سازگار خوانده می‌شود و migration صرفاً برای افزودن descriptor، storage موجود را بازنویسی نمی‌کند.

یک component سه profile دارد:

| Profile | کاربرد | فیلدهای مشتق‌شدهٔ Runtime |
| --- | --- | --- |
| `authoring` | دادهٔ قابل‌ویرایش و قابل‌ذخیره در Universal Project | حذف می‌شوند؛ فیلدهای ناشناختهٔ JSON حفظ می‌شوند |
| `runtime` | مقدار normalizeشده‌ای که Engine و systemها مصرف می‌کنند | مجازند، مانند `Transform.world` و جرم/اینرسی مشتق‌شده |
| `snapshot` | وضعیت فعال ECS در `Engine.export()` / `ah2d ecs export` | برای بازسازی وضعیت Runtime حفظ می‌شوند |

حالت `compat` برای بررسی پروژه‌های قدیمی، رشته‌های عددی/بولی را از نظر schema می‌پذیرد اما آن‌ها را تبدیل نمی‌کند؛ مسیر `runtime` عمداً strict است. بنابراین پیش از اجرای Engine باید این مقادیر در Authoring به نوع واقعی `number`/`boolean` تبدیل شوند یا validation با `--strict` اجرا شود.

مقادیر component باید object یا array و کاملاً JSON-serializable باشند؛ function، `undefined`، عدد غیرمتناهی، object با prototype خاص و reference دوری رد می‌شوند. نام componentها PascalCase امن (`^[A-Z][A-Za-z0-9]*$`) است.

#### precedence، storage و provenance

یک component built-in ممکن است هم در dialect تخت Editor و هم در `components` وجود داشته باشد. ترتیب resolution همیشه چنین است:

1. `components.<CanonicalName>`؛ سپس aliasهای ثبت‌شده در `components`، مانند `components.RigidBody` یا `components.Body`.
2. محل‌های legacy/تخت همان component، مانند `transform` یا `x/y/rot/sx/sy`، `rigidbody`/`rigidBody` و `collider`.

پس `components.*` بر legacy precedence دارد. اگر دو محل مقدار متفاوتی داشته باشند، API/CLI محل انتخاب‌شده را در `storage` و `provenance` برمی‌گرداند و conflict را گزارش می‌کند؛ validation عادی آن را warning و `--strict` آن را error می‌داند. mutationهای `component put|set|patch|delete` provenance موجود را حفظ می‌کنند و فقط همان محل مؤثر را تغییر می‌دهند. مقدار legacy دیگر و تمام componentها/فیلدهای ناشناخته دست‌نخورده می‌مانند. برای canonicalization صریح می‌توان از API codec با storage برابر `canonical` استفاده کرد؛ migration پروژه storage را صرفاً برای یکدست‌سازی جابه‌جا نمی‌کند.

در storage فشردهٔ flat، `Transform` و `Renderable` روی خود Entity پخش شده‌اند؛ به همین دلیل نوشتن مقدار جدید، propertyهای sibling حذف‌شده را نگه می‌دارد. در `components.*`، مقدار component به‌طور کامل جایگزین می‌شود. برای تغییر فیلدی از `patch` و برای replace کاملاً مستقل از canonical storage استفاده کنید.

Registry پیش‌فرض این componentها را می‌شناسد: `Name`، `Transform`، `Renderable`، `Rigidbody` (با aliasهای `RigidBody` و `Body`)، `Collider`، `Hidden`، `Locked`، `PrefabInstance`، `Camera`، `Light`، `ShadowCaster`، `Animation`، `Tilemap`، `ParticleEmitter`، `BoxCollider`، `BoxCollider2D`، `CircleCollider` و `CircleCollider2D`. registry به‌صورت پیش‌فرض open-world است: component سفارشیِ PascalCase زیر `components.<Type>` حفظ و به‌عنوان object/array اعتبارسنجی می‌شود، حتی اگر هنوز schema اختصاصی ثبت نشده باشد.

### ساختار Universal JSON

نمونهٔ فشردهٔ خروجی واقعی Editor:

```json
{
  "format": "AH2D",
  "version": 4,
  "dataModel": {
    "id": "ah2d.ecs",
    "version": 1,
    "componentSchemaVersion": 1
  },
  "engine": {
    "name": "AH2D Engine",
    "version": "0.3.0",
    "renderer": "custom",
    "runtime": "custom",
    "runtimeBackend": "custom",
    "physics": "box2d",
    "physicsBackend": "builtin",
    "gravity": { "x": 0, "y": 980 },
    "pixelsPerMeter": 100,
    "compatibleRuntimes": ["pixijs", "phaserjs", "custom"]
  },
  "meta": {
    "name": "Demo Project",
    "units": "px",
    "currentSceneId": "level-1"
  },
  "currentSceneId": "level-1",
  "scenes": [
    {
      "id": "level-1",
      "name": "Level 1",
      "objects": [],
      "updatedAt": 1789257600000,
      "view": { "zoom": 1, "pan": { "x": 0, "y": 0 } }
    }
  ],
  "scene": [],
  "postProcess": {
    "enabled": true,
    "effects": [
      { "id": "bloom", "type": "bloom", "name": "Bloom", "enabled": false, "intensity": 0.22, "radius": 8, "threshold": 0.72 },
      { "id": "vignette", "type": "vignette", "name": "Vignette", "enabled": true, "intensity": 0.24, "softness": 0.68 },
      { "id": "color-adjust", "type": "colorAdjust", "name": "Color Adjust", "enabled": true, "brightness": 1, "contrast": 1, "saturation": 1, "hue": 0 },
      { "id": "chromatic-aberration", "type": "chromaticAberration", "name": "Chromatic Aberration", "enabled": false, "amount": 3, "intensity": 0.32 },
      { "id": "pixelate", "type": "pixelate", "name": "Pixelate", "enabled": false, "size": 4 },
      { "id": "crt", "type": "crt", "name": "CRT", "enabled": false, "scanlines": 0.18, "noise": 0.04, "curvature": 0.12 }
    ]
  },
  "assets": [],
  "folders": ["Environment", "Characters", "FX", "UI", "Prefabs", "Animations"],
  "prefab": [],
  "animations": [],
  "particles": []
}
```

`scenes` نمایش اصلی Multi-Scene است. کلید `scene` فقط آینهٔ سازگاری از `objects` صحنهٔ فعال است. CLI بعد از هر تغییر این آینه را هماهنگ می‌کند.

### Post Process قابل‌ویرایش هر پروژه

هر پروژه یک stack مستقل در `postProcess` دارد. پروژهٔ تازه شش effect پیش‌فرض `Bloom`، `Vignette`، `Color Adjust`، `Chromatic Aberration`، `Pixelate` و `CRT` دریافت می‌کند؛ فعال‌بودن و مقدارهای هر effect در همان Universal JSON ذخیره می‌شود. دکمهٔ Post Process بالای Scene، master toggle، sliderها و `Reset Defaults` را در اختیار کاربر قرار می‌دهد و Preview در لحظه به‌روز می‌شود.

API Runtime:

```js
engine.postProcess.load(project.postProcess);
engine.postProcess.configure('bloom', { enabled: true, intensity: 0.5 });
engine.postProcess.configure('colorAdjust', { saturation: 1.2, hue: 12 });

console.log(engine.postProcess.get('vignette'));
console.log(engine.postProcess.active);
project.postProcess = engine.postProcess.toJSON();

engine.events.on('postprocess:change', ({ postProcess }) => {
  renderer.applyPostProcess(postProcess.active);
});
```

`engine.postProcess.reset()` stack اولیه را برمی‌گرداند. Editor فیلترهای Canvas خود را اعمال می‌کند؛ در Runtimeهای PixiJS، PhaserJS و Custom، host باید effectهای موجود در `engine.postProcess.active` را به filter/shader همان renderer نگاشت کند.

CLI هنگام `init` همین defaultها را اضافه می‌کند، `migrate` پروژهٔ فاقد `postProcess` را تکمیل می‌کند و `validate` ساختار effectها را بررسی می‌کند. برای ویرایش امن می‌توان از JSON Patch استفاده کرد:

```json
[
  { "op": "replace", "path": "/postProcess/effects/0/enabled", "value": true },
  { "op": "replace", "path": "/postProcess/effects/0/intensity", "value": 0.5 }
]
```

```powershell
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- patch --file game.ah2d.json --patch @postprocess.patch.json --dry-run --include-document --pretty
npm run ah2d -- patch --file game.ah2d.json --patch @postprocess.patch.json --write --expect-sha256 <sha256>
```

هر Scene ساختار زیر را دارد:

```js
{
  id: 'level-1',              // شناسهٔ پایدار و یکتا
  name: 'Level 1',
  objects: [],                // Game Objectها
  updatedAt: 1789257600000,
  view: {
    zoom: 1,                  // 0.25 .. 4 در Editor
    pan: { x: 0, y: 0 }
  }
}
```

### Game Object

```js
{
  id: 'player',
  name: 'Player',
  kind: 'character',
  icon: '🛡️',                 // فقط دادهٔ Authoring/UI
  x: 320,
  y: 180,
  w: 64,
  h: 96,
  rot: 0,                     // درجه
  sx: 1,
  sy: 1,
  layer: 10,
  color: '#ffffff',
  visible: true,
  locked: false,
  tag: 'Player',
  parentId: null,             // اختیاری؛ ID والد در همین Scene
  assetId: 'player-image',    // اختیاری
  imageSrc: 'data:image/png;base64,...',
  prefab: false,
  rigidbody: {},              // اختیاری
  collider: {},               // اختیاری
  components: {               // برای componentهای سفارشی Runtime
    PlayerController: { speed: 260 }
  }
}
```

قرارداد Editor برای Transform از `x/y/rot/sx/sy` و قرارداد canonical از `x/y/rotation/scaleX/scaleY` استفاده می‌کند. این مقادیر **همیشه local نسبت به `parentId`** هستند؛ برای Entity ریشه، local و world برابرند. `Engine.createEntity()` dialect ذخیره‌شده را به Component `Transform` تبدیل می‌کند و `parentId` را وارد Scene Graph می‌کند.

ماتریس `Transform.world` با ترتیب root-to-leaf از ضرب world والد در local فرزند محاسبه می‌شود و فیلدی مشتق‌شده در profileهای Runtime/Snapshot است؛ آن را در Universal Authoring JSON منبع حقیقت نکنید. محور `+Y` در Editor رو به پایین، rotation بر حسب درجه و ماتریس‌ها Canvas-style به شکل `[a,b,c,d,e,f]` هستند.

Shortcutهای ورودی و component متناظر در Runtime:

| دادهٔ Editor | Component در ECS |
| --- | --- |
| `name` | `Name` |
| `x/y/rot/sx/sy` | `Transform` |
| `kind/w/h/color/assetId/imageSrc` | `Renderable` |
| `visible: false` | `Hidden` |
| `locked: true` | `Locked` |
| `prefab: true` | `PrefabInstance` |
| `rigidbody` یا `rigidBody` | `Rigidbody` |
| `collider` | `Collider` |
| `components.*` | component canonical یا سفارشی؛ در تداخل با shortcutهای بالا precedence دارد |

## کار امن با پروژه از طریق CLI

ابتدا قابلیت‌ها و schema را از خود CLI بخوانید:

```powershell
npm run ah2d -- capabilities --pretty
npm run ah2d -- schema list --pretty
npm run ah2d -- schema show --name project --pretty
npm run ah2d -- schema show --component Transform --pretty
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
```

برای تغییر، ابتدا Dry Run و سپس write همراه hash انجام دهید:

```powershell
npm run ah2d -- entity create --file game.ah2d.json --scene level-1 --id player --name Player --x 320 --y 180 --dry-run --include-document --pretty
npm run ah2d -- entity create --file game.ah2d.json --scene level-1 --id player --name Player --x 320 --y 180 --write --expect-sha256 <hash>
```

برای مشاهدهٔ hierarchy واقعی و Transformهای مشتق‌شده، سپس جابه‌جایی parent بدون تغییر ظاهر:

```powershell
npm run ah2d -- entity tree --file game.ah2d.json --scene level-1 --world --pretty
npm run ah2d -- entity reparent --file game.ah2d.json --scene level-1 sword player --preserve-world --dry-run --include-document --pretty
npm run ah2d -- entity reparent --file game.ah2d.json --scene level-1 sword player --preserve-world --write --expect-sha256 <hash>
```

بدون `--preserve-world`، دستور Reparent برای سازگاری قبلی local Transform را ثابت نگه می‌دارد؛ `--preserve-local` همین رفتار را صریح می‌کند.

برای چند تغییر وابسته از Batch اتمیک استفاده کنید:

```json
[
  { "op": "entity.create", "sceneId": "level-1", "id": "player", "name": "Player", "kind": "character", "x": 320, "y": 180 },
  { "op": "component.put", "sceneId": "level-1", "entityId": "player", "component": "Rigidbody" },
  { "op": "component.patch", "sceneId": "level-1", "entityId": "player", "component": "Rigidbody", "patch": { "mass": 1, "gravityScale": 1 } },
  { "op": "component.put", "sceneId": "level-1", "entityId": "player", "component": "Collider", "value": { "shape": "rectangle", "width": 64, "height": 96 } }
]
```

```powershell
npm run ah2d -- apply --file game.ah2d.json --ops @operations.json --dry-run --include-document --pretty
npm run ah2d -- apply --file game.ah2d.json --ops @operations.json --write --expect-sha256 <hash>
```

مرجع همهٔ commandها در [`engine/CLI.md`](./engine/CLI.md) قرار دارد.

## کدنویسی بازی با AH2D Engine

### ساختار پیشنهادی بازی

```text
my-game/
├── index.html
├── game.ah2d.json
├── engine/
│   ├── AH2DDataModel.js
│   └── AH2DEngine.js
├── src/
│   ├── main.js
│   ├── input.js
│   ├── gameplay.js
│   ├── renderer.js
│   └── scenes.js
└── tests/
    └── gameplay.test.js
```

منطق بازی را داخل `AH2DEdtior.html` قرار ندهید. Editor ابزار Authoring است؛ کد gameplay باید در فایل‌های بازی باشد و پروژهٔ JSON را به‌عنوان data بخواند.

### بارگذاری در Browser

```html
<!doctype html>
<html lang="fa">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>My AH2D Game</title>
    <style>
      html, body { margin: 0; height: 100%; background: #0b1220; }
      canvas { width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <canvas id="game" width="1920" height="1080"></canvas>
    <script src="./engine/AH2DDataModel.js"></script>
    <script src="./engine/AH2DEngine.js"></script>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
```

```js
// src/main.js
const { AH2D } = window;
const project = await fetch('../game.ah2d.json').then(response => {
  if (!response.ok) throw new Error(`Project load failed: ${response.status}`);
  return response.json();
});

const engine = new AH2D.Engine({
  physics: 'builtin',
  gravity: project.engine?.gravity ?? { x: 0, y: 980 },
  physicsOptions: {
    pixelsPerMeter: project.engine?.pixelsPerMeter ?? 100,
    maxStep: 1 / 120
  }
});

engine.load(project);
const authoredScene = project.scenes.find(scene => scene.id === engine.activeSceneId);
for (const object of authoredScene?.objects || []) {
  engine.ecs.add(object.id, 'RenderOrder', { layer: object.layer ?? 0 });
}
engine.update(0); // ساخت bodyهای Physics بدون جلو رفتن زمان

console.log('Scene:', engine.activeSceneId);
console.log('Entities:', [...engine.ecs.entities]);
```

در Browser، `AH2DDataModel.js` قرارداد را روی `window.AH2DDataModel` و `AH2DEngine.js` API اجرا را روی `window.AH2D` قرار می‌دهد؛ در Node، خود Engine وابستگی DataModel را با `require` بارگذاری می‌کند.

### حلقهٔ بازی و Custom Canvas Renderer

برای game logic که باید پیش از Physics اجرا شود، حلقهٔ دستی واضح‌ترین مدل است:

```js
const canvas = document.querySelector('#game');
const context = canvas.getContext('2d');
const pressed = new Set();
const imageCache = new Map();
const PLAYER_ID = 'player';

addEventListener('keydown', event => pressed.add(event.code));
addEventListener('keyup', event => pressed.delete(event.code));

function imageFor(source) {
  if (!source) return null;
  if (!imageCache.has(source)) {
    const image = new Image();
    image.src = source;
    imageCache.set(source, image);
  }
  return imageCache.get(source);
}

function updateGameplay() {
  const body = engine.physics.getBody(PLAYER_ID);
  if (!body) return;

  const horizontal = Number(pressed.has('ArrowRight')) - Number(pressed.has('ArrowLeft'));
  engine.physics.setVelocity(PLAYER_ID, horizontal * 260, body.velocity.y);
}

function draw() {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);

  const ids = engine.ecs.query('Transform', 'Renderable').sort((left, right) => {
    const a = engine.ecs.get(left, 'RenderOrder')?.layer ?? 0;
    const b = engine.ecs.get(right, 'RenderOrder')?.layer ?? 0;
    return a - b;
  });
  for (const id of ids) {
    if (engine.ecs.has(id, 'Hidden')) continue;

    const transform = engine.ecs.get(id, 'Transform');
    const renderable = engine.ecs.get(id, 'Renderable');
    const [a, b, c, d, x, y] = transform.world;
    const width = renderable.width || 64;
    const height = renderable.height || 64;
    const image = imageFor(renderable.imageSrc);

    context.save();
    context.setTransform(a, b, c, d, x, y);
    if (image?.complete && image.naturalWidth) {
      context.drawImage(image, -width / 2, -height / 2, width, height);
    } else {
      context.fillStyle = renderable.color || '#ffffff';
      context.fillRect(-width / 2, -height / 2, width, height);
    }
    context.restore();
  }
}

let previousTime = performance.now();
function frame(time) {
  const dt = Math.min(0.05, (time - previousTime) / 1000);
  previousTime = time;

  updateGameplay(dt); // پیش از Physics
  engine.update(dt);
  draw();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
```

`Transform.world` یک ماتریس Canvas-style به شکل `[a,b,c,d,e,f]` است. اگر از حلقهٔ دستی استفاده می‌کنید، هم‌زمان `engine.start()` را فراخوانی نکنید؛ هر Frame باید فقط یک بار `engine.update(dt)` اجرا شود.

### چرخهٔ Play / Pause / Stop

وقتی می‌خواهید خود Engine حلقهٔ Frame را مدیریت کند، یک Custom Runtime بدهید:

```js
const engine = new AH2D.Engine({
  runtime: 'custom',
  runtimeOptions: {
    mount(engine, target) {
      console.log('Mounted on', target);
    },
    render(engine, alpha) {
      drawWorld(engine, alpha);
    },
    destroy() {
      console.log('Renderer destroyed');
    }
  }
});

engine.load(project);
engine.start(canvas, { restoreOnStop: false });
engine.pause();
engine.resume();
engine.stop({ restore: false });
```

به‌صورت پیش‌فرض `start()` یک runtime snapshot می‌گیرد و `stop()` آن را restore می‌کند. این snapshot فقط ECS فعال است و Universal Multi-Scene Project نیست؛ بنابراین برای یک بازی Multi-Scene معمولاً `restoreOnStop: false` مناسب‌تر است. اگر Preview باید به حالت Authoring برگردد، سند اصلی `project` را نزد host نگه دارید و هنگام Stop دوباره `engine.load(project)` را صدا بزنید. گزینهٔ `snapshot: false` گرفتن snapshot را کاملاً غیرفعال می‌کند.

### ساخت Entity و Component سفارشی

```js
const enemyId = engine.createEntity({
  id: 'enemy-01',
  name: 'Slime',
  x: 640,
  y: 420,
  kind: 'enemy',
  w: 72,
  h: 54,
  color: '#70d68b',
  components: {
    Health: { current: 30, maximum: 30 },
    EnemyAI: { state: 'idle', detectionRadius: 260 }
  },
  rigidbody: {
    type: 'dynamic',
    mass: 1,
    gravityScale: 1,
    fixedRotation: true
  },
  collider: {
    shape: 'circle',
    radius: 27,
    friction: 0.4,
    restitution: 0
  }
});

engine.ecs.add(enemyId, 'Damage', { amount: 5 });
const health = engine.ecs.get(enemyId, 'Health');
health.current -= engine.ecs.get(enemyId, 'Damage').amount;

for (const id of engine.ecs.query('Health', 'EnemyAI')) {
  updateEnemy(id, engine.ecs.get(id, 'EnemyAI'));
}

engine.ecs.remove(enemyId, 'Damage');
```

Componentها باید object/array کاملاً JSON-safe باشند. Function، `undefined`، `NaN`/`Infinity`، DOM node، texture/class instance یا referenceهای circular را داخل component ذخیره نکنید؛ resourceهای Runtime را در Mapهای جدا و بر اساس Entity ID نگه دارید.

Registry پیش‌فرض open-world است و `Health`/`EnemyAI` را با schema عمومی حفظ می‌کند. برای defaults و validation دقیق، component سفارشی را پیش از load/create ثبت کنید:

```js
engine.registerComponent({
  type: 'Health',
  schemaVersion: 1,
  schemas: {
    authoring: {
      type: 'object',
      required: ['current', 'maximum'],
      properties: {
        current: { type: 'number', minimum: 0 },
        maximum: { type: 'number', exclusiveMinimum: 0 }
      },
      additionalProperties: true
    }
  },
  defaults: { current: 100, maximum: 100 }
});
```

اگر schemaهای `runtime` یا `snapshot` داده نشوند، از `authoring` ارث می‌برند. definition همچنین می‌تواند `aliases`، `runtimeOnlyFields`، `normalize`، `storage` و migrationهای ترتیبی داشته باشد. برای policy بسته، `new AH2D.ComponentSchemaRegistry({ openWorld: false })` بسازید و آن را با گزینهٔ `componentSchemas` به Engine بدهید. CLI مستقل، registry built-in و schema عمومی componentهای سفارشی را می‌شناسد ولی کد registration بازی را اجرا نمی‌کند.

### Parent / Child و Scene Graph

```js
engine.createEntity({ id: 'player', name: 'Player', x: 300, y: 300 });
engine.createEntity({
  id: 'weapon',
  name: 'Sword',
  parentId: 'player',
  x: 32, // local نسبت به player
  y: 0
});

console.log(engine.graph.getParent('weapon'));   // player
console.log(engine.graph.getChildren('player')); // ['weapon']
console.log(engine.transform.getLocal('weapon'));
console.log(engine.transform.getLocalMatrix('weapon'));
console.log(engine.transform.getWorldMatrix('weapon')); // [a,b,c,d,e,f]

// child سپس parent؛ local ثابت می‌ماند و ممکن است world عوض شود.
engine.graph.attach('weapon', 'vehicle');

// world ثابت می‌ماند و local جدید دقیقاً محاسبه می‌شود.
engine.reparent('weapon', 'player', { preserveWorld: true });
engine.graph.detach('weapon', { preserveWorld: true });

engine.graph.traverse(null, (id, { depth, parentId, path }) => {
  console.log({ id, depth, parentId, path });
});
console.log(engine.graph.ancestors('weapon'));
console.log(engine.graph.descendants('player'));

const worldPoint = engine.transform.localToWorld('weapon', { x: 8, y: 0 });
const localPoint = engine.transform.worldToLocal('weapon', worldPoint);

engine.transform.setLocal('weapon', { x: 48, rotation: 15 });
engine.transform.setWorld('weapon', { x: 500, y: 240 });
```

`x/y/rotation/scaleX/scaleY` وضعیت local و `Transform.world`/خروجی `getWorldMatrix()` وضعیت مشتق‌شده است. تغییر مستقیم مقدار local یک Component در update بعدی تشخیص داده می‌شود؛ برای کد شفاف‌تر از `setLocal()` استفاده کنید. `setWorld()` مقدار world دلخواه را با inverse world والد به local تبدیل می‌کند.

ماتریس world مرجع دقیق رندر است. ترکیب rotation با scale غیرهمسان در چند سطح ممکن است world shear بسازد؛ در آن حالت decomposition به TRS یکتا/دقیق نیست. عملیات‌هایی که نیازمند decomposition دقیق هستند با `E_TRANSFORM_SHEAR` رد می‌شوند. parent با scale صفر نیز برای preserve-world یا تبدیل world-to-local قابل‌معکوس نیست و `E_NON_INVERTIBLE_TRANSFORM` می‌دهد.
در همگام‌سازی Physics، انتقال مکانیِ فرزند dynamic زیر والد دارای scale غیرهمسان یا reflection با ماتریس world انجام می‌شود و امن است؛ اما angular motion اگر برای بازنویسی local Transform به shear نیاز داشته باشد با `E_TRANSFORM_SHEAR` رد می‌شود و Engine آن را تقریبی نمی‌کند. برای bodyهای physics-driven که آزادانه می‌چرخند، والد بدون non-uniform/reflected scale یا یک root مستقل انتخاب کنید.


Scene Graph از hierarchy با عمق دلخواه، traversal پیش‌/پس‌ترتیب، ancestor/descendant و چند root پشتیبانی می‌کند و self-parent، parent گمشده و cycle را رد می‌کند. برای حذف امن Runtime Entity از `engine.destroyEntity(id, { childPolicy })` استفاده کنید: policy پیش‌فرض `reject` است؛ `cascade` کل subtree را حذف می‌کند، `reparent` فرزندان مستقیم را به والد قبلی می‌برد و `detach`/`root` آن‌ها را root می‌کند. برای دو policy آخر می‌توان `preserveWorld: true` داد.

برای تغییر دائمی hierarchy در Universal Project از `entity reparent` در CLI و برای مشاهدهٔ local/world مشتق‌شده از `entity tree --world` استفاده کنید.

### Multi-Scene و تغییر Level

```js
engine.events.on('scene:change', ({ id, name }) => {
  console.log(`Entered ${name} (${id})`);
});

engine.load(project);           // currentSceneId را بارگذاری می‌کند
engine.loadScene('boss-room');  // از engine.document Scene دیگری را بارگذاری می‌کند
```

`loadScene()` Runtime را از نسخهٔ موجود در `engine.document` دوباره می‌سازد. تغییرات موقت Runtime به‌طور خودکار داخل Universal Project نوشته نمی‌شوند؛ ذخیرهٔ Authoring باید از Editor یا CLI انجام شود.

### Rigidbody و Collider

Rigidbody نمونه:

```js
{
  enabled: true,
  type: 'dynamic',             // static | dynamic | kinematic
  mass: 1,
  useAutoMass: false,
  gravityScale: 1,
  linearDamping: 0.08,
  angularDamping: 0.08,
  velocityX: 0,
  velocityY: 0,
  angularVelocity: 0,          // درجه بر ثانیه
  fixedRotation: false,
  bullet: false,
  allowSleep: true,
  sleeping: false
}
```

Collider نمونه:

```js
{
  enabled: true,
  shape: 'rectangle',          // rectangle/box | circle
  width: 64,
  height: 96,
  radius: 32,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  density: 1,
  friction: 0.35,
  restitution: 0.05,
  isTrigger: false,
  categoryBits: 1,
  maskBits: 65535,
  groupIndex: 0
}
```

Entity دارای Collider و بدون Rigidbody به‌صورت static رفتار می‌کند. API کنترل Physics:

```js
engine.update(0); // bodyها را با ECS sync می‌کند

engine.physics.setGravity({ x: 0, y: 980 });
engine.physics.setVelocity('player', 180, 0);
engine.physics.setAngularVelocity('crate', 45);
engine.physics.applyForce('player', { x: 500, y: 0 });
engine.physics.applyImpulse('player', 0, -420);
engine.physics.applyTorque('crate', 80);
engine.physics.setTransform('player', 320, 180, 0);
engine.physics.wake('player');
engine.physics.sleep('crate');
```

در صورت فراهم بودن API سازگار Box2D/Planck، `Box2DPhysicsAdapter` از آن استفاده می‌کند. در غیر این صورت backend داخلی deterministic فعال می‌شود. `engine.physics.backend` اجرای واقعی را گزارش می‌دهد.

### Collision و Trigger

```js
const unsubscribeCollision = engine.events.on(
  'physics:collisionstart',
  ({ a, b, normal, point }) => {
    if ([a, b].includes('player')) {
      console.log('Player collision', { a, b, normal, point });
    }
  }
);

let requestedScene = null;
const unsubscribeTrigger = engine.events.on(
  'physics:triggerenter',
  ({ a, b }) => {
    if ([a, b].includes('exit-zone')) requestedScene = 'level-2';
  }
);

// پس از پایان engine.update(dt)، بیرون callback فیزیک:
if (requestedScene) {
  engine.loadScene(requestedScene);
  requestedScene = null;
}

// در زمان destroy شدن Scene یا Game:
unsubscribeCollision();
unsubscribeTrigger();
```

رویدادهای موجود:

- `physics:collisionstart`, `physics:collisionstay`, `physics:collisionend`
- `physics:triggerenter`, `physics:triggerstay`, `physics:triggerexit`
- `physics:contact` برای دریافت همهٔ contactها

Payload شامل `a`, `b`, `bodyA`, `bodyB`, `colliderA`, `colliderB`, `normal`, `penetration`, `point`, `phase` و `trigger` است.

### Animation

AnimationSystem فعلی clock را جلو می‌برد؛ تعویض Sprite Frame را renderer بازی انجام می‌دهد:

```js
engine.ecs.add('player', 'Animation', {
  clip: 'Knight_Run',
  playing: true,
  time: 0,
  duration: 0.8,
  speed: 1,
  loop: true,
  frameCount: 12
});

function animationFrame(entityId) {
  const animation = engine.ecs.get(entityId, 'Animation');
  const normalized = animation.duration > 0
    ? (animation.time % animation.duration) / animation.duration
    : 0;
  return Math.floor(normalized * animation.frameCount) % animation.frameCount;
}
```

فایل مستقل Animation فعلی شامل `name`, `fps`, `frames`, `loop` و `events` است. اتصال frameها به sprite sheet، interpolation و اجرای eventها مسئولیت کد بازی/renderer است.

### Camera، Light، Shadow و Tilemap

```js
engine.ecs.add('camera-main', 'Camera', { zoom: 1, viewportWidth: 1920, viewportHeight: 1080 });
engine.camera.setActive('camera-main');
console.log(engine.camera.view);

engine.lighting.ambient = { color: '#bcd8ff', intensity: 0.35 };
engine.ecs.add('lamp', 'Light', { color: '#ffd27a', intensity: 1.2, radius: 260 });
console.log(engine.lighting.lights);

engine.ecs.add('crate', 'ShadowCaster', { opacity: 0.45 });
console.log(engine.shadows.collect());

engine.ecs.add('map', 'Tilemap', {
  tileWidth: 32,
  tileHeight: 32,
  tiles: [[0, 0, 1], [1, 1, 1]]
});
engine.tilemap.setTile('map', 1, 0, 2);
console.log(engine.tilemap.tileAt('map', 1, 0)); // 2
```

Camera/Light/Shadow داده و collection فراهم می‌کنند؛ renderer باید zoom، نور و سایه را اعمال کند.

### Custom Runtime

```js
engine.useRuntime('custom', {
  mount(engine, target) {
    renderer.attach(target);
  },
  render(engine, alpha) {
    renderer.draw(engine.ecs, engine.camera.view, alpha);
  },
  destroy() {
    renderer.dispose();
  }
});
```

### PixiJS Runtime

```js
engine.useRuntime('pixijs', { PIXI: window.PIXI });
console.log(engine.runtime.name);    // pixijs
console.log(engine.runtime.backend); // pixijs یا editor-bridge

for (const id of engine.ecs.query('Transform', 'Renderable')) {
  const transform = engine.ecs.get(id, 'Transform');
  const renderable = engine.ecs.get(id, 'Renderable');
  syncPixiDisplayObject(id, transform, renderable);
}
```

### PhaserJS Runtime

```js
engine.useRuntime('phaserjs', { Phaser: window.Phaser });

class GameScene extends Phaser.Scene {
  create() {
    engine.load(project);
    engine.update(0);
    createPhaserObjectsFromECS(this, engine.ecs);
  }

  update(_time, deltaMilliseconds) {
    const dt = Math.min(0.05, deltaMilliseconds / 1000);
    updateGameplay(dt);
    engine.update(dt);
    syncPhaserObjectsFromECS(this, engine.ecs);
  }
}
```

آداپترهای PixiJS و PhaserJS در نسخهٔ فعلی انتخاب Runtime و قرارداد host را فراهم می‌کنند، اما خودشان Spriteها را از ECS ایجاد یا Render نمی‌کنند. توابع نگاشت مانند `syncPixiDisplayObject` و `createPhaserObjectsFromECS` باید در پروژهٔ بازی پیاده شوند.

### اجرای Headless در Node.js

برای تست gameplay، simulation سرور یا CI:

```js
// tests/simulation.js
global.window = global;
require('../engine/AH2DEngine.js');

const fs = require('node:fs');
const project = JSON.parse(fs.readFileSync('game.ah2d.json', 'utf8'));
const engine = new global.AH2D.Engine({
  physics: 'builtin',
  gravity: project.engine?.gravity
});

engine.load(project, { sceneId: 'level-1' });
for (let frame = 0; frame < 600; frame += 1) {
  updateHeadlessGameplay(engine, 1 / 60);
  engine.update(1 / 60);
}

console.log(engine.export()); // فقط snapshot فعال ECS
```

CLI نیز simulation ثابت و تکرارپذیر ارائه می‌کند:

```powershell
npm run ah2d -- simulate --file game.ah2d.json --scene level-1 --steps 600 --dt 0.0166666667 --pretty
```

## API سریع

```js
new AH2D.Engine(options)
engine.registerComponent(definition)
engine.load(project, { sceneId })
engine.loadScene(sceneId)
engine.reparent(childId, parentId, options)
engine.destroyEntity(id, options)
engine.createEntity(data)
engine.update(dt)
engine.start(target, options)
engine.pause()
engine.resume()
engine.stop(options)
engine.captureSnapshot()
engine.restoreSnapshot(snapshot)
engine.export()

engine.ecs.create(id)
engine.ecs.destroy(id)
engine.ecs.add(id, type, value)
engine.ecs.get(id, type)
engine.ecs.has(id, type)
engine.ecs.remove(id, type)
engine.ecs.query(...types)

engine.graph.attach(childId, parentId, { preserveWorld })
engine.graph.reparent(childId, parentId, { preserveWorld })
engine.graph.detach(childId, { preserveWorld })
engine.graph.getParent(id)
engine.graph.getChildren(id)
engine.graph.roots()
engine.graph.ancestors(id, options)
engine.graph.descendants(id, options)
engine.graph.traverse(root, visitor, options)

engine.transform.getLocal(id)
engine.transform.getLocalMatrix(id)
engine.transform.getWorldTransform(id)
engine.transform.getWorldMatrix(id)
engine.transform.setLocal(id, transformOrMatrix)
engine.transform.setWorld(id, transformOrMatrix)
engine.transform.localToWorld(id, point)
engine.transform.worldToLocal(id, point)
AH2D.Matrix2D

engine.postProcess.load(config)
engine.postProcess.get(idOrType)
engine.postProcess.configure(idOrType, values)
engine.postProcess.reset()
engine.postProcess.toJSON()
engine.postProcess.active

engine.events.on(type, callback) // تابع unsubscribe برمی‌گرداند
engine.events.emit(type, payload)
```

`engine.update(dt)` مقدار `dt` را در بازهٔ `0..0.25` محدود می‌کند. سیستم Script/Behavior scheduler داخلی هنوز وجود ندارد؛ systemهای gameplay را در حلقهٔ دستی قبل از `engine.update(dt)` یا با listener رویداد `engine:update` اجرا کنید. listener دوم بعد از systemهای داخلی اجرا می‌شود و برای تغییرات frame بعد مناسب است.

`engine.ecs.destroy(id)` API سطح پایین ECS است و به‌تنهایی hierarchy یا body فیزیک را مدیریت نمی‌کند. در کد بازی از `engine.destroyEntity(id, { childPolicy: 'reject' | 'cascade' | 'reparent' | 'detach' })` استفاده کنید تا Scene Graph، ECS، Transform cache و bodyهای Physics در همان lifecycle operation هماهنگ پاک‌سازی شوند.

## وضعیت فعلی Authoring Assetها

- نام پروژه در خروجی مستقیم Editor فعلاً `Demo Project` است؛ CLI می‌تواند `meta.name` را بدون از دست رفتن داده تغییر دهد.
- Loader فعلی Editor ساختار top-level را بازسازی می‌کند؛ فیلدهای ناشناختهٔ داخل Entity حفظ می‌شوند، اما فیلدهای ناشناختهٔ top-level/Scene/meta/engine تضمین‌شده نیستند. برای mutation بدون اتلاف از CLI استفاده کنید.
- Project Load فقط `particles[0]` را بازیابی می‌کند و `animations` را هنوز به state ادیتور برنمی‌گرداند. Assetها نیز بر اساس ID merge می‌شوند.
- standalone animation/particle JSON ورودی مستقیم Project Load نیستند.
- layout پنل‌ها، selection، undo history، grid/snap، commentهای محلی داخل canvas و وضعیت دوربین Prefab در Universal JSON ذخیره نمی‌شوند. Commentهای مشارکتی Studio جداگانه در Project API ذخیره می‌شوند.
- `prefab` فعلاً یک workspace سراسری و flat است، نه مجموعه‌ای کامل از definition/variant/overrideها.
- Animation export فعلاً metadata و eventهای hard-coded clip را ذخیره می‌کند؛ frame image، curve و hitbox serialization کامل نیست و Project Load آن را مصرف نمی‌کند.
- Particle export پارامترهای emitter را ذخیره می‌کند؛ texture، gradient، curve keyها و live particleها صادر نمی‌شوند.
- Editor در UI برای هر Entity یک Rigidbody و یک Collider flat مدیریت می‌کند؛ Runtime می‌تواند componentهای سفارشی بیشتری داشته باشد.
- دادهٔ `playing` در Particle export وضعیت Preview Editor است و نباید به‌تنهایی مبنای lifecycle Runtime قرار گیرد.

این محدودیت‌ها باید هنگام نوشتن importer یا Runtime سفارشی لحاظ شوند؛ مستندات قابلیت‌هایی را که هنوز در خروجی وجود ندارند تضمین نمی‌کند.

## Validation و تست

```powershell
npm run check
npm run ah2d -- schema list --pretty
npm run ah2d -- schema show --component Transform --pretty
npm test
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
```

Test suite شامل hierarchy عمیق و چندریشه، local/world Transform، propagation، traversal، تشخیص cycle/ID تکراری، Reparent و Delete با preserve-world، rollback اتمیک برای shear/singular، Multi-Scene، Runtime selection، Rigidbody، colliderهای box/circle، trigger، collision filtering، auto mass، impulse، kinematic body، sleeping، snapshot/restore، مسیر Box2D و قرارداد Editor است.

برای workflow استاندارد توسعه توسط Agent، [`Agent.md`](./Agent.md) را بخوانید.
