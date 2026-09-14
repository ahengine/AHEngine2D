# AH2D Physics و اتصال Box2D

AH2D به‌صورت پیش‌فرض Physics دوبعدی سازگار با Box2D را از طریق `planck` اجرا می‌کند. Planck یک بازنویسی JavaScript/TypeScript از API و solver خانوادهٔ Box2D است و در این پروژه implementation بومیِ Browser و Node محسوب می‌شود؛ این بسته wrapper رسمی کتابخانهٔ C نیست. solver داخلی AH2D همچنان برای تست‌های مستقل از dependency موجود است، اما فقط باید صریح انتخاب شود.

قرارداد فعلی Authoring شامل Rigidbody و چند fixture از نوع box/circle است. polygon، edge، chain و joint هنوز schema پایدار Universal JSON ندارند. بازی می‌تواند این امکانات پیشرفته را با handleهای بومی Runtime بسازد، اما نباید objectهای Planck را serialize کند.

## انتخاب و تشخیص backend

```js
const engine = new AH2D.Engine();

if (
  engine.physics.backend !== 'box2d' ||
  engine.physics.implementation !== 'planck' ||
  engine.physics.native !== true
) {
  throw new Error(`Native physics unavailable: ${engine.physics.nativeError?.message || 'unknown error'}`);
}
```

مقادیر موفق بومی:

```json
{
  "backend": "box2d",
  "implementation": "planck",
  "status": "ready",
  "native": true
}
```

fallback خودکار در اثر دردسترس‌نبودن Planck:

```json
{
  "backend": "builtin",
  "implementation": "ah2d-builtin",
  "status": "fallback",
  "native": false
}
```

انتخاب عمدی solver داخلی `status: "ready"` دارد:

```js
const engine = new AH2D.Engine({ physics: 'builtin' });
```

Editor هنگام ورود به Play Mode، برای پروژه‌ای که `box2d` خواسته است وجود backend بومی را الزام می‌کند و fallback خودکار را به‌عنوان خطای قابل‌مشاهده نشان می‌دهد. پروژه‌ای که صریحاً `builtin` خواسته باشد با solver داخلی اجرا می‌شود. CLI نیز نام backend نامعتبر را رد می‌کند و backend واقعی را در خروجی گزارش می‌دهد.

## Bootstrap

ترتیب scriptها در Browser مهم است:

```html
<script src="./node_modules/pixi.js/dist/pixi.min.js"></script>
<script src="./node_modules/pixi.js/dist/packages/unsafe-eval.min.js"></script>
<script src="./node_modules/planck/dist/planck.min.js"></script>
<script src="./engine/AH2DDataModel.js"></script>
<script src="./engine/AH2DEngine.js"></script>
```

PixiJS برای Physics لازم نیست و فقط در صورت استفاده از renderer آن بارگذاری می‌شود؛ Planck باید پیش از Engine روی `window.planck` موجود باشد. فایل دوم polyfill رسمی CSP-safe خود Pixi است: با وجود نام `unsafe-eval`، generated `Function` را حذف می‌کند و مجوز CSP با همین نام را فعال نمی‌کند. bundle عمومی `/api/editor/engine` و frame sandboxشدهٔ Studio وابستگی‌های لازم را inline می‌کنند تا CSP سخت‌گیرانه و حالت offline حفظ شود.

در Node.js، Engine بستهٔ نصب‌شده را به‌صورت خودکار resolve می‌کند:

```js
global.window = global;
require('./engine/AH2DEngine.js');

const engine = new global.AH2D.Engine();
```

برای dependency و syntax سازگار با نسخهٔ فعلی repository از Node.js 24 یا جدیدتر استفاده کنید.

## تنظیم Project و Engine

پیکربندی Authoring در Universal Project:

```json
{
  "engine": {
    "physics": "box2d",
    "physicsBackend": "box2d",
    "physicsImplementation": "planck",
    "gravity": { "x": 0, "y": 980 },
    "pixelsPerMeter": 100
  }
}
```

`physics` انتخاب مورد درخواست است. دو فیلد دیگر metadata backend/implementation ذخیره‌شده هستند؛ CLI enum مجاز و non-empty بودن را بررسی می‌کند و runtime واقعی metadata مستقل خود را گزارش می‌دهد. `new AH2D.Engine()` انتخاب پروژه را هنگام `engine.load(project)` رعایت می‌کند و در نبود metadata به Box2D می‌رود. دادن `physics: 'box2d'` یا `physics: 'builtin'` در constructor یک override صریح و ثابت برای آن Engine است. `load` همچنین `gravity` و `pixelsPerMeter` سند را روی Physics فعال اعمال می‌کند.

گزینه‌های Runtime:

```js
const engine = new AH2D.Engine({
  physics: 'box2d',
  physicsOptions: {
    pixelsPerMeter: 100,
    maxStep: 1 / 60,
    maxSubSteps: 32,
    velocityIterations: 8,
    positionIterations: 3
  }
});
```

`dt` هر `engine.update(dt)` در محدودهٔ `0..0.25` قرار می‌گیرد. اگر `dt` از `maxStep` بزرگ‌تر باشد، World تا سقف `maxSubSteps` به چند step مساوی تقسیم می‌شود. نیرو و torque جمع‌شده دقیقاً برای همان update اعمال و سپس پاک می‌شوند؛ برای نیروی مداوم آن را در هر frame دوباره اعمال کنید.

## واحدها و دستگاه مختصات

- Position، اندازه، offset، velocity و gravity در API عمومی AH2D بر حسب pixel، pixel/second و pixel/second² هستند.
- Planck این مقادیر را در مرز adapter با `pixelsPerMeter` به metre تبدیل می‌کند.
- محور Y مثبت مطابق Editor رو به پایین است.
- Rotation و angular velocity در AH2D درجه و درجه/ثانیه هستند؛ adapter آن‌ها را به radian تبدیل می‌کند.
- `mass` جرم Runtime است. با `useAutoMass: false`، density fixtureهای solid طوری scale می‌شود که جرم خواسته‌شده حفظ شود. sensorها در محاسبهٔ جرم وارد نمی‌شوند.
- force، impulse و torque در API AH2D در مقیاس pixel-space هستند و adapter آن‌ها را قبل از ارسال به World تبدیل می‌کند.

مقدار scale را مستقیم تغییر ندهید:

```js
engine.physics.setPixelsPerMeter(128);
```

این setter World و fixtureهای بومی را rebuild می‌کند و position، velocity، rotation، sleep state و forceهای صف‌شده را در فضای AH2D حفظ می‌کند.

## Rigidbody

```json
{
  "enabled": true,
  "type": "dynamic",
  "mass": 1,
  "useAutoMass": false,
  "gravityScale": 1,
  "linearDamping": 0.08,
  "angularDamping": 0.08,
  "velocityX": 0,
  "velocityY": 0,
  "angularVelocity": 0,
  "fixedRotation": false,
  "bullet": false,
  "allowSleep": true,
  "sleeping": false
}
```

نوع‌ها `static`، `dynamic` و `kinematic` هستند. Entity دارای Collider ولی بدون Rigidbody به‌صورت static ساخته می‌شود. `bullet` continuous collision را برای bodyهای سریع فعال می‌کند.

## Collider و چند fixture

یک Collider فشرده:

```json
{
  "id": "main",
  "enabled": true,
  "shape": "box",
  "width": 64,
  "height": 96,
  "offsetX": 0,
  "offsetY": 0,
  "rotation": 0,
  "density": 1,
  "friction": 0.35,
  "restitution": 0.05,
  "isTrigger": false,
  "categoryBits": 1,
  "maskBits": 65535,
  "groupIndex": 0
}
```

فرم‌های معتبر multi-fixture:

```js
components: {
  Collider: [
    { id: 'torso', shape: 'box', width: 42, height: 62 },
    { id: 'head', shape: 'circle', radius: 16, offsetY: -42 },
    { id: 'feet', shape: 'box', width: 28, height: 8, offsetY: 36, isTrigger: true }
  ]
}

// یا برای حفظ metadata/فیلدهای wrapper:
components: {
  Collider: {
    colliders: [/* fixtures */],
    customAuthoringField: true
  }
}
```

کلید `shapes` نیز به‌عنوان alias پذیرفته می‌شود. هر `id` صریح باید میان تمام fixtureهای همان Entity یکتا باشد؛ Data Model و CLI تکرار را با JSON Pointer دقیق رد می‌کنند و fixture بدون ID در Runtime یک ID قطعی می‌گیرد. Editor هنگام افزودن، ویرایش و حذف fixture شکل موجود storage و فیلدهای ناشناخته را حفظ می‌کند. fixture غیرفعال ساخته نمی‌شود و trigger به Planck sensor تبدیل می‌شود.

filterها مطابق Box2D روی خود fixture اعمال می‌شوند:

- `categoryBits`: دستهٔ fixture؛
- `maskBits`: دسته‌هایی که با آن‌ها برخورد می‌کند؛
- `groupIndex`: override گروهی مثبت/منفی.

## Lifecycle و همگام‌سازی ECS

```js
engine.load(project);
engine.update(0); // Body/Fixtureهای Scene فعال را materialize می‌کند.
```

قبل از step، Transform/Rigidbody/Collider مؤثر ECS به body بومی sync می‌شوند. پس از step، position، rotation، velocity، angular velocity و sleeping state به componentهای Runtime برمی‌گردند. Transform Authoring همیشه local نسبت به `parentId` است؛ `Transform.world` خروجی مشتق‌شدهٔ Scene Graph باقی می‌ماند.

تغییر collider، filter، جرم یا body definition باعث rebuild کنترل‌شدهٔ body/fixture مربوط می‌شود. حذف Entity را با `engine.destroyEntity()` انجام دهید تا Graph، ECS، Physics و contactهای پایان‌یافته با هم پاک شوند. `engine.loadScene()` World صحنهٔ قبلی را خالی و Scene جدید را materialize می‌کند. Stop در Play Mode نیز snapshot پیش از Play را بازیابی می‌کند، مگر این رفتار صریحاً غیرفعال شده باشد.

## کنترل Runtime

```js
engine.update(0);

engine.physics.setGravity({ x: 0, y: 980 });
engine.physics.setVelocity('player', 180, 0);
engine.physics.setAngularVelocity('wheel', 90);
engine.physics.applyForce('player', { x: 500, y: 0 });
engine.physics.applyTorque('wheel', 80);
engine.physics.applyImpulse('player', 0, -420);
engine.physics.setTransform('player', 320, 180, 0);
engine.physics.wake('player');
engine.physics.sleep('crate');
```

`applyForce` و `applyTorque` برای یک update هستند. `applyImpulse` بلافاصله velocity بومی را تغییر می‌دهد. methodها برای body ناموجود یا عملیات نامعتبر `false` برمی‌گردانند.

## Contact، Collision و Trigger

رویدادها مستقیماً از contactهای World بومی ساخته می‌شوند:

- `physics:collisionstart`, `physics:collisionstay`, `physics:collisionend`
- `physics:triggerenter`, `physics:triggerstay`, `physics:triggerexit`
- `physics:contact` برای همهٔ phaseها

```js
const off = engine.events.on('physics:collisionstart', contact => {
  const {
    a, b,
    bodyA, bodyB,
    colliderA, colliderB,
    normal, point,
    penetration,
    phase,
    trigger
  } = contact;

  console.log(a, colliderA, b, colliderB, normal, point);
});
```

`colliderA`/`colliderB` object نرمال‌شدهٔ fixture هستند و ID پایدار در `colliderA.id`/`colliderB.id` قرار دارد. callback نباید وسط step صحنه را reload یا bodyها را destroy کند؛ درخواست را ثبت و پس از بازگشت `engine.update()` اجرا کنید. هنگام destroy/clear، event پایان contactها قبل از حذف کامل state منتشر می‌شود.

## دسترسی بومی و قابلیت‌های پیشرفته

```js
engine.update(0);

const world = engine.physics.getNativeWorld();
const playerBody = engine.physics.getNativeBody('player');
const feet = engine.physics.getNativeFixture('player', 'feet');

if (!world || !playerBody || !feet) {
  throw new Error('Native Planck handles are unavailable');
}
```

این handleها برای joint، query، ray cast، contact listener اضافه یا extension موقت بازی در دسترس‌اند. چند مرز مهم:

- handle بومی را داخل component، Project JSON، history یا save قرار ندهید؛
- ownership body/fixtureهای ECS با Engine است؛ آن‌ها را مستقیم destroy نکنید؛
- body/fixture ممکن است پس از load، Scene switch، تغییر Collider یا `setPixelsPerMeter()` rebuild شود، پس handle را طولانی‌مدت cache نکنید؛
- body/joint اضافه‌ای که فقط در World بومی ساخته می‌شود در Universal Project، undo/redo و Scene switch پایدار نیست؛
- اگر polygon/chain/joint باید Authoring شود، schema، migration، validation، Editor، CLI، runtime load/save و تست را با هم توسعه دهید.

## CLI

```powershell
npm run ah2d -- physics get --file game.ah2d.json --pretty
npm run ah2d -- physics set --file game.ah2d.json --backend box2d --write
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
npm run ah2d -- simulate --file game.ah2d.json --scene main --steps 600 --dt 0.0166666667 --pretty
npm run ah2d -- ecs export --file game.ah2d.json --scene main --out main.ecs.json
```

`validate --engine`، `simulate` و `ecs export` انتخاب `engine.physics` پروژه را رعایت می‌کنند. برای override موقت و بدون تغییر فایل:

```powershell
npm run ah2d -- simulate --file game.ah2d.json --backend builtin --steps 600 --dt 0.0166666667 --pretty
```

خروجی CLI چهار مقدار `requested`، `backend`، `implementation` و `native` را جدا گزارش می‌کند. برای mutation قرارداد استاندارد SHA-256/`--expect-sha256` را رعایت کنید.

## چک‌لیست اعتبارسنجی

```powershell
npm run check
npm run test:engine
npm run test:cli
npm run test:server
npm test
npm run build
```

برای smoke test بازی، حداقل یک ground static، یک body dynamic، چند fixture، trigger، filter، force، torque، impulse، Scene switch و چرخهٔ Play/Stop را اجرا کنید و metadata backend را قبل از نتیجه بررسی کنید.

## عیب‌یابی

- `backend: builtin` با درخواست `box2d`: Planck پیش از Engine بارگذاری نشده یا API ناسازگار تزریق شده است؛ `nativeError` را بخوانید.
- body ساخته نشده: بعد از ساخت componentها `engine.update(0)` را اجرا و `enabled` Collider/Rigidbody را بررسی کنید.
- contact نمی‌رسد: `categoryBits`/`maskBits`/`groupIndex`، static-static بودن bodyها و enabled بودن fixture را بررسی کنید.
- حرکت چند برابر است: هم‌زمان حلقهٔ دستی و `engine.start()` را اجرا نکنید.
- اندازه/سرعت اشتباه است: مقدار `pixelsPerMeter` را با setter یا Project تغییر دهید، نه با assignment مستقیم.
- نتیجهٔ CLI متفاوت است: backend و نسخهٔ dependency را در خروجی ثبت کنید؛ برای مقایسهٔ solver داخلی `--backend builtin` را صریح بگذارید.
